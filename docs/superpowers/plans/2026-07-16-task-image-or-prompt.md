# Task subagent: arbitrary image or plain task — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the `task` / `task_batch` expert subagents run with an arbitrary image file, with just a prompt (no source), or with a source page as today.

**Architecture:** Add an explicit `image` (path) parameter and make `source` optional. Changes concentrate in `runExpertTurn` and the two tool wrappers; the expert-tools execution layer already tolerates a missing source. A new image loader normalizes any `sharp`-readable file to a downscaled PNG. Per-turn persistence records the image path so image tasks rehydrate across restarts.

**Tech Stack:** TypeScript (Node ESM), `@earendil-works/pi-{ai,coding-agent}`, `@sinclair/typebox` (tool param schemas), `sharp` (image decode/resize), Lit (webview).

## Global Constraints

- **pi loads the agent from `dist/`, not `src`.** After editing anything under `chronos/{tools,utils,http,extensions}/*.ts`, run `cd chronos && npm run build` (= `tsc`) or the change has no effect and does not typecheck. Prompts (`chronos/prompts/*.md`) are read live — no rebuild needed.
- **Webview + host typecheck separately** (esbuild does not typecheck):
  - `cd chronos-vscode && npx tsc --noEmit -p tsconfig.json` (host)
  - `cd chronos-vscode && npx tsc --noEmit -p webview/tsconfig.json` (webview)
- **No unit-test runner in this repo.** Pure helpers are verified with a throwaway node script run against built `dist/`; wiring changes are verified by `tsc`; end-to-end by the manual checklist in `chronos-vscode/TESTING.md`.
- **Commit authorship:** commits are authored as `Lorenz Hufe <lorenz.hufe@posteo.de>`. Do NOT add any `Co-Authored-By: Claude` trailer.
- **Image long-edge cap:** every expert image is downscaled to `CHRONOS_MAX_IMAGE_DIMENSION` (`MAX_IMAGE_DIMENSION` const in `expert-turn.ts`, default 2576px, 0 = disabled). Arbitrary images obey the same cap.
- **Image path scope:** an `image` path resolves **inside the workspace root only** (reject `..`/absolute-outside escapes). Do NOT apply `read_file`'s restricted-dir filter — page images live under `png/` (a restricted dir), and the target must decode as an image anyway.

---

## File Structure

- `chronos/utils/crop-image.ts` — **modify.** Add `loadImageAsPng(imgPath, maxDim)`: read any file, normalize to a downscaled PNG buffer. Pure (only depends on `sharp` + `node:fs`).
- `chronos/tools/expert-tools.ts` — **modify.** Add `hasSource` to `buildExpertTools` (gate `view_page`/`view_region`). Add exported `resolveImagePath(workspaceRoot, p)` (inside-workspace resolver, no restricted-dir filter).
- `chronos/tools/expert-turn.ts` — **modify.** Add `imageFileContent(imgPath)` (mirror of `pageImageContent`). `ExpertTurnInput.source` → optional; new `imagePath?`. Resolve `sourceDir` only when source given; build attached image from `imagePath` else `pageId`; pass `hasSource` to `buildExpertTools`; suppress the `[view p.N]` link for non-page turns; persist/rehydrate `imagePath`.
- `chronos/utils/expert-store.ts` — **modify.** `PersistedTurn` gains `imagePath?: string`.
- `chronos/tools/view-page.ts` — **modify.** `task` tool: `source` optional, new `image` param, validation, sourceless `output_file` base, updated descriptions.
- `chronos/tools/task-batch.ts` — **modify.** `source` optional; `page_ids` optional; new `images` param; item model with `key`/`label`; `{index}`/`{name}` placeholders; sourceless output base.
- `chronos/prompts/task.md`, `chronos/prompts/task-batch.md` — **modify.** Document the new modes.
- `chronos-vscode/webview/components/chronos-chat.ts` — **modify.** `BatchExpertEntry` gains `label?`/`key?`, `page_id` optional; chip renders `label` with `p. N` fallback.

---

## Task 1: `loadImageAsPng` image loader

**Files:**
- Modify: `chronos/utils/crop-image.ts`
- Test (throwaway): `/tmp/claude-1342064982/-home-hufe-Documents-code-chronos/58d0c1ec-f28a-40f6-9384-e4b44dda70ef/scratchpad/test-load-image.mjs`

**Interfaces:**
- Produces: `export async function loadImageAsPng(imgPath: string, maxDim: number): Promise<Buffer>` — returns a PNG-encoded buffer whose long edge is ≤ `maxDim` (0 disables the cap). Throws `Error("Image not found: <path>")` if the file is missing and lets `sharp` errors propagate for undecodable files.

- [ ] **Step 1: Write the failing test**

Create the throwaway test at the scratchpad path above:

```js
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { loadImageAsPng } from "/home/hufe/Documents/code/chronos/chronos/dist/utils/crop-image.js";

const dir = mkdtempSync(join(tmpdir(), "loadimg-"));

// A 100x40 JPEG — non-PNG input to prove format normalization.
const jpgPath = join(dir, "in.jpg");
writeFileSync(jpgPath, await sharp({ create: { width: 100, height: 40, channels: 3, background: "#888" } }).jpeg().toBuffer());

// maxDim below the long edge → downscaled AND re-encoded to PNG.
const capped = await loadImageAsPng(jpgPath, 50);
const capMeta = await sharp(capped).metadata();
assert.equal(capMeta.format, "png", "output must be PNG");
assert.equal(capMeta.width, 50, "long edge downscaled to maxDim");
assert.equal(capMeta.height, 20, "aspect ratio preserved");

// maxDim=0 disables the cap but still yields PNG.
const full = await loadImageAsPng(jpgPath, 0);
const fullMeta = await sharp(full).metadata();
assert.equal(fullMeta.format, "png");
assert.equal(fullMeta.width, 100, "no resize when maxDim=0");

// Missing file → clear error.
await assert.rejects(() => loadImageAsPng(join(dir, "nope.png"), 0), /Image not found/);

console.log("OK");
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/hufe/Documents/code/chronos/chronos && npm run build && \
node /tmp/claude-1342064982/-home-hufe-Documents-code-chronos/58d0c1ec-f28a-40f6-9384-e4b44dda70ef/scratchpad/test-load-image.mjs
```
Expected: FAIL — build errors with `loadImageAsPng` not exported / import throws `SyntaxError: does not provide an export named 'loadImageAsPng'`.

- [ ] **Step 3: Write minimal implementation**

Append to `chronos/utils/crop-image.ts` (after `downscaleToLimit`). Add `existsSync` to the `node:fs` import — currently the file imports only `sharp`, so add the fs import at the top:

```ts
import { existsSync, readFileSync } from "node:fs";
```

```ts
/**
 * Load an arbitrary image file and return it as a PNG buffer whose long edge is
 * at most `maxDim` px (0 = no cap). Always re-encodes to PNG, so any
 * sharp-readable format is accepted. Throws a clear error for a missing file;
 * sharp's own error propagates for an undecodable one.
 */
export async function loadImageAsPng(imgPath: string, maxDim: number): Promise<Buffer> {
  if (!existsSync(imgPath)) throw new Error(`Image not found: ${imgPath}`);
  let img = sharp(readFileSync(imgPath));
  if (maxDim > 0) {
    img = img.resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true });
  }
  return img.png().toBuffer();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/hufe/Documents/code/chronos/chronos && npm run build && \
node /tmp/claude-1342064982/-home-hufe-Documents-code-chronos/58d0c1ec-f28a-40f6-9384-e4b44dda70ef/scratchpad/test-load-image.mjs
```
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
cd /home/hufe/Documents/code/chronos
git add chronos/utils/crop-image.ts
git commit -m "feat: loadImageAsPng normalizes any image to a downscaled PNG"
```
(`chronos/dist/` is gitignored — never stage it; only source `.ts` is committed. This holds for every task below.)

---

## Task 2: `runExpertTurn` — optional source, arbitrary image, persistence

**Files:**
- Modify: `chronos/tools/expert-tools.ts` (add `hasSource` to `buildExpertTools`; add `resolveImagePath`)
- Modify: `chronos/tools/expert-turn.ts` (add `imageFileContent`; input changes; wiring; persistence; restore)
- Modify: `chronos/utils/expert-store.ts` (`PersistedTurn.imagePath`)

**Interfaces:**
- Consumes: `loadImageAsPng(imgPath, maxDim)` (Task 1).
- Produces:
  - `buildExpertTools(opts: { vision: boolean; hasSource: boolean; granted: ExpertCapability[]; output: boolean }): Tool[]` — `view_page`/`view_region` offered only when `vision && hasSource`.
  - `resolveImagePath(workspaceRoot: string, p: string): string` — absolute path inside the workspace; throws `Error("Image path is outside the workspace.")` on escape.
  - `imageFileContent(imgPath: string): Promise<ImageContent>` (in `expert-turn.ts`).
  - `ExpertTurnInput`: `source?: string`; new `imagePath?: string`. `ExpertTurnResult.pageId` is `null` for image/text-only turns.
  - `PersistedTurn.imagePath?: string`.

- [ ] **Step 1: Add `hasSource` to `buildExpertTools` and the `resolveImagePath` resolver**

In `chronos/tools/expert-tools.ts`, change the signature and body of `buildExpertTools`:

```ts
export function buildExpertTools(opts: {
  vision: boolean;
  hasSource: boolean;
  granted: ExpertCapability[];
  output: boolean;
}): Tool[] {
  const tools: Tool[] = [];
  if (opts.vision && opts.hasSource) tools.push(VIEW_REGION_TOOL, VIEW_PAGE_TOOL);
  tools.push(READ_FILE_TOOL, LIST_DIR_TOOL, GREP_TOOL);
  for (const cap of opts.granted) {
    const tool = ELEVATED_TOOLS[cap];
    if (tool && !tools.includes(tool)) tools.push(tool);
  }
  if (opts.output) tools.push(SAVE_OUTPUT_TOOL);
  return tools;
}
```

Add this exported resolver near `resolveInWorkspace` (reuse the existing `resolve`, `relative`, `isAbsolute` imports at the top of the file):

```ts
/**
 * Resolve an `image` path for a task/task_batch call. Like resolveInWorkspace it
 * keeps the target inside the workspace, but deliberately does NOT apply the
 * restricted-dir filter: page images legitimately live under png/, and the
 * anti-secret-leak rationale doesn't apply here because the target must decode
 * as an image (a .env won't). workspaceRoot is the pi cwd / workspace dir.
 */
