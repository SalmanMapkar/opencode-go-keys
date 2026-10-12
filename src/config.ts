import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_HEADERS, applyAuth, readRetryAfter } from "./auth.js"
import { parseUsage, windowLimited, type UsageInfo } from "./panel/usage.js"

export const PROVIDER_ID = "opencode-go"
export const DEFAULT_COOLDOWN_MS = 1_800_000
export const DEFAULT_MAX_COOLDOWN_MS = 21_600_000

/** Messages never contain key values — only paths and field names. */
export class ConfigError extends Error {}

export interface ProviderConfig {
  readonly keys: readonly string[]
  readonly headers: Record<string, string>
}

export interface RotaConfig {
  readonly provider: ProviderConfig
  readonly cooldownMs: number
  readonly maxCooldownMs: number
}

export function keysFilePath(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR
  return path.join(dir ?? path.join(os.homedir(), ".config", "opencode"), "go-keys.json")
}

/** Fixed mirror of the rotation log; the TUI usage view reads the same file. */
export function goKeysLogPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "log", "go-keys.log")
}

/** Read + parse the keys file. Strips a UTF-8 BOM (PowerShell writes one by default). */
function readJsonFile(filePath: string): unknown {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch {
    throw new ConfigError(`keys file not readable: ${filePath}`)
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""))
  } catch {
    throw new ConfigError(`keys file is not valid JSON: ${filePath}`)
  }
}

export interface AddKeyResult {
  readonly index: number
  readonly count: number
  readonly duplicate: boolean
}

/**
 * Append a Go key to the keys file, creating the file when missing. Other
 * providers and header overrides are preserved. Throws ConfigError without
 * ever including the key value.
 */
