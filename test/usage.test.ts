import assert from "node:assert/strict"
import test from "node:test"

import { parseDurationToken, parseUsage, renderBar, timeAgo, windowLimited } from "../src/panel/usage.js"

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0)
const HOUR = 3_600_000

test("parseDurationToken handles m/h/s and rejects garbage", () => {
  assert.equal(parseDurationToken("30m"), 1_800_000)
  assert.equal(parseDurationToken("2h"), 2 * HOUR)
  assert.equal(parseDurationToken("45s"), 45_000)
  assert.equal(parseDurationToken("soon"), undefined)
})

test("parseUsage reads rolling/weekly/monthly windows", () => {
  const parsed = parseUsage({
    usage: {
      rolling: { status: "ok", percent: 46, resetsAt: "2026-10-11T20:56:01.000Z" },
      weekly: { status: "ok", percent: 12.5, resetsAt: "2026-10-14T00:00:00.000Z" },
      monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-01T00:00:00.000Z" },
    },
  })
  assert.deepEqual(parsed, {
    rolling: { percent: 46, resetsAt: Date.UTC(2026, 9, 11, 20, 56, 1), status: "ok" },
    weekly: { percent: 12.5, resetsAt: Date.UTC(2026, 9, 14), status: "ok" },
    monthly: { percent: 100, resetsAt: Date.UTC(2026, 10, 1), status: "rate-limited" },
  })
})

test("parseUsage tolerates empty, malformed, and partial responses", () => {
  assert.deepEqual(parseUsage(undefined), {})
  assert.deepEqual(parseUsage({}), {})
  assert.deepEqual(parseUsage({ usage: { rolling: { percent: "high", resetsAt: "2026-10-11T20:56:01.000Z" } } }), {})
  const partial = parseUsage({ usage: { rolling: { status: "ok", percent: 3, resetsAt: "2026-10-11T20:56:01.000Z" } } })
  assert.deepEqual(Object.keys(partial), ["rolling"])
})

test("windowLimited: status wins and a full bar is limited", () => {
  assert.equal(windowLimited({ percent: 99, resetsAt: NOW, status: "ok" }), false)
  assert.equal(windowLimited({ percent: 100, resetsAt: NOW, status: "ok" }), true)
  assert.equal(windowLimited({ percent: 40, resetsAt: NOW, status: "rate-limited" }), true)
})

test("renderBar clamps, fills proportionally, and shows the percent", () => {
  assert.equal(renderBar(0, 10), "[░░░░░░░░░░] 0%")
  assert.equal(renderBar(50, 10), "[█████░░░░░] 50%")
  assert.equal(renderBar(200, 10), "[██████████] 100%")
  assert.equal(renderBar(-5, 10), "[░░░░░░░░░░] 0%")
  assert.equal(renderBar(50, 10, "|", "-"), "[|||||-----] 50%")
  assert.equal(renderBar(50, 10, "|", "-", false), "[|||||-----]")
})

test("timeAgo renders just-now, minutes, hours, days", () => {
  assert.equal(timeAgo(NOW - 10_000, NOW), "just now")
  assert.equal(timeAgo(NOW - 12 * 60_000, NOW), "12m ago")
  assert.equal(timeAgo(NOW - 3 * HOUR, NOW), "3h ago")
  assert.equal(timeAgo(NOW - 2 * 86_400_000, NOW), "2d ago")
})
