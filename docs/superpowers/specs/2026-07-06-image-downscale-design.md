# Image downscaling on upload to expert models

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation

## Problem

Expert subagents (`task` / `task_batch`) upload page imagery to vision models on
every turn — the full history, including the page PNG and all `view_region`
crops, is re-sent per LLM call. Scan PNGs commonly exceed 2 MB (e.g. the
Straubing source: ~2.1 MB/page), and every current provider resizes images past
a pixel cap anyway (Anthropic: 2576 px long edge on Opus 4.7+, 1568 px on older
models; Gemini/OpenAI tile at comparable sizes). Pixels beyond the provider cap
are pure wasted upload bandwidth. At batch concurrency this saturates the
user's uplink: on 2026-07-05 a 324-page batch at concurrency 50 stalled for
3.5 h with 241 pages failing on SDK "Request timed out" errors, with kernel
Send-Q backlogs confirming stalled uploads.

Downscaling must be **provider-agnostic** (Chronos hardcodes no provider) and
**user-tunable** from VS Code settings.

## Decision summary

- One knob: **max long-edge pixels** (not bytes, not both). Every provider
  documents a pixel cap, and bytes shrink quadratically with the dimension.
- **Default 2576 px** — Anthropic's current maximum; no fidelity loss on
  Opus 4.7+/Sonnet 5, other providers resize down themselves. Users on slow
  uplinks can lower it (1568 ≈ 4× smaller uploads on current scans).
- Applied **at upload time only**. Originals on disk are never modified.
- `0` disables downscaling entirely (exact current behavior).

## Design

### VS Code setting (chronos-vscode)

`chronos.maxImageDimension` in `package.json` `contributes.configuration`:

- type `integer`, default `2576`, minimum `0`
- Description: caps the long edge (in pixels) of every image sent to expert
  vision models. Lower values shrink uploads quadratically at the cost of
  full-page detail; experts can still zoom via `view_region`, which crops from
  the full-resolution file on disk. `0` sends originals untouched. Notes the
  provider context (Anthropic resizes past 2576 px regardless).

Forwarded to the pi subprocess in `src/extension.ts` alongside the existing
limits (`agentEnv` block, ~line 758):

```ts
CHRONOS_MAX_IMAGE_DIMENSION: String(chronosCfg.get<number>("maxImageDimension", 2576)),
```

### Agent (chronos pi-package)

New helper in `chronos/utils/crop-image.ts`:

```ts
/** Downscale so the long edge is ≤ maxDim. Returns the input unchanged when
 *  already within the cap (no re-encode) or when maxDim is 0. */
export async function downscaleToLimit(png: Buffer, maxDim: number): Promise<Buffer>
```

- Uses `sharp` (already a dependency): read metadata; if
  `max(width, height) > maxDim`, `resize({ width|height: maxDim, fit: "inside",
  withoutEnlargement: true })` on the long edge and re-encode PNG; else return
  the original buffer.

Applied inside `pageImageContent()` (`chronos/tools/expert-turn.ts:74`) — the
single funnel for all model-bound imagery:

- full-page attachment (`task` / `task_batch` page context)
- `view_page` / `view_region` expert tools
- session-restore rehydration (`rehydrateToolResult`)

Both branches are capped: the full-page `readFileSync` path and the
`cropImageToBase64` path (crop from full-res first, then cap — so an oversized
crop can't blow past the limit, while small zoom crops pass through untouched).

Cap read via the existing env pattern:

```ts
const MAX_IMAGE_DIMENSION = envInt("CHRONOS_MAX_IMAGE_DIMENSION", 2576, 0, 100_000);
```

`0` short-circuits `downscaleToLimit` to a no-op.

### Non-goals

- No byte-ceiling setting (encode-search loop; unpredictable pixel output).
- No PNG→JPEG/WebP re-encoding.
- No import-time downscaling — disk originals stay pristine.
- Not a fix for uplink saturation by itself: at the 2576 default, current scans
  shrink only modestly. Relief for slow links comes from lowering the setting,
  plus the separate retry/timeout work and concurrency limits.

## Testing

1. `cd chronos && npm run build`; typecheck both `chronos-vscode` tsconfigs.
2. Node one-liner: run `downscaleToLimit` on a >2576 px page PNG; assert output
   long edge ≤ 2576 and output bytes < input bytes; assert a small crop buffer
   is returned byte-identical (no re-encode).
3. Manual smoke in a dev workspace: run a `task` on a large page; confirm the
   expert reads it and the viewer still renders; set the setting to `0` and
   confirm originals pass through.
