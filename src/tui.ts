// TUI entry: /go-keys opens the key list. Every key's live usage (real
// per-window percentages from Go's /usage endpoint) is fetched in parallel
// once per command invocation and cached — opening a key, ESC back, and
// reopening never refetch. A new /go-keys run starts fresh.
// Slash arguments act directly: add / test / del.

import { createComponent } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/plugin"
import {
  ConfigError,
  addKey,
  formatDuration,
  keysFilePath,
  loadConfig,
  maskKey,
  parseSlashArgs,
  removeKey,
  testKey,
  type KeyTestResult,
} from "./config.js"
import { renderBar, type UsageInfo } from "./panel/usage.js"
import { GoKeysModal } from "./panel/view.js"

const FILE = keysFilePath()

/** One invocation's results: index -> fetch result. Cleared on each /go-keys run. */
let cache = new Map<number, KeyTestResult>()

function showKeyModal(ctx: Context, index: number, result: KeyTestResult | undefined): Promise<void> {
  return new Promise((resolve) => {
    ctx.ui.dialog.set({ size: "large", centered: true })
    ctx.ui.dialog.show(() => createComponent(GoKeysModal, { index, result }), () => resolve())
  })
}

function fail(ctx: Context, title: string, message: string): void {
  ctx.ui.toast.show({ title, message, variant: "error" })
}

function readPool(): { keys: readonly string[] } | { reason: string } {
  try {
    return { keys: loadConfig({}, FILE).provider.keys }
  } catch (error) {
    return { reason: error instanceof ConfigError ? error.message : `failed to load ${FILE}` }
  }
}

function stateLabel(result: KeyTestResult | undefined): string {
  if (result === undefined) return "not fetched"
  if (result.ok && !result.limited) return "ok"
  return result.limited ? "limited" : "failed"
}

function usageOneLiner(result: KeyTestResult | undefined): string {
  if (result === undefined) return "no usage data"
  const w: UsageInfo = result.usage
  const pad = (value: number): string => `${String(Math.round(value)).padStart(3)}%`
  const parts: string[] = []
  if (w.rolling) parts.push(`${renderBar(w.rolling.percent, 8, "|", "-", false)} ${pad(w.rolling.percent)} 5h`)
  if (w.weekly) parts.push(`${pad(w.weekly.percent)} wk`)
  if (w.monthly) parts.push(`${pad(w.monthly.percent)} mo`)
  if (parts.length === 0) return "no usage data"
  return parts.join(" ")
}

/** Fetch every key once per invocation, in parallel. */
async function ensureCache(keys: readonly string[]): Promise<void> {
  if (cache.size > 0 || keys.length === 0) return
  const results = await Promise.all(keys.map((key) => testKey(key)))
  cache = new Map(results.map((result, index) => [index, result]))
}

async function openList(ctx: Context): Promise<void> {
  for (;;) {
    const pool = readPool()
    const keys = "keys" in pool ? pool.keys : []
    await ensureCache(keys)
    const picked = await ctx.ui.dialog.select({
      title: keys.length === 0 ? "go-keys — no keys stored yet" : `go-keys — ${keys.length} keys`,
      placeholder: "Select a key for its usage view",
      options: keys.map((key, index) => ({
        title: `#${index} ${maskKey(key)} ${stateLabel(cache.get(index))}`,
        value: index,
        description: usageOneLiner(cache.get(index)),
      })),
      actions: [
        {
          bind: "ctrl+a",
          title: "Add key",
          selection: "none",
          onTrigger: () => {
            void (async () => {
              const pasted = await ctx.ui.dialog.prompt({
                title: "Add Go API key",
                description: "Paste one OpenCode Go API key. Repeat per subscription.",
                placeholder: "go-key…",
              })
              if (pasted !== undefined) {
                try {
                  const result = addKey(FILE, pasted)
                  const fresh = loadConfig({}, FILE).provider.keys[result.index]
                  const verdict = fresh === undefined ? undefined : await testKey(fresh)
                  cache.set(result.index, verdict ?? { ok: false, limited: false, detail: "not tested", usage: {} })
                  ctx.ui.toast.show({
                    title: result.duplicate ? `Key #${result.index} already stored` : `Stored as key #${result.index}`,
                    message:
                      (result.duplicate
                        ? `${result.count} total — no change`
                        : `${result.count} total — restart the service to activate`) +
                      (verdict === undefined ? "" : ` · ${stateLabel(verdict)}`),
                    variant: "success",
                  })
                } catch (error) {
                  fail(ctx, "Key not stored", error instanceof ConfigError ? error.message : `could not update ${FILE}`)
                }
              }
              ctx.ui.dialog.clear()
              await openList(ctx)
            })()
          },
        },
        {
          bind: "ctrl+t",
          title: "Refresh",
          selection: "none",
          onTrigger: () => {
            void (async () => {
              cache = new Map()
              ctx.ui.dialog.clear()
              await openList(ctx)
            })()
          },
        },
        {
          bind: "ctrl+d",
          title: "Delete key",
          selection: "required",
          onTrigger: (value) => {
            void (async () => {
              const poolNow = readPool()
              const key = "keys" in poolNow ? poolNow.keys[value] : undefined
              if (key === undefined) return
              const confirmed = await ctx.ui.dialog.confirm({
                title: `Delete key #${value}?`,
                message: `${maskKey(key)} will be removed. Restart the service afterwards to apply.`,
                label: { confirm: "Delete", cancel: "Keep" },
              })
              ctx.ui.dialog.clear()
              if (confirmed) {
                try {
                  const result = removeKey(FILE, value)
                  ctx.ui.toast.show({
                    title: `Key #${result.index} deleted`,
                    message: `${result.count} remaining — restart the service to apply`,
                    variant: "success",
                  })
                } catch (error) {
                  fail(ctx, "Key not deleted", error instanceof ConfigError ? error.message : `could not update ${FILE}`)
                }
                cache = new Map()
              }
              await openList(ctx)
            })()
          },
        },
      ],
    })
    if (picked === undefined) return
    await showKeyModal(ctx, picked, cache.get(picked))
  }
}

