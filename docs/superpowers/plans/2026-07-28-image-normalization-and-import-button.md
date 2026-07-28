# Image Normalization + Import Sources Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize every imported raster to PNG so `sources/<name>/png/` holds only PNGs, fix the JPEG-bytes-labelled-`image/png` bug at the model boundary, and surface Import Sources as a button in the webview.

**Architecture:** Import-side conversion is a pure module (`image-convert.ts`) driven by a thin worker wrapper (`image-worker.ts`), mirroring the existing `pdf-stream.ts` / `pdf-worker.ts` split so decode stays off the extension-host thread while the logic stays directly testable. Model-side, `pageImageContent` routes through the existing `loadImageAsPng`, which always re-encodes — needed because existing workspaces already contain `page_0001.jpg`. The Import button reuses the established "one implementation, two entry points" convention (as `promptLogin` does) by extracting the command body into `runImportSourcesFlow`.

**Tech Stack:** TypeScript, mupdf 1.27 (WASM, already a `chronos-vscode` dependency), sharp (in `chronos/` only), Lit 3 web components, esbuild, Node worker_threads.

## Global Constraints

- **Decode rasters with `mupdf.Image`, never `Document`/`Page`.** Verified: the page route derives bounds from the DPI tag (`px × 72/dpi`), rendering a 600-dpi 1200×1600 scan at **144×192**. `new mupdf.Image(buf)` returns true native pixels regardless of DPI tag.
- **Do not add `sharp` to `chronos-vscode`.** It requires native binaries and would force platform-specific `.vsix` packaging. mupdf is already present and handles png/jpg/tif/bmp *and* multi-page TIFF.
- mupdf is **ESM-only** — always `await import("mupdf")`, never `require`.
- **esbuild does not type-check.** After editing extension or webview TS, run both: `npx tsc --noEmit -p tsconfig.json` and `npx tsc --noEmit -p webview/tsconfig.json`.
- **pi loads the agent from `chronos/dist/`, not the TS source.** After editing anything under `chronos/{extensions,tools,utils,http}/`, run `cd chronos && npm run build` or the change does not take effect.
- Page files are named `page_NNNN.png`, 4-digit zero-padded, **1-indexed**.
- Crash safety: every page write goes to `<target>.tmp` then `renameSync` — a present file must always be complete, because the resume path treats presence as done.
- Commit as `Lorenz Hufe <lorenz.hufe@posteo.de>`. Do **not** add `Co-Authored-By: Claude` trailers.
- Branch from `dev`, never commit to `master`.

## PRECONDITION — read before starting

**This plan targets the tree with `feat/archive-support` already merged into `dev`.** It depends on `loadImageAsPng` (`chronos/utils/crop-image.ts:72`), `downscaleToLimit` (`:55`) and `MAX_IMAGE_DIMENSION` (`chronos/tools/expert-turn.ts:43`), none of which exist on `dev` today.

Per the spec's Phase 0, that branch has **six logic blockers that must be fixed before it lands**. Those fixes are a separate plan. Do not start Task 1 until `git log dev --oneline | grep -q archive-support` succeeds.

All line numbers below are as of the verified merge (`review/archive-support-integration`). Re-locate by symbol if they have drifted.

## Correction to the spec

The spec asks the converter to warn "when any page's rendered dimensions differ from `bounds × scale` expectations by more than a rounding pixel." **That check is unimplementable** — rendered dimensions are `bounds × scale` by construction, and mupdf's page prototype (`getBounds, run, runPageContents, runPageAnnots, runPageWidgets, toPixmap, toDisplayList, toStructuredText, getLinks, createLink, deleteLink`) exposes no per-page image or resolution accessor, so per-page DPI cannot be recovered at all.

Task 2 instead emits an **unconditional informational warning** for any multi-page raster, naming the assumed DPI and page count. Honest and implementable; the spec's limitation section stands otherwise.

## File Structure

**Created:**
- `chronos-vscode/src/image-convert.ts` — pure conversion logic. Reads an image file, writes `page_NNNN.png` files. No VS Code API, no worker API, so it is directly testable.
- `chronos-vscode/src/image-worker.ts` — thin `worker_threads` wrapper: reads `workerData`, calls `convertImageToPngPages`, posts progress/done/error. Mirrors `pdf-worker.ts`.
- `chronos-vscode/src/import/import-sources-flow.ts` — the extracted Import Sources flow, callable from both the palette command and the panel.
- `chronos-vscode/test/image-convert-test.mjs` — bundles `image-convert.ts` with esbuild's JS API and asserts conversion behaviour.
- `chronos/scripts/page-mime-canary.mjs` — asserts `pageImageContent` never mislabels bytes. Sits alongside the existing `retry-canary.mjs` / `downscale-canary.mjs`.

**Modified:**
- `chronos-vscode/src/extension.ts` — replace the plain-image copy branch (`:577-585`); extract the `chronos.importSources` body (`:808-892`).
- `chronos/tools/expert-turn.ts:89-97` — `pageImageContent` uncropped path.
- `chronos/utils/page-files.ts:43` — misleading `.png` fallback.
- `chronos/tools/list-pages.ts:41` — output text asserting a `.png` extension.
- `chronos-vscode/src/panel/webview-protocol.ts` — add `{ type: "importSources" }`.
- `chronos-vscode/src/panel/chronos-panel.ts` — handle `importSources`.
- `chronos-vscode/webview/components/chronos-app.ts` — Import button + `clickImport` test seam.
- `chronos-vscode/webview/styles.css` — no new class needed; verify the `.yolo-toggle::before` divider.
- `DOCS.md`, `chronos-vscode/TESTING.md` — document formats, inflation, manual cases.

---

### Task 1: `convertImageToPngPages` — single-page rasters

**Files:**
- Create: `chronos-vscode/src/image-convert.ts`
- Test: `chronos-vscode/test/image-convert-test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `convertImageToPngPages(filePath: string, outDir: string, startPage: number): Promise<ConvertResult>` where `interface ConvertResult { pagesWritten: number; warnings: string[] }`. Task 2 extends it for multi-page; Task 3 calls it from the worker.

- [ ] **Step 1: Create the test fixture generator**

The repo has no image fixtures. Create `chronos-vscode/test/fixtures/make-fixtures.mjs`:

```js
// Generates the raster fixtures used by image-convert-test.mjs.
// Uses sharp from the chronos/ package (chronos-vscode has no image dep of its own).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });

