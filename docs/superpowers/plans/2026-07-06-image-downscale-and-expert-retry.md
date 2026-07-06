# Image Downscaling + Expert Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the pixel size of every image uploaded to expert vision models, and retry transient expert LLM failures instead of permanently failing the page.

**Architecture:** All model-bound imagery funnels through `pageImageContent()` in `chronos/tools/expert-turn.ts` — a `sharp`-based `downscaleToLimit()` helper caps it there. All expert LLM calls go through the single `complete()` call in the same file — a generic `completeWithRetry()` wrapper (new `chronos/utils/expert-retry.ts`) adds bounded retries + per-attempt timeout. Three new VS Code settings forward as env vars via the existing `agentEnv` pattern.

**Tech Stack:** TypeScript (chronos pi-package, compiled with `tsc` to `dist/`), `sharp` (already a dependency), VS Code extension settings (`chronos-vscode/package.json` + `src/extension.ts`).

**Specs:** `docs/superpowers/specs/2026-07-06-image-downscale-design.md`, `docs/superpowers/specs/2026-07-06-expert-retry-design.md`

## Global Constraints

- **pi loads the agent from `dist/`** — after editing anything under `chronos/{tools,utils}/*.ts`, run `cd chronos && npm run build` or the change has no effect.
- **The working tree contains unrelated uncommitted changes** (archive-support work). `git add` ONLY the exact files listed in each commit step. Never `git add -A` / `git add .`.
- **Commits:** author `Lorenz Hufe <lorenz.hufe@posteo.de>`, NO `Co-Authored-By` trailers (repo convention).
- **Env var names (exact):** `CHRONOS_MAX_IMAGE_DIMENSION`, `CHRONOS_EXPERT_RETRIES`, `CHRONOS_EXPERT_TIMEOUT`. Defaults: 2576 px / 3 retries / 300 s. `0` disables (image cap, retries) or means provider default (timeout).
- **Setting names (exact):** `chronos.maxImageDimension`, `chronos.expertRetries`, `chronos.expertRequestTimeout`.
- `chronos-vscode` esbuild does not type-check; after editing it run `npx tsc --noEmit -p tsconfig.json` from `chronos-vscode/`.
- Canary test scripts live in `chronos/scripts/` (new directory, committed — mirrors `chronos-vscode/scripts/`). They import from `../dist/`, so build before running them.

---

### Task 1: `downscaleToLimit()` helper + canary

**Files:**
- Modify: `chronos/utils/crop-image.ts` (append function at end of file)
- Test: `chronos/scripts/downscale-canary.mjs` (create)

**Interfaces:**
- Consumes: `sharp` (already imported at top of `crop-image.ts`).
- Produces: `export async function downscaleToLimit(png: Buffer, maxDim: number): Promise<Buffer>` — Task 2 imports this from `../utils/crop-image.js`.

- [ ] **Step 1: Write the failing canary**

Create `chronos/scripts/downscale-canary.mjs`:

```js
// Canary for downscaleToLimit (utils/crop-image.ts). Run from chronos/ after
// `npm run build`:  node scripts/downscale-canary.mjs
import sharp from "sharp";
import { downscaleToLimit } from "../dist/utils/crop-image.js";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const make = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 150 } } })
    .png()
    .toBuffer();

// Oversized image is capped on the long edge, aspect ratio preserved.
const big = await make(4000, 3000);
const capped = await downscaleToLimit(big, 2576);
const meta = await sharp(capped).metadata();
assert(meta.width === 2576, `long edge capped to 2576, got ${meta.width}`);
assert(meta.height === 1932, `aspect preserved (3000*2576/4000=1932), got ${meta.height}`);

// Portrait orientation: the LONG edge is capped, whichever axis it is.
const portrait = await make(1000, 4000);
const cappedPortrait = await downscaleToLimit(portrait, 2576);
const metaP = await sharp(cappedPortrait).metadata();
assert(metaP.height === 2576, `portrait long edge capped, got ${metaP.height}`);

// Under-cap image: returned byte-identical (no re-encode cost).
const small = await make(800, 600);
assert((await downscaleToLimit(small, 2576)) === small, "under-cap buffer returned unchanged");

// maxDim 0 disables entirely.
assert((await downscaleToLimit(big, 0)) === big, "maxDim 0 is a no-op");

console.log("downscale canary OK");
```

- [ ] **Step 2: Run canary, verify it fails**

