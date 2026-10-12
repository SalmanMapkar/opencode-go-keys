/** @jsxImportSource @opentui/solid */

import { For, Show, createSignal, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import fs from "node:fs"
import { ConfigError, formatDuration, keysFilePath, loadConfig, maskKey, type KeyTestResult } from "../config.js"
import { renderBar, windowLimited, type UsageInfo } from "./usage.js"

const FILE = keysFilePath()

/** Per-window rows: label, usage window, bar width. */
const WINDOWS = [
  { label: "5h", key: "rolling" },
  { label: "weekly", key: "weekly" },
  { label: "monthly", key: "monthly" },
] as const

export function GoKeysModal(props: { index: number; result: KeyTestResult | undefined }) {
  const theme = usePlugin().theme
  const [key, setKey] = createSignal<string | undefined>()
  const [problem, setProblem] = createSignal<string | undefined>()

  onMount(() => {
    // Usage comes from the caller's cache — fetched once per /go-keys run,
    // never recomputed on open or after ESC.
    try {
      const list = loadConfig({}, FILE).provider.keys
      const current = list[props.index]
      if (current === undefined) setProblem(`key #${props.index} is no longer stored`)
      else setKey(current)
    } catch (error) {
      setProblem(error instanceof ConfigError ? error.message : `failed to load ${FILE}`)
    }
  })

  const result = () => props.result

  const stateColor = () => {
    const r = result()
    if (r === undefined) return theme.text.muted
    if (r.ok && !r.limited) return theme.text.feedback.success.base
    return r.limited ? theme.text.feedback.warning.base : theme.text.feedback.error.base
  }

  const stateWord = () => {
    const r = result()
    if (r === undefined) return "not fetched"
    if (r.ok && !r.limited) return "connected"
    return r.limited ? "limited" : "failed"
  }

  const windows = (): UsageInfo => result()?.usage ?? {}

  const windowRow = (label: string, name: keyof UsageInfo): string => {
    const w = windows()[name]
    if (w === undefined) return `${label.padEnd(7)} no usage data`
    return `${label.padEnd(7)} ${renderBar(w.percent, 14)} · resets in ~${formatDuration(Math.max(0, w.resetsAt - Date.now()))}`
  }

  const barColor = (name: keyof UsageInfo) => {
    const w = windows()[name]
    if (w === undefined) return theme.text.muted
    return windowLimited(w) ? theme.text.feedback.warning.base : theme.text.base
  }

  return (
    <box
      border
      borderColor={theme.border.base}
      flexDirection="column"
      gap={1}
      padding={1}
      title={`go-keys — key #${props.index} ${key() === undefined ? "" : maskKey(key()!)}`}
      width="100%"
    >
      <Show when={problem() !== undefined}>
        <text fg={theme.text.feedback.warning.base} truncate wrapMode="none">
          {problem()}
        </text>
      </Show>
      <Show when={key() !== undefined && problem() === undefined}>
        <box flexDirection="column" gap={0} width="100%">
          <text fg={stateColor()} truncate wrapMode="none">
            #{props.index} {maskKey(key()!)} — {stateWord()}
          </text>
          <For each={WINDOWS}>
            {(entry) => (
              <text fg={barColor(entry.key)} truncate wrapMode="none">
                {windowRow(entry.label, entry.key)}
              </text>
            )}
          </For>
          <Show when={result() !== undefined && (!result()!.ok || result()!.limited)}>
            <text fg={stateColor()} truncate wrapMode="none">
              {result()!.detail}
            </text>
          </Show>
        </box>
      </Show>
      <text fg={theme.text.muted} truncate wrapMode="none">
        esc: back to list
      </text>
    </box>
  )
}
