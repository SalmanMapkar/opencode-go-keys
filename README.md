# opencode-go-keys

Sticky key-rotation balancer for the **opencode-go** provider in OpenCode V2,
with a built-in usage dashboard: real per-window quota percentages (the same
numbers the OpenCode console shows), automatic failover when a key hits a Go
usage limit, and key management — all in one `/go-keys` command.

Not affiliated with OpenCode. Holds N OpenCode Go API keys (one per
subscription), uses one sticky key at a time, and automatically fails over to
another key when the current one hits a Go usage limit, so sessions keep
working without manual account switching.

No proxy daemon, no dashboard server, no OAuth. A server plugin (three hooks,
a keys file, in-memory state) plus a TUI view (list, add, test, usage).

## The manager: /go-keys

In any OpenCode session, run `/go-keys` (or pick **Open Go Keys manager**
from the command palette) to open the key list: one row per key, each with
its window status. Select a key to open the centered usage view — its title
shows the key (`key #0 …x9yB`).

- **Key list** - every key as `#index` plus a last-4 suffix (full values are
  never displayed), its 5h/rolling usage bar with weekly and monthly
  percentages inline, and its live verdict. All keys are fetched in parallel
  when the list opens. `ctrl+a` add, `ctrl+t` refresh (forced refetch),
  `ctrl+d` delete selected.
- **Usage view** (Enter on a key) - the same usage numbers as the OpenCode
  console, per window: horizontal bars for the rolling 5-hour, weekly, and
  monthly limits with real percentages and reset countdowns
  (`5h [██████░░] 46% · resets in ~3h 10m`), plus the live connection state.
  Usage is fetched once per `/go-keys` invocation and cached — opening keys,
  ESC back, and reopening never refetch; a new `/go-keys` run fetches fresh.
  `ctrl+t` forces a refetch mid-session.

Data source: `GET https://opencode.ai/zen/go/v1/usage` with the key — the
same endpoint that powers the console website. It is a plain GET, so checks
spend no model tokens.
- **Slash arguments** act directly: `/go-keys add <key>` (repeat per
  subscription; duplicates are ignored), `/go-keys test [n]`,
  `/go-keys del <n>` (with confirmation). Every action ends back at the list.
  Test verdicts: connected, limited (valid key, quota exhausted - with the
  reset estimate when Go provides one), rejected (bad key), or unreachable.

After adding or deleting keys, restart the service once so rotation picks up
the new pool:

```bash
opencode service restart
```

## Does it rotate between keys automatically?