Run: `cd chronos && npm run build && node scripts/downscale-canary.mjs`
Expected: FAIL — `SyntaxError: The requested module ... does not provide an export named 'downscaleToLimit'`

- [ ] **Step 3: Implement `downscaleToLimit`**

Append to `chronos/utils/crop-image.ts`:

```ts
/**
 * Downscale a PNG so its long edge is at most `maxDim` pixels. Returns the
 * input buffer unchanged when it is already within the cap (no re-encode) or
 * when maxDim is 0 (disabled). Aspect ratio is preserved.
 */
export async function downscaleToLimit(png: Buffer, maxDim: number): Promise<Buffer> {
  if (maxDim <= 0) return png;
  const img = sharp(png);
  const { width, height } = await img.metadata();
  if (!width || !height || Math.max(width, height) <= maxDim) return png;
  return img
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}
```

- [ ] **Step 4: Run canary, verify it passes**

Run: `cd chronos && npm run build && node scripts/downscale-canary.mjs`
Expected: `downscale canary OK`

- [ ] **Step 5: Commit**

```bash
cd /home/hufe/Documents/code/chronos
git add chronos/utils/crop-image.ts chronos/scripts/downscale-canary.mjs
git commit --author="Lorenz Hufe <lorenz.hufe@posteo.de>" -m "feat: downscaleToLimit helper caps image long edge with sharp"
```

---

### Task 2: Apply the cap in `pageImageContent()`

**Files:**
- Modify: `chronos/tools/expert-turn.ts` (imports at ~line 17, module consts at ~line 36, `pageImageContent` at lines 74–81)

**Interfaces:**
- Consumes: `downscaleToLimit(png, maxDim)` from Task 1; existing `cropImageToBuffer(imgPath, bbox)` from `chronos/utils/crop-image.ts`; existing `envInt(name, fallback, min, max)` from `chronos/utils/env-config.ts`.
- Produces: `pageImageContent()` behavior change only — signature unchanged, all four call paths (page attachment, `view_page`, `view_region`, `rehydrateToolResult`) get capped images automatically.

- [ ] **Step 1: Change the crop-image import**

In `chronos/tools/expert-turn.ts`, replace:

```ts
import { cropImageToBase64, type Bbox } from "../utils/crop-image.js";
```

with:

```ts
import { cropImageToBuffer, downscaleToLimit, type Bbox } from "../utils/crop-image.js";
```

(`cropImageToBase64` has no other consumers — verified 2026-07-06.)

- [ ] **Step 2: Add the env-configured cap**

Below the `HARD_TOOL_CALL_CEILING` const (~line 36), add:

```ts
// Cap the long edge of every image sent to expert models. Providers resize
// past their own pixel caps anyway (Anthropic: 2576px on Opus 4.7+), so
// larger uploads are pure wasted bandwidth — at batch concurrency they can
// saturate the user's uplink. `chronos.maxImageDimension` setting, forwarded
// as CHRONOS_MAX_IMAGE_DIMENSION; 0 disables. view_region crops are cut from
// the full-resolution file first, so expert zooming keeps full detail.
const MAX_IMAGE_DIMENSION = envInt("CHRONOS_MAX_IMAGE_DIMENSION", 2576, 0, 100_000);
```

- [ ] **Step 3: Route both `pageImageContent` branches through the cap**

Replace the body of `pageImageContent` (lines 74–81):

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

- [ ] **Step 4: Build and integration-check both branches**

```bash
cd /home/hufe/Documents/code/chronos/chronos && npm run build
TMP_SRC=$(mktemp -d) && mkdir -p "$TMP_SRC/png"
TMP_SRC="$TMP_SRC" node --input-type=module -e '
import sharp from "sharp";
await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 200, g: 180, b: 150 } } })
  .png().toFile(process.env.TMP_SRC + "/png/page_0001.png");
console.log("fixture ok");
'
TMP_SRC="$TMP_SRC" CHRONOS_MAX_IMAGE_DIMENSION=1000 node --input-type=module -e '
import sharp from "sharp";
const { pageImageContent } = await import("./dist/tools/expert-turn.js");
const tmp = process.env.TMP_SRC;
const full = await pageImageContent(tmp, 1);
const m1 = await sharp(Buffer.from(full.data, "base64")).metadata();
if (m1.width !== 1000) { console.error("FAIL full-page cap, got", m1.width); process.exit(1); }
const crop = await pageImageContent(tmp, 1, { x: 0, y: 0, w: 0.1, h: 0.1 });
const m2 = await sharp(Buffer.from(crop.data, "base64")).metadata();
if (m2.width !== 400) { console.error("FAIL small crop should be untouched (400px), got", m2.width); process.exit(1); }
console.log("pageImageContent cap OK");
'
```