export function addKey(filePath: string, key: string): AddKeyResult {
  const value = key.trim()
  if (value === "" || /\s/.test(value)) {
    throw new ConfigError("usage: /go-keys add <go-api-key> — the key is one token, no spaces")
  }
  const root = readRoot(filePath, true)
  const keys = providerKeys(root, filePath, true)
  const existing = keys.indexOf(value)
  if (existing !== -1) return { index: existing, count: keys.length, duplicate: true }
  keys.push(value)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(root, null, 2)}\n`, "utf8")
  return { index: keys.length - 1, count: keys.length, duplicate: false }
}

export interface RemoveKeyResult {
  readonly index: number
  readonly count: number
}

/** Remove one key by index. Throws ConfigError; the file keeps headers and other providers. */
export function removeKey(filePath: string, index: number): RemoveKeyResult {
  const root = readRoot(filePath)
  const keys = providerKeys(root, filePath)
  if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
    throw new ConfigError(`usage: pick a stored key index (0-${Math.max(0, keys.length - 1)})`)
  }
  keys.splice(index, 1)
  fs.writeFileSync(filePath, `${JSON.stringify(root, null, 2)}\n`, "utf8")
  return { index, count: keys.length }
}

/**
 * Parse the keys file into its mutable root object. With allowMissing, a
 * missing/unreadable file starts empty; malformed JSON always throws.
 */
function readRoot(filePath: string, allowMissing = false): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = readJsonFile(filePath)
  } catch (error) {
    if (allowMissing && error instanceof ConfigError && error.message.startsWith("keys file not readable")) {
      return {}
    }
    throw error
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError("keys file must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

/** The live keys array for this provider, creating the scaffolding when allowed. */
function providerKeys(root: Record<string, unknown>, filePath: string, allowMissing = false): string[] {
  if (root.providers === undefined) {
    if (!allowMissing) throw new ConfigError(`providers.${PROVIDER_ID} is not configured in ${filePath}`)
    root.providers = {}
  }
  const providers = root.providers
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    throw new ConfigError('keys file "providers" must be an object')
  }
  const table = providers as Record<string, unknown>
  if (table[PROVIDER_ID] === undefined) {
    if (!allowMissing) throw new ConfigError(`providers.${PROVIDER_ID} is not configured in ${filePath}`)
    table[PROVIDER_ID] = { keys: [] }
  }
  const entry = table[PROVIDER_ID]
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new ConfigError(`providers.${PROVIDER_ID} must be an object with a "keys" array`)
  }
  const record = entry as { keys?: unknown }
  if (record.keys === undefined) {
    if (!allowMissing) throw new ConfigError(`providers.${PROVIDER_ID}.keys must be an array of non-empty strings`)
    record.keys = []
  }
  if (!Array.isArray(record.keys) || !record.keys.every((k) => typeof k === "string" && (k as string).trim() !== "")) {
    throw new ConfigError(`providers.${PROVIDER_ID}.keys must be an array of non-empty strings`)
  }
  return record.keys as string[]
}

/** Throws ConfigError on any problem; the caller disables rotation and continues. */
export function loadConfig(options: unknown, filePath = keysFilePath()): RotaConfig {
  const parsed = readJsonFile(filePath)
  const root = parsed as { providers?: Record<string, { keys?: unknown; headers?: unknown }> }
  const entry = root?.providers?.[PROVIDER_ID]
  const keys = entry?.keys
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === "string" && k.trim() !== "")) {
    throw new ConfigError(`providers.${PROVIDER_ID}.keys must be a non-empty array of non-empty strings`)
  }
  const unique = [...new Set(keys as string[])]
  return {
    provider: { keys: unique, headers: validateHeaders(entry?.headers) },
    ...validateOptions(options),
  }
}

function validateHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined) return DEFAULT_HEADERS
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`providers.${PROVIDER_ID}.headers must be an object of header name -> scheme`)
  }
  const out: Record<string, string> = {}
  for (const [name, scheme] of Object.entries(raw)) {
    if (typeof scheme !== "string") {
      throw new ConfigError(`header scheme for "${name}" must be a string ("Bearer") or "" for the raw key`)
    }
    out[name] = scheme
  }
  if (Object.keys(out).length === 0) throw new ConfigError(`providers.${PROVIDER_ID}.headers must not be empty`)
  return out
}

function validateOptions(options: unknown): { cooldownMs: number; maxCooldownMs: number } {
  const o = (options ?? {}) as Record<string, unknown>
  // ctx.options only carries values when the loader accepts object-form plugin
  // entries; env vars keep the two timings configurable otherwise.
  return {
    cooldownMs: pickPositive(o.cooldownMs ?? envMs("GO_KEYS_COOLDOWN_MS"), DEFAULT_COOLDOWN_MS, "cooldownMs"),
    maxCooldownMs: pickPositive(o.maxCooldownMs ?? envMs("GO_KEYS_MAX_COOLDOWN_MS"), DEFAULT_MAX_COOLDOWN_MS, "maxCooldownMs"),
  }
}

function envMs(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : NaN
}

function pickPositive(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`plugin option "${name}" must be a positive number of milliseconds`)
  }
  return value
}

/** Slash-arg parsing for /go-keys. Plain "/go-keys" opens the view. */
export type GoKeysAction =
  | { action: "view" }
  | { action: "add"; key: string }
  | { action: "test"; index?: number }
  | { action: "del"; index?: number }

export function parseSlashArgs(input?: string): GoKeysAction {
  const tokens = (input ?? "").trim().replace(/^\/go-keys\b/, "").trim().split(/\s+/).filter((t) => t !== "")
  const [sub, ...rest] = tokens
  if (sub === undefined || sub === "list") return { action: "view" }
  if (sub === "add") return { action: "add", key: rest[0] ?? "" }
  if (sub === "test") return { action: "test", index: rest[0] === undefined ? undefined : Number(rest[0]) }
  if (sub === "del" || sub === "delete" || sub === "rm") {
    return { action: "del", index: rest[0] === undefined ? undefined : Number(rest[0]) }
  }
  return { action: "view" }
}

/** Last-4 display form; never the full key. */
export function maskKey(key: string): string {
  return `…${key.slice(-4)}`
}

// shortcut: baseURL is the documented Go default; plugins cannot read provider options. Revisit if OpenCode exposes them.
export const GO_DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1"

/** Retry-After hint (delta-seconds or HTTP-date) in ms, or undefined when absent/garbage. */
function parseRetryAfterMs(hint: string): number | undefined {
  const trimmed = hint.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  }
  return `${Math.floor(hours / 24)}d`
}

export interface KeyTestResult {
  readonly ok: boolean
  /** true when the key is valid but a quota window is exhausted */
  readonly limited: boolean
  /** fixed strings only — never contains the key */
  readonly detail: string
  readonly usage: UsageInfo
}

/** GET /usage with the key as the Go upstream would receive it — the same
 * endpoint that powers the console website, so bars show real quota
 * percentages. Free: a GET spends no model tokens. */
export async function fetchUsage(
  key: string,
  fetchFn: typeof fetch = fetch,
  baseURL = GO_DEFAULT_BASE_URL,
): Promise<KeyTestResult> {
  const headers = new Headers()
  applyAuth(headers, key)
  let response: Response
  try {
    response = await fetchFn(`${baseURL.replace(/\/+$/, "")}/usage`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    return { ok: false, limited: false, detail: `unreachable (${error instanceof Error ? error.message : "network error"})`, usage: {} }
  }
  if (response.status === 200) {
    const usage = parseUsage(await response.json())
    const windows = [usage.rolling, usage.weekly, usage.monthly].filter((w) => w !== undefined)
    const limited = windows.some(windowLimited)
    return { ok: true, limited, detail: limited ? "limited — see the usage view" : "connected", usage }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, limited: false, detail: "rejected — not a valid key", usage: {} }
  }
  if (response.status === 429) {
    // Valid key, spent quota: surface the reset estimate instead of a bare failure.
    const hint = readRetryAfter(response.headers)
    const remaining = hint === null ? undefined : parseRetryAfterMs(hint)
    return {
      ok: false,
      limited: true,
      detail:
        remaining === undefined
          ? "valid key — usage exhausted, resets when its window clears"
          : `valid key — usage exhausted, resets in ~${formatDuration(remaining)}`,
      usage: {},
    }
  }
  return { ok: false, limited: false, detail: `http ${response.status}`, usage: {} }
}

export const testKey = fetchUsage
