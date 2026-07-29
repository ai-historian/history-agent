# Design: `save_output` — expert-authored output files

**Issue:** #14 — *output_file should let the expert edit that file directly, not pipe its raw text*
**Date:** 2026-07-02
**Branch:** feat/archive-support

## Problem

When `output_file` is passed to `task` or `task_batch`, we capture the expert's
**entire final assistant text** (`result.text`) and write it verbatim into a file
in the source's `data/` dir (`task-batch.ts:140-143`, `view-page.ts:139-148`).

This "pipe the model's stdout into a file" approach is a poor fit for structured
output (JSON):

- Prose, preamble/closing remarks, or ` ```json ` fences routinely leak into the
  file and make it invalid JSON.
- The expert can't iterate on or self-correct the file — it emits one blob and we
  write whatever came out.
- We over-constrain the prompt to beg for "only JSON, no fences", which is brittle.

## Approved decisions

1. **Trigger model — implicit, path-less tool.** When `output_file` is set the
   expert is handed a dedicated tool that takes only `content` (no path). It can
   only ever touch the one declared output file, so it is auditable by
   construction and needs **no `grant` prompt**.
2. **Strict, no raw-text fallback.** The file is written *only* by a successful
   `save_output` call. An expert that never calls it produces **no file** and is
   flagged. The existing raw-text `writeFileSync` paths are removed.

## Design

### 1. New expert tool: `save_output`

Offered **only when `output_file` is set** for that turn:

```
save_output({ content: string })   // writes to the one pre-resolved output path; no path param
```

- The caller (`task` / `task_batch`) resolves the concrete filename (`{page_id}`
  already substituted) to an absolute path inside the source's `dataDir` and
  passes it into the expert turn. The model never sees or names a path → scoped
  by construction.
- **Last write wins.** The expert may call it repeatedly to revise. Success
  returns `"Saved N chars."` so it knows to stop.
- **JSON self-correction.** If the target ends in `.json`, `JSON.parse` the
  content *before* writing. On failure, **do not write**; return an `isError`
  result (`"content is not valid JSON: <err>; call save_output again with
  corrected content"`) so the expert fixes it inside its own bounded loop. No
  fences/prose ever reach a `.json` file.

### 2. Strict semantics (no raw-text fallback)

- File written only by a successful `save_output`.
- Expert finishes without writing → no file, page flagged.
- The `writeFileSync(result.text ...)` blocks in `task-batch.ts` and
  `view-page.ts` are removed. `runExpertTurn` returns `wroteOutput: boolean`
  (and `outputBytes?`); callers report from that.

### 3. Tool-budget interaction

The loop disables tools after `MAX_EXPERT_TOOL_CALLS` to force a text answer.
When output mode is on and the budget is spent, keep **only** `save_output`
available (drop the exploratory tools) so the expert can always fulfill the
contract. (`MAX_EXPERT_TOOL_CALLS` was raised to 100, so stranding is unlikely,
but this rule stays as a cheap correctness guarantee.)

### 4. Reporting

- **`task_batch`**: `ExpertEntry` gains `wroteOutput`. The header counts a third
  bucket, e.g. `12/13 succeeded, 1 produced no output`. Per-page line:
  `task-7 ⇒ p.42 → entries_0042.json` or
  `p.42: expert produced no output (no file written)`.
- **`task`**: `output_file` + no write → soft-failure message
  (`"expert produced no output; no file written"`), no file.

### 5. Abort semantics

If `save_output` writes and the turn is then aborted, the file persists (the
model deliberately committed it) while the turn returns `ok:false`. Minor
divergence from today's "never write partial text" — acceptable because the write
was intentional, not salvaged stdout. Noted in a comment.

### 6. Prompts

- `page-expert-prompt.md`: document `save_output` (present only when applicable).
- `runExpertTurn` appends a directive to the turn prompt when output mode is on:
  *"You MUST call `save_output` with your final result; your chat reply is for
  reasoning only and is discarded."*
- `task.md` / `task-batch.md`: rewrite the `output_file` description — expert
  writes via `save_output`; drop the brittle "only JSON, no fences" begging.

## Files touched

- `chronos/tools/expert-tools.ts` — new tool + write/JSON-validate logic + budget rule
- `chronos/tools/expert-turn.ts` — thread `outputPath` in, return `wroteOutput`, prompt directive, budget rule
- `chronos/tools/task-batch.ts` — pass path, drop raw write, new reporting
- `chronos/tools/view-page.ts` — pass path, drop raw write, new reporting
- `chronos/prompts/page-expert-prompt.md`, `task.md`, `task-batch.md`

## Out of scope (YAGNI)

- A separate `edit_output` tool — `save_output` overwrites; the expert has its own
  content in context and can re-emit corrected content.
- JSON *schema* validation — we only check that `.json` targets parse.