export function resolveImagePath(workspaceRoot: string, p: string): string {
  const abs = resolve(workspaceRoot, p);
  const rel = relative(workspaceRoot, abs);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error("Image path is outside the workspace.");
  }
  return abs;
}
```

- [ ] **Step 2: Add `imageFileContent` and update `PersistedTurn`**

In `chronos/tools/expert-turn.ts`, import the loader (extend the existing `crop-image.js` import):

```ts
import { cropImageToBuffer, downscaleToLimit, loadImageAsPng, type Bbox } from "../utils/crop-image.js";
```

Add, right after `pageImageContent`:

```ts
/**
 * Build the image content block for an arbitrary image file (not a source page),
 * normalized to a downscaled PNG. Mirrors `pageImageContent`; shared by live
 * turns and session restore so an image task rehydrates from disk.
 */
export async function imageFileContent(imgPath: string): Promise<ImageContent> {
  const png = await loadImageAsPng(imgPath, MAX_IMAGE_DIMENSION);
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}
```

In `chronos/utils/expert-store.ts`, add to `PersistedTurn` (after `sourceDir`):

```ts
  /** Absolute path of an arbitrary attached image (not a source page) — rehydrated from disk. */
  imagePath?: string;
```

- [ ] **Step 3: Make `source` optional and wire the image in `ExpertTurnInput` + `runExpertTurn`**

In `chronos/tools/expert-turn.ts`, update `ExpertTurnInput`:

```ts
export interface ExpertTurnInput {
  /** Collection member ref the expert works on. Optional now — omit for a
   *  sourceless task (no source-scoped view/save tools). */
  source?: string;
  /** Continue an existing session; omit to spawn a new one. */
  taskId?: string;
  prompt: string;
  model?: string;
  /** Attach this source page's image. Requires `source`. */
  pageId?: number;
  bbox?: Bbox;
  /** Attach an arbitrary image by absolute path (pre-resolved by the caller).
   *  Mutually exclusive with pageId. */
  imagePath?: string;
  signal?: AbortSignal;
  grantedCaps?: ExpertCapability[];
  outputPath?: string;
  onProgress?: (progress: ExpertProgress) => void;
}
```

Replace the source-resolution block near the top of `runExpertTurn` (currently unconditional) so a missing source is allowed unless a page needs it:

```ts
  if (input.bbox && input.pageId === undefined) {
    return { ok: false, error: "bbox requires page_id." };
  }
  if (input.pageId !== undefined && !input.source) {
    return { ok: false, error: "page_id requires a source." };
  }

  // Resolve the source up-front only when one is given. It scopes the attached
  // page image and the expert's own view_page/view_region tools.
  let sourceDir: string | undefined;
  if (input.source) {
    try {
      sourceDir = resolveSource(collectionCtx, input.source).path;
    } catch (e) {
      return { ok: false, taskId: input.taskId, error: (e as Error).message };
    }
  }
```

Change the attached-image build block (the `if (input.pageId !== undefined) { … }` around line 236) to prefer `imagePath`:

```ts
  const content: (TextContent | ImageContent)[] = [];
  let pageId: number | null = null;
  if (input.imagePath) {
    try {
      content.push(await imageFileContent(input.imagePath));
    } catch (e) {
      return { ok: false, taskId, error: (e as Error).message };
    }
  } else if (input.pageId !== undefined && sourceDir) {
    pageId = Math.round(input.pageId);
    try {
      content.push(await pageImageContent(sourceDir, pageId, input.bbox));
    } catch (e) {
      return { ok: false, taskId, error: (e as Error).message };
    }
  }
```

Remove the old `const turnSourceDir: string = sourceDir;` line and replace later uses of `turnSourceDir` with `sourceDir` (now `string | undefined`). The two references are: `executeExpertTool({ sourceDir: turnSourceDir, … })` and the `appendExpertTurn({ … sourceDir: turnSourceDir })` call — both accept `string | undefined` already (`ExpertToolContext.sourceDir` and `PersistedTurn.sourceDir` are optional).

Update the `buildExpertTools` call to pass `hasSource`:

```ts
  let expertToolDefs = buildExpertTools({
    vision: resolved.model.input.includes("image"),
    hasSource: !!sourceDir,
    granted: [...granted],
    output: outputMode,
  });