Yes for failover, no for cycling. One sticky key serves every request until
it hits a Go usage limit; only then does the retried request automatically go
out on the next healthy key, inside the same session, while the spent key is
parked (30 min default, or the response's `Retry-After`). There is no
round-robin: per-request cycling would look like abuse to Go's monitors and
destroy prompt-cache locality. What you will see in `go-keys.log` when a
window exhausts:

```
opencode-go: key #0 -> #1 (status 429), key #0 parked 30m
```

from then on key #1 serves everything until it limits or #0's park expires.

## How rotation works

- **Sticky key**: every request uses the active key until it fails.
- **Failover**: on a Go usage-limit response (429, 500/502/503/504/529) the
  failed key is parked and the retried request goes out on the next healthy
  key — inside the same session. Auth errors (400/401/403/404) never rotate:
  a bad key stays bad.
- **Parking**: the failed key is benched for the response's `Retry-After`
  (delta-seconds or HTTP-date; the `x-codex-*-reset-*` headers are also
  honored), capped at `maxCooldownMs` — otherwise for `cooldownMs` (30 min
  default; Go windows are hours long). Parking is how long the key stays
  benched; the retried request goes out after ~500 ms.
- **All keys parked**: OpenCode's own retry/error handling surfaces the limit
  error. No infinite loops (OpenCode's built-in attempt cap is a hard limit).
- **Fail safe**: any config problem logs one `[go-keys]` warning and disables
  rotation — OpenCode itself never breaks. Cooldowns reset on server restart.
- **Only opencode-go**: hooks are registered scoped to that one provider; no
  other provider's traffic is touched. The plugin replaces only the auth
  headers (`authorization: Bearer <key>` plus `x-api-key: <key>`, because the
  Go upstream serves both the OpenAI-style and Anthropic-style endpoint
  families); `x-opencode-session` and every other header pass through
  untouched.
- **One rotating instance**: if two copies load for one keys file, the second
  logs a line and stays idle.

## Requirements

- OpenCode v2.0.26+ with the `opencode-go` provider connected once natively
  (`/connect` → OpenCode Go) so its models are selectable.
- **Two or more Go subscriptions**, each its own single-member workspace, each
  API key obtained from its own console. With one subscription rotation is a
  no-op — use the native "Use balance" pay-as-you-go fallback and the free
  models instead.

## Install

### From npm

```bash
opencode plugin add opencode-go-keys
opencode service restart
```

The package ships the server plugin entry the loader discovers inside
installed packages and a `./tui` export, so the `/go-keys` view loads too.

### From a local checkout

```bash
git clone https://github.com/<you>/opencode-go-keys && cd opencode-go-keys
npm install && npm run build   # dist/ must exist before OpenCode loads it
```

OpenCode loads server plugins from `.opencode/plugins/` location directories
and each server plugin's `./tui` entry into the TUI automatically — no
`tui.json` change needed. For global use, point a shim at this repo's built
output (the local directory name doubles as the plugin id — keep it `go-keys`
so the command and shim stay in sync):

- `~/.opencode/plugins/go-keys/package.json`:
  ```json
  {
    "name": "opencode-go-keys",
    "version": "1.0.0",
    "type": "module",
    "main": "index.js",
    "exports": { ".": "./index.js", "./tui": "./tui.js" }
  }
  ```
- `~/.opencode/plugins/go-keys/index.js`:
  ```js
  export { default } from "file:///C:/Users/Salman%20Mapkar/go-keys/dist/index.js"
  ```
- `~/.opencode/plugins/go-keys/tui.js`:
  ```js
  export { default } from "file:///C:/Users/Salman%20Mapkar/go-keys/dist/tui.js"
  ```

(URL-encode spaces as `%20`.) Restart the OpenCode service
(`opencode service restart`) after installing.

Version note: on OpenCode 2.0.26, `plugin`/`plugins` config entries cannot
load a local path — object-form entries are rejected as malformed and
`file://`/plain paths are silently ignored (`opencode plugin add` only
accepts npm/git specifiers). If a later OpenCode version loads the object
form, `cooldownMs`/`maxCooldownMs` are read from `ctx.options` there too.

### Rotation timings

Defaults: `cooldownMs` 1800000 (30 min park with no usable Retry-After),
`maxCooldownMs` 21600000 (6 h cap for Retry-After-driven parks). Override with
the environment (plugin options are unavailable through location auto-load):

```bash
GO_KEYS_COOLDOWN_MS=3600000 GO_KEYS_MAX_COOLDOWN_MS=21600000
```

## Keys file

`$OPENCODE_CONFIG_DIR/go-keys.json`, else `~/.config/opencode/go-keys.json`
(Windows: `%USERPROFILE%\.config\opencode\go-keys.json`). Plain UTF-8, no
BOM. Normally written via the manager view, but the schema is:

```json
{
  "providers": {
    "opencode-go": {
      "keys": ["go-key-from-subscription-1", "go-key-from-subscription-2"]
    }
  }
}
```

Optional per-provider header override (default injects both headers):

```json
{
  "providers": {
    "opencode-go": {
      "keys": ["key-1", "key-2"],
      "headers": { "authorization": "Bearer" }
    }
  }
}
```

`""` as the scheme sends the raw key. One key in the file → the plugin
registers no hooks at all (pure no-op).

## Security

- Key values are never logged, never included in error messages, never pasted
  into toasts or dialogs, and never sent anywhere except the auth headers of
  the model requests OpenCode already makes (plus the explicit connection
  check you trigger yourself). The manager shows only indexes and last-4
  suffixes.
- `go-keys.json` contains plaintext API keys. **Do not commit it.** Restrict
  it to your user: on macOS/Linux `chmod 600`, on Windows make sure the file
  is not in any synced/shared folder.

## Troubleshooting

OpenCode swallows plugin `console.log` output, so every `[go-keys]` line is
also appended to `~/.local/share/opencode/log/go-keys.log` — grep that file:

- startup: `opencode-go: 3 keys, sticky rotation active` (or a one-line reason
  rotation is disabled).
- per rotation: `opencode-go: key #0 -> #1 (status 429), key #0 parked 30m`.

If `/go-keys` does nothing or the TUI reports the plugin failed, open
`/plugins` for the error, check the shim files and that `dist/` was built
(`dist/tui.js` must exist for the view), then `opencode service restart`. If
rotation stays off with keys stored, the file must be valid JSON, UTF-8
without BOM.

## Development

```bash
npm test        # unit tests: selector, Retry-After parsing, trigger statuses,
                # one-key no-op, env options, duplicate-instance guard, keys-file
                # add/remove flow, connection-test outcomes, masking, slash args,
                # usage-log parsing
npm run build
npm run e2e     # spins a local mock Go endpoint + throwaway OPENCODE_CONFIG_DIR and runs
                # failover / stickiness / all-parked / redaction scenarios via `opencode run`
```

The e2e runs from this repo root and asserts against the mock's request log
plus the rotation lines in `go-keys.log`. It uses fake `e2e-key-*` keys
against a local mock and never touches the real Go upstream. Override the
model with `E2E_MODEL=opencode-go/<model>`.

`src/tui.ts` is the slash entry (view + slash-arg actions); `src/panel/view.tsx`
is the modal (Solid JSX, built with the same babel transform @opentui/solid
uses); both are verified by driving the real TUI headlessly rather than by
unit tests. `src/index.ts`
is hooks + setup; `src/rotation.ts` the pure state/selector; `src/config.ts`
the keys file, masking, and the connection test; `src/auth.ts` header
injection.

### Design notes

- Sticky-only, no round-robin: Go monitors for abuse, and request-level key
  cycling destroys prompt-cache locality. Keys rotate only on limit failures.
- No per-model limit tracking: Go limits are per model per window; the plugin
  rotates keys, not models. Rotating onto a key that is also limited for that
  model is allowed to fail normally.
- Key removal is index-based (`/go-keys del <n>`, with confirmation);
  deleting a key shifts later indexes, so restart the service right after to
  keep the active pool aligned with the file.- The connection check uses a 1-token chat completion because the models
  catalog endpoint answers without authentication and cannot validate a key.
  A `rejected` result means the key is bad; `limited` means the key is valid
  but its window is currently exhausted (with Go's reset estimate, e.g.
  "resets in ~2h") - exactly the case rotation handles by parking that key
  and failing over.
- Compliance: each key is assumed to be a legitimately purchased single-member
  Go subscription. The usage pattern stays indistinguishable from normal
  single-key use — one sticky key per request, failover only on limit errors,
  no parallel multi-key fan-out.
- Registering the HTTP hooks keeps the provider on HTTP transport; opencode-go
  does not use WebSocket on any model path.

## License

MIT