Expected: `fixture ok`, then `pageImageContent cap OK` (full page capped 4000→1000; the 400 px crop passes through untouched). The env var is read at module load, so `CHRONOS_MAX_IMAGE_DIMENSION` must be set on the node invocation itself, as shown.

- [ ] **Step 5: Commit**

```bash
cd /home/hufe/Documents/code/chronos
git add chronos/tools/expert-turn.ts
git commit --author="Lorenz Hufe <lorenz.hufe@posteo.de>" -m "feat: cap expert image uploads at CHRONOS_MAX_IMAGE_DIMENSION (default 2576px)"
```

---

### Task 3: Retry utility + canary

**Files:**
- Create: `chronos/utils/expert-retry.ts`
- Test: `chronos/scripts/retry-canary.mjs` (create)

**Interfaces:**
- Consumes: nothing project-internal (self-contained; generic over the response shape so the canary needs no pi-ai stubs).
- Produces (Task 4 imports these from `../utils/expert-retry.js`):
  - `interface CompleteLike { stopReason: string; errorMessage?: string }`
  - `completeWithRetry<T extends CompleteLike>(attempt: () => Promise<T>, opts: { retries: number; delayMs?: (retryIndex: number) => number }, signal?: AbortSignal): Promise<{ response: T; attempts: number }>`
  - `isPermanentExpertError(message: string | undefined): boolean`
  - `backoffDelayMs(retryIndex: number, random?: () => number): number`
  - `sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void>`

- [ ] **Step 1: Write the failing canary**

Create `chronos/scripts/retry-canary.mjs`:

```js
// Canary for the expert LLM retry policy (utils/expert-retry.ts). Run from
// chronos/ after `npm run build`:  node scripts/retry-canary.mjs
import {
  backoffDelayMs,
  completeWithRetry,
  isPermanentExpertError,
} from "../dist/utils/expert-retry.js";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}
const tinyDelay = () => 5;

// 1. Success on the first attempt: no retry.
{
  const { response, attempts } = await completeWithRetry(
    async () => ({ stopReason: "stop" }),
    { retries: 3, delayMs: tinyDelay },
  );
  assert(response.stopReason === "stop" && attempts === 1, "success needs one attempt");
}

// 2. Transient errors recover.
{
  let n = 0;
  const { response, attempts } = await completeWithRetry(
    async () => (++n < 3 ? { stopReason: "error", errorMessage: "Request timed out." } : { stopReason: "stop" }),
    { retries: 3, delayMs: tinyDelay },
  );
  assert(response.stopReason === "stop" && attempts === 3, `transient recovers (attempts=${attempts})`);
}

// 3. Permanent error: exactly one attempt.
{
  let n = 0;
  const { response, attempts } = await completeWithRetry(
    async () => {
      n++;
      return { stopReason: "error", errorMessage: "invalid x-api-key" };
    },
    { retries: 3, delayMs: tinyDelay },
  );
  assert(attempts === 1 && n === 1 && response.stopReason === "error", "permanent error not retried");
}

// 4. Retries exhausted: 1 + retries attempts, error returned.
{
  const { response, attempts } = await completeWithRetry(
    async () => ({ stopReason: "error", errorMessage: "Overloaded" }),
    { retries: 3, delayMs: tinyDelay },
  );
  assert(attempts === 4 && response.stopReason === "error", `exhausted after 4 attempts (got ${attempts})`);
}

// 5. "aborted" responses are never retried.
{
  const { attempts } = await completeWithRetry(
    async () => ({ stopReason: "aborted" }),
    { retries: 3, delayMs: tinyDelay },
  );
  assert(attempts === 1, "aborted response returns immediately");
}

// 6. Abort during backoff cuts the wait short.
{
  const ctl = new AbortController();
  const start = Date.now();
  const pending = completeWithRetry(
    async () => ({ stopReason: "error", errorMessage: "Request timed out." }),
    { retries: 3, delayMs: () => 60_000 },
    ctl.signal,
  );
  setTimeout(() => ctl.abort(), 20);
  const { attempts } = await pending;
  assert(Date.now() - start < 5_000, "abort resolves the backoff sleep promptly");
  assert(attempts === 1, "no further attempt after abort");
}

// 7. Classifier + backoff shape.
assert(isPermanentExpertError("401 Unauthorized"), "auth is permanent");
assert(isPermanentExpertError("invalid_request_error: bad schema"), "validation is permanent");
assert(!isPermanentExpertError("Request timed out."), "timeout is transient");
assert(!isPermanentExpertError(undefined), "missing message is transient");
assert(backoffDelayMs(0, () => 0.5) === 2000, "retry 0 midpoint 2s");
assert(backoffDelayMs(1, () => 0.5) === 8000, "retry 1 midpoint 8s");
assert(backoffDelayMs(9, () => 0.5) === 30000, "later retries capped at 30s");

console.log("retry canary OK");
```