```

Update the model-resolution `hasImage` argument (4th arg of `resolveExpertModel`) so an arbitrary image also demands a vision model:

```ts
  const resolved = await resolveExpertModel(input.model, extCtx.modelRegistry, fallback, pageId !== null || !!input.imagePath);
```

- [ ] **Step 4: Persist and restore the image path**

In `runExpertTurn`, add `imagePath` to the `appendExpertTurn` turn payload (alongside `pageId`/`bbox`/`sourceDir`):

```ts
    prompt: input.prompt,
    pageId: pageId ?? undefined,
    bbox: input.bbox,
    imagePath: input.imagePath,
    sourceDir,
```

In `restoreExpertSessions`, extend the per-turn content rebuild so an image turn rehydrates (place before the existing page branch, since they are mutually exclusive):

```ts
      const content: (TextContent | ImageContent)[] = [];
      if (turn.imagePath) {
        try {
          content.push(await imageFileContent(turn.imagePath));
        } catch {
          // image file no longer on disk — restore this turn text-only
        }
      } else if (turn.pageId !== undefined && turn.sourceDir) {
        try {
          content.push(await pageImageContent(turn.sourceDir, turn.pageId, turn.bbox));
        } catch {
          // page/source no longer on disk — restore this turn text-only
        }
      }
```

- [ ] **Step 5: Typecheck**

```bash
cd /home/hufe/Documents/code/chronos/chronos && npm run build
```
Expected: no errors. (If `tsc` flags an unused `downscaleToLimit`/`cropImageToBuffer`, leave them — they are still used by `pageImageContent`.)

- [ ] **Step 6: Smoke-test the source-optional/image wiring**

Extend the Task 1 smoke script (or a new one) to exercise `buildExpertTools` gating and `resolveImagePath`, run against `dist/`:

```js
import { strict as assert } from "node:assert";
import { buildExpertTools, resolveImagePath } from "/home/hufe/Documents/code/chronos/chronos/dist/tools/expert-tools.js";

const names = (o) => buildExpertTools(o).map((t) => t.name);

// No source → no view_page/view_region even with vision.
const sourceless = names({ vision: true, hasSource: false, granted: [], output: false });
assert.ok(!sourceless.includes("view_page") && !sourceless.includes("view_region"), "sourceless has no view tools");
assert.ok(sourceless.includes("read_file"), "read_file always present");

// Source + vision → view tools present.
const withSource = names({ vision: true, hasSource: true, granted: [], output: false });
assert.ok(withSource.includes("view_page") && withSource.includes("view_region"), "sourced has view tools");

// Path resolver: inside ok, escape throws.
assert.equal(resolveImagePath("/ws", "sources/x/png/page_0001.png"), "/ws/sources/x/png/page_0001.png");
assert.throws(() => resolveImagePath("/ws", "../secret.png"), /outside the workspace/);

console.log("OK");
```

```bash
node /tmp/claude-1342064982/-home-hufe-Documents-code-chronos/58d0c1ec-f28a-40f6-9384-e4b44dda70ef/scratchpad/test-expert-tools.mjs
```
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
cd /home/hufe/Documents/code/chronos
git add chronos/tools/expert-tools.ts chronos/tools/expert-turn.ts chronos/utils/expert-store.ts
git commit -m "feat: runExpertTurn supports optional source and arbitrary image"
```

---

## Task 3: `task` tool — `image` param, optional source, validation

**Files:**
- Modify: `chronos/tools/view-page.ts`
- Modify: `chronos/prompts/task.md`

**Interfaces:**
- Consumes: `runExpertTurn` (`ExpertTurnInput.source?`, `imagePath?`) and `resolveImagePath(workspaceRoot, p)` (Task 2).
- Produces: the `task` tool now accepting `image`, optional `source`.

- [ ] **Step 1: Update `taskParams`**

In `chronos/tools/view-page.ts`, make `source` optional and add `image`. Import `resolveImagePath`:

```ts
import { resolveImagePath, type ExpertCapability } from "./expert-tools.js";
```

Change the `source` field and add `image` after it:

```ts
  source: Type.Optional(
    Type.String({
      description:
        "Collection member ref the expert works on (see the catalog in the system prompt). " +
        "Optional: required only when you pass page_id, or when the expert should have source-scoped " +
        "view_page/view_region. Omit for a task on an arbitrary `image` or a plain (text-only) task.",
    }),
  ),
  image: Type.Optional(
    Type.String({
      description:
        "Attach an arbitrary image file by path (workspace-relative, inside the workspace). Use this for " +
        "a picture that is not a cataloged source page. Mutually exclusive with page_id. Any common image " +
        "format is accepted (normalized to PNG, downscaled to the image cap). A missing/undecodable file " +
        "fails the task.",
    }),
  ),
```

