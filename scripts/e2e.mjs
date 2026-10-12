// Mock-provider e2e for go-keys against a real OpenCode CLI.
//
// Spins up a local OpenAI/Anthropic-compatible server, points a throwaway
// OPENCODE_CONFIG_DIR at it (provider opencode-go baseURL + a go-keys.json
// with fake keys), and runs `opencode run --standalone` from this repo (the
// plugin auto-loads from .opencode/plugins/go-keys/). Assertions read the
// mock's request log and the rotation lines appended to
// ~/.local/share/opencode/log/go-keys.log.
//
// Requires `npm run build` first. Default model targets the /chat/completions
// family; /messages and /responses are mocked too so any model works.

import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const REPO = fileURLToPath(new URL("..", import.meta.url))
const MODEL = process.env.E2E_MODEL ?? "opencode-go/deepseek-v4-flash"
const PROMPT = "Reply with exactly MOCK-OK and nothing else."
const TIMEOUT_MS = 180_000
const LOG_FILE = path.join(os.homedir(), ".local", "share", "opencode", "log", "go-keys.log")

const EXE =
  process.platform === "win32" && fs.existsSync(path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"))
    ? path.join(process.env.APPDATA, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe")
    : "opencode"

const failures = []
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(name)
}

function makeMock(behaviors) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const auth = req.headers["authorization"] ?? ""
      const apiKey = req.headers["x-api-key"] ?? ""
      const key = (apiKey || auth.split(" ").pop() || "none").replace(/^.*e2e-key-/, "")
      const behavior = behaviors[key] ?? { status: 429 }
      requests.push({ method: req.method, path: req.url, key, status: behavior.status })
      if (req.method !== "POST" || behavior.status === 200) {
        respond(req, res)
      } else {
        res.writeHead(behavior.status, {
          "content-type": "application/json",
          ...(behavior.retryAfter ? { "retry-after": behavior.retryAfter } : {}),
        })
        res.end(
          JSON.stringify({
            error: { message: `e2e limit for ${key}`, type: "rate_limit_error", code: "rate_limit_exceeded" },
          }),
        )
      }
    })
  })
  return { server, requests }
}

