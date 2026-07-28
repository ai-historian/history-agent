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

**Status: reviewed 2026-07-28. Merge is mechanically clean; six logic blockers
must be fixed before it lands.** Decision taken: fix all six *before* merging, so
`dev` never contains known silently-corrupting code.

#### Verification already done

Merged `dev` into a throwaway `review/archive-support-integration` — **clean, no
conflicts**. All gates pass on the merged result:

| Check | Result |
|---|---|
| `cd chronos && npm run build` | clean |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npx tsc --noEmit -p webview/tsconfig.json` | clean |
| `cd chronos-vscode && npm run build` | clean |
| `node scripts/rpc-spike.mjs` | 7/7 PASS |
| `node test/run-ui-test.mjs` | 18/18 PASS |
| `chronos/scripts/downscale-canary.mjs` | PASS |
| `chronos/scripts/retry-canary.mjs` | PASS |

Also verified clean by review: protocol wiring (all 25 `ExtToWebview` / 24
`WebviewToExt` members handled on both sides), no XSS in new interpolations (all
Lit text/attribute bindings), and `initWorkspace` cannot clobber a user workspace
(`writeIfMissing` + `recursive: true` throughout, reachable only from
`chronos.init`).

**Every blocker below is a logic/path bug that no existing test exercises.** Green
tests are not evidence of correctness here.

#### Blockers — must fix before the merge

1. **`output_file` on a `task` follow-up writes to the workspace root.**
   `expert-turn.ts:240` makes a follow-up inherit `session.sourceRef`, but
   `view-page.ts:141-149` derives the output base dir from `params.source` alone
   and falls back to `collectionCtx.workspaceDir`. Re-running an extraction
   writes to the wrong place, leaves the original stale, and reports success.
2. **`resolveSource` has no ambiguity check.** `collection-context.ts:91-100`
   returns the *first* member whose `basename(m.path)` matches, so
   `frankfurt/Adressbuch_1864` and `mainz/Adressbuch_1864` are indistinguishable
   — the agent silently gets one and `dataKeyForRef` writes into its `data/` dir.
   Mirror `resolveExpertModel` (`resolve-model.ts:173-176`), which errors on an
   ambiguous bare id.
3. **`change_source` additions evaporate on resume.** `change-source.ts:53-55`
   mutates the in-memory catalog only, while `buildCollectionFromDiscovery`
   clears and repopulates from `sources/` on every `session_start`
   (`index.ts:244`). Refs the agent was told to use start throwing mid-session.
   Master's `saveSessionSource` persistence was dropped.
4. **Nested sources break the Data tab and the source dropdown.**
   `chronos-panel.ts:661,678` use `basename(sourceDir)` while the agent now uses
   a slug (`dataKeyForRef` → `Frankfurt--1858`). Citations resolve to
   `data/1858`, which does not exist; `postDataFiles` latches the wrong value.
   `chronos-app.ts:420`'s `endsWith("/" + currentSource)` matcher was written for
   a basename and no longer matches, so the header snaps to "— none —".
5. **A collection whose manifest `name` ≠ its filename can never be selected.**
   The picker sends the display name (`sources.ts:31`) and the loader treats it
   as a filename (`manifestPath` → `collections/<name>.json`). Fails on resume
   too, since `saveSessionCollection` persists the display name.
6. **The 300s expert timeout is a no-op on Gemini/Vertex.** Verified against the
   installed pi-ai 0.80.2: `api/google-generative-ai.js`, `api/google-vertex.js`
   and `api/google-shared.js` contain **zero** `timeout` references (they honour
   only `options.signal`), while `anthropic-messages.js`,
   `openai-completions.js`, `openai-responses.js`,
   `azure-openai-responses.js` and `openrouter-images.js` do consume it. The
   comment at `expert-turn.ts:44-50` asserts the opposite. This is the exact
   provider/incident combination the branch was built to fix — a stalled Gemini
   expert holds its concurrency slot indefinitely and wedges the batch. Fix by
   racing an `AbortController` on a timer, and correct the comment.

#### Cheap fixes to fold into the landing

- `chronos-vscode/walkthroughs/setup.md` ends with a literal `<<<<`
  (conflict-marker remnant) and no trailing newline — it renders in the VS Code
  Getting Started walkthrough.
- `src/workspace-templates.ts:22` — "design for resa resume", written verbatim
  into every new workspace's `skills/trace-entity/SKILL.md`.
- Delete the two 0-byte files `memory/MEMORY.MD` and
  `chronos-vscode/memory/MEMORY.MD` (artifacts of `ensureWorkspace(ctx.cwd)`
  running with cwd = repo root / `chronos-vscode/`), **and add a `.gitignore`
  rule** — nothing ignores them today, so they silently reappear and get
  re-committed on the next dev run from those directories.
- `dev/pi-release` is legitimate (isolated-agent-home wrapper for testing the
  released agent) — keep it.

#### Non-blocking follow-ups (do not gate the merge)

- `CLAUDE.md:59` still documents `SourceContext` / `tools/source-context.ts` as
  the source-redirection contract — that file is **deleted** and the contract
  replaced by the `source`-per-call `CollectionContext`. `CLAUDE.md:68,72`,
  `DOCS.md:31,36` and `README.md:92` are stale the same way. High leverage: this
  misleads every future session working in the repo.
- Batch robustness: one unexpected throw in a `task_batch` worker rejects
  `Promise.all` and discards all completed (paid-for) results
  (`task-batch.ts:333-343`); cancelled items vanish from the report so the
  summary is indistinguishable from failure; duplicate `page_ids` collide on the
  `live` map key; colliding `{name}` templates make two experts write one file.
- `chronos.piAgentDir` is non-functional: `agentEnv` never sets
  `PI_CODING_AGENT_DIR`, and only 1 of 4 agent-home reads honours the setting.
  Either wire it or remove the setting and its `package.json` claim.
- `.expert-chip-task` ellipsis CSS is inert (flex item with default
  `min-width: auto`); needs `min-width: 0`.
- `scripts/rpc-spike.mjs` no longer reflects how pi is launched (missing
  `--skill`), which matters because CLAUDE.md designates it the launch-contract
  canary. `scripts/skill-canary.mjs` and the two new canaries are referenced by
  nothing — wire them into `package.json` / `TESTING.md`.
- `chronos/utils/session-source-store.ts` is newly orphaned; existing workspaces'
  `.chronos/session-sources.json` is now dead data.

#### Landing procedure, once blockers are fixed

Re-run the full gate above, then PR into `dev` as a **real merge commit**, not a
squash — the branch carries its own specs and plans under `docs/superpowers/`
that are worth preserving.

Note: local `chronos/dist/` was rebuilt from the merged branch during this
review, so local pi sessions now run that agent, not `dev`'s. See the `dist/`
staleness trap — `dist/` is gitignored and survives branch switches.

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
  this is accepted rather than solved.

  **Corrected 2026-07-28 during planning.** An earlier draft of this spec
  required the converter to warn "when any page's rendered dimensions differ
  from `bounds × scale` expectations." That check is **unimplementable**:
  rendered dimensions *are* `bounds × scale` by construction, and mupdf's Page
  prototype (`getBounds, run, runPageContents, runPageAnnots, runPageWidgets,
  toPixmap, toDisplayList, toStructuredText, getLinks, createLink, deleteLink`)
  exposes no per-page image or resolution accessor — so per-page DPI cannot be
  recovered at all, and a non-uniform file cannot be detected. The converter
  instead emits an **unconditional** notice for any multi-page raster, naming
  the assumed DPI and page count, surfaced in the import summary.
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
