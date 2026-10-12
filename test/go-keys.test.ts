import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createState,
  isHealthy,
  isTriggerStatus,
  nextHealthy,
  park,
  parseParkMs,
  select,
} from "../src/rotation.js"
import { readRetryAfter } from "../src/auth.js"
import { ConfigError, addKey, loadConfig, maskKey, parseSlashArgs, removeKey, testKey } from "../src/config.js"
import plugin from "../src/index.js"

const NOW = 1_000_000_000_000
const parkOptions = { now: NOW, defaultMs: 1_800_000, maxMs: 21_600_000 }

test("selector returns the healthy active key", () => {
  const state = createState(3)
  park(state, 1, NOW + 60_000)
  assert.equal(select(state, NOW), 0)
})

test("selector advances with wraparound when the active key is parked", () => {
  const state = createState(3)
  state.activeIndex = 2
  park(state, 2, NOW + 60_000)
  park(state, 0, NOW + 60_000)
  assert.equal(select(state, NOW), 1)
})

test("selector falls back to the earliest-expiry key when all are parked", () => {
  const state = createState(3)
  state.activeIndex = 1
  park(state, 0, NOW + 5_000)
  park(state, 1, NOW + 60_000)
  park(state, 2, NOW + 30_000)
  assert.equal(select(state, NOW), 0)
  assert.equal(nextHealthy(state, 1, NOW), undefined)
})

test("expired parks become healthy again", () => {
  const state = createState(2)
  park(state, 0, NOW - 1)
  assert.ok(isHealthy(state, 0, NOW))
  assert.equal(select(state, NOW), 0)
})

test("Retry-After parsing: delta seconds", () => {
  assert.equal(parseParkMs("120", parkOptions), 120_000)
})

test("Retry-After parsing: HTTP-date", () => {
  const until = new Date(NOW + 300_000).toUTCString()
  assert.equal(parseParkMs(until, parkOptions), 300_000)
})

test("Retry-After parsing: past date parks for 0 ms, garbage and absent use the default", () => {
  assert.equal(parseParkMs(new Date(NOW - 60_000).toUTCString(), parkOptions), 0)
  assert.equal(parseParkMs("soon", parkOptions), 1_800_000)
  assert.equal(parseParkMs(null, parkOptions), 1_800_000)
})

test("Retry-After parsing: header values capped at maxCooldownMs", () => {
  assert.equal(parseParkMs("999999", parkOptions), 21_600_000)
  const far = new Date(NOW + 100 * 60 * 60 * 1000).toUTCString()
  assert.equal(parseParkMs(far, parkOptions), 21_600_000)
})

test("trigger statuses: 429 and gateway failures rotate, auth errors never do", () => {
  for (const status of [429, 500, 502, 503, 504, 529]) assert.ok(isTriggerStatus(status), String(status))
  for (const status of [400, 401, 403, 404, 200, 402]) assert.ok(!isTriggerStatus(status), String(status))
  assert.ok(!isTriggerStatus(undefined))
})

test("readRetryAfter finds the standard header, then x-codex reset headers", () => {
  assert.equal(readRetryAfter(new Headers({ "retry-after": "30" })), "30")
  assert.equal(
    readRetryAfter(new Headers({ "x-codex-primary-reset-after-seconds": "600" })),
    "600",
  )
  assert.equal(readRetryAfter(new Headers({ "x-codex-primary-reset-at": "Sun, 11 Oct 2026 12:00:00 GMT" })), "Sun, 11 Oct 2026 12:00:00 GMT")
  assert.equal(readRetryAfter(new Headers({ "content-type": "application/json" })), null)
})

function mockCtx() {
  const registered: string[] = []
  return {
    registered,
    options: {} as Record<string, unknown>,
    session: {
      hook: async (name: string) => {
        registered.push(name)
        return { dispose: async () => {} }
      },
    },
  }
}

test("one key in the file: plugin registers no hooks", async () => {
  const ctx = mockCtx()
  await withTempKeysFileEnv('{"providers":{"opencode-go":{"keys":["solo-key"]}}}', async () => {
    const cleanup = await (plugin as unknown as { setup(c: unknown): Promise<(() => Promise<void>) | undefined> }).setup(ctx)
    assert.deepEqual(ctx.registered, [])
    assert.equal(typeof cleanup, "function")
    await cleanup?.()
  })
})

test("two keys: plugin registers the three scoped hooks and cleans up", async () => {
  const ctx = mockCtx()
  let cleanup: (() => Promise<void>) | undefined
  await withTempKeysFileEnv('{"providers":{"opencode-go":{"keys":["key-1","key-2"]}}}', async () => {
    cleanup = (await (plugin as unknown as { setup(c: unknown): Promise<(() => Promise<void>) | undefined> }).setup(ctx)) as
      | (() => Promise<void>)
      | undefined
  })
  assert.deepEqual(ctx.registered, ["http.request", "http.response", "retry"])
  await cleanup?.()
})