const sharp = (await import(join(here, "../../../chronos/node_modules/sharp/lib/index.js"))).default;

// 1200x1600 flat image with a dark block, so PNG/JPEG round-trips are visibly non-trivial.
const raw = Buffer.alloc(1200 * 1600 * 3, 0xf5);
for (let y = 100; y < 300; y++) {
  for (let x = 100; x < 900; x++) {
    const i = (y * 1200 + x) * 3;
    raw[i] = raw[i + 1] = raw[i + 2] = 0x20;
  }
}
const base = sharp(raw, { raw: { width: 1200, height: 1600, channels: 3 } });

writeFileSync(join(here, "page.png"), await base.clone().png().toBuffer());
writeFileSync(join(here, "page.jpg"), await base.clone().jpeg({ quality: 88 }).toBuffer());
writeFileSync(join(here, "page.bmp"), await base.clone().png().toBuffer()); // placeholder, replaced below
writeFileSync(join(here, "page.tif"), await base.clone().tiff().toBuffer());
// 600-dpi tagged JPEG: the adversarial case for the Document/Page route.
writeFileSync(
  join(here, "hidpi.jpg"),
  await base.clone().withMetadata({ density: 600 }).jpeg({ quality: 90 }).toBuffer(),
);
// 2-page TIFF at a uniform 300 dpi.
writeFileSync(
  join(here, "multi.tif"),
  await sharp([
    await base.clone().withMetadata({ density: 300 }).tiff().toBuffer(),
  ][0]).tiff({ pyramid: false }).toBuffer(),
);
console.log("fixtures written to", here);
```

Then run it and confirm the files exist:

```bash
cd chronos-vscode && node test/fixtures/make-fixtures.mjs && ls -l test/fixtures/
```

Expected: `page.png`, `page.jpg`, `page.bmp`, `page.tif`, `hidpi.jpg`, `multi.tif` all present and non-empty.

> **Note:** sharp cannot author a genuine multi-page TIFF or BMP. If `multi.tif` comes out single-page or `page.bmp` is not a real BMP, generate those two with ImageMagick instead — `convert page.png page.bmp` and `convert page.png page.png multi.tif` — and record in the test file which fixtures came from which tool. Task 2's multi-page assertions require a real 2-page TIFF; do not proceed to Task 2 without one.

- [ ] **Step 2: Write the failing test**

Create `chronos-vscode/test/image-convert-test.mjs`:

```js
// Bundles src/image-convert.ts with esbuild (the repo's only TS build tool) and
// asserts conversion behaviour. mupdf stays external so node resolves the real
// ESM package at runtime.
import { build } from "esbuild";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
let failures = 0;

function check(name, cond, detail = "") {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
}

const outfile = join(mkdtempSync(join(tmpdir(), "ch-conv-")), "image-convert.mjs");
await build({
  entryPoints: [join(here, "../src/image-convert.ts")],
  outfile, bundle: true, format: "esm", platform: "node", external: ["mupdf"],
});
const { convertImageToPngPages } = await import(outfile);