- [ ] **Step 2: Run canary, verify it fails**

Run: `cd chronos && node scripts/retry-canary.mjs`
Expected: FAIL — `Cannot find module '.../dist/utils/expert-retry.js'`

- [ ] **Step 3: Implement `chronos/utils/expert-retry.ts`**

```ts
// Retry policy for expert LLM calls.
// See docs/superpowers/specs/2026-07-06-expert-retry-design.md.
//
// pi-ai's complete() reports failures as a *resolved* response with
// stopReason "error" (it does not throw), so the retry wraps that check.
// pi-ai's own maxRetries stays at its default 0 — this is the single retry
// layer; adding SDK-level retries on top would multiply attempts.

/** Minimal shape of a pi-ai AssistantMessage that the retry loop inspects. */
export interface CompleteLike {
  stopReason: string;
  errorMessage?: string;
}

// Auth/validation failures fail identically on every attempt — skip retries
// for those. Everything else (timeouts, 429s, 5xx/529, connection resets,
// unclassifiable messages) is retried: a wasted bounded retry is cheaper than
// permanently losing a page to a transient error.
const PERMANENT_ERROR = /invalid|unauthorized|authentication|api key|permission|not.found|billing/i;

export function isPermanentExpertError(message: string | undefined): boolean {
  return message !== undefined && PERMANENT_ERROR.test(message);
}

// ~2s / 8s / 30s, capped at 30s for later retries; ±25% jitter so a
// 50-expert batch doesn't retry in lockstep.
const BASE_DELAYS_MS = [2_000, 8_000, 30_000];

export function backoffDelayMs(retryIndex: number, random: () => number = Math.random): number {
  const base = BASE_DELAYS_MS[Math.min(retryIndex, BASE_DELAYS_MS.length - 1)];
  return Math.round(base * (0.75 + random() * 0.5));
}

/** Sleep that resolves early (without throwing) when the signal aborts. */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}

export interface RetryResult<T> {
  response: T;
  /** Total attempts made (1 = succeeded or failed without any retry). */
  attempts: number;
}

/**
 * Run `attempt` until it succeeds, fails permanently, is aborted, or retries
 * are exhausted. `retries` counts *re*-attempts after the first try, so the
 * loop makes at most `1 + retries` calls. The last response is returned
 * as-is; the caller keeps its existing stopReason handling.
 */
export async function completeWithRetry<T extends CompleteLike>(
  attempt: () => Promise<T>,
  opts: { retries: number; delayMs?: (retryIndex: number) => number },
  signal?: AbortSignal,
): Promise<RetryResult<T>> {
  const delayMs = opts.delayMs ?? backoffDelayMs;
  const maxAttempts = 1 + Math.max(0, opts.retries);
  let response = await attempt();
  let attempts = 1;
  while (
    attempts < maxAttempts &&
    response.stopReason === "error" &&
    !signal?.aborted &&
    !isPermanentExpertError(response.errorMessage)
  ) {
    await sleepWithAbort(delayMs(attempts - 1), signal);
    if (signal?.aborted) break;
    response = await attempt();
    attempts++;
  }
  return { response, attempts };
}
```

- [ ] **Step 4: Run canary, verify it passes**

Run: `cd chronos && npm run build && node scripts/retry-canary.mjs`
Expected: `retry canary OK`

- [ ] **Step 5: Commit**

```bash
cd /home/hufe/Documents/code/chronos
git add chronos/utils/expert-retry.ts chronos/scripts/retry-canary.mjs
git commit --author="Lorenz Hufe <lorenz.hufe@posteo.de>" -m "feat: retry policy for expert LLM calls (backoff, permanent-error classifier, abort-aware)"
```

