# Task subagent: arbitrary image or plain task

**Date:** 2026-07-16
**Status:** Design — awaiting review

## Problem

The `task` / `task_batch` expert subagents are hard-wired to a *source*: `source`
is a required parameter, and the only way to give an expert an image is
`page_id` (a page **within that source**), optionally cropped by `bbox`. There is
no way to:

- Hand an expert an **arbitrary image** (a screenshot, a diagram, a picture that
  isn't a cataloged source page), or
- Run an expert on **just a prompt** without naming a valid `source`.

Text-only turns already work internally (omit `page_id`), but a valid `source`
ref is still mandatory, and the expert's `view_page` / `view_region` /
`save_output` are all scoped to that source's directory.

## Goal

Let the `task` subagent be driven three ways:

1. **Image** — attach an arbitrary image file by path.
2. **Plain task** — a prompt with no source and no image.
3. **Source + page** — today's behavior, unchanged.

And extend `task_batch` to iterate over either page ids (as today) **or** a list
of arbitrary image paths, with `source` optional.

## Approach

Add an explicit `image` parameter (a file path) and make `source` optional,
rather than overloading `page_id` to also accept path strings (messy typing) or
introducing a separate tool (duplicate surface). The expert-tools execution
layer already accepts `sourceDir: string | undefined` and fails
`view_page`/`view_region` gracefully when no source is present, so the change is
concentrated in `runExpertTurn` and the two tool wrappers.

## Design

### `task` (single) — `chronos/tools/view-page.ts`

Parameter changes to `taskParams`:

- `source`: **optional** (was required). Description: required only when using
  `page_id`, or when the expert should have source-scoped `view_page` /
  `view_region`.
- `image`: **new**, optional `string`. Path to an image file to attach.
  Resolved **inside the workspace only** (see Image path resolution). Mutually
  exclusive with `page_id`.
- `page_id`: unchanged, optional — but now **requires `source`**.
- `bbox`: unchanged — requires `page_id`.
- `output_file`: with `source`, resolves in the source's data dir (today's
  behavior). Without `source`, treated as a **workspace-relative** path (kept
  inside the workspace).

Validation (in the tool, returning a clear error and running nothing):

- `image` and `page_id` are mutually exclusive.
- `page_id` (and therefore `bbox`) requires `source`.
- A missing / undecodable `image` file **fails the task** with a clear error.

Three usable modes fall out: image-only, text-only (no source), source+page.

### `task_batch` — `chronos/tools/task-batch.ts`

The batch unit generalizes from "page" to "item":

- `source`: **optional** (was required).
- `page_ids`: **optional** (was required); requires `source`.
- `images`: **new**, optional `string[]`; arbitrary image paths, source optional.
- **Exactly one** of `page_ids` / `images` must be provided. A sourceless,
  imageless batch (N identical experts) is rejected.
- `output_file` template placeholders:
  - page batch: `{page_id}` (today), zero-padded.
  - image batch: `{index}` (1-based, zero-padded) and/or `{name}` (image
    basename without extension); at least one must be present.
  - Output base dir: page batch resolves the template in the source's data dir
    (today). Image batch (no source) resolves the rendered filename as a
    **workspace-relative** path, matching sourceless single-`task` output.

Internal item model: each item carries a stable `key` and a display `label`
(the page id, or the image basename) instead of assuming a numeric `page_id`.
`LiveExpertEntry` / `ExpertEntry` gain `key: string` + `label: string`; the
existing `page_id` field is retained only on page-batch entries so the UI page
chips keep working. Sorting/reporting key off `key`/`label`.

### Shared internals — `chronos/tools/expert-turn.ts`

- `ExpertTurnInput.source`: `string | undefined`.
- New `ExpertTurnInput.imagePath?: string`.
- Resolve `sourceDir` only when `source` is given; otherwise `undefined` and
  pass it through to `executeExpertTool` (already supported).
- Build the attached image from **exactly one** source: `imagePath` →
  `imageContentFromPath()`; else `pageId` → `pageImageContent()` (requires
  `sourceDir`).
- `buildExpertTools` gains a `hasSource: boolean` flag: `view_page` /
  `view_region` are offered only when `vision && hasSource`. `read_file` /
  `list_dir` / `grep` (workspace-scoped) and `save_output` are unaffected.
- The turn's `pageId` in the result is `null` for image / text-only turns; the
  `[view p.N]` citation link is emitted only for page turns (image turns have no
  source page to link to).

### Image loading — `chronos/utils/crop-image.ts`

New helper:

```
imageContentFromPath(path: string, maxDim: number): Promise<ImageContent>
```

Read the file, normalize to PNG via `sharp`, downscale so the long edge ≤ `maxDim`
(0 = disabled), return `{ type: "image", data: <base64>, mimeType: "image/png" }`.
Always re-encodes to PNG so any `sharp`-readable format is accepted. Throws on a
missing / undecodable file (callers turn that into the task-level error).

### Image path resolution

Inside-workspace only: reject paths that escape the workspace root (`..` or an
absolute path outside it). Unlike `read_file`'s `resolveInWorkspace`, do **not**
apply the restricted-dir filter (`.`-dirs, `png/`, `dist/`, …): page images
legitimately live under `png/`, and the anti-secret-leak rationale for that
filter doesn't apply here because the target must decode as an image (a `.env`
won't). A small dedicated resolver in `expert-tools.ts` (or `crop-image.ts`)
handles this.

### Persistence — `chronos/utils/expert-store.ts` + `restoreExpertSessions`

- `PersistedTurn` gains `imagePath?: string`.
- `appendExpertTurn` call in `runExpertTurn` records `imagePath` when present.
- `restoreExpertSessions` rehydrates an image turn by re-reading `imagePath`
  from disk via `imageContentFromPath()` (parallel to the existing page rehydrate
  branch); if the file is gone, restore the turn text-only, matching the page
  fallback.

## Prompt / description updates

- `chronos/prompts/task.md`, `chronos/prompts/task-batch.md`: document `image` /
  `images`, the optional `source`, mutual exclusivity, and the output_file
  placeholder rules.
- Parameter `description` strings in `view-page.ts` / `task-batch.ts` updated to
  match.

## Out of scope

- Zooming into an arbitrary `image` (no `view_region` on non-source images) — the
  image is sent as provided.
- Combining an arbitrary `image` with `page_id` in one turn (two images) — kept
  mutually exclusive for a clean model.
- A fully text-only `task_batch` (no differentiator per item).

## Testing

- Typecheck: `cd chronos && npm run build`.
- Manual smoke (per `chronos-vscode/TESTING.md`): (a) `task` with `image` on a
  workspace file; (b) `task` with prompt only, no source; (c) `task` source+page
  still works; (d) `task_batch` with `images`; (e) restart session and follow up
  on an image task via `task_id` (rehydration).
