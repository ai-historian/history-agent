# Image normalization + Import Sources button — design

Date: 2026-07-28
Status: approved, not yet implemented
Branch plan: `dev` is the standing integration branch; topic branches off `dev`, periodic `dev` → `master` release PRs.

## Problem

Two user-reported issues, plus two adjacent bugs found while investigating.

### 1. JPG handling is wrong

`sources/<name>/png/` can contain `.jpg` files, because the importer copies plain
images through byte-for-byte while preserving the original extension
(`extension.ts:583`):

```ts
copyFileSync(filePath, join(pngPartial, `page_0001${ext}`));
```

The viewer handles this fine — pages reach the webview as `vscode-webview://`
file URIs (`chronos-panel.ts:600`) with no MIME type involved, CSP `img-src` is
origin-based, and four separate enumeration paths already accept
`png|jpg|jpeg`. **The viewer was never the problem.**

The break is at the model boundary, `chronos/tools/expert-turn.ts:66-73`:

```ts
const data = bbox ? await cropImageToBase64(imgPath, bbox) : readFileSync(imgPath).toString("base64");
return { type: "image", data, mimeType: "image/png" };
```

Raw JPEG bytes are declared `image/png` to the provider API. This affects every
`task`-with-page call, every `view_page`, and session rehydration. `view_region`
survives by accident because `cropImageToBuffer` re-encodes via sharp `.png()`.

On `feat/archive-support` the bug is narrower but still present: that branch
routes through `downscaleToLimit`, which returns the input buffer **unchanged**
when it is already within the cap — so a JPG page under 2576px on its long edge
is still JPEG-bytes-labelled-PNG. Its sibling `imageFileContent` does it
correctly via `loadImageAsPng`.

### 2. Import Sources is Command-Palette-only

`chronos.importSources` has no `menus` contribution, no icon, and no webview
entry point. A user with the panel open has no visible way to add sources, and
there is no empty state anywhere that mentions importing — an empty `sources`
array renders as a Source dropdown containing only `— none —`, indistinguishable
from "sources exist but none selected".

### 3. (found) TIFF and BMP imports silently produce zero-page sources

`IMAGE_EXTS` (`extension.ts:370`) and the file-picker filter both accept
`.tif/.tiff/.bmp`, but **none** of the four enumeration whitelists recognize
them (`chronos/utils/page-files.ts:4`, `chronos-vscode/src/panel/sources.ts:13`,
`chronos-vscode/src/import-status.ts:56`, `chronos-vscode/src/panel/chronos-panel.ts:604`).
Such an import reports success and yields a source with 0 pages: invisible in the
picker, empty in `list_pages`, and miscounted by resume logic.

This is worse than the JPG bug and no vision API accepts TIFF or BMP anyway, so
those formats *must* be converted, not merely labelled.

### 4. (found) Source-name collision is silently a skip

`stripExt` (`extension.ts:373`) derives the source name from the basename, so
`scan.jpg` and `scan.png` both map to source dir `scan`; the second is rejected
as "already exists" and counted as *skipped*. Normalizing every format to PNG
makes this collision more likely to bite.

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Branching | Permanent `dev` integration branch | User preference; topic branches off `dev`, release PRs `dev` → `master`. `master` is protection-gated (PR required). |
| Sequencing | Land `feat/archive-support` into `dev` **first** | It is 18 commits ahead / 3 behind and overlaps *every* file both features touch: `expert-turn.ts` (+250/−44), `webview-protocol.ts` (+8), `chronos-app.ts` (+30), `styles.css` (+58), `sources.ts` (+35). Building first would guarantee hand-resolved conflicts and duplicate `loadImageAsPng`-shaped logic. |
| `png/` invariant | Normalize non-PNG to PNG at import | Makes the directory name honest, removes MIME logic from the model path, and fixes TIFF/BMP. Accepted cost: measured 3.9× disk inflation. |
| Decoder | mupdf (already a `chronos-vscode` dep) | Zero new dependencies. `sharp` would add native binaries and force platform-specific `.vsix` packaging. Empirically verified to decode jpg/png/tif/bmp **and multi-page TIFF**. |
| First-run banner | Out of scope for v1 | `sources: []` is also the pre-seed state, so a banner needs a "sources message received yet" flag to avoid flashing on startup. Header button first. |

## Verified technical constraint: use `mupdf.Image`, never `Document`/`Page`

Measured against mupdf 1.27.0 with a 1200×1600 JPEG tagged 600 dpi:

| Route | Result |
|---|---|
| `Document.openDocument(buf, "x.jpg")` → `page.toPixmap(scale(1,1))` | **144×192** — bounds are DPI-derived points (`px × 72/dpi`), so a 600-dpi scan is destroyed |
| `new mupdf.Image(buf)` → `getWidth()/getHeight()`, `toPixmap()` | **1200×1600** — true native pixels, DPI-independent |

`mupdf.Image` also exposes `getXResolution()` / `getYResolution()` (returned 600
correctly), which is how multi-page scale is recovered below.

Multi-page TIFF: `new mupdf.Image(buf)` sees **page 0 only**;
`Document.countPages()` correctly reports 2. So enumeration needs the Document
route while fidelity needs the Image route — reconciled by scaling.

Measured inflation on a simulated 300-dpi A4 scan (paper-texture noise + dense
text marks): 1.06 MB JPEG → 4.12 MB PNG, **3.9×**. A 500-page JPEG corpus goes
roughly 530 MB → 2.1 GB.

## Design

### Phase 0 — Land `feat/archive-support` into `dev`

Prerequisite, and review work rather than authorship: the branch's soundness is
unverified until read. It contains a commit literally titled
`wip: in-progress archive-support / collection-context work (checkpoint)`.

1. Merge `dev` into `feat/archive-support` (it is 3 commits behind), resolve.
2. Clean up: the branch adds a **0-byte `memory/MEMORY.MD`**, and a
   `dev/pi-release` file (13 lines) whose purpose must be established or dropped.
3. Verification gate — all must pass before the PR:
   - `cd chronos && npm run build`
   - `cd chronos-vscode && npm run build`
   - `npx tsc --noEmit -p tsconfig.json` and `-p webview/tsconfig.json`
   - `node scripts/rpc-spike.mjs`
   - `node test/run-ui-test.mjs`
4. PR into `dev` as a **real merge commit**, not a squash — the branch carries
   its own specs and plans under `docs/superpowers/` that are worth preserving.

Note: local `chronos/dist/` is currently built from this branch (it contains
`expert-retry.js`, `collection-manifest.js`, `env-config.js` with no source
counterpart on `master`). Since pi loads from `dist/`, any behaviour observed
locally before this phase reflects `feat/archive-support`, not `master`.

### Phase 1 — Format normalization

#### Layer A — import (`chronos-vscode`)

New `src/image-convert.ts`:

```
convertImageToPngPages(filePath, outDir, startPage) -> number  // pages written
```

`startPage` is **1-indexed** and names the number for the first page written, so
output is `page_${String(startPage + i).padStart(4, "0")}.png`. Callers pass `1`
for a single-file import; the parameter exists so a future multi-file-into-one-
source flow can append. Returns the count written, which the caller adds to its
progress total.

- `.png` input → `copyFileSync` unchanged. No re-encode: lossless and fast.
- Single-page non-PNG → `new mupdf.Image(buf).toPixmap().asPNG()`, native pixels.
- Multi-page TIFF → `Document` route to enumerate pages, rendering each at
  `scale = img.getXResolution() / 72` where `img` is `new mupdf.Image(buf)`
  (page 0).

  **Documented limitation.** Rendered size for page *N* works out to
  `px_N × (dpi_0 / dpi_N)`. So for a TIFF whose pages carry differing DPI:
  a page with *lower* DPI than page 0 is harmlessly upscaled, but a page with
  *higher* DPI than page 0 **loses detail**. Scanner output is uniform-DPI, so
  this is accepted rather than solved — but the converter must `console.warn`
  (surfaced into the import error/summary path) when any page's rendered
  dimensions differ from `bounds × scale` expectations by more than a rounding
  pixel, so a non-uniform file is not silently degraded.
- Output `page_NNNN.png` (4-digit, 1-indexed) into `png.partial/`, written to
  `.tmp` then `renameSync`d, matching `pdf-worker.ts:39` crash-safety so a resume
  can never mistake a truncated file for a finished page.

New `src/image-worker.ts` mirroring `pdf-worker.ts`, so a 600-dpi multi-page TIFF
decode runs off the extension host thread.

Wire in by replacing the plain-image branch at `extension.ts:583-590`. Multi-page
TIFF now yields N pages where it previously yielded 1.

#### Layer B — model (`chronos`)

Point `pageImageContent`'s uncropped path at `loadImageAsPng` (which always
re-encodes) instead of `readFileSync` + `downscaleToLimit`. This is the actual
bug fix and is **still required after Layer A**, because existing workspaces
already contain `page_0001.jpg` from prior imports.