- [ ] **Step 2: Add validation + image resolution in `execute`**

In `execute`, after the `grant` confirmation block and before the `output_file` resolution, add:

```ts
      if (params.image && params.page_id !== undefined) {
        return {
          content: [{ type: "text", text: "`image` and `page_id` are mutually exclusive — pass only one." }],
          details: {},
        };
      }
      if (params.page_id !== undefined && !params.source) {
        return {
          content: [{ type: "text", text: "`page_id` requires a `source`." }],
          details: {},
        };
      }
      let imagePath: string | undefined;
      if (params.image) {
        try {
          imagePath = resolveImagePath(collectionCtx.workspaceDir, params.image);
        } catch (e) {
          return { content: [{ type: "text", text: (e as Error).message }], details: {} };
        }
      }
```

- [ ] **Step 3: Resolve `output_file` with/without source**

Replace the existing `output_file` resolution block so a sourceless task writes workspace-relative:

```ts
      let outputPath: string | undefined;
      if (params.output_file) {
        if (params.source) {
          try {
            outputPath = join(requireSourceDataDir(collectionCtx, params.source), params.output_file);
          } catch {
            outputPath = undefined;
          }
        } else {
          // Sourceless: treat output_file as a workspace-relative path.
          try {
            outputPath = resolveImagePath(collectionCtx.workspaceDir, params.output_file);
          } catch {
            outputPath = undefined;
          }
        }
      }
```

(Reusing `resolveImagePath` here is deliberate: it is a generic "resolve inside the workspace" check — not image-specific — so the sourceless output file is kept inside the workspace by the same rule.)

- [ ] **Step 4: Pass `imagePath` into `runExpertTurn`**

In the `runExpertTurn(...)` call, add `imagePath` and note `source`/`page_id` may be undefined (already the case):

```ts
      const result = await runExpertTurn(registry, collectionCtx, pageExpertPrompt, extCtx, {
        source: params.source,
        taskId: params.task_id,
        prompt: params.prompt,
        model: params.model,
        pageId: params.page_id,
        bbox: params.bbox,
        imagePath,
        signal,
        grantedCaps: grant,
        outputPath,
        onProgress: /* unchanged */ onUpdate ? (p) => onUpdate({ /* unchanged */
```

(Leave the `onProgress` body unchanged.)

- [ ] **Step 5: Guard `sourceRel` for the sourceless case**

The success-path `sourceRel` block calls `resolveSource(collectionCtx, params.source)`. With `source` now optional, guard it so a sourceless task doesn't throw:

```ts
      let sourceRel = "";
      if (params.source) {
        try {
          sourceRel = relative(collectionCtx.workspaceDir, resolveSource(collectionCtx, params.source).path);
        } catch {
          sourceRel = "";
        }
      }
```

(`pageId === null` for image/text-only turns already suppresses the `[view p.N]` link, so no further change there.)

- [ ] **Step 6: Typecheck**

```bash
cd /home/hufe/Documents/code/chronos/chronos && npm run build
```
Expected: no errors.

- [ ] **Step 7: Update `task.md` description**

In `chronos/prompts/task.md`, revise the opening so it documents the three modes. Replace the first two sentences with:

```
Talk to an expert model in a persistent conversation. Give it work in one of three ways: (1) pass `source` + `page_id` to attach a cataloged source page (scopes the expert's view_page/view_region to that source); (2) pass `image` to attach an arbitrary image file by path (workspace-relative), for a picture that is not a source page — mutually exclusive with page_id; (3) pass neither for a plain text-only task. `source` is optional and only needed for mode (1) or to give the expert source-scoped view tools. bbox requires page_id. If `output_file` is set without a source, it is written at that workspace-relative path; with a source it is written in the source's data dir (as before).
```

Leave the rest of the file (task_id, model, output_file, chronos_page guidance) intact.

- [ ] **Step 8: Commit**

```bash
cd /home/hufe/Documents/code/chronos
git add chronos/tools/view-page.ts chronos/prompts/task.md
git commit -m "feat: task tool accepts arbitrary image and optional source"
```

---

## Task 4: `task_batch` — image list, optional source, item model

**Files:**
- Modify: `chronos/tools/task-batch.ts`
- Modify: `chronos/prompts/task-batch.md`

**Interfaces:**
- Consumes: `runExpertTurn` (`imagePath?`, `source?`), `resolveImagePath` (Task 2).
- Produces: `ExpertEntry` / `LiveExpertEntry` gain `key: string` and `label: string`; `page_id` becomes optional (present only on page batches). The tool result `details.experts` entries carry `key`/`label`/optional `page_id`.

- [ ] **Step 1: Update `taskBatchParams`**

In `chronos/tools/task-batch.ts`, make `source`/`page_ids` optional and add `images`. Import `resolveImagePath`:

```ts
import { resolveImagePath, type ExpertCapability } from "./expert-tools.js";
```

