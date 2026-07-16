# Live expert progress (task / task_batch)

**Date:** 2026-07-06
**Status:** Implemented

## Problem

Subagent ("expert") results only appeared when the whole `task` / `task_batch`
tool call returned. During a long batch the UI sat on "spawning experts…" with
no sign of life — indistinguishable from a freeze — and there was no way to see
how many experts were queued, running, finished, or failed.

## Approach

Use pi's existing per-tool progress channel end-to-end; no protocol changes.
Every tool's `execute` receives an `onUpdate(partialResult)` callback (4th
argument, previously ignored as `_onUpdate`). Calling it makes pi emit a
`tool_execution_update` session event with `partialResult`, which `--mode rpc`
streams verbatim; the extension panel already relays every RPC event to the
webview, and `chronos-chat.ts` already applies `partialResult` to the matching
tool item. Verified against the installed pi 0.80.2 (runtime pi, not
`chronos/node_modules`).

Rejected alternatives: a new HTTP push event type (the HTTP channel is
viewer-only, and it would duplicate an existing pipe) and polling from the
extension (no agent-side registry to poll).

## Design

### chronos/tools/expert-turn.ts

`ExpertTurnInput` gains `onProgress?: (p: ExpertProgress) => void`.
`ExpertProgress` = `{ phase: "thinking" | "tool", toolCalls, lastTool?,
taskId?, toolUses }`. Emitted at the top of each completion round-trip and
after every expert tool call. Best-effort: listener errors are swallowed so a
UI bug can never fail an expert's actual work.

### chronos/tools/task-batch.ts

A live registry `Map<pageId, LiveExpertEntry>` seeds every page as `"queued"`;
workers flip entries to `"running"` (with an `activity` line derived from
`onProgress`, e.g. `view_region · 3 tool calls`) and finally to the real
`"ok"`/`"error"` entry. Snapshots stream through `onUpdate` with the same
`details` shape the batch card already reads (`model/prompt/bbox/source/
experts`) plus `progress: { total, queued, running, done, failed }` and a
human-readable `content` line.

Emissions are coalesced to one per 150 ms (`PROGRESS_EMIT_MS`, trailing
timer) — a 250-expert batch changes state every few ms and the UI only needs a
trickle. The trailing timer is cancelled before the tool returns so no update
can land after `tool_execution_end` and overwrite the final result (pi 0.80
also guards this side with `acceptingUpdates`). Entries are shallow-copied per
emission so later mutation can't race serialization. The final return value is
unchanged; `activity` never appears in it.

### chronos/tools/view-page.ts (single `task`)

Wires `onProgress` straight to `onUpdate` (no throttle — one expert is low
frequency): partial `details` carry `{ taskId, toolUses, live: { phase,
toolCalls, lastTool } }`, so the card shows what the expert is doing and the
transcript drawer's "examined" chips grow live.

### Webview (chronos-vscode/webview/)

- `BatchExpertEntry.status` widens to `"queued" | "running" | "ok" | "error"`
  (the first two only ever appear in live partials) plus `activity?`.
- The batch card renders the chip grid while running: header shows a spinner
  plus `N running` / `M queued` count pills next to the existing `✓ ok` /
  `✗ err` pills; the "spawning experts…" placeholder only covers the moment
  before the first progress event.
- Chips: queued = dimmed, running = full-opacity with pulsing dot and the live
  activity line (ellipsized, full text in the tooltip), finished = clickable
  transcript button as before. Only finished chips with a `taskId` are
  clickable.
- The single expert card's status line shows the live phase
  (`thinking · 4 tool calls`, `view_region · 5 tool calls`) instead of a bare
  "consulting…".

## Testing

`tsc` builds of both packages plus both extension tsconfigs. Behavioral test
(scratchpad script driving the built `createTaskBatchTool` with a stub
collection/registry and slow-failing auth): asserts the initial all-queued
snapshot, observed `running` states, `queued+running+done+failed == total` on
every emission, no `activity` leakage into the final result, and no emission
after `execute()` resolves. Manual smoke: run a real batch in the dev host and
watch chips progress.
