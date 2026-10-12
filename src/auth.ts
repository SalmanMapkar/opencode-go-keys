// Auth header injection. The Go upstream serves both protocol families, so the
// default sets Bearer for /chat/completions + /responses and x-api-key for
// /messages; endpoints ignore the header they do not use. Only these headers
// are touched — x-opencode-session and everything else passes through.

export const DEFAULT_HEADERS: Record<string, string> = {
  authorization: "Bearer",
  "x-api-key": "",
}

/** `spec` maps header name -> scheme ("" sends the raw key). */
export function applyAuth(headers: Headers, key: string, spec: Record<string, string> = DEFAULT_HEADERS): void {
  for (const [name, scheme] of Object.entries(spec)) {
    headers.set(name, scheme ? `${scheme} ${key}` : key)
  }
}

/**
 * Retry-After hint off a response: the standard header first, then the
 * x-codex-*-reset-after-seconds / x-codex-*-reset-at headers the Go upstream
 * sends on limit responses.
 */
export function readRetryAfter(headers: Headers): string | null {
  const retryAfter = headers.get("retry-after")
  if (retryAfter !== null) return retryAfter
  let seconds: string | null = null
  let resetAt: string | null = null
  for (const [name, value] of headers) {
    if (seconds === null && name.endsWith("reset-after-seconds")) seconds = value
    else if (resetAt === null && name.endsWith("reset-at")) resetAt = value
  }
  return seconds ?? resetAt
}