---

### Task 4: Wire retry + timeout into the expert loop

**Files:**
- Modify: `chronos/tools/expert-turn.ts` (imports; module consts; the `complete()` call at ~line 259 and the error return just below it)

**Interfaces:**
- Consumes: `completeWithRetry`, `CompleteLike` semantics from Task 3; existing `envInt`; pi-ai `complete()` options `timeoutMs` (verified present in `chronos/node_modules/@earendil-works/pi-ai/dist/types.d.ts:77` — if the compiler rejects it, STOP and bump the pi-ai dep, do not cast).
- Produces: no new exports. Error strings gain an `" (after N attempts)"` suffix when retries happened — `task-batch.ts` passes these through unchanged.

- [ ] **Step 1: Add import and env consts**

Import (with the other util imports near the top):

```ts
import { completeWithRetry } from "../utils/expert-retry.js";
```

Below `MAX_IMAGE_DIMENSION` (added in Task 2):

```ts
// Retry/timeout policy for expert LLM calls (`chronos.expertRetries` /
// `chronos.expertRequestTimeout` settings). The timeout bounds each attempt's
// HTTP request AND stream idleness (pi-ai forwards it to the provider SDK),
// so a stalled upload or dead stream can't hold a batch slot for the SDK's
// 10-minute default. 0 retries / 0 timeout restore the old behavior.
const EXPERT_RETRIES = envInt("CHRONOS_EXPERT_RETRIES", 3, 0, 10);
const EXPERT_TIMEOUT_S = envInt("CHRONOS_EXPERT_TIMEOUT", 300, 0, 3600);
```

- [ ] **Step 2: Wrap the `complete()` call**

Replace (currently at ~lines 259–274):

```ts
    const response = await complete(
      resolved.model,
      {
        systemPrompt: pageExpertPrompt,
        messages: [...session.messages, ...turnMessages],
        tools: toolsEnabled ? expertToolDefs : undefined,
      },
      { apiKey: resolved.apiKey, headers: resolved.headers, signal: input.signal },
    );
    if (response.stopReason === "error") {
      return {
        ok: false,
        taskId,
        error: `Expert model error (${modelSpec(resolved.model)}): ${response.errorMessage ?? "unknown error"}`,
      };
    }
```

with:

```ts
    const { response, attempts } = await completeWithRetry(
      () =>
        complete(
          resolved.model,
          {
            systemPrompt: pageExpertPrompt,
            messages: [...session.messages, ...turnMessages],
            tools: toolsEnabled ? expertToolDefs : undefined,
          },
          {
            apiKey: resolved.apiKey,
            headers: resolved.headers,
            signal: input.signal,
            ...(EXPERT_TIMEOUT_S > 0 ? { timeoutMs: EXPERT_TIMEOUT_S * 1000 } : {}),
          },
        ),
      { retries: EXPERT_RETRIES },
      input.signal,
    );
    if (response.stopReason === "error") {
      const attemptNote = attempts > 1 ? ` (after ${attempts} attempts)` : "";
      return {
        ok: false,
        taskId,
        error: `Expert model error (${modelSpec(resolved.model)}): ${response.errorMessage ?? "unknown error"}${attemptNote}`,
      };
    }
```

Leave the abort check that follows (`if (input.signal?.aborted || response.stopReason === "aborted")`) exactly as it is — `completeWithRetry` never retries an `"aborted"` response, so the existing handling still applies.

- [ ] **Step 3: Build (this is the type-level test)**

Run: `cd chronos && npm run build`
Expected: clean compile. `response` keeps its full `AssistantMessage` type through the generic, so the downstream `turnMessages.push(response)` / `response.usage` / `response.content` code compiles unchanged. If `timeoutMs` is rejected: the build-time pi-ai is older than expected — bump `@earendil-works/pi-ai` in `chronos/package.json` and re-verify; do not cast.

- [ ] **Step 4: Re-run both canaries (regression)**

Run: `cd chronos && node scripts/downscale-canary.mjs && node scripts/retry-canary.mjs`
Expected: `downscale canary OK`, `retry canary OK`

- [ ] **Step 5: Commit**

```bash
cd /home/hufe/Documents/code/chronos
git add chronos/tools/expert-turn.ts
git commit --author="Lorenz Hufe <lorenz.hufe@posteo.de>" -m "feat: expert LLM calls retry transient failures with 300s per-attempt timeout"
```

