// Real usage data from Go's /usage endpoint — the same numbers the console
// shows. Bars are genuine quota usage per window (rolling = 5 hours).

/** "30m" / "2h" / "45s" back to ms; undefined when unparseable. */
export function parseDurationToken(token: string): number | undefined {
  const match = /^(\d+)([smh])$/.exec(token.trim())
  if (!match) return undefined
  const value = Number(match[1])
  const unit = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1_000
  return value * unit
}

/** "3h ago" style relative time. */
export function timeAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Horizontal usage bar: "[██████░░░░] 63%" (block chars) or "[||||||----] 63%" (ascii). */
export function renderBar(percent: number, width = 20, fill = "█", empty = "░", showPercent = true): string {
  const clamped = Math.min(100, Math.max(0, percent))
  const filled = Math.round((clamped / 100) * width)
  const bar = `[${fill.repeat(filled)}${empty.repeat(width - filled)}]`
  return showPercent ? `${bar} ${Math.round(clamped)}%` : bar
}

export interface UsageWindow {
  readonly percent: number
  readonly resetsAt: number
  readonly status: string
}

export interface UsageInfo {
  readonly rolling?: UsageWindow
  readonly weekly?: UsageWindow
  readonly monthly?: UsageWindow
}

/** Parse the /usage response; unknown or missing windows are dropped. */
export function parseUsage(raw: unknown): UsageInfo {
  const usage = (raw as { usage?: unknown } | null)?.usage
  if (typeof usage !== "object" || usage === null) return {}
  const out: Record<string, UsageWindow> = {}
  for (const name of ["rolling", "weekly", "monthly"] as const) {
    const w = (usage as Record<string, unknown>)[name] as { percent?: unknown; resetsAt?: unknown; status?: unknown } | undefined
    if (!w) continue
    const percent = typeof w.percent === "number" ? w.percent : undefined
    const resetsAt = typeof w.resetsAt === "string" ? Date.parse(w.resetsAt) : NaN
    const status = typeof w.status === "string" ? w.status : "ok"
    if (percent === undefined || Number.isNaN(resetsAt)) continue
    out[name] = { percent, resetsAt, status }
  }
  return out
}

/** A window is limited when Go says so or the bar is full. */
export function windowLimited(w: UsageWindow): boolean {
  return w.status !== "ok" || w.percent >= 100
}