async function withTempKeysFileEnv(content: string, run: () => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go-keys-test-"))
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = dir
  try {
    fs.writeFileSync(path.join(dir, "go-keys.json"), content)
    await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test("keys file problems throw ConfigError without leaking key values", async () => {
  await withTempKeysFileEnv('{"providers":{"opencode-go":{"keys":["secret-key-xyz"]}}}', async () => {
    assert.throws(() => loadConfig({}, path.join(os.tmpdir(), "definitely-missing-go-keys.json")), ConfigError)
    const dir = process.env.OPENCODE_CONFIG_DIR!
    assert.throws(() => loadConfig({}, path.join(dir, "nope.json")), ConfigError)
  })
  await withTempKeysFileEnv("{not json", async () => {
    assert.throws(() => loadConfig({}), ConfigError)
  })
  await withTempKeysFileEnv('{"providers":{"opencode-go":{"keys":["a",123]}}}', async () => {
    assert.throws(() => loadConfig({}), ConfigError)
  })
  await withTempKeysFileEnv('{"providers":{"opencode-go":{"keys":["a","b"]}}}', async () => {
    assert.equal(loadConfig({ cooldownMs: 5, maxCooldownMs: 10 }).provider.keys.length, 2)
    assert.throws(() => loadConfig({ cooldownMs: -1 }), ConfigError)
    assert.throws(() => loadConfig({ cooldownMs: "soon" }), ConfigError)
  })
})

test("missing keys file disables rotation without throwing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go-keys-test-"))
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = dir
  const ctx = mockCtx()
  try {
    const result = await (plugin as unknown as { setup(c: unknown): Promise<(() => Promise<void>) | undefined> }).setup(ctx)
    assert.deepEqual(ctx.registered, [])
    assert.equal(typeof result, "function")
    await result?.()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("cooldowns fall back to GO_KEYS_* env vars when options are absent", async () => {
  await withTempKeysFileEnv('{"providers":{"opencode-go":{"keys":["a","b"]}}}', async () => {
    const previousCooldown = process.env.GO_KEYS_COOLDOWN_MS
    const previousMax = process.env.GO_KEYS_MAX_COOLDOWN_MS
    process.env.GO_KEYS_COOLDOWN_MS = "5000"
    process.env.GO_KEYS_MAX_COOLDOWN_MS = "9000"
    try {
      const config = loadConfig({})
      assert.equal(config.cooldownMs, 5000)
      assert.equal(config.maxCooldownMs, 9000)
      assert.equal(loadConfig({ cooldownMs: 7 }).cooldownMs, 7)
      process.env.GO_KEYS_COOLDOWN_MS = "soon"
      assert.throws(() => loadConfig({}), ConfigError)
    } finally {
      if (previousCooldown === undefined) delete process.env.GO_KEYS_COOLDOWN_MS
      else process.env.GO_KEYS_COOLDOWN_MS = previousCooldown
      if (previousMax === undefined) delete process.env.GO_KEYS_MAX_COOLDOWN_MS
      else process.env.GO_KEYS_MAX_COOLDOWN_MS = previousMax
    }
  })
})

test("second setup for the same keys file registers no hooks", async () => {
  await withTempKeysFileEnv('{"providers":{"opencode-go":{"keys":["a","b"]}}}', async () => {
    const setup = (plugin as unknown as { setup(c: unknown): Promise<(() => Promise<void>) | undefined> }).setup
    const first = mockCtx()
    const cleanup = await setup(first)
    assert.deepEqual(first.registered, ["http.request", "http.response", "retry"])
    const second = mockCtx()
    const idle = await setup(second)
    assert.deepEqual(second.registered, [])
    assert.equal(typeof idle, "function")
    await idle?.()
    await cleanup?.()
    const third = mockCtx()
    const retake = await setup(third)
    assert.deepEqual(third.registered, ["http.request", "http.response", "retry"])
    await retake?.()
  })
})

test("addKey creates the file when missing, appends, and dedupes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go-keys-test-"))
  try {
    const file = path.join(dir, "fresh", "go-keys.json")
    const first = addKey(file, "key-one")
    assert.deepEqual(first, { index: 0, count: 1, duplicate: false })
    const second = addKey(file, "key-two")
    assert.deepEqual(second, { index: 1, count: 2, duplicate: false })
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { providers: { "opencode-go": { keys: string[] } } }
    assert.deepEqual(stored.providers["opencode-go"].keys, ["key-one", "key-two"])
    const dup = addKey(file, "key-one")
    assert.deepEqual(dup, { index: 0, count: 2, duplicate: true })
    assert.throws(() => addKey(file, ""), ConfigError)
    assert.throws(() => addKey(file, "two tokens"), ConfigError)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("addKey preserves other providers and header overrides, rejects malformed files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go-keys-test-"))
  try {
    const file = path.join(dir, "go-keys.json")
    fs.writeFileSync(
      file,
      JSON.stringify({ providers: { other: { keys: ["x"] }, "opencode-go": { keys: ["a"], headers: { authorization: "Bearer" } } } }),
    )
    const result = addKey(file, "b")
    assert.deepEqual(result, { index: 1, count: 2, duplicate: false })
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      providers: { other: { keys: string[] }; "opencode-go": { keys: string[]; headers: Record<string, string> } }
    }
    assert.deepEqual(stored.providers.other.keys, ["x"])
    assert.deepEqual(stored.providers["opencode-go"].headers, { authorization: "Bearer" })
    fs.writeFileSync(file, "{not json")
    assert.throws(() => addKey(file, "c"), ConfigError)
    assert.equal(fs.readFileSync(file, "utf8"), "{not json")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("testKey reports connected / rejected / unreachable without leaking the key", async () => {
  const usageBody = JSON.stringify({
    usage: { rolling: { status: "ok", percent: 46, resetsAt: "2026-10-11T20:56:01.000Z" } },
  })
  const ok = await testKey("secret-k", (async () => new Response(usageBody, { status: 200 })) as typeof fetch)
  assert.equal(ok.ok, true)
  assert.equal(ok.limited, false)
  assert.equal(ok.detail, "connected")
  assert.equal(ok.usage.rolling?.percent, 46)
  const denied = await testKey("secret-k", (async () => new Response("{}", { status: 401 })) as typeof fetch)
  assert.deepEqual(denied, { ok: false, limited: false, detail: "rejected — not a valid key", usage: {} })
  const down = await testKey("secret-k", (async () => {
    throw new Error("boom")
  }) as typeof fetch)
  assert.equal(down.detail, "unreachable (boom)")
  for (const result of [ok, denied, down]) assert.ok(!result.detail.includes("secret-k"))
})

test("testKey marks exhausted windows as limited", async () => {
  const limitedBody = JSON.stringify({
    usage: { rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-10-11T20:56:01.000Z" } },
  })
  const limited = await testKey("secret-k", (async () => new Response(limitedBody, { status: 200 })) as typeof fetch)
  assert.equal(limited.ok, true)
  assert.equal(limited.limited, true)
  assert.ok(!limited.detail.includes("secret-k"))
  const withRetry = await testKey(
    "secret-k",
    (async () => new Response("{}", { status: 429, headers: { "retry-after": "7200" } })) as typeof fetch,
  )
  assert.equal(withRetry.limited, true)
  assert.equal(withRetry.detail, "valid key — usage exhausted, resets in ~2h")
  const bare = await testKey("secret-k", (async () => new Response("{}", { status: 429 })) as typeof fetch)
  assert.equal(bare.detail, "valid key — usage exhausted, resets when its window clears")
})

test("maskKey shows only the last four characters", () => {
  assert.equal(maskKey("abcdefgh"), "…efgh")
})

test("parseSlashArgs routes view/add/test/del", async () => {
  assert.deepEqual(parseSlashArgs(undefined), { action: "view" })
  assert.deepEqual(parseSlashArgs(""), { action: "view" })
  assert.deepEqual(parseSlashArgs("/go-keys"), { action: "view" })
  assert.deepEqual(parseSlashArgs("/go-keys add abc"), { action: "add", key: "abc" })
  assert.deepEqual(parseSlashArgs("add abc"), { action: "add", key: "abc" })
  assert.deepEqual(parseSlashArgs("/go-keys test"), { action: "test", index: undefined })
  assert.deepEqual(parseSlashArgs("/go-keys test 1"), { action: "test", index: 1 })
  assert.deepEqual(parseSlashArgs("/go-keys del 0"), { action: "del", index: 0 })
  assert.deepEqual(parseSlashArgs("/go-keys frobnicate"), { action: "view" })
})

test("removeKey deletes by index and keeps the rest", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go-keys-test-"))
  try {
    const file = path.join(dir, "go-keys.json")
    fs.writeFileSync(
      file,
      JSON.stringify({ providers: { other: { keys: ["x"] }, "opencode-go": { keys: ["a", "b", "c"] } } }),
    )
    assert.deepEqual(removeKey(file, 1), { index: 1, count: 2 })
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      providers: { other: { keys: string[] }; "opencode-go": { keys: string[] } }
    }
    assert.deepEqual(stored.providers["opencode-go"].keys, ["a", "c"])
    assert.deepEqual(stored.providers.other.keys, ["x"])
    assert.throws(() => removeKey(file, 7), ConfigError)
    assert.throws(() => removeKey(file, -1), ConfigError)
    assert.equal(fs.readFileSync(file, "utf8").includes("a"), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("removeKey on missing or malformed files throws without writing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go-keys-test-"))
  try {
    assert.throws(() => removeKey(path.join(dir, "go-keys.json"), 0), ConfigError)
    assert.ok(!fs.existsSync(path.join(dir, "go-keys.json")))
    const file = path.join(dir, "bad.json")
    fs.writeFileSync(file, "{broken")
    assert.throws(() => removeKey(file, 0), ConfigError)
    assert.equal(fs.readFileSync(file, "utf8"), "{broken")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

