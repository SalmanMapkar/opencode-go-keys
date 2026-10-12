// Pure rotation state and selectors. Knows nothing about keys, HTTP, or time sources.

export interface RotationState {
  readonly count: number
  activeIndex: number
  /** key index -> parked-until epoch ms */
  readonly cooldowns: Map<number, number>
}

export function createState(count: number): RotationState {
  return { count, activeIndex: 0, cooldowns: new Map() }
}

export function isHealthy(state: RotationState, index: number, now: number): boolean {
  const until = state.cooldowns.get(index)
  return until === undefined || until <= now
}

export function isParked(state: RotationState, index: number): boolean {
  return state.cooldowns.has(index)
}

/** Next healthy key strictly after `from`, wrapping around; undefined when all are parked. */
export function nextHealthy(state: RotationState, from: number, now: number): number | undefined {
  for (let step = 1; step <= state.count; step++) {
    const index = (from + step) % state.count
    if (isHealthy(state, index, now)) return index
  }
  return undefined
}

/** Sticky selection: active key if healthy, else next healthy with wraparound, else earliest-expiry key. */
export function select(state: RotationState, now: number): number {
  if (isHealthy(state, state.activeIndex, now)) return state.activeIndex
  const next = nextHealthy(state, state.activeIndex, now)
  if (next !== undefined) return next
  let earliest = 0
  for (let index = 1; index < state.count; index++) {
    if ((state.cooldowns.get(index) ?? 0) < (state.cooldowns.get(earliest) ?? 0)) earliest = index
  }
  return earliest
}

export function park(state: RotationState, index: number, until: number): void {
  state.cooldowns.set(index, until)
}

/** Rotate on Go usage-limit and gateway failures; never on auth/request errors (a bad key stays bad). */
export const TRIGGER_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529])

export function isTriggerStatus(status: number | undefined): boolean {
  return status !== undefined && TRIGGER_STATUSES.has(status)
}

export interface ParkOptions {
  now: number
  /** parking time when the response carries no usable Retry-After */
  defaultMs: number
  /** cap for Retry-After-driven values */
  maxMs: number
}

/**
 * Retry-After per RFC 7231: delta-seconds or HTTP-date. Absent or garbage -> defaultMs.
 * Header-driven values are capped at maxMs; a date in the past parks for 0 ms.
 */
export function parseParkMs(raw: string | null | undefined, options: ParkOptions): number {
  if (raw === null || raw === undefined) return options.defaultMs
  const trimmed = raw.trim()
  if (trimmed === "") return options.defaultMs
  if (/^\d+$/.test(trimmed)) return clamp(Number(trimmed) * 1000, options.maxMs)
  const date = Date.parse(trimmed)
  if (!Number.isNaN(date)) return clamp(date - options.now, options.maxMs)
  return options.defaultMs
}

function clamp(ms: number, maxMs: number): number {
  return Math.min(Math.max(ms, 0), maxMs)
}