```ts
  source: Type.Optional(
    Type.String({
      description:
        "Collection member ref every expert in this batch works on. Required when using page_ids; " +
        "optional (and unused) when using images.",
    }),
  ),
  page_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Spawn one expert per page id (file-system indices, not printed page numbers). Requires `source`. " +
        "Provide EITHER page_ids OR images, not both.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Spawn one expert per arbitrary image file path (workspace-relative). Source-independent. " +
        "Provide EITHER page_ids OR images, not both.",
    }),
  ),
```

Update the `output_file` description to cover both placeholder schemes:

```ts
  output_file: Type.Optional(
    Type.String({
      description:
        "Filename template. For a page batch use {page_id} (zero-padded), written in the source data dir. " +
        "For an image batch use {index} (1-based, zero-padded) and/or {name} (image basename without " +
        "extension), written workspace-relative. Each expert writes its own result via save_output (JSON " +
        "validated). If omitted, results are returned inline.",
    }),
  ),
```

- [ ] **Step 2: Build the item list and validate**

Replace the top of `execute` (the `resolveSource` + `pageIds` derivation, roughly lines 116–131) with an item model. Each item has a `key` (stable, used for maps/sorting), a `label` (display), an optional `pageId`, and an optional pre-resolved `imagePath`:

```ts
      interface BatchItem { key: string; label: string; sortIndex: number; pageId?: number; imagePath?: string; }

      const usePages = Array.isArray(params.page_ids) && params.page_ids.length > 0;
      const useImages = Array.isArray(params.images) && params.images.length > 0;
      if (usePages === useImages) {
        return {
          content: [{ type: "text", text: "Provide exactly one of `page_ids` or `images` (non-empty)." }],
          details: {},
        };
      }
      if (usePages && !params.source) {
        return { content: [{ type: "text", text: "`page_ids` requires a `source`." }], details: {} };
      }

      let member: import("./collection-context.js").CollectionMember | undefined;
      let sourceRel: string | undefined;
      if (params.source) {
        try {
          member = resolveSource(collectionCtx, params.source);
          sourceRel = relative(collectionCtx.workspaceDir, member.path);
        } catch (e) {
          if (usePages) return { content: [{ type: "text", text: (e as Error).message }], details: {} };
          // image batch: a bad source ref is harmless (source unused) — ignore it.
        }
      }

      const outputFileTemplate = params.output_file;
      const bbox = params.bbox as Bbox | undefined;

      // Validate the output template against the chosen mode.
      if (outputFileTemplate) {
        if (usePages && !outputFileTemplate.includes("{page_id}")) {
          return { content: [{ type: "text", text: "output_file must contain {page_id} for a page batch." }], details: {} };
        }
        if (useImages && !outputFileTemplate.includes("{index}") && !outputFileTemplate.includes("{name}")) {
          return { content: [{ type: "text", text: "output_file must contain {index} and/or {name} for an image batch." }], details: {} };
        }
      }

      const items: BatchItem[] = [];
      if (usePages) {
        params.page_ids!.forEach((raw, i) => {
          const pageId = Math.round(raw);
          items.push({ key: `p${pageId}`, label: `p. ${pageId}`, sortIndex: i, pageId });
        });
      } else {
        for (let i = 0; i < params.images!.length; i++) {
          let imagePath: string;
          try {
            imagePath = resolveImagePath(collectionCtx.workspaceDir, params.images![i]);
          } catch (e) {
            return { content: [{ type: "text", text: `${params.images![i]}: ${(e as Error).message}` }], details: {} };
          }
          const base = params.images![i].replace(/\\/g, "/").split("/").pop() ?? params.images![i];
          items.push({ key: `img${i}`, label: base, sortIndex: i, imagePath });
        }
      }
```

- [ ] **Step 3: Generalize `ExpertEntry` / `LiveExpertEntry`**

Update the two interfaces at the top of the file. `page_id` becomes optional; add `key`/`label`:

```ts
interface ExpertEntry {
  key: string;
  label: string;
  taskId?: string;
  page_id?: number;
  status: "ok" | "error";
  response?: string;
  file?: string;
  noOutput?: boolean;
  error?: string;
  cost?: number;
  toolUses?: ExpertToolUse[];
}

interface LiveExpertEntry extends Omit<ExpertEntry, "status"> {
  status: "queued" | "running" | "ok" | "error";
  activity?: string;
}
```

- [ ] **Step 4: Rework the live map, `runOne`, worker pool, and reporting to key off items**

Replace the `live` map init (line ~157) to key by `item.key`:

```ts
      const live = new Map<string, LiveExpertEntry>(
        items.map((it) => [it.key, { key: it.key, label: it.label, page_id: it.pageId, status: "queued" }]),
      );
```

In `emitNow`, change the sort/derivation to use `label`/`sortIndex`. Since entries no longer sort by `page_id`, keep a `sortIndex` lookup:

```ts
        const order = new Map(items.map((it) => [it.key, it.sortIndex]));
        const entries = [...live.values()]
          .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
          .map((e) => ({ ...e }));
```

Rewrite `runOne` to take a `BatchItem`:

```ts
      const runOne = async (item: BatchItem): Promise<ExpertEntry> => {
        const filename = outputFileTemplate
          ? outputFileTemplate
              .replace("{page_id}", item.pageId !== undefined ? String(item.pageId).padStart(4, "0") : "")
              .replace("{index}", String(item.sortIndex + 1).padStart(4, "0"))
              .replace("{name}", item.label.replace(/\.[^.]+$/, ""))
          : undefined;
        const outputPath = filename
          ? item.pageId !== undefined && member
            ? join(member.dataDir, filename)
            : join(collectionCtx.workspaceDir, filename)
          : undefined;
        const entry = live.get(item.key)!;
        entry.status = "running";
        scheduleEmit();
        const input: ExpertTurnInput = {
          source: params.source,
          prompt: params.prompt,
          model: params.model,
          pageId: item.pageId,
          bbox: item.pageId !== undefined ? bbox : undefined,
          imagePath: item.imagePath,
          signal,
          grantedCaps: grant,
          outputPath,
          onProgress: (p) => {
            if (p.taskId) entry.taskId = p.taskId;
            entry.activity =
              p.phase === "tool"
                ? `${p.lastTool} · ${p.toolCalls} tool ${p.toolCalls === 1 ? "call" : "calls"}`
                : p.toolCalls > 0
                  ? `thinking · ${p.toolCalls} tool ${p.toolCalls === 1 ? "call" : "calls"}`
                  : "thinking";
            scheduleEmit();
          },
        };
        const result = await runExpertTurn(registry, collectionCtx, pageExpertPrompt, extCtx, input);
        let final: ExpertEntry;
        const skel = { key: item.key, label: item.label, page_id: item.pageId };
        if (!result.ok) {
          final = { ...skel, status: "error", error: result.error };
        } else {
          resolvedModel = result.model;
          if (outputFileTemplate) {
            final = result.wroteOutput
              ? { ...skel, taskId: result.taskId, status: "ok", file: filename, cost: result.cost, toolUses: result.toolUses }
              : { ...skel, taskId: result.taskId, status: "ok", noOutput: true, cost: result.cost, toolUses: result.toolUses };
          } else {
            final = { ...skel, taskId: result.taskId, status: "ok", response: result.text || "(empty response)", cost: result.cost, toolUses: result.toolUses };
          }
        }
        live.set(item.key, { ...final });
        scheduleEmit();
        return final;
      };
```

Update the worker pool to iterate `items` instead of `pageIds`:

```ts
      const queue = [...items];
      if (onUpdate) emitNow();
      const workers: Promise<void>[] = [];
      for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push(
          (async () => {
            while (queue.length > 0) {
              if (signal?.aborted) return;
              const item = queue.shift()!;
              experts.push(await runOne(item));
            }
          })(),
        );
      }
      await Promise.all(workers);
      progressClosed = true;
      if (emitTimer) clearTimeout(emitTimer);
      const orderFinal = new Map(items.map((it) => [it.key, it.sortIndex]));
      experts.sort((a, b) => (orderFinal.get(a.key) ?? 0) - (orderFinal.get(b.key) ?? 0));
```

Also update the confirm-grant scope string and the two `pageIds.length` references to `items.length`, and the earlier "No page IDs" guard is now covered by the exactly-one check (remove the old `if (pageIds.length === 0)` block). The grant call becomes:

```ts
      if (grant.length > 0 && !(await confirmExpertGrant(extCtx, grant, `all ${items.length} experts in this batch`))) {
```

- [ ] **Step 5: Update the final summary + return details to use `label`**

Replace `pageIds.length` with `items.length` in the summary line, and the per-expert report lines to use `label`:

```ts
      const lines = [
        `Batch complete: ${okCount}/${items.length} succeeded` +
          (errCount > 0 ? `, ${errCount} failed` : "") +
          (noOutputCount > 0 ? `, ${noOutputCount} produced no output` : "") +
          (totalCost > 0 ? ` [total cost: $${totalCost.toFixed(4)}]` : ""),
        "",
        ...experts.map((e) =>
          e.status !== "ok"
            ? `(failed) ${e.label}: ${e.error}`
            : e.noOutput
              ? `(no output) ${e.label}: expert never called save_output — no file written [${e.taskId}]`
              : `${e.taskId} ⇒ ${e.label}${e.file ? ` → ${e.file}` : ""}`,
        ),
        "",
        "Follow up on any item with task(task_id, prompt).",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { model: resolvedModel, prompt: params.prompt, bbox: bbox ?? null, source: sourceRel, experts },
      };
```

Also update the two `emitNow` `details` objects' `source` to the now-optional `sourceRel` (already a variable) — no change needed if `sourceRel` is in scope; ensure the live `emitNow` `details.source` still reads `sourceRel` (it does).