async function runAdd(ctx: Context, key: string): Promise<void> {
  if (key === "") {
    fail(ctx, "go-keys", "usage: /go-keys add <go-api-key>")
    return
  }
  try {
    const result = addKey(FILE, key)
    ctx.ui.toast.show({
      title: result.duplicate ? `Key #${result.index} already stored` : `Stored as key #${result.index}`,
      message: result.duplicate
        ? `${result.count} total — no change`
        : `${result.count} total — restart the service to activate`,
      variant: "success",
    })
  } catch (error) {
    fail(ctx, "Key not stored", error instanceof ConfigError ? error.message : `could not update ${FILE}`)
  }
}

async function runTest(ctx: Context, index: number | undefined): Promise<void> {
  const pool = readPool()
  if (!("keys" in pool)) {
    fail(ctx, "go-keys", pool.reason)
    return
  }
  const picked = index === undefined ? pool.keys.map((_, i) => i) : [index]
  if (picked.some((i) => !Number.isInteger(i) || i < 0 || i >= pool.keys.length)) {
    fail(ctx, "go-keys", "usage: /go-keys test [key-index]")
    return
  }
  for (const i of picked) {
    const result = await testKey(pool.keys[i]!)
    cache.set(i, result)
    ctx.ui.toast.show({
      title: `Key #${i} ${stateLabel(result)}`,
      message: `${maskKey(pool.keys[i]!)} — ${result.detail}`,
      variant: result.ok && !result.limited ? "success" : result.limited ? "warning" : "error",
    })
  }
}

async function runDelete(ctx: Context, index: number | undefined): Promise<void> {
  const pool = readPool()
  if (!("keys" in pool)) {
    fail(ctx, "go-keys", pool.reason)
    return
  }
  if (index === undefined || !Number.isInteger(index) || index < 0 || index >= pool.keys.length) {
    fail(ctx, "go-keys", `usage: /go-keys del <key-index> (0-${Math.max(0, pool.keys.length - 1)})`)
    return
  }
  const confirmed = await ctx.ui.dialog.confirm({
    title: `Delete key #${index}?`,
    message: `${maskKey(pool.keys[index]!)} will be removed. Restart the service afterwards to apply.`,
    label: { confirm: "Delete", cancel: "Keep" },
  })
  if (!confirmed) return
  try {
    const result = removeKey(FILE, index)
    ctx.ui.toast.show({
      title: `Key #${result.index} deleted`,
      message: `${result.count} remaining — restart the service to apply`,
      variant: "success",
    })
  } catch (error) {
    fail(ctx, "Key not deleted", error instanceof ConfigError ? error.message : `could not update ${FILE}`)
  }
}

export default Plugin.define({
  id: "go-keys",
  setup(ctx) {
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "go.keys.open",
          title: "Open Go Keys manager",
          description: "Key list and per-key usage views for OpenCode Go API keys",
          group: "go-keys",
          palette: true,
          slash: { name: "go-keys", arguments: true },
          run: (input) => {
            void (async () => {
              // New invocation: drop the previous cache so usage is fetched fresh.
              cache = new Map()
              const action = parseSlashArgs(input)
              if (action.action === "add") await runAdd(ctx, action.key)
              else if (action.action === "test") await runTest(ctx, action.index)
              else if (action.action === "del") await runDelete(ctx, action.index)
              await openList(ctx)
            })()
          },
        },
      ],
    }))
  },
})