#### Consequence: no whitelist growth

Because import output is always PNG, the four duplicated extension whitelists do
not need to learn `.tif/.tiff/.bmp` — those never reach enumeration. `jpg|jpeg`
remains solely for legacy files. No new format plumbing to keep in sync across
four sites.

#### Cleanups in scope (same files)

- `chronos/utils/page-files.ts:43` — the `return base + ".png"` fallback makes
  "not found" errors report a path that was never a candidate.
- `chronos/tools/list-pages.ts:41` — output text asserts files are named
  `page_NNNN.png`; must not assert an extension while legacy `.jpg` exists.
  Same wording appears in `chronos/prompts/system-prompt.md`,
  `page-expert-prompt.md`, `task.md`, `show-page.ts:20`, `expert-tools.ts:63`.
- `stripExt` collision (issue 4) — disambiguate with a numeric suffix
  (`scan`, `scan-2`) instead of silently skipping the second file.

### Phase 2 — Import Sources button

- Add `{ type: "importSources" }` to `WebviewToExt` in
  `src/panel/webview-protocol.ts`.
- Extract the command body (`extension.ts:806-888`) into
  `src/import/import-sources-flow.ts` exporting
  `runImportSourcesFlow(workspaceFolder)`. Both the palette command and the new
  panel case call it. This follows the existing `promptLogin` convention (one
  implementation, two entry points), avoids introducing the first
  `executeCommand` into `chronos-panel.ts`, and shrinks `extension.ts` — which is
  ~980 lines and doing too much.
- Handle the message in `chronos-panel.ts`'s `handleWebviewMessage` switch.
- UI: a `.header-btn` labelled **Import** immediately after the Source `<select>`
  (`chronos-app.ts:395`), `title="Import PDFs, images, or text files as sources"`,
  borrowing the existing `is-attn` accent treatment when `sources.length === 0`.
- No refresh plumbing needed: `ChronosPanel.refreshSources()` → `postSources()`
  → `{ type: "sources" }` already exists and is already called after import.
- Test seam: add a `clickImport` case to `ChronosApp.runTestAction` alongside the
  existing `clickReopen`.

**Watch item:** the hairline divider before Auto-approve is drawn by
`.header-controls > .yolo-toggle::before` (`styles.css:270-283`), so inserting a
button changes which element owns it. The header is a fixed 41px single row
already holding 2 selects + context meter + 4 buttons — needs a visual check at
narrow panel widths.

## Error handling

- Corrupt or undecodable image: mupdf throws; `importFile` already records
  `lastError` and deliberately leaves the marker + `png.partial/` in place for
  the resume flow. Preserve that behaviour; surface the failing filename.
- A file passing the extension gate that mupdf cannot decode: report as an error
  for that file, continue the batch (existing `importFiles` semantics).
- Multi-page TIFF with non-uniform page DPI: accepted limitation, documented in
  `DOCS.md`.
- Disk growth: note the ~4× JPEG→PNG inflation in `DOCS.md` so users importing
  large JPEG corpora are not surprised.

## Testing

- **New** `chronos-vscode/test/image-convert-test.mjs` — the highest-value
  addition. Fixtures already generated (jpg, png, single-page tif, bmp,
  2-page tif, 600-dpi-tagged jpg). Asserts: native pixel dimensions preserved
  (specifically that the 600-dpi fixture yields 1200×1600, not 144×192);
  multi-page TIFF yields 2 `page_NNNN.png` files; output parses as valid PNG;
  `.png` input is byte-identical to source.
- Extend `test/run-ui-test.mjs`: assert the Import button renders and that
  `clickImport` reaches the host. The native `showOpenDialog` cannot be driven
  from that harness, so assert message delivery, not the dialog.
- `scripts/rpc-spike.mjs` is unaffected (no RPC contract change).
- Manual: add a JPG-source and a multi-page-TIFF case to
  `chronos-vscode/TESTING.md`.
- Regression to check explicitly: a *legacy* workspace with `page_0001.jpg`
  still renders in the viewer and now reaches the model as real PNG.

## Out of scope

- First-run empty-state banner (see Decisions).
- Recursive folder import — `collectSupportedFiles` is non-recursive today and
  stays that way.
- Any change to PDF rendering DPI (200) or the `MAX_WASM_PDF_BYTES` split path.
- Migrating existing `.jpg` files already in workspaces to PNG on disk. Layer B
  handles them correctly at read time; a disk migration is a separate decision.