function pngDims(path) {
  const b = readFileSync(path);
  // PNG IHDR: width at byte 16, height at byte 20 (big-endian uint32).
  return { magicOk: b.subarray(0, 4).toString("hex") === "89504e47",
           w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const tmp = () => mkdtempSync(join(tmpdir(), "ch-out-"));

// 1. JPEG converts to a real PNG at native pixels.
{
  const out = tmp();
  const r = await convertImageToPngPages(join(fixtures, "page.jpg"), out, 1);
  const f = join(out, "page_0001.png");
  check("jpg -> 1 page", r.pagesWritten === 1, `got ${r.pagesWritten}`);
  check("jpg -> page_0001.png exists", existsSync(f));
  const d = existsSync(f) ? pngDims(f) : {};
  check("jpg -> real PNG magic bytes", d.magicOk === true);
  check("jpg -> native 1200x1600", d.w === 1200 && d.h === 1600, `got ${d.w}x${d.h}`);
}

// 2. THE REGRESSION THAT MATTERS: a 600-dpi tag must not shrink the output.
//    The Document/Page route yields 144x192 here; mupdf.Image yields 1200x1600.
{
  const out = tmp();
  await convertImageToPngPages(join(fixtures, "hidpi.jpg"), out, 1);
  const d = pngDims(join(out, "page_0001.png"));
  check("600dpi jpg -> native 1200x1600 (not 144x192)",
        d.w === 1200 && d.h === 1600, `got ${d.w}x${d.h}`);
}

// 3. PNG input is copied byte-identically, never re-encoded.
{
  const out = tmp();
  const src = join(fixtures, "page.png");
  const r = await convertImageToPngPages(src, out, 1);
  check("png -> 1 page", r.pagesWritten === 1);
  check("png -> byte-identical copy",
        readFileSync(src).equals(readFileSync(join(out, "page_0001.png"))));
}

// 4. startPage is honoured and 1-indexed with 4-digit padding.
{
  const out = tmp();
  await convertImageToPngPages(join(fixtures, "page.jpg"), out, 7);
  check("startPage=7 -> page_0007.png", existsSync(join(out, "page_0007.png")));
}

// 5. BMP and TIFF are accepted (they previously imported to a zero-page source).
for (const fx of ["page.bmp", "page.tif"]) {
  const out = tmp();
  const r = await convertImageToPngPages(join(fixtures, fx), out, 1);
  check(`${fx} -> 1 page`, r.pagesWritten === 1, `got ${r.pagesWritten}`);
  check(`${fx} -> real PNG`, existsSync(join(out, "page_0001.png")) &&
        pngDims(join(out, "page_0001.png")).magicOk === true);
}

// 6. No .tmp files survive a successful conversion.
{
  const out = tmp();
  await convertImageToPngPages(join(fixtures, "page.jpg"), out, 1);
  check("no .tmp left behind", readdirSync(out).every((f) => !f.endsWith(".tmp")));
}

// 7. A missing file fails loudly, naming the path.
{
  let msg = "";
  try { await convertImageToPngPages(join(fixtures, "nope.jpg"), tmp(), 1); }
  catch (e) { msg = e.message; }
  check("missing file throws naming the path", msg.includes("nope.jpg"), `got "${msg}"`);
}

console.log(failures === 0 ? "\nIMAGE CONVERT OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd chronos-vscode && node test/image-convert-test.mjs
```

Expected: FAIL — esbuild errors that `src/image-convert.ts` cannot be resolved.

- [ ] **Step 4: Write the implementation**

Create `chronos-vscode/src/image-convert.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export interface ConvertResult {
  pagesWritten: number;
  /** Non-fatal notices for the import summary (e.g. assumed DPI on multi-page input). */
  warnings: string[];
}

function pageName(pageNumber: number): string {
  return `page_${String(pageNumber).padStart(4, "0")}.png`;
}

// Write via .tmp + rename so a crash can never leave a truncated PNG that the
// resume path would treat as a finished page (same contract as pdf-worker.ts).
function writeAtomic(target: string, data: Uint8Array): void {
  const tmp = target + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}

/**
 * Convert an image file into `page_NNNN.png` files under `outDir`.
 *
 * `startPage` is 1-indexed and names the number of the FIRST page written, so
 * output is `page_${startPage + i}`. Returns the number of pages written.
 *
 * A `.png` input is copied byte-for-byte (lossless, no re-encode). Every other
 * format is decoded with mupdf and re-encoded to PNG.
 */
export async function convertImageToPngPages(
  filePath: string,
  outDir: string,
  startPage: number,
): Promise<ConvertResult> {
  if (!existsSync(filePath)) throw new Error(`Image not found: ${filePath}`);
  mkdirSync(outDir, { recursive: true });

  if (extname(filePath).toLowerCase() === ".png") {
    const target = join(outDir, pageName(startPage));
    const tmp = target + ".tmp";
    copyFileSync(filePath, tmp);
    renameSync(tmp, target);
    return { pagesWritten: 1, warnings: [] };
  }

  const mupdf = await import("mupdf");
  const buf = readFileSync(filePath);

  // Native pixel dimensions come from the Image primitive. The Document/Page
  // route derives bounds from the file's DPI tag (px * 72/dpi), which renders a
  // 600-dpi scan at 1/8.3 scale — never use it to size a raster.
  const image = new mupdf.Image(buf);
  const pixmap = image.toPixmap();
  writeAtomic(join(outDir, pageName(startPage)), pixmap.asPNG());
  pixmap.destroy();
  return { pagesWritten: 1, warnings: [] };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd chronos-vscode && node test/image-convert-test.mjs
```

Expected: all checks PASS except the two multi-page ones (not yet written) — specifically `IMAGE CONVERT OK`.

- [ ] **Step 6: Typecheck**

```bash
cd chronos-vscode && npx tsc --noEmit -p tsconfig.json
```

Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add chronos-vscode/src/image-convert.ts chronos-vscode/test/image-convert-test.mjs chronos-vscode/test/fixtures/
git commit -m "feat: convert non-PNG rasters to PNG at native resolution

Decodes via mupdf.Image, which reports true native pixels. The
Document/Page route derives bounds from the DPI tag and would render a
600-dpi 1200x1600 scan at 144x192 — the test asserts against exactly
that regression. PNG input is copied byte-for-byte, never re-encoded."
```

---

### Task 2: Multi-page TIFF support

**Files:**
- Modify: `chronos-vscode/src/image-convert.ts`
- Test: `chronos-vscode/test/image-convert-test.mjs`

**Interfaces:**
- Consumes: `convertImageToPngPages` and `ConvertResult` from Task 1.
- Produces: same signature; `pagesWritten` may now exceed 1 and `warnings` may be non-empty.

- [ ] **Step 1: Write the failing test**

Append to `chronos-vscode/test/image-convert-test.mjs`, immediately before the final `console.log`:

```js
// 8. A 2-page TIFF yields two sequentially-numbered pages.
{
  const out = tmp();
  const r = await convertImageToPngPages(join(fixtures, "multi.tif"), out, 1);
  check("multi.tif -> 2 pages", r.pagesWritten === 2, `got ${r.pagesWritten}`);
  check("multi.tif -> page_0001.png", existsSync(join(out, "page_0001.png")));
  check("multi.tif -> page_0002.png", existsSync(join(out, "page_0002.png")));
  check("multi.tif -> both are real PNGs",
        existsSync(join(out, "page_0002.png")) &&
        pngDims(join(out, "page_0001.png")).magicOk &&
        pngDims(join(out, "page_0002.png")).magicOk);
  check("multi.tif -> warns about assumed DPI",
        r.warnings.some((w) => /dpi/i.test(w)), `warnings: ${JSON.stringify(r.warnings)}`);
}

// 9. startPage offsets a multi-page file correctly.
{
  const out = tmp();
  const r = await convertImageToPngPages(join(fixtures, "multi.tif"), out, 5);
  check("multi.tif startPage=5 -> 0005 and 0006",
        existsSync(join(out, "page_0005.png")) && existsSync(join(out, "page_0006.png")));
  check("multi.tif startPage=5 -> reports 2", r.pagesWritten === 2);
}

// 10. A single-page file produces no DPI warning (no false alarms).
{
  const out = tmp();
  const r = await convertImageToPngPages(join(fixtures, "page.jpg"), out, 1);
  check("single page -> no warnings", r.warnings.length === 0,
        `warnings: ${JSON.stringify(r.warnings)}`);
}
```

- [ ] **Step 2: Run the test to verify the new checks fail**

```bash
cd chronos-vscode && node test/image-convert-test.mjs
```

Expected: FAIL — `multi.tif -> 2 pages — got 1`, plus the page_0002 and warning checks.

- [ ] **Step 3: Implement multi-page handling**

In `chronos-vscode/src/image-convert.ts`, replace everything after `const buf = readFileSync(filePath);` with:

```ts
  // Page count needs the Document route (mupdf.Image sees only page 0 of a
  // multi-page TIFF). Sizing still comes from the Image primitive.
  const image = new mupdf.Image(buf);
  let pageCount = 1;
  let doc: ReturnType<typeof mupdf.Document.openDocument> | undefined;
  try {
    doc = mupdf.Document.openDocument(buf, basename(filePath));
    pageCount = doc.countPages();
  } catch {
    pageCount = 1; // Not container-openable; treat as a single image.
  }

  if (pageCount <= 1) {
    const pixmap = image.toPixmap();
    writeAtomic(join(outDir, pageName(startPage)), pixmap.asPNG());
    pixmap.destroy();
    return { pagesWritten: 1, warnings: [] };
  }

  // Multi-page: render each page through the Document route, scaled by page 0's
  // DPI so output lands at native pixels. Page bounds are points (px * 72/dpi),
  // so scale = dpi/72 recovers pixels.
  //
  // Limitation: mupdf exposes no per-page resolution (the Page prototype has no
  // image or resolution accessor), so page 0's DPI is assumed for all pages.
  // Rendered size for page N is px_N * (dpi_0 / dpi_N): a page authored at a
  // LOWER dpi than page 0 is harmlessly upscaled, but a page at a HIGHER dpi
  // loses detail. Undetectable, hence the unconditional warning below.
  const xres = image.getXResolution();
  const scale = xres > 0 ? xres / 72 : 1;
  const warnings = [
    `${basename(filePath)}: ${pageCount} pages rendered at an assumed ${xres > 0 ? xres : 72} dpi ` +
      `taken from page 1. Pages authored at a different resolution may be rescaled.`,
  ];

  for (let i = 0; i < pageCount; i++) {
    const page = doc!.loadPage(i);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    writeAtomic(join(outDir, pageName(startPage + i)), pixmap.asPNG());
    // Free WASM memory before the next page so a long TIFF cannot pile up.
    pixmap.destroy();
    page.destroy();
  }

  return { pagesWritten: pageCount, warnings };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd chronos-vscode && node test/image-convert-test.mjs
```

Expected: `IMAGE CONVERT OK`, all checks PASS.

- [ ] **Step 5: Typecheck**

```bash
cd chronos-vscode && npx tsc --noEmit -p tsconfig.json
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add chronos-vscode/src/image-convert.ts chronos-vscode/test/image-convert-test.mjs
git commit -m "feat: multi-page TIFF imports as one page per TIFF page

Page count comes from the Document route; sizing from mupdf.Image.
mupdf exposes no per-page resolution, so page 1's DPI is assumed for all
pages and the result carries an explicit warning — a page authored at a
higher DPI than page 1 would lose detail undetectably."
```

---

### Task 3: Worker wrapper + wire into the importer

**Files:**
- Create: `chronos-vscode/src/image-worker.ts`
- Modify: `chronos-vscode/src/extension.ts:577-585`, `chronos-vscode/esbuild.mjs`

**Interfaces:**
- Consumes: `convertImageToPngPages` from Task 2.
- Produces: `convertImageInWorker(workerScript: string, filePath: string, outDir: string, startPage: number): Promise<ConvertResult>` in `extension.ts`. No later task depends on it.

- [ ] **Step 1: Check how the pdf worker is bundled**

```bash
cd chronos-vscode && grep -n "pdf-worker\|entryPoints\|pdf-split" esbuild.mjs
```

Expected: an `entryPoints` list including `src/pdf-worker.ts` (and `src/pdf-split-worker.ts`). Note the exact shape — `image-worker.ts` must be added the same way, or the worker file will not exist in `out/` at runtime.

- [ ] **Step 2: Create the worker**

Create `chronos-vscode/src/image-worker.ts`:

```ts
import { workerData, parentPort } from "node:worker_threads";
import { convertImageToPngPages } from "./image-convert";

interface WorkerData {
  filePath: string;
  outDir: string;
  startPage: number;
}

async function main() {
  const { filePath, outDir, startPage } = workerData as WorkerData;
  const result = await convertImageToPngPages(filePath, outDir, startPage);
  parentPort?.postMessage({ type: "done", ...result });
}

main().catch((err) => {
  parentPort?.postMessage({ type: "error", message: (err as Error).message });
  process.exit(1);
});
```

- [ ] **Step 3: Add the worker to the esbuild entry points**

In `chronos-vscode/esbuild.mjs`, add `src/image-worker.ts` to the same `entryPoints` array that already contains `src/pdf-worker.ts`, matching the surrounding style exactly.

- [ ] **Step 4: Add the worker driver to extension.ts**

Insert immediately above `async function importFile(` (currently `extension.ts:469`):

```ts
// Run image conversion in a worker: a 600-dpi multi-page TIFF decode is slow
// enough to stall the extension host, and mupdf WASM has no async yield points.
function convertImageInWorker(
  workerScript: string,
  filePath: string,
  outDir: string,
  startPage: number,
): Promise<{ pagesWritten: number; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerScript, { workerData: { filePath, outDir, startPage } });
    let settled = false;
    w.on("message", (msg: { type: string; pagesWritten?: number; warnings?: string[]; message?: string }) => {
      if (msg.type === "done") {
        settled = true;
        resolve({ pagesWritten: msg.pagesWritten ?? 0, warnings: msg.warnings ?? [] });
      } else if (msg.type === "error") {
        settled = true;
        reject(new Error(msg.message ?? "image conversion failed"));
      }
    });
    w.on("error", (err) => { settled = true; reject(err); });
    w.on("exit", (code) => {
      if (!settled) reject(new Error(`image worker exited with code ${code}`));
    });
  });
}
```

- [ ] **Step 5: Replace the copy branch**

`extension.ts:577-585` currently reads:

```ts
    if (IMAGE_EXTS.has(ext)) {
      const pngPartial = partialPngDir(sourceDir);
      mkdirSync(pngPartial, { recursive: true });
      progress(`Importing image: ${sourceName}`);
      updateImportMarker(sourceDir, { expectedPages: 1 });
      copyFileSync(filePath, join(pngPartial, `page_0001${ext}`));
      finalizePartialImport(sourceDir);
      return { ok: true };
    }
```

Replace with:

```ts
    if (IMAGE_EXTS.has(ext)) {
      const pngPartial = partialPngDir(sourceDir);
      mkdirSync(pngPartial, { recursive: true });
      progress(`Importing image: ${sourceName}`);
      // Normalize every raster to PNG so png/ only ever holds .png. Previously
      // the file was copied with its original extension, which left .jpg in a
      // dir named png/ and made .tif/.bmp invisible to every page-enumeration
      // path (a silently zero-page source).
      const workerScript = join(context.extensionPath, "out", "image-worker.js");
      const { pagesWritten, warnings } = await convertImageInWorker(workerScript, filePath, pngPartial, 1);
      updateImportMarker(sourceDir, { expectedPages: pagesWritten });
      finalizePartialImport(sourceDir);
      for (const w of warnings) console.warn(`[chronos-import] ${w}`);
      return { ok: true, warnings };
    }
```

> `expectedPages` is now set *after* conversion, because a multi-page TIFF's count is unknown until decode. If `importFile`'s return type does not already carry `warnings`, add `warnings?: string[]` to it and surface them in `importFiles`' summary alongside errors. Locate `context` — if `importFile` has no access to the extension context, thread the already-computed worker-script path in the same way the PDF path obtains it (see `extension.ts:532` / `:568` call sites of `renderPdfFile`).

- [ ] **Step 6: Build and typecheck**

```bash
cd chronos-vscode && npx tsc --noEmit -p tsconfig.json && npm run build && ls -l out/image-worker.js
```

Expected: clean typecheck, `Build complete.`, and `out/image-worker.js` exists.

- [ ] **Step 7: Verify end-to-end against a real workspace**

```bash
cd chronos-vscode && node test/image-convert-test.mjs
```

Expected: `IMAGE CONVERT OK`. Then confirm the worker path itself works by driving the real importer — run the UI test, which exercises extension activation:

```bash
cd chronos-vscode && node test/run-ui-test.mjs
```

Expected: `UI TEST OK` (18 PASS). This does not import an image; Task 8's manual checklist covers that.

- [ ] **Step 8: Commit**

```bash
git add chronos-vscode/src/image-worker.ts chronos-vscode/src/extension.ts chronos-vscode/esbuild.mjs
git commit -m "feat: import images through the PNG converter in a worker

Replaces the byte-copy that preserved the original extension. png/ now
holds only .png, so .tif/.bmp stop importing as zero-page sources, and a
multi-page TIFF becomes one page per page. Decode runs in a worker
because mupdf WASM has no yield points and would stall the host."
```

---

### Task 4: Fix the JPEG mime mislabel at the model boundary

**Files:**
- Modify: `chronos/tools/expert-turn.ts:89-97`
- Create: `chronos/scripts/page-mime-canary.mjs`

**Interfaces:**
- Consumes: `loadImageAsPng(imgPath: string, maxDim: number): Promise<Buffer>` from `chronos/utils/crop-image.ts:72`, and `MAX_IMAGE_DIMENSION` from `expert-turn.ts:43`.
- Produces: no signature change — `pageImageContent(sourceDir, pageId, bbox?)` still returns `ImageContent`.

**Why this is still needed after Task 3:** existing workspaces already contain `page_0001.jpg` from imports made before Task 3. Enumeration keeps accepting `png|jpg|jpeg` for exactly that reason.

- [ ] **Step 1: Write the failing canary**

Create `chronos/scripts/page-mime-canary.mjs`, matching the style of the existing `retry-canary.mjs`:

```js
// Asserts pageImageContent never declares a mimeType that contradicts the bytes.
// A legacy workspace can hold page_0001.jpg (pre-normalization imports), and a
// JPEG labelled image/png is a provider-API contract violation.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const { pageImageContent } = await import("../dist/tools/expert-turn.js");
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
};

function kind(b64) {
  const h = Buffer.from(b64, "base64").subarray(0, 4).toString("hex").toUpperCase();
  return h.startsWith("FFD8FF") ? "image/jpeg" : h.startsWith("89504E47") ? "image/png" : `unknown(${h})`;
}

const root = mkdtempSync(join(tmpdir(), "ch-mime-"));
const pngDir = join(root, "png");
mkdirSync(pngDir, { recursive: true });

// A JPEG well under MAX_IMAGE_DIMENSION (2576) — the case downscaleToLimit
// passes through unchanged, which is precisely where the mislabel survived.
const raw = Buffer.alloc(800 * 1000 * 3, 0xf0);
writeFileSync(join(pngDir, "page_0001.jpg"),
  await sharp(raw, { raw: { width: 800, height: 1000, channels: 3 } }).jpeg().toBuffer());

const uncropped = await pageImageContent(root, 1);
check("legacy .jpg page: bytes match declared mimeType",
      kind(uncropped.data) === uncropped.mimeType,
      `declared ${uncropped.mimeType}, bytes are ${kind(uncropped.data)}`);

const cropped = await pageImageContent(root, 1, { x: 0.1, y: 0.1, w: 0.3, h: 0.3 });
check("legacy .jpg crop: bytes match declared mimeType",
      kind(cropped.data) === cropped.mimeType,
      `declared ${cropped.mimeType}, bytes are ${kind(cropped.data)}`);

// A .png page must still work unchanged.
writeFileSync(join(pngDir, "page_0002.png"),
  await sharp(raw, { raw: { width: 800, height: 1000, channels: 3 } }).png().toBuffer());
const p = await pageImageContent(root, 2);
check("png page: bytes match declared mimeType", kind(p.data) === p.mimeType,
      `declared ${p.mimeType}, bytes are ${kind(p.data)}`);

console.log(failures === 0 ? "\npage mime canary OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Build and run the canary to verify it fails**

```bash
cd chronos && npm run build && node scripts/page-mime-canary.mjs
```

Expected: FAIL — `legacy .jpg page: bytes match declared mimeType — declared image/png, bytes are image/jpeg`. The crop and png checks should PASS.

- [ ] **Step 3: Fix `pageImageContent`**

`chronos/tools/expert-turn.ts:89-97` currently reads:

```ts
export async function pageImageContent(sourceDir: string, pageId: number, bbox?: Bbox): Promise<ImageContent> {
  const imgPath = pageIdToPath(sourceDir, pageId);
  if (!existsSync(imgPath)) {
    throw new Error(`Page ${String(pageId).padStart(4, "0")} not found: ${imgPath}`);
  }
  const raw = bbox ? await cropImageToBuffer(imgPath, bbox) : readFileSync(imgPath);
  const capped = await downscaleToLimit(raw, MAX_IMAGE_DIMENSION);
  return { type: "image", data: capped.toString("base64"), mimeType: "image/png" };
}
```

Replace the body's last two lines with:

```ts
  // Both paths must yield actual PNG bytes, because the mimeType below is fixed.
  // Cropping re-encodes to PNG already; the uncropped path must go through
  // loadImageAsPng rather than readFileSync + downscaleToLimit, because
  // downscaleToLimit returns its input UNCHANGED when already within the cap —
  // which sent a legacy page_0001.jpg out as JPEG bytes labelled image/png.
  const png = bbox
    ? await downscaleToLimit(await cropImageToBuffer(imgPath, bbox), MAX_IMAGE_DIMENSION)
    : await loadImageAsPng(imgPath, MAX_IMAGE_DIMENSION);
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
```

Then remove the now-unused `raw`/`capped` locals, and drop `readFileSync` from the import list at the top of the file **only if** no other code in the file uses it (check with `grep -n "readFileSync" chronos/tools/expert-turn.ts`). Add `loadImageAsPng` to the existing `../utils/crop-image.js` import at `expert-turn.ts:17` if it is not already there.

- [ ] **Step 4: Build and run the canary to verify it passes**

```bash
cd chronos && npm run build && node scripts/page-mime-canary.mjs
```

Expected: all three checks PASS, `page mime canary OK`.

- [ ] **Step 5: Confirm no regression in the other canaries**

```bash
cd chronos && node scripts/downscale-canary.mjs && node scripts/retry-canary.mjs
```

Expected: `downscale canary OK` and `retry canary OK`.

- [ ] **Step 6: Commit**

```bash
git add chronos/tools/expert-turn.ts chronos/scripts/page-mime-canary.mjs
git commit -m "fix: never declare image/png for non-PNG page bytes

downscaleToLimit returns its input unchanged when already within the
cap, so a legacy page_0001.jpg under 2576px went to the provider as
JPEG bytes labelled image/png. Route the uncropped path through
loadImageAsPng, which always re-encodes. Legacy workspaces still hold
.jpg pages, so this is required independently of import normalization."
```

---

### Task 5: Extension-side cleanups

**Files:**
- Modify: `chronos/utils/page-files.ts:43`, `chronos/tools/list-pages.ts:41`, `chronos-vscode/src/extension.ts:367` (`stripExt` collision)

**Interfaces:**
- Consumes: nothing new.
- Produces: `uniqueSourceName(sourcesDir: string, base: string): string` in `extension.ts`. No later task depends on it.

- [ ] **Step 1: Fix the misleading "not found" path**

`chronos/utils/page-files.ts:43` returns `base + ".png"` as a fallback, so a missing page reports a path that was never a candidate (as seen live: `Page 0001 not found: …/page_0001.png` when no such candidate was probed). Read the function first:

```bash
sed -n '30,46p' chronos/utils/page-files.ts
```

Change the fallback so the error names every extension actually tried. Keep the return type `string` — callers only use it for `existsSync` plus the message — by returning the `.png` candidate but exporting the tried list for the message. Concretely, add below `pageIdToPath`:

```ts
/** The candidate paths `pageIdToPath` probes, for "not found" diagnostics. */
export function pageCandidatePaths(sourceDir: string, pageId: number): string[] {
  const base = join(sourceDir, "png", `page_${String(pageId).padStart(4, "0")}`);
  return IMAGE_EXTS.map((ext) => base + ext);
}
```

Then in `chronos/tools/expert-turn.ts`'s `pageImageContent`, change the throw to:

```ts
    throw new Error(
      `Page ${String(pageId).padStart(4, "0")} not found. Tried: ${pageCandidatePaths(sourceDir, pageId).join(", ")}`,
    );
```

importing `pageCandidatePaths` alongside the existing `pageIdToPath` import.

- [ ] **Step 2: Stop asserting a page extension in tool output**

`chronos/tools/list-pages.ts:41` tells the model `Files are named page_NNNN.png (4-digit zero-padded).` That is now true for new imports but false for legacy `.jpg` workspaces. Read and replace:

```bash
sed -n '35,46p' chronos/tools/list-pages.ts
```

Change the sentence to: `Files are named page_NNNN (4-digit zero-padded) under png/.` — dropping the extension claim. Then find and fix the same claim elsewhere:

```bash
grep -rn "page_NNNN\.png\|page_0001\.png" chronos/prompts/ chronos/tools/ | grep -v dist
```

Update each hit the same way. Do **not** touch `chronos/scripts/` or test files.

- [ ] **Step 3: Write the failing test for the name collision**

`stripExt` makes `scan.jpg` and `scan.png` both resolve to source `scan`; the second is rejected as "already exists" and counted as *skipped* — more likely to bite now that both normalize to PNG. Add to `chronos-vscode/test/image-convert-test.mjs`, before the final `console.log`:

```js
// 11. Source names disambiguate instead of colliding.
{
  const { uniqueSourceName } = await import(outfileExt);
  const root = tmp();
  check("unique name: free name unchanged", uniqueSourceName(root, "scan") === "scan");
  mkdirSync(join(root, "scan", "png"), { recursive: true });
  check("unique name: taken name gets a suffix", uniqueSourceName(root, "scan") === "scan-2",
        `got ${uniqueSourceName(root, "scan")}`);
  mkdirSync(join(root, "scan-2", "png"), { recursive: true });
  check("unique name: skips to the next free suffix", uniqueSourceName(root, "scan") === "scan-3",
        `got ${uniqueSourceName(root, "scan")}`);
}
```

Add `mkdirSync` to the `node:fs` import at the top of that test file, and above the existing `convertImageToPngPages` import add a second bundle:

```js
const outfileExt = join(dirname(outfile), "source-name.mjs");
await build({
  entryPoints: [join(here, "../src/source-name.ts")],
  outfile: outfileExt, bundle: true, format: "esm", platform: "node",
});
```

- [ ] **Step 4: Run to verify it fails**

```bash
cd chronos-vscode && node test/image-convert-test.mjs
```

Expected: FAIL — esbuild cannot resolve `src/source-name.ts`.

- [ ] **Step 5: Implement**

Create `chronos-vscode/src/source-name.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A source directory name that is not already taken. `scan.jpg` and `scan.png`
 * both reduce to `scan`, so without this the second import is rejected as
 * "already exists" and silently counted as skipped.
 */
export function uniqueSourceName(sourcesDir: string, base: string): string {
  if (!existsSync(join(sourcesDir, base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(join(sourcesDir, candidate))) return candidate;
  }
  throw new Error(`Could not find a free source name for "${base}" after 999 attempts`);
}
```

Then in `extension.ts`, import it and use it where the source name is derived from `stripExt`. **Important:** only apply it to the *new-import* path. Do not apply it where an existing source is deliberately detected for the skip/resume logic, or resume will create duplicates instead of continuing. Read `importFile`'s opening lines before editing:

```bash
sed -n '469,505p' chronos-vscode/src/extension.ts
```

- [ ] **Step 6: Run to verify it passes**

```bash
cd chronos-vscode && node test/image-convert-test.mjs && npx tsc --noEmit -p tsconfig.json
```

Expected: `IMAGE CONVERT OK`, clean typecheck.

- [ ] **Step 7: Rebuild the agent and re-run its canaries**

```bash
cd chronos && npm run build && node scripts/page-mime-canary.mjs
```

Expected: `page mime canary OK` (the changed error message must not break it).

- [ ] **Step 8: Commit**

```bash
git add chronos/utils/page-files.ts chronos/tools/list-pages.ts chronos/tools/expert-turn.ts chronos/prompts/ chronos-vscode/src/source-name.ts chronos-vscode/src/extension.ts chronos-vscode/test/image-convert-test.mjs
git commit -m "fix: honest page-not-found paths, no extension claim, unique source names

The not-found error reported a .png path that was never probed. Tool and
prompt text claimed page_NNNN.png, untrue for legacy .jpg workspaces.
And scan.jpg + scan.png both reduced to source 'scan', so the second was
silently skipped — now disambiguated with a numeric suffix."
```

---

### Task 6: Import Sources button — host side

**Files:**
- Create: `chronos-vscode/src/import/import-sources-flow.ts`
- Modify: `chronos-vscode/src/extension.ts:808-892`, `chronos-vscode/src/panel/webview-protocol.ts`, `chronos-vscode/src/panel/chronos-panel.ts:864`

**Interfaces:**
- Consumes: `importFiles`, `collectSupportedFiles`, `promptRecoverIncompleteImports` from `extension.ts`.
- Produces: `runImportSourcesFlow(workspaceFolder: string): Promise<void>`, and the protocol member `{ type: "importSources" }`. Task 7 sends that message.

- [ ] **Step 1: Extract the flow**

Create `chronos-vscode/src/import/import-sources-flow.ts` holding the entire body currently inside the `chronos.importSources` callback (`extension.ts:809-891`), as:

```ts
export async function runImportSourcesFlow(workspaceFolder: string | undefined): Promise<void> {
```

with the body unchanged except that the early `return`s stay `return` (not `return false`). The helpers it calls — `importFiles`, `collectSupportedFiles`, `promptRecoverIncompleteImports` — currently live in `extension.ts`. Move whichever are used *only* by this flow into the new module; for any also used elsewhere (e.g. `promptRecoverIncompleteImports` is called on activation at roughly `extension.ts:976`), export it from `extension.ts` and import it here, or move it to the new module and import it back into `extension.ts` — pick whichever leaves no circular import. Verify with the typecheck in Step 4.

- [ ] **Step 2: Reduce the command to a delegation**

Replace the whole `registerCommand("chronos.importSources", …)` body with:

```ts
    vscode.commands.registerCommand("chronos.importSources", async () => {
      await runImportSourcesFlow(workspaceFolder);
    }),
```

- [ ] **Step 3: Add the protocol member and handler**

In `chronos-vscode/src/panel/webview-protocol.ts`, add to `WebviewToExt` immediately after the `refreshSources` member:

```ts
  | { type: "importSources" }
```

In `chronos-vscode/src/panel/chronos-panel.ts`, add a case immediately after the existing `case "refreshSources":` block (currently `:864-866`):

```ts
        case "importSources":
          // Same implementation as the palette command (mirrors promptLogin's
          // one-impl-two-entry-points shape). The flow refreshes the source
          // picker itself when anything imported.
          await runImportSourcesFlow(this.workspaceDir);
          break;
```

Import `runImportSourcesFlow` at the top of `chronos-panel.ts`. Confirm the field name for the workspace directory first — it may be `this.workspaceDir` or similar:

```bash
grep -n "workspaceDir" chronos-vscode/src/panel/chronos-panel.ts | head -5
```

- [ ] **Step 4: Typecheck both projects**

```bash
cd chronos-vscode && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p webview/tsconfig.json
```

Expected: clean, both. A circular-import mistake in Step 1 surfaces here.

- [ ] **Step 5: Verify the palette command still works**

```bash
cd chronos-vscode && npm run build && node test/run-ui-test.mjs
```

Expected: `UI TEST OK`. The extraction must not change activation.

- [ ] **Step 6: Commit**

```bash
git add chronos-vscode/src/import/ chronos-vscode/src/extension.ts chronos-vscode/src/panel/webview-protocol.ts chronos-vscode/src/panel/chronos-panel.ts
git commit -m "refactor: extract runImportSourcesFlow, reachable from the panel

One implementation, two entry points — the same shape promptLogin uses.
Keeps executeCommand out of chronos-panel.ts and trims extension.ts,
which was ~980 lines. Adds the importSources webview message."
```

---

### Task 7: Import Sources button — webview

**Files:**
- Modify: `chronos-vscode/webview/components/chronos-app.ts:408` (after the Source `<label>`), `:287` (test seam)
- Verify: `chronos-vscode/webview/styles.css:270-283` (divider ownership)

**Interfaces:**
- Consumes: the `{ type: "importSources" }` member from Task 6.
- Produces: a `.header-btn.import-btn` element and the `clickImport` test action.

- [ ] **Step 1: Add the button**

In `chronos-vscode/webview/components/chronos-app.ts`, the Source control currently ends at `:425` with `</select></label>`. Immediately **after** that closing `</label>` and before the next `<label class="control">` (the Model control), insert:

```ts
          <button
            class="header-btn import-btn ${this.sources.length === 0 ? "is-attn" : ""}"
            title="Import PDFs, images, or text files as sources"
            @click=${() => this.postMessage({ type: "importSources" })}
          >
            Import
          </button>
```

The `is-attn` class already exists and is styled for `.login-btn`; check whether the rule is scoped:

```bash
grep -n "is-attn" chronos-vscode/webview/styles.css
```

If the selector is `.header-btn.login-btn.is-attn`, add `.header-btn.import-btn.is-attn` to the same rule's selector list rather than writing a new rule.

- [ ] **Step 2: Add the test seam**

In the same file, in `runTestAction` (`:260`), add a case beside the existing `clickReopen`:

```ts
      case "clickImport":
        this.querySelector<HTMLButtonElement>(".import-btn")?.click();
        break;
```

- [ ] **Step 3: Typecheck and build**

```bash
cd chronos-vscode && npx tsc --noEmit -p webview/tsconfig.json && npm run build
```

Expected: clean, `Build complete.`

- [ ] **Step 4: Add the UI-test assertion**

In `chronos-vscode/test/run-ui-test.mjs`, following the existing assertion style, add a check that the button renders. Read a nearby example first to copy the harness idiom exactly:

```bash
grep -n "clickReopen\|view-reopen" chronos-vscode/test/run-ui-test.mjs
```

Add an assertion that the dumped webview state or DOM contains a `.import-btn`. Do **not** assert on `clickImport` firing the dialog — `showOpenDialog` is native and cannot be driven from this harness; asserting the click would hang the test on a modal.

- [ ] **Step 5: Run the UI test**

```bash
cd chronos-vscode && node test/run-ui-test.mjs
```

Expected: `UI TEST OK`, with the new Import-button check passing and the pre-existing 18 still passing.

- [ ] **Step 6: Verify the header visually**

This is the step the tests cannot cover. Launch the extension and confirm three things by eye:

1. The Import button sits directly after the Source dropdown and is accented (`is-attn`) when the workspace has no sources.
2. The hairline divider before **Auto-approve** still renders correctly — it is drawn by `.header-controls > .yolo-toggle::before` (`styles.css:270-283`), so inserting a sibling can change which element owns it.
3. Nothing wraps or clips at a narrow panel width. The header is a fixed 41px single row already holding a Collection select, a Source select, a Model select, the context meter and four buttons; `.header-controls` has no `flex-wrap`.

If the header is too crowded, prefer shortening the label to an icon-only `$(add)`-style button over introducing wrapping.

- [ ] **Step 7: Commit**

```bash
git add chronos-vscode/webview/components/chronos-app.ts chronos-vscode/webview/styles.css chronos-vscode/test/run-ui-test.mjs
git commit -m "feat: Import button in the panel header

Import Sources was Command-Palette-only, so a user with the panel open
had no visible way to add sources. Accented via the existing is-attn
treatment while the workspace has none."
```

---

### Task 8: Documentation

**Files:**
- Modify: `DOCS.md`, `chronos-vscode/TESTING.md`, `chronos/package.json`

- [ ] **Step 1: Document the format behaviour in DOCS.md**

Add to the import/sources section of `DOCS.md`:

- Accepted inputs: PDF, PNG, JPG/JPEG, TIF/TIFF, BMP, TXT.
- Every raster is converted to PNG on import; `sources/<name>/png/` contains only `.png`. PNG inputs are copied byte-for-byte.
- A multi-page TIFF imports as one page per page.
- **Disk cost:** JPEG→PNG inflates roughly 4× (measured: a 1.06 MB 300-dpi A4 scan → 4.12 MB). A 500-page JPEG corpus goes ~530 MB → ~2.1 GB.
- Multi-page TIFFs are rendered at page 1's DPI, because mupdf exposes no per-page resolution. A page authored at a higher DPI than page 1 loses detail; the import warns.
- Legacy note: workspaces imported before this change may contain `page_0001.jpg`. Those still work — the viewer and the model path both handle them.

- [ ] **Step 2: Wire the canaries into npm scripts**

`chronos/package.json` currently has only a `build` script, so the three canaries are orphans nobody runs. Add:

```json
"scripts": {
  "build": "tsc",
  "canary": "node scripts/retry-canary.mjs && node scripts/downscale-canary.mjs && node scripts/page-mime-canary.mjs"
}
```

Keep the existing `build` value exactly as it is.

- [ ] **Step 3: Add manual smoke cases to TESTING.md**

Add to `chronos-vscode/TESTING.md`:

- Import a `.jpg` → `sources/<name>/png/page_0001.png` exists, no `.jpg` in `png/`, viewer renders it.
- Import a `.tif` and a `.bmp` → each yields a **non-zero** page count in the Source dropdown (this silently produced a zero-page source before).
- Import a multi-page TIFF → page count equals the TIFF's page count.
- Import a 600-dpi scan → the stored PNG's pixel dimensions match the original, not a DPI-derived shrink.
- Import `scan.jpg` then `scan.png` → two sources (`scan`, `scan-2`), neither silently skipped.
- Open a legacy workspace containing `page_0001.jpg` → viewer renders it and a `task` on that page succeeds.
- Click **Import** in the panel header → same flow as the palette command; the Source dropdown refreshes when it completes.

- [ ] **Step 4: Run the whole gate**

```bash
cd chronos && npm run build && npm run canary
cd ../chronos-vscode && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p webview/tsconfig.json && npm run build
node test/image-convert-test.mjs && node scripts/rpc-spike.mjs && node test/run-ui-test.mjs
```

Expected, in order: `retry canary OK`, `downscale canary OK`, `page mime canary OK`, clean typechecks, `Build complete.`, `IMAGE CONVERT OK`, `SPIKE OK`, `UI TEST OK`.

- [ ] **Step 5: Commit**

```bash
git add DOCS.md chronos-vscode/TESTING.md chronos/package.json
git commit -m "docs: image format behaviour, disk cost, and manual smoke cases

Also wires the three chronos canaries into an npm script — they existed
but nothing ran them."
```

---

## Self-Review

**Spec coverage.** Phase 1 Layer A → Tasks 1–3. Layer B → Task 4. Cleanups (`page-files.ts` fallback, `list-pages.ts` text, `stripExt` collision) → Task 5. Phase 2 → Tasks 6–7. Error handling and disk-cost documentation → Task 8. Testing section → Tasks 1, 2, 4, 7, 8.

The "no whitelist growth" consequence needs no task, correctly: import output is always `.png`, so the four enumeration whitelists keep `png|jpg|jpeg` for legacy files and never need `.tif/.bmp`. Verify this holds by leaving those four sites untouched.

**Deliberately out of scope** (per the spec): the first-run banner, recursive folder import, PDF DPI changes, and migrating existing on-disk `.jpg` files. Phase 0's six blockers are a separate plan.

**Known soft spot.** Task 1 Step 1 depends on sharp being able to author a real multi-page TIFF and a real BMP, which it may not. The step names the ImageMagick fallback and gates Task 2 on having a genuine 2-page TIFF, so this cannot silently produce a test that passes for the wrong reason.

**Type consistency.** `ConvertResult { pagesWritten, warnings }` is introduced in Task 1 and used unchanged in Tasks 2 and 3. `convertImageToPngPages(filePath, outDir, startPage)` keeps one signature throughout. `uniqueSourceName(sourcesDir, base)` is defined and consumed in Task 5 only. `runImportSourcesFlow(workspaceFolder)` is defined in Task 6 and referenced by Task 7's message only, not called directly. `pageCandidatePaths(sourceDir, pageId)` is defined and consumed in Task 5.

**Line-number caveat.** Every citation is as of the `feat/archive-support`-merged tree. Several tasks deliberately open with a `sed`/`grep` read-before-edit step rather than trusting a line number, because that branch has not landed yet and offsets will move.