---

### Task 5: VS Code settings + env forwarding

**Files:**
- Modify: `chronos-vscode/package.json` (`contributes.configuration.properties`, directly after the `chronos.maxConcurrency` block at ~lines 92–98)
- Modify: `chronos-vscode/src/extension.ts` (`agentEnv` object, ~line 758)

**Interfaces:**
- Consumes: env var names from Global Constraints; the settings must default to the SAME values as the `envInt` fallbacks in the agent (2576 / 3 / 300) so an unset setting and a missing env var agree.
- Produces: the three settings visible in VS Code Settings UI; env vars on the pi subprocess.

- [ ] **Step 1: Add the three settings to `package.json`**

Insert after the `chronos.maxConcurrency` property block:

```json
"chronos.maxImageDimension": {
  "type": "integer",
  "default": 2576,
  "minimum": 0,
  "markdownDescription": "Maximum long-edge size in **pixels** for images sent to expert vision models (`task`/`task_batch` page context, `view_page`, `view_region`). Larger images are downscaled before upload — providers resize past their own caps anyway (Anthropic: 2576 px), so bigger uploads only waste bandwidth. Lower values shrink uploads roughly quadratically (1568 ≈ 4× smaller than a typical 3000 px scan) at the cost of full-page detail; experts can still zoom via `view_region`, which crops from the full-resolution file on disk. `0` sends originals untouched. Default: 2576."
},
"chronos.expertRetries": {
  "type": "integer",
  "default": 3,
  "minimum": 0,
  "maximum": 10,
  "markdownDescription": "How many times a failed expert LLM call is retried (exponential backoff ≈2 s/8 s/30 s with jitter) before the page is reported failed. Retries recover pages from transient provider/network failures — timeouts, rate limits, overloads; auth and validation errors are never retried. `0` disables retries. Default: 3."
},
"chronos.expertRequestTimeout": {
  "type": "integer",
  "default": 300,
  "minimum": 0,
  "maximum": 3600,
  "markdownDescription": "Per-attempt timeout in **seconds** for expert LLM calls. Bounds how long a stalled upload or an idle response stream can hold a `task_batch` concurrency slot. `0` uses the provider SDK default (typically 10 minutes). Default: 300."
}
```

- [ ] **Step 2: Forward them in `extension.ts`**

In the `agentEnv` object (after the `CHRONOS_MAX_CONCURRENCY` line):

```ts
CHRONOS_MAX_IMAGE_DIMENSION: String(chronosCfg.get<number>("maxImageDimension", 2576)),
CHRONOS_EXPERT_RETRIES: String(chronosCfg.get<number>("expertRetries", 3)),
CHRONOS_EXPERT_TIMEOUT: String(chronosCfg.get<number>("expertRequestTimeout", 300)),
```

- [ ] **Step 3: Typecheck + build the extension**

Run:
```bash
cd /home/hufe/Documents/code/chronos/chronos-vscode
npx tsc --noEmit -p tsconfig.json
npm run build
node -e 'const p = require("./package.json").contributes.configuration.properties; for (const k of ["chronos.maxImageDimension","chronos.expertRetries","chronos.expertRequestTimeout"]) { if (!p[k]) { console.error("missing", k); process.exit(1); } } console.log("settings present");'
```
Expected: no type errors; build succeeds; `settings present`.

- [ ] **Step 4: Commit**

```bash
cd /home/hufe/Documents/code/chronos
git add chronos-vscode/package.json chronos-vscode/src/extension.ts
git commit --author="Lorenz Hufe <lorenz.hufe@posteo.de>" -m "feat: settings for image cap, expert retries, and request timeout"
```

---

### Task 6: Final verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full builds + canaries from clean state**

```bash
cd /home/hufe/Documents/code/chronos/chronos && npm run build && node scripts/downscale-canary.mjs && node scripts/retry-canary.mjs
cd ../chronos-vscode && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p webview/tsconfig.json && npm run build
```
Expected: both canaries OK, zero type errors, both builds green.

- [ ] **Step 2: Confirm nothing unrelated was staged**

Run: `cd /home/hufe/Documents/code/chronos && git log --oneline -6 && git status --short | head -30`
Expected: the 5 feature commits on top of the two spec commits; the pre-existing archive-support modifications still present and UNSTAGED.
