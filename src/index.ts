import fs from "node:fs"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { ConfigError, PROVIDER_ID, goKeysLogPath, keysFilePath, loadConfig } from "./config.js"
import { applyAuth, readRetryAfter } from "./auth.js"
import {
  createState,
  isTriggerStatus,
  nextHealthy,
  park,
  parseParkMs,
  select,
} from "./rotation.js"

const TAG = "[go-keys]"
// Parking (how long the failed key stays benched) is separate from the retry
// delay (how long until the retried request goes out on the next key).
const RETRY_DELAY_MS = 500
// shortcut: log path is fixed rather than tracking OpenCode's data-dir env; move it if OpenCode relocates its log dir
const LOG_FILE = goKeysLogPath()

/** console.log is swallowed by OpenCode's spawned servers, so mirror to a file next to opencode.log. */
function log(message: string): void {
  const line = `${TAG} ${message}`
  console.log(line)
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // logging must never break rotation
  }
}

interface InFlight {
  index: number
  /** park duration from the response that was seen, when the response was a trigger */
  parkMs?: number
  /** response status seen for this request, when it was a trigger */
  status?: number
}

/** Keys files already claimed by a setup in this process (rotation or command). */
const claimedFiles = new Set<string>()

export default Plugin.define({
  id: "go-keys",
  async setup(ctx) {
    const filePath = keysFilePath()
    // Location shims can load a second copy of this plugin (e.g. a project
    // shim plus the home-dir shim). The first setup claims the keys file; a
    // duplicate registers nothing and stays idle.
    if (claimedFiles.has(filePath)) {
      log(`${PROVIDER_ID}: already active for ${filePath} — duplicate instance idle`)
      return async () => {}
    }
    claimedFiles.add(filePath)
    const registrations: Array<{ dispose(): Promise<void> }> = []
    const release = async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()))
      claimedFiles.delete(filePath)
    }
    let config
    try {
      config = loadConfig(ctx.options, filePath)
    } catch (error) {
      const reason = error instanceof ConfigError ? error.message : `failed to load ${filePath}`
      log(`${reason} — rotation disabled, provider auth unchanged`)
      return release
    }
    const { provider, cooldownMs, maxCooldownMs } = config
    if (provider.keys.length < 2) {
      log(`${PROVIDER_ID}: ${provider.keys.length} key in ${keysFilePath()} — need >=2 to rotate; passing through`)
      return release
    }

    const state = createState(provider.keys.length)
    /** `${sessionID}:${kind}` -> in-flight request info */
    const inFlight = new Map<string, InFlight>()
    const scope = { providerID: PROVIDER_ID }
    const parkOptions = () => ({ now: Date.now(), defaultMs: cooldownMs, maxMs: maxCooldownMs })

    registrations.push(
      await ctx.session.hook(
        "http.request",
        (event) => {
          const index = select(state, Date.now())
          inFlight.set(`${event.sessionID}:${event.kind}`, { index })
          applyAuth(event.request.headers, provider.keys[index]!, provider.headers)
        },
        scope,
      ),
    )

    // Parking happens here — the only hook that sees both the exact key used
    // for this request (per kind) and the Retry-After header. A trigger status
    // always comes from an HTTP response, so the retry hook never needs to park.
    registrations.push(
      await ctx.session.hook(
        "http.response",
        (event) => {
          const id = `${event.sessionID}:${event.kind}`
          if (!isTriggerStatus(event.response.status)) {
            inFlight.delete(id)
            return
          }
          const entry = inFlight.get(id)
          if (entry === undefined) return
          const parkMs = parseParkMs(readRetryAfter(event.response.headers), parkOptions())
          park(state, entry.index, Date.now() + parkMs)
          inFlight.set(id, { ...entry, parkMs, status: event.response.status })
        },
        scope,
      ),
    )

    registrations.push(
      await ctx.session.hook(
        "retry",
        (event) => {
          if (!isTriggerStatus(event.error.status)) return
          // The retry hook carries no `kind`, so match this failure against the
          // session's in-flight entries by status. Concurrent requests share the
          // same sticky active key, so the index is right either way.
          let candidate: { id: string; entry: InFlight } | undefined
          let fallback: { id: string; entry: InFlight } | undefined
          for (const [id, entry] of inFlight) {
            if (!id.startsWith(`${event.sessionID}:`)) continue
            if (entry.status === event.error.status) candidate ??= { id, entry }
            else fallback ??= { id, entry }
          }
          const match = candidate ?? fallback
          if (match === undefined) return
          inFlight.delete(match.id)
          const failed = match.entry.index
          const next = nextHealthy(state, failed, Date.now())
          if (next === undefined) return // all keys parked: keep OpenCode's own decision
          state.activeIndex = next
          event.decision = { retry: true, delay: RETRY_DELAY_MS }
          const duration = match.entry.parkMs ?? cooldownMs
          log(
            `${PROVIDER_ID}: key #${failed} -> #${next} (status ${event.error.status}), key #${failed} parked ${formatMs(duration)}`,
          )
        },
        scope,
      ),
    )

    log(`${PROVIDER_ID}: ${provider.keys.length} keys, sticky rotation active`)
    return async () => {
      inFlight.clear()
      await release()
    }
  },
})

function formatMs(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`
}