- [ ] **Step 6: Typecheck**

```bash
cd /home/hufe/Documents/code/chronos/chronos && npm run build
```
Expected: no errors.

- [ ] **Step 7: Update `task-batch.md`**

In `chronos/prompts/task-batch.md`, update the first paragraph to document that a batch runs over EITHER `page_ids` (requires `source`) OR `images` (arbitrary paths, source-independent), and the output_file placeholder rules (`{page_id}` for pages; `{index}`/`{name}` for images). Keep the entire "ABSOLUTE AND NON-NEGOTIABLE PROTOCOL" section verbatim. Replace only the first sentence group:

```
Spawn one expert per item in parallel — a batch version of the `task` tool. The batch runs over EITHER `page_ids` (one expert per source page; requires `source`) OR `images` (one expert per arbitrary image file path, workspace-relative; source-independent) — provide exactly one of the two. The same prompt is sent to every item; each becomes its own persistent expert session with its own `task_id` for follow-up via `task(task_id, …)`. Each expert self-directs and is READ-ONLY by default. With `output_file`, each expert writes its own result via save_output: use a {page_id} placeholder for a page batch (written in the source data dir) or {index} (1-based, zero-padded) and/or {name} (image basename) for an image batch (written workspace-relative).
```

- [ ] **Step 8: Commit**

```bash
cd /home/hufe/Documents/code/chronos
git add chronos/tools/task-batch.ts chronos/prompts/task-batch.md
git commit -m "feat: task_batch runs over page_ids or arbitrary images, source optional"
```

---

## Task 5: Webview — render batch item labels

**Files:**
- Modify: `chronos-vscode/webview/components/chronos-chat.ts`

**Interfaces:**
- Consumes: `details.experts` entries now carry `key`/`label` and optional `page_id` (Task 4).
- Produces: batch chips + expert-turn cards display `label`, falling back to `p. N`.

- [ ] **Step 1: Widen `BatchExpertEntry`**

In `chronos-chat.ts` (interface at line ~150) make `page_id` optional and add `key`/`label`:

```ts
interface BatchExpertEntry {
  taskId?: string;
  key?: string;
  label?: string;
  page_id?: number;
  status: "queued" | "running" | "ok" | "error";
  response?: string;
  file?: string;
  error?: string;
  toolUses?: ExpertToolUse[];
  activity?: string;
}
```

- [ ] **Step 2: Render the chip label with fallback**

In `renderBatchChip` (line ~1170) replace the page span:

```ts
        <span class="expert-chip-page">${e.label ?? (e.page_id != null ? `p. ${e.page_id}` : "—")}</span>
```

- [ ] **Step 3: Typecheck the webview**

```bash
cd /home/hufe/Documents/code/chronos/chronos-vscode && npx tsc --noEmit -p webview/tsconfig.json
```
Expected: no errors. (The `entry.page_id` read at line ~903 stays valid — it is now `number | undefined`, and the `expertTurns` `pageId` field is already optional.)

- [ ] **Step 4: Build the extension**

```bash
cd /home/hufe/Documents/code/chronos/chronos-vscode && npm run build
```
Expected: esbuild completes with no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/hufe/Documents/code/chronos
git add chronos-vscode/webview/components/chronos-chat.ts
git commit -m "feat: batch chips show item label (page or image) in the webview"
```

---

## Task 6: Manual end-to-end smoke

**Files:** none (verification only).

- [ ] **Step 1: Rebuild both packages**

```bash
cd /home/hufe/Documents/code/chronos/chronos && npm run build
cd /home/hufe/Documents/code/chronos/chronos-vscode && npm run build
```

- [ ] **Step 2: Confirm the local pi points at this working copy**

Confirm `~/.pi/agent/settings.json` `packages` includes the absolute path to this repo's `chronos/` dir (per CLAUDE.md). Sessions snapshot at startup — restart the Chronos session/extension after building so the new tools load.

- [ ] **Step 3: Exercise the five paths (manual, per `chronos-vscode/TESTING.md`)**

Verify each and note the observed result:
1. `task` with `image` pointing at a workspace image file → expert answers about that image; no `[view p.N]` link; result has a `task_id`.
2. `task` with only a `prompt` (no `source`, no `image`) → expert answers; no source-scoped tools offered.
3. `task` with `source` + `page_id` (regression) → unchanged behavior, `[view p.N]` link present.
4. `task_batch` with `images: [...]` (2–3 workspace images) → one expert per image; chips show image basenames; follow-up via `task(task_id)` works.
5. Restart the session, then follow up on the image `task` from (1) via its `task_id` → the image rehydrates (expert still "sees" it) or degrades to text-only if the file was removed.

- [ ] **Step 4: Final verification note**

Record the outcomes in the PR/commit description. If any path fails, do NOT claim completion — file the discrepancy and fix before finishing.