function respond(req, res) {
  const url = req.url ?? ""
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [] }))
    return
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  if (url.includes("/messages")) {
    for (const [event, data] of [
      ["message_start", { type: "message_start", message: { id: "e2e", type: "message", role: "assistant", model: MODEL, content: [], usage: { input_tokens: 1, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "MOCK-OK" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }],
      ["message_stop", { type: "message_stop" }],
    ]) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
  } else if (url.includes("/responses")) {
    for (const data of [
      { type: "response.output_text.delta", delta: "MOCK-OK" },
      { type: "response.completed", response: { id: "e2e", status: "completed", output: [] } },
    ]) {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
  } else {
    for (const data of [
      { id: "e2e", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "MOCK-OK" }, finish_reason: null }] },
      { id: "e2e", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    res.write("data: [DONE]\n\n")
  }
  res.end()
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))

function runOpencode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`opencode run timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    child.on("error", (e) => { clearTimeout(timer); reject(e) })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, output: stdout + stderr })
    })
  })
}

const readLog = () => {
  try {
    return fs.readFileSync(LOG_FILE, "utf8")
  } catch {
    return ""
  }
}
const rotationLines = (text) => text.split("\n").filter((l) => l.includes("[go-keys]") && l.includes("-> #"))

function makeTempConfig(baseURL, keys) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go-keys-e2e-"))
  fs.writeFileSync(
    path.join(dir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: { "opencode-go": { options: { baseURL, apiKey: "e2e-native-placeholder" } } },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(dir, "go-keys.json"), JSON.stringify({ providers: { "opencode-go": { keys } } }))
  return dir
}

async function scenario(name, behaviors, keys, prompt = PROMPT) {
  const mock = makeMock(behaviors)
  const port = await listen(mock.server)
  const dir = makeTempConfig(`http://127.0.0.1:${port}`, keys)
  const logBefore = readLog()
  let result
  try {
    // --standalone: private server per run (no pollution of the shared
    // background service or real quota). cwd stays this repo, so the plugin
    // loads from the home-dir shim up the ancestor chain.
    result = await runOpencode(["run", "--standalone", "-m", MODEL, prompt], { OPENCODE_CONFIG_DIR: dir })
  } finally {
    mock.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const newLog = readLog().slice(logBefore.length)
  console.log(`\n=== ${name} ===`)
  for (const r of mock.requests) console.log(`  mock ${r.method} ${r.path} key=${r.key} -> ${r.status}`)
  console.log(`  exit=${result.code}, rotations=${rotationLines(newLog).length}`)
  for (const line of newLog.split("\n").filter((l) => l.includes("[go-keys]"))) console.log(`  ${line.trim()}`)
  return { ...result, requests: mock.requests, newLog }
}

// Scenario 1: key A 429 (with Retry-After), key B 200 -> one prompt completes, exactly one
// rotation, and every later request in the same server process starts on B (A parked).
const s1 = await scenario(
  "failover: 429 with Retry-After -> 200",
  { alpha: { status: 429, retryAfter: "120" }, beta: { status: 200 } },
  ["e2e-key-alpha", "e2e-key-beta"],
)
check("failover: prompt completes on key B", s1.output.includes("MOCK-OK"))
check("failover: first request used key A", s1.requests[0]?.key === "alpha")
// The concurrent /responses request may share key A, so assert from the first
// key-B request onward: key A stays parked for the rest of the process.
const firstBeta1 = s1.requests.findIndex((r) => r.key === "beta")
check(
  "failover: from key B onward every request used key B (A parked, sticky B)",
  firstBeta1 >= 0 && s1.requests.slice(firstBeta1).every((r) => r.key === "beta"),
)
check("failover: every successful request used key B", s1.requests.filter((r) => r.status === 200).every((r) => r.key === "beta"))
check("failover: exactly one rotation logged", rotationLines(s1.newLog).length === 1, `got ${rotationLines(s1.newLog).length}`)
check("failover: rotation line cites status and park duration", /status 429.*parked 2m/.test(s1.newLog))

// Scenario 2: same failover without Retry-After -> default cooldown parking applies.
const s2 = await scenario(
  "failover: 429 without Retry-After -> 200",
  { alpha: { status: 429 }, beta: { status: 200 } },
  ["e2e-key-alpha", "e2e-key-beta"],
)
check("no Retry-After: prompt completes on key B", s2.output.includes("MOCK-OK"))
check("no Retry-After: first request used key A", s2.requests[0]?.key === "alpha")
const firstBeta2 = s2.requests.findIndex((r) => r.key === "beta")
check(
  "no Retry-After: from key B onward every request used key B (default cooldown park)",
  firstBeta2 >= 0 && s2.requests.slice(firstBeta2).every((r) => r.key === "beta"),
)
check("no Retry-After: exactly one rotation logged", rotationLines(s2.newLog).length === 1)
check("no Retry-After: parked for the default cooldown", /parked 30m/.test(s2.newLog))

// Scenario 3: all keys 429 without Retry-After -> error surfaced, requests bounded, no loop.
const s3 = await scenario(
  "all keys parked: error surfaces",
  { gamma: { status: 429 }, delta: { status: 429 } },
  ["e2e-key-gamma", "e2e-key-delta"],
)
check("all parked: request count bounded (no infinite loop)", s3.requests.length > 0 && s3.requests.length <= 24, `${s3.requests.length} requests`)
check("all parked: no reply", !s3.output.includes("MOCK-OK"))
check("all parked: both keys tried", new Set(s3.requests.map((r) => r.key)).size === 2)
check("all parked: rotation attempted and logged", rotationLines(s3.newLog).length >= 1, `got ${rotationLines(s3.newLog).length}`)

// Redaction: no test key value anywhere in OpenCode's output or the plugin's own log lines.
for (const [name, s] of [["s1", s1], ["s2", s2], ["s3", s3]]) {
  check(`redaction: ${name} output leaks no key values`, !/e2e-key-(alpha|beta|gamma|delta)/.test(s.output))
  check(`redaction: ${name} log lines leak no key values`, !/e2e-key-(alpha|beta|gamma|delta)/.test(s.newLog))
}

console.log("")
if (failures.length > 0) {
  console.error(`E2E FAILED: ${failures.join(", ")}`)
  process.exit(1)
}
console.log("E2E PASSED")
