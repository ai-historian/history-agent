# feat/archive-support Blocker Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six logic blockers (plus two that fixing blocker 6 makes reachable) so `feat/archive-support` can land in `dev` without carrying known silently-corrupting behaviour.

**Architecture:** Six independent fixes, ordered cheapest-and-most-isolated first. Four are in the pi-package (`chronos/`) and tested with node canaries that import `chronos/dist/`, matching the existing `retry-canary.mjs` convention. Two are in the extension (`chronos-vscode/`) and tested by bundling the module under test with esbuild's JS API. The final task runs the full landing gate and merges into `dev`.

**Tech Stack:** TypeScript, Node `AbortController`/`AbortSignal`, esbuild, `@earendil-works/pi-ai` (runtime 0.80.2), VS Code extension API, Lit 3.

## Global Constraints

- Design decisions for every fix are recorded in [the blocker spec](../specs/2026-07-28-archive-support-blockers-design.md). Do not re-decide them; if a decision looks wrong, stop and raise it.
- **Deferred and explicitly out of scope** — do not fix these here: collection-name path sanitization beyond what task 6 gives for free, the `all`/`All` sentinel collision, `/select-collection` newline injection, batch robustness, `chronos.piAgentDir`, stale `CLAUDE.md`/`DOCS.md`/`README.md`, `.expert-chip-task` CSS, `rpc-spike`'s missing `--skill`, unwired canaries.
- **pi loads the agent from `chronos/dist/`.** After any change under `chronos/`, run `cd chronos && npm run build` or the canaries test stale code.
- **esbuild does not type-check.** After extension/webview changes run both `npx tsc --noEmit -p tsconfig.json` and `-p webview/tsconfig.json`.
- `chronos/` and `chronos-vscode/` are **independent builds with no shared code**. `chronos-vscode/tsconfig.json` has `rootDir: "src"`, so importing from `../chronos` is not possible. Duplication is the established convention (`protocol.ts`, `discoverSources`) — but see task 7, which deliberately avoids a third duplication.
- Every fix ships a test that **fails before the fix**. Green existing tests are not evidence: all eight gates already pass on this branch. **One explicit exemption: task 1**, which changes only user-facing text and deletes files — it has no runtime behaviour to assert, and is verified by the full gate plus the ignore-rule check in its own steps. No other task is exempt.
- No test may assert a literal constant. If the property under test is "this terminated rather than hanging", express it as a watchdog race, not `check(name, true)`.
- Commit as `Lorenz Hufe <lorenz.hufe@posteo.de>`. No `Co-Authored-By: Claude` trailers.
- Work on `fix/archive-support-blockers`. Do not commit to `master`.

## Landing gate

Referred to below as "the full gate". Every command must pass:

```bash
cd chronos && npm run build && node scripts/retry-canary.mjs && node scripts/downscale-canary.mjs
cd ../chronos-vscode && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p webview/tsconfig.json && npm run build
node scripts/rpc-spike.mjs && node test/run-ui-test.mjs
```

Plus every canary added by this plan.

## File Structure

**Created:**
- `chronos/scripts/timeout-canary.mjs` — asserts a hung attempt is aborted, retried, and distinguished from a user cancel.
- `chronos/scripts/collection-canary.mjs` — asserts source-ref ambiguity, `output_file` placement, `change_source` persistence, and collection id/name round-trip.
- `chronos-vscode/test/collection-id-test.mjs` — asserts the host's collection discovery exposes a filename-derived id.

**Modified:**
- `chronos/utils/expert-retry.ts` — per-attempt timeout-as-abort, `try`/`catch`, timeout-vs-user-abort (task 2).
- `chronos/tools/expert-turn.ts` — pass the per-attempt signal; correct the false comment; `output_file` base dir is not this file (task 2, 3).
- `chronos/tools/view-page.ts` — `output_file` base dir honours the inherited source (task 3).
- `chronos/tools/collection-context.ts` — ambiguity check in `resolveByAlias`; stale doc comment (task 4).
- `chronos/utils/session-collection-store.ts` — `extraMembers` (task 5).
- `chronos/utils/session-source-store.ts` — **deleted** (task 5).
- `chronos/tools/change-source.ts`, `chronos/extensions/index.ts` — persist and replay additions (task 5); collection `id` (task 6).
- `chronos/utils/collection-manifest.ts` — `id` separate from `name` (task 6).
- `chronos-vscode/src/panel/sources.ts` — `id` on `CollectionInfo` (task 6).
- `chronos-vscode/webview/components/chronos-app.ts` — option value is `id` (task 6).
- `chronos-vscode/src/panel/webview-protocol.ts` — `collections` carries `id` (task 6).
- `chronos-vscode/src/panel/chronos-panel.ts` — `sourceDir → dataKey` lookup (task 7).
- `chronos-vscode/walkthroughs/setup.md`, `chronos-vscode/src/workspace-templates.ts`, `.gitignore` — cleanups (task 1).

---

### Task 1: Cheap cleanups — user-facing text and prior-run findings

**Files:**
- Modify: `chronos-vscode/walkthroughs/setup.md`, `chronos-vscode/src/workspace-templates.ts:22`, `.gitignore`, `chronos/tools/task-batch.ts:157`, `chronos/utils/crop-image.ts`
- Delete: `memory/MEMORY.MD`, `chronos-vscode/memory/MEMORY.MD`

**Interfaces:** none — no code contract changes.

**Note:** this is the plan's one task exempt from the failing-test-first rule (see Global Constraints). It changes user-facing text, one parameter description, and factors out a duplicated options literal — no runtime behaviour to assert. It is verified by the full gate plus the ignore-rule check in Step 5.

- [ ] **Step 1: Confirm the defects**

```bash
cd /home/hufe/Documents/code/chronos
tail -c 60 chronos-vscode/walkthroughs/setup.md | cat -A | tail -3
grep -n "resa resume" chronos-vscode/src/workspace-templates.ts
git ls-files | grep "MEMORY.MD"
grep -n "memory" .gitignore
```

Expected: a literal `<<<<` on the final line with no trailing `$`; the typo at line 22; two tracked `MEMORY.MD` paths; no `memory` rule in `.gitignore`.

- [ ] **Step 2: Strip the conflict-marker remnant**

Remove the final `<<<<` line from `chronos-vscode/walkthroughs/setup.md` and ensure the file ends with a single trailing newline. This text renders in the VS Code Getting Started walkthrough.

- [ ] **Step 3: Fix the typo seeded into every workspace**

In `chronos-vscode/src/workspace-templates.ts:22`, change `design for resa resume` to `design for resume`. This string is written verbatim into `skills/trace-entity/SKILL.md` in every new workspace and is read by the model.

- [ ] **Step 4: Remove the 0-byte artifacts and stop them returning**

```bash
git rm memory/MEMORY.MD chronos-vscode/memory/MEMORY.MD
```

These are artifacts of `chronos/utils/workspace.ts`'s `ensureWorkspace(ctx.cwd)` running with cwd = repo root and cwd = `chronos-vscode/` during development. Nothing reads a repo-relative `memory/MEMORY.MD` — the workspace-side reader resolves against the session cwd.

Then add to `.gitignore`, so a dev run cannot silently re-commit them:

```
# Workspace artifacts from dev-running the agent inside the repo
/memory/
/chronos-vscode/memory/
```

- [ ] **Step 5: Verify they are now ignored**

```bash
mkdir -p memory && touch memory/MEMORY.MD && git status --porcelain memory/ && echo "(empty above = ignored)"
```

Expected: no output before the echo. Then `rm -rf memory`.

- [ ] **Step 6: Fold in two findings the previous SDD run left unresolved**

Both were recorded as Minor in `.superpowers/sdd/progress.md` and never fixed.

**(a) `chronos/tools/task-batch.ts:157`** — the `source` parameter description says it is "optional (and unused) when using images", but a valid `source` in an image batch *is* forwarded (it enables that item's view tools). This misleads the orchestrating model. Read it and tighten the wording to say that `source`, when supplied with `images`, enables the view tools for those items:

```bash
sed -n '150,165p' chronos/tools/task-batch.ts
```

**(b) `chronos/utils/crop-image.ts`** — `loadImageAsPng` (~`:72-80`) duplicates the resize options literal from `downscaleToLimit` (~`:55-64`) verbatim. Factor the shared `{ width, height, fit: "inside", withoutEnlargement: true }` construction into one small local helper used by both. Behaviour must not change: `downscaleToLimit` still returns its input untouched when already within the cap or when `maxDim <= 0`, and `loadImageAsPng` still always re-encodes.

Read both functions before editing:

```bash
sed -n '50,85p' chronos/utils/crop-image.ts
```

- [ ] **Step 7: Build and run the full gate**

Run the full gate from the top of this plan. Expected: everything passes exactly as it did before. `downscale-canary.mjs` is the specific guard on Step 6(b) — it must still pass, since it covers `downscaleToLimit`'s no-op-when-within-cap behaviour.

- [ ] **Step 8: Commit**

```bash
git add chronos-vscode/walkthroughs/setup.md chronos-vscode/src/workspace-templates.ts .gitignore chronos/tools/task-batch.ts chronos/utils/crop-image.ts
git commit -m "fix: strip conflict marker from the walkthrough, fix seeded typo

setup.md ended with a literal <<<< that renders in the VS Code Getting
Started walkthrough. workspace-templates.ts wrote 'design for resa
resume' into every new workspace's SKILL.md. Also drops the two 0-byte
MEMORY.MD files committed by dev-running the agent inside the repo, and
ignores those paths so they cannot come back.

Folds in two Minor findings the previous SDD run left unresolved: the
task_batch source description claimed source is unused with images (it is
forwarded, enabling that item's view tools), and loadImageAsPng
duplicated downscaleToLimit's resize options literal."
```

---

### Task 2: Blocker 6 — timeout as abort, with try/catch and timeout-vs-user-abort

**Files:**
- Modify: `chronos/utils/expert-retry.ts`, `chronos/tools/expert-turn.ts:44-50` (comment) and `:353-371` (call)
- Test: `chronos/scripts/timeout-canary.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: **a breaking signature change.** `completeWithRetry<T extends CompleteLike>(attempt: (signal?: AbortSignal) => Promise<T>, opts: { retries: number; timeoutMs?: number; delayMs?: (retryIndex: number) => number }, signal?: AbortSignal): Promise<RetryResult<T>>` where `RetryResult<T> = { response: T; attempts: number; timedOut: boolean }`. `attempt` now **receives** the per-attempt composed signal and must use it instead of the caller's signal.

**Why:** `providers/google.js`, `google-shared.js` and `google-vertex.js` in the installed pi-ai never reference `timeoutMs`; they honour only `signal`. So the 300s timeout is a no-op on Gemini and a stalled expert holds its batch slot forever — `retries` cannot help, because the loop blocks on an attempt that never resolves.

- [ ] **Step 1: Write the failing canary**

Create `chronos/scripts/timeout-canary.mjs`:

```js
// Asserts the expert retry layer bounds each attempt with an abort (the only
// mechanism every provider honours — Google's SDK ignores timeoutMs entirely),
// retries a timed-out attempt, distinguishes it from a user cancel, and
// survives an attempt that THROWS instead of resolving (Google throws
// "Request aborted" when the signal is already aborted on entry).
const { completeWithRetry } = await import("../dist/utils/expert-retry.js");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
};
const ok = { stopReason: "stop" };
const fast = () => 1; // no real backoff in tests

// 1. A hung attempt is aborted by the timeout rather than hanging forever.
//    Raced against a watchdog: without a per-attempt timeout this call never
//    settles, so the watchdog is what actually asserts the fix.
{
  let seen = 0;
  const WATCHDOG_MS = 5_000;
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("attempt hung — no per-attempt timeout")), WATCHDOG_MS);
  });
  let res;
  let hung = false;
  try {
    res = await Promise.race([
      completeWithRetry(
        (signal) => {
          seen++;
          // Never resolves on its own; only the abort ends it.
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve({ stopReason: "aborted" }));
          });
        },
        { retries: 2, timeoutMs: 30, delayMs: fast },
      ),
      watchdog,
    ]);
  } catch (e) {
    hung = true;
  } finally {
    clearTimeout(timer);
  }
  check("hung attempt is aborted, not left hanging", hung === false,
        `did not settle within ${WATCHDOG_MS}ms`);
  check("hung attempt is retried to exhaustion", seen === 3, `attempts=${seen}`);
  check("result reports timedOut", res?.timedOut === true, JSON.stringify(res));
}

// 2. A timeout does not consume the permanent-error path and is not reported
//    as a user abort.
{
  let seen = 0;
  const res = await completeWithRetry(
    (signal) => {
      seen++;
      if (seen === 1) {
        return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ stopReason: "aborted" })));
      }
      return Promise.resolve(ok);
    },
    { retries: 3, timeoutMs: 30, delayMs: fast },
  );
  check("timeout then success -> success", res.response.stopReason === "stop", JSON.stringify(res.response));
  check("timeout then success -> 2 attempts", res.attempts === 2, `attempts=${res.attempts}`);
}

// 3. A USER abort stops immediately and is not retried.
{
  const ac = new AbortController();
  let seen = 0;
  ac.abort();
  const res = await completeWithRetry(
    () => { seen++; return Promise.resolve({ stopReason: "aborted" }); },
    { retries: 3, timeoutMs: 1000, delayMs: fast },
    ac.signal,
  );
  check("user abort -> single attempt", seen === 1, `attempts=${seen}`);
  check("user abort -> timedOut false", res.timedOut === false, JSON.stringify(res));
}

// 4. A THROWING attempt is retried, not propagated, while retries remain.
{
  let seen = 0;
  const res = await completeWithRetry(
    () => { seen++; if (seen < 3) return Promise.reject(new Error("Request aborted")); return Promise.resolve(ok); },
    { retries: 3, timeoutMs: 1000, delayMs: fast },
  );
  check("throwing attempt is retried", res.response.stopReason === "stop", JSON.stringify(res.response));
  check("throwing attempt counted", res.attempts === 3, `attempts=${res.attempts}`);
}

// 5. An attempt that throws on EVERY try surfaces as an error response, not an
//    uncaught exception.
{
  let threw = false;
  let res;
  try {
    res = await completeWithRetry(
      () => Promise.reject(new Error("Request aborted")),
      { retries: 1, timeoutMs: 1000, delayMs: fast },
    );
  } catch { threw = true; }
  check("exhausted throwing attempts do not escape", threw === false);
  check("exhausted throwing attempts report stopReason error",
        res?.response?.stopReason === "error", JSON.stringify(res?.response));
  check("error message is preserved",
        /Request aborted/.test(res?.response?.errorMessage ?? ""), res?.response?.errorMessage);
}

// 6. A permanent error is still not retried.
{
  let seen = 0;
  const res = await completeWithRetry(
    () => { seen++; return Promise.resolve({ stopReason: "error", errorMessage: "invalid api key" }); },
    { retries: 3, timeoutMs: 1000, delayMs: fast },
  );
  check("permanent error -> single attempt", seen === 1, `attempts=${seen}`);
}

// 7. timeoutMs omitted or 0 disables the timeout (no spurious aborts).
{
  const res = await completeWithRetry(() => Promise.resolve(ok), { retries: 1, delayMs: fast });
  check("no timeoutMs -> success, timedOut false",
        res.response.stopReason === "stop" && res.timedOut === false, JSON.stringify(res));
}

console.log(failures === 0 ? "\ntimeout canary OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Build and run to verify it fails**

```bash
cd chronos && npm run build && node scripts/timeout-canary.mjs
```

Expected: FAIL. Check 1 will **hang** (no timeout exists yet) — if it hangs rather than failing, that itself confirms the bug; kill it with Ctrl-C and proceed. Once implemented it must complete.

- [ ] **Step 3: Rewrite `completeWithRetry`**

In `chronos/utils/expert-retry.ts`, replace `RetryResult` and `completeWithRetry` (lines 51-84) with:

```ts
export interface RetryResult<T> {
  response: T;
  /** Total attempts made (1 = succeeded or failed without any retry). */
  attempts: number;
  /** True when the final attempt ended because its per-attempt timeout fired. */
  timedOut: boolean;
}

interface AttemptOutcome<T> {
  response?: T;
  /** Message from an attempt that threw instead of resolving. */
  threw?: string;
  timedOut: boolean;
}

/**
 * Run one attempt bounded by `timeoutMs`, composed with the caller's
 * user-cancel signal.
 *
 * The timeout is expressed as an ABORT, not as pi-ai's `timeoutMs` option:
 * the Google/Vertex providers ignore `timeoutMs` entirely and honour only
 * `signal`, so an abort is the one mechanism that works on every provider.
 */
async function runAttempt<T extends CompleteLike>(
  attempt: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
  userSignal: AbortSignal | undefined,
): Promise<AttemptOutcome<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const onUserAbort = () => controller.abort();
  userSignal?.addEventListener("abort", onUserAbort);
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  try {
    return { response: await attempt(controller.signal), timedOut };
  } catch (e) {
    // Google throws `new Error("Request aborted")` when the signal is already
    // aborted on entry, breaking pi-ai's usual resolve-with-stopReason
    // contract. Treat a throw like a failed response so it stays retryable.
    return { threw: e instanceof Error ? e.message : String(e), timedOut };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    userSignal?.removeEventListener("abort", onUserAbort);
  }
}

/**
 * Run `attempt` until it succeeds, fails permanently, is cancelled by the user,
 * or retries are exhausted. `retries` counts *re*-attempts, so at most
 * `1 + retries` calls are made. Each attempt is bounded by `opts.timeoutMs`
 * (0 or omitted = unbounded).
 *
 * A timed-out attempt is retryable and is NOT reported as a user abort: the
 * loop tests the user's own signal, never the composed per-attempt one.
 */
export async function completeWithRetry<T extends CompleteLike>(
  attempt: (signal?: AbortSignal) => Promise<T>,
  opts: { retries: number; timeoutMs?: number; delayMs?: (retryIndex: number) => number },
  signal?: AbortSignal,
): Promise<RetryResult<T>> {
  const delayMs = opts.delayMs ?? backoffDelayMs;
  const timeoutMs = opts.timeoutMs ?? 0;
  const maxAttempts = 1 + Math.max(0, opts.retries);

  let outcome = await runAttempt(attempt, timeoutMs, signal);
  let attempts = 1;

  while (attempts < maxAttempts && !signal?.aborted && isRetryable(outcome)) {
    await sleepWithAbort(delayMs(attempts - 1), signal);
    if (signal?.aborted) break;
    outcome = await runAttempt(attempt, timeoutMs, signal);
    attempts++;
  }

  return { response: finalResponse(outcome), attempts, timedOut: outcome.timedOut };
}

function isRetryable<T extends CompleteLike>(o: AttemptOutcome<T>): boolean {
  if (o.timedOut) return true;
  if (o.threw !== undefined) return !isPermanentExpertError(o.threw);
  return o.response?.stopReason === "error" && !isPermanentExpertError(o.response.errorMessage);
}

// An attempt that only ever threw has no response object to return. Synthesize
// the shape pi-ai would have produced so callers keep their stopReason handling
// and nothing escapes as an uncaught exception.
function finalResponse<T extends CompleteLike>(o: AttemptOutcome<T>): T {
  if (o.response !== undefined) return o.response;
  return { stopReason: "error", errorMessage: o.threw ?? "expert call failed" } as unknown as T;
}
```

- [ ] **Step 4: Build and run the canary to verify it passes**

```bash
cd chronos && npm run build && node scripts/timeout-canary.mjs
```

Expected: all checks PASS, `timeout canary OK`, and it terminates promptly.

- [ ] **Step 5: Update the call site and correct the false comment**

`chronos/tools/expert-turn.ts:353-371` currently passes `signal: input.signal` to `complete` and drops `timeoutMs` into the options. Change the closure to take the per-attempt signal, and move the timeout into `completeWithRetry`:

```ts
    const { response, attempts } = await completeWithRetry(
      (attemptSignal) =>
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
            signal: attemptSignal,
          },
        ),
      { retries: EXPERT_RETRIES, timeoutMs: EXPERT_TIMEOUT_S * 1000 },
      input.signal,
    );
```

Note `timeoutMs` no longer goes to pi-ai at all — remove the
`...(EXPERT_TIMEOUT_S > 0 ? { timeoutMs: ... } : {})` spread.

Then replace the comment at `expert-turn.ts:44-50`. It currently claims the
timeout "bounds each attempt's HTTP request AND stream idleness (pi-ai forwards
it to the provider SDK)", which is false. Replace with:

```ts
// Per-attempt wall-clock budget, overridable as CHRONOS_EXPERT_TIMEOUT; 0
// disables. Enforced by ABORTING the attempt, not via pi-ai's timeoutMs
// option: the Google/Vertex providers ignore timeoutMs entirely and honour
// only `signal`, so an abort is the only mechanism that bounds every
// provider. A timed-out attempt is retried and is reported distinctly from a
// user cancel.
```

- [ ] **Step 6: Check how a timeout now surfaces to the user**

`expert-turn.ts:384` reads roughly `if (input.signal?.aborted || response.stopReason === "aborted")` and reports "Expert turn aborted." A timed-out attempt that exhausted its retries must not be reported as a user cancel. Read the surrounding block and thread `timedOut` through:

```bash
sed -n '378,395p' chronos/tools/expert-turn.ts
```

Capture `timedOut` from the `completeWithRetry` result and, when it is true and `input.signal?.aborted` is false, report a timeout with the budget — e.g. `Expert turn timed out after ${EXPERT_TIMEOUT_S}s per attempt (${attempts} attempts).` Keep the user-cancel message for a genuine user abort.

- [ ] **Step 7: Verify no caller relied on the old throw behaviour**

```bash
grep -rn "completeWithRetry" chronos/ --include=*.ts | grep -v dist
grep -n "try {" chronos/tools/task-batch.ts | head
```

Confirm `expert-turn.ts` is the only caller. `completeWithRetry` no longer throws for a failed attempt, so any `try`/`catch` around it becomes dead for that case — leave existing catches in place (they still guard other throws) but do not add new ones.

- [ ] **Step 8: Run the full gate**

Run the full gate, plus `node scripts/timeout-canary.mjs`. Expected: all pass, including the pre-existing `retry-canary.mjs` — its `attempt` closures take no arguments, which is still valid for a function whose parameter is optional. If `retry-canary.mjs` fails, its expectations encoded the old signature; update it rather than reverting the design.

- [ ] **Step 9: Commit**

```bash
git add chronos/utils/expert-retry.ts chronos/tools/expert-turn.ts chronos/scripts/timeout-canary.mjs
git commit -m "fix: enforce the expert timeout by aborting, not pi-ai timeoutMs

The Google and Vertex providers never reference timeoutMs and honour only
signal, so the 300s budget was a silent no-op on Gemini — a stalled
expert held its batch slot forever and retries could not help, because
the loop blocked on an attempt that never resolved.

Each attempt now gets its own AbortController composed with the user's
cancel signal. A timed-out attempt stays retryable (the loop tests the
user signal, never the composed one) and is reported distinctly from a
user cancel. Attempts that THROW instead of resolving are also retried
and converted to an error response, since Google throws when the signal
is pre-aborted — previously that would have escaped uncaught."
```

---

### Task 3: Blocker 1 — `output_file` on a follow-up escapes to the workspace root

**Files:**
- Modify: `chronos/tools/view-page.ts:139-149`
- Test: `chronos/scripts/collection-canary.mjs` (created here, extended by tasks 4–6)

**Interfaces:**
- Consumes: `resolveSource`, `requireSourceDataDir` from `chronos/tools/collection-context.ts`.
- Produces: no signature change.

**Why:** `expert-turn.ts:240` makes a `task_id` follow-up inherit `session.sourceRef`, but `view-page.ts` picks the output base dir from `params.source` alone and falls back to `collectionCtx.workspaceDir`. So re-running an extraction to fix a column writes the file to the workspace root, leaves the original stale, and reports success.

- [ ] **Step 1: Write the failing canary**

Create `chronos/scripts/collection-canary.mjs`:

```js
// Asserts collection-context invariants that no other test covers.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createCollectionContext, resolveSource, requireSourceDataDir } =
  await import("../dist/tools/collection-context.js");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
};

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "ch-coll-"));
  mkdirSync(join(ws, "sources"), { recursive: true });
  return ws;
}
function makeSource(ws, rel) {
  const p = join(ws, "sources", rel);
  mkdirSync(join(p, "png"), { recursive: true });
  writeFileSync(join(p, "png", "page_0001.png"), Buffer.alloc(8));
  return p;
}

// --- Task 3: output_file resolution for an inherited source -----------------
// A task_id follow-up inherits session.sourceRef, so the output dir must follow
// the EFFECTIVE source, not only an explicitly-passed one. Falling back to the
// workspace root writes a follow-up's output outside the source's data dir
// while the expert still views the inherited source.
{
  const { outputBaseDir } = await import("../dist/tools/view-page.js");
  const ws = workspace();
  const p = makeSource(ws, "Frankfurt_1864");
  const ctx = createCollectionContext(ws);
  const dataDir = join(ws, "data", "Frankfurt_1864");
  ctx.members.set("Frankfurt_1864", { ref: "Frankfurt_1864", path: p, dataDir });

  check("explicit source -> its data dir",
        outputBaseDir(ctx, "Frankfurt_1864", undefined) === dataDir,
        outputBaseDir(ctx, "Frankfurt_1864", undefined));

  // THE BUG: no explicit source, but the session remembers one.
  check("inherited source -> its data dir (not the workspace root)",
        outputBaseDir(ctx, undefined, "Frankfurt_1864") === dataDir,
        `got ${outputBaseDir(ctx, undefined, "Frankfurt_1864")} — workspace root is ${ws}`);

  check("explicit wins over inherited",
        outputBaseDir(ctx, "Frankfurt_1864", "Other") === dataDir);

  // A genuine plain task (no source anywhere) still targets the workspace root.
  check("no source at all -> workspace root",
        outputBaseDir(ctx, undefined, undefined) === ws,
        outputBaseDir(ctx, undefined, undefined));

  // An unresolvable ref yields "" so runExpertTurn reports the source error.
  check("unresolvable ref -> empty string",
        outputBaseDir(ctx, "Nope", undefined) === "",
        outputBaseDir(ctx, "Nope", undefined));
}

console.log(failures === 0 ? "\ncollection canary OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

Note the unused-import cleanup: `requireSourceDataDir` is imported at the top of the canary but only used indirectly now — keep the import only if a later task's checks use it, otherwise drop it.

- [ ] **Step 2: Build and run it to verify it fails**

```bash
cd chronos && npm run build && node scripts/collection-canary.mjs
```

Expected: FAIL — `outputBaseDir is not a function` (it does not exist yet). After Step 4 introduces it, the `inherited source -> its data dir` check is the one that must flip from failing to passing; it is the blocker.

- [ ] **Step 3: Read the current output_file block**

```bash
sed -n '130,165p' chronos/tools/view-page.ts
grep -n "effectiveSource\|sourceRef" chronos/tools/expert-turn.ts | head
```

Confirm the mismatch: `view-page.ts` branches on `params.source`; `expert-turn.ts` computes `effectiveSource = input.source ?? session?.sourceRef`.

- [ ] **Step 4: Make the output dir follow the effective source**

The fix must resolve the same source the expert will actually view. `view-page.ts` needs the session's remembered ref for a `task_id` follow-up. Locate how it can obtain it — the expert store is `chronos/utils/expert-store.ts`:

```bash
grep -n "export" chronos/utils/expert-store.ts
grep -n "task_id\|taskId" chronos/tools/view-page.ts | head
```

Extract the decision into an **exported pure function** so it is directly
testable (the canary in Step 1 imports it), then call it from the `output_file`
block:

```ts
/**
 * Base dir for a task's `output_file`.
 *
 * An explicit `source` wins; otherwise a task_id follow-up inherits the
 * session's remembered source (mirroring expert-turn.ts's `effectiveSource`).
 * Only a genuine plain task — no source anywhere, a supported mode — targets
 * the workspace root. Returns "" for a ref that does not resolve, so
 * runExpertTurn reports the source error rather than writing somewhere else.
 */
export function outputBaseDir(
  ctx: CollectionContext,
  explicitSource: string | undefined,
  inheritedSource: string | undefined,
): string {
  const effective = explicitSource ?? inheritedSource;
  if (!effective) return ctx.workspaceDir;
  try {
    return requireSourceDataDir(ctx, effective);
  } catch {
    return "";
  }
}
```

Then in the `output_file` block replace the whole `let baseDir = ""; if (params.source) {…} else {…}` sequence with:

```ts
        const baseDir = outputBaseDir(collectionCtx, params.source, sessionSourceRef(params.task_id));
```

Implement `sessionSourceRef(taskId)` as a small local (non-exported) helper reading the persisted expert session's `sourceRef` via `expert-store.ts`, returning `undefined` when there is no `task_id` or no stored source. Import `CollectionContext` as a type if it is not already imported.

**Also fold in a prior-run finding** recorded in the SDD ledger: `view-page.ts:61-69`'s `output_file` parameter description says the path is relative to "the source data directory" only, which is stale for the sourceless workspace-relative mode — and this change makes it actively wrong for the inherited-source case too. Update that description so the model reading the schema in isolation gets the real rule: relative to the source's data dir when a source is in effect (explicit or inherited), otherwise the workspace root.

- [ ] **Step 5: Typecheck, build, and run all canaries**

```bash
cd chronos && npm run build && node scripts/collection-canary.mjs && node scripts/timeout-canary.mjs && node scripts/retry-canary.mjs && node scripts/downscale-canary.mjs
```

Expected: all OK.

- [ ] **Step 6: Commit**

```bash
git add chronos/tools/view-page.ts chronos/scripts/collection-canary.mjs
git commit -m "fix: follow-up output_file follows the inherited source

A task_id follow-up inherits the session's source for viewing, but the
output dir was chosen from params.source alone and fell back to the
workspace root. Re-running an extraction wrote the file outside the
source's data dir, left the original stale, and reported success."
```

---

### Task 4: Blocker 2 — `resolveSource` silently picks the first basename match

**Files:**
- Modify: `chronos/tools/collection-context.ts:91-100` (`resolveByAlias`), `:130-131` (stale comment)
- Test: `chronos/scripts/collection-canary.mjs`

**Interfaces:**
- Consumes: `createCollectionContext`, `resolveSource` from task 3's canary setup.
- Produces: `resolveSource` now **throws** on an ambiguous bare basename instead of returning the first match. No signature change.

**Why:** `resolveByAlias` returns the first member whose `basename(m.path)` equals the ref, with no ambiguity check. With `sources/frankfurt/Adressbuch_1864` and `sources/mainz/Adressbuch_1864`, `source: "Adressbuch_1864"` silently resolves to whichever sorts first — and `dataKeyForRef` then writes the extraction into that source's `data/` dir. For a provenance tool, a silently-wrong source is the worst failure class available. `resolveExpertModel` already errors on an ambiguous bare model id; mirror it.

- [ ] **Step 1: Write the failing checks**

Insert into `chronos/scripts/collection-canary.mjs` before the final `console.log`:

```js
// --- Task 4: ambiguous bare basenames must error, not guess -----------------
{
  const ws = workspace();
  const a = makeSource(ws, join("frankfurt", "Adressbuch_1864"));
  const b = makeSource(ws, join("mainz", "Adressbuch_1864"));
  const ctx = createCollectionContext(ws);
  ctx.members.set("frankfurt/Adressbuch_1864",
    { ref: "frankfurt/Adressbuch_1864", path: a, dataDir: join(ws, "data", "frankfurt--Adressbuch_1864") });
  ctx.members.set("mainz/Adressbuch_1864",
    { ref: "mainz/Adressbuch_1864", path: b, dataDir: join(ws, "data", "mainz--Adressbuch_1864") });

  let msg = "";
  try { resolveSource(ctx, "Adressbuch_1864"); } catch (e) { msg = e.message; }
  check("ambiguous basename throws", msg !== "", "resolved silently instead of throwing");
  check("ambiguous error names both refs",
        msg.includes("frankfurt/Adressbuch_1864") && msg.includes("mainz/Adressbuch_1864"), msg);

  // An exact ref still resolves.
  check("exact ref still resolves",
        resolveSource(ctx, "mainz/Adressbuch_1864").path === b);
}

// An UNambiguous basename must still resolve — the lenient alias is a feature.
{
  const ws = workspace();
  const p = makeSource(ws, join("city", "Frankfurt_1864"));
  const ctx = createCollectionContext(ws);
  ctx.members.set("city/Frankfurt_1864",
    { ref: "city/Frankfurt_1864", path: p, dataDir: join(ws, "data", "city--Frankfurt_1864") });
  check("unambiguous basename still resolves",
        resolveSource(ctx, "Frankfurt_1864").path === p);
}
```

- [ ] **Step 2: Build and run to verify the new checks fail**

```bash
cd chronos && npm run build && node scripts/collection-canary.mjs
```

Expected: FAIL — `ambiguous basename throws — resolved silently instead of throwing`.

- [ ] **Step 3: Add the ambiguity check**

Replace `resolveByAlias` (`chronos/tools/collection-context.ts:91-100`) with:

```ts
// Lenient fallback so the agent can pass the human-obvious name. Mirrors the
// /select-source match (exact ref → basename → workspace-relative path).
//
// A bare basename shared by two members is AMBIGUOUS and must not be guessed:
// nested sources keep distinct refs but can share a basename, and silently
// picking one writes the extraction into the wrong source's data dir. Mirrors
// resolveExpertModel, which errors on an ambiguous bare model id.
function resolveByAlias(ctx: CollectionContext, ref: string): CollectionMember | undefined {
  const byBasename = [...ctx.members.values()].filter((m) => basename(m.path) === ref);
  if (byBasename.length > 1) {
    const refs = byBasename.map((m) => m.ref).sort().join(", ");
    throw new Error(
      `Source "${ref}" is ambiguous — it matches ${byBasename.length} members: ${refs}. ` +
        `Pass the full ref instead.`,
    );
  }
  if (byBasename.length === 1) return byBasename[0];

  const norm = ref.replace(/\\/g, "/").replace(/^\.?\/?sources\//, "").replace(/\/+$/, "");
  for (const m of ctx.members.values()) {
    if (m.ref === norm) return m;
  }
  return undefined;
}
```

- [ ] **Step 4: Fix the stale doc comment**

`collection-context.ts:130-131` claims "dataKey stays `basename(path)`", but line 142 calls `dataKeyForRef`. Correct it to describe the actual behaviour: flat sources use `basename(path)`, nested refs are slugged via `toSlug`.

- [ ] **Step 5: Run all canaries**

```bash
cd chronos && npm run build && node scripts/collection-canary.mjs && node scripts/timeout-canary.mjs && node scripts/retry-canary.mjs && node scripts/downscale-canary.mjs
```

Expected: all OK.

- [ ] **Step 6: Verify the agent still starts**

```bash
cd chronos-vscode && node scripts/rpc-spike.mjs
```

Expected: `SPIKE OK`. `resolveByAlias` now throws, and `resolveSource` is called during tool execution — this confirms nothing on the startup path resolves an ambiguous ref.

- [ ] **Step 7: Commit**

```bash
git add chronos/tools/collection-context.ts chronos/scripts/collection-canary.mjs
git commit -m "fix: error on an ambiguous bare source basename

resolveByAlias returned the first member whose basename matched, so two
nested sources sharing a basename were indistinguishable — the agent
silently got one and wrote its extraction into that source's data dir.
Mirrors resolveExpertModel, which already errors on an ambiguous id."
```

---

### Task 5: Blocker 3 — `change_source` additions evaporate on resume

**Files:**
- Modify: `chronos/utils/session-collection-store.ts`, `chronos/tools/change-source.ts`, `chronos/extensions/index.ts` (~`:244-248`)
- Delete: `chronos/utils/session-source-store.ts`
- Test: `chronos/scripts/collection-canary.mjs`

**Interfaces:**
- Consumes: `createCollectionContext` from task 3's canary setup.
- Produces: `saveSessionExtraMember(workspaceDir: string, sessionId: string, sourcePath: string): void` and `loadSessionExtraMembers(workspaceDir: string, sessionId: string): string[]` from `session-collection-store.ts`. `Selection` becomes `{ name?: string; extraMembers?: string[] }`.

**Why:** `change-source.ts` mutates the in-memory catalog only, while `buildCollectionFromDiscovery` clears and repopulates from `sources/` on **every** `session_start` — startup, switch, resume and fork. An out-of-tree source is wiped with nothing to restore it from, so refs the agent was told to use start throwing mid-conversation.

**Design trap:** `saveSessionCollection(ws, id, null)` currently *deletes the whole entry* to mean "auto-collection". Hanging `extraMembers` off that entry naively would make selecting "All sources" wipe the user's added sources.

- [ ] **Step 1: Write the failing checks**

Insert into `chronos/scripts/collection-canary.mjs` before the final `console.log`:

```js
// --- Task 5: change_source additions survive a session_start ---------------
{
  const store = await import("../dist/utils/session-collection-store.js");
  const ws = workspace();
  const out = makeSource(ws, "InTree");
  const sid = "sess-1";

  store.saveSessionExtraMember(ws, sid, "/mnt/archive/Koeln_1871");
  check("extra member persists", store.loadSessionExtraMembers(ws, sid).includes("/mnt/archive/Koeln_1871"),
        JSON.stringify(store.loadSessionExtraMembers(ws, sid)));

  store.saveSessionExtraMember(ws, sid, "/mnt/archive/Koeln_1871");
  check("extra member add is idempotent", store.loadSessionExtraMembers(ws, sid).length === 1,
        JSON.stringify(store.loadSessionExtraMembers(ws, sid)));

  // THE TRAP: selecting a named collection then "all sources" must not wipe them.
  store.saveSessionCollection(ws, sid, "frankfurt");
  check("name and extraMembers coexist",
        store.loadSessionCollection(ws, sid) === "frankfurt" &&
        store.loadSessionExtraMembers(ws, sid).length === 1);

  store.saveSessionCollection(ws, sid, null);
  check("selecting all-sources clears name but KEEPS extra members",
        store.loadSessionCollection(ws, sid) === undefined &&
        store.loadSessionExtraMembers(ws, sid).length === 1,
        `name=${store.loadSessionCollection(ws, sid)} extras=${JSON.stringify(store.loadSessionExtraMembers(ws, sid))}`);

  // A legacy entry written as {name} must still read.
  const legacy = workspace();
  mkdirSync(join(legacy, ".chronos"), { recursive: true });
  writeFileSync(join(legacy, ".chronos", "session-collections.json"),
    JSON.stringify({ "sess-old": { name: "mainz" } }));
  check("legacy {name} entry still reads",
        store.loadSessionCollection(legacy, "sess-old") === "mainz");
  check("legacy entry has no extra members",
        store.loadSessionExtraMembers(legacy, "sess-old").length === 0);

  // Unknown sessions are empty, not undefined.
  check("unknown session -> empty array",
        Array.isArray(store.loadSessionExtraMembers(ws, "nope")) &&
        store.loadSessionExtraMembers(ws, "nope").length === 0);
  void out;
}
```

- [ ] **Step 2: Build and run to verify it fails**

```bash
cd chronos && npm run build && node scripts/collection-canary.mjs
```

Expected: FAIL — `store.saveSessionExtraMember is not a function`.

- [ ] **Step 3: Extend the store**

In `chronos/utils/session-collection-store.ts`, change `Selection` and add the two functions. Replace lines 16-18 with:

```ts
interface Selection {
  /** The named collection, absent for the auto "all sources" collection. */
  name?: string;
  /** Absolute source dirs added this session via change_source. */
  extraMembers?: string[];
}

/** True when an entry carries nothing worth keeping. */
function isEmptySelection(s: Selection | undefined): boolean {
  return !s || (s.name === undefined && (s.extraMembers === undefined || s.extraMembers.length === 0));
}
```

Replace `saveSessionCollection` (lines 43-54) with a version that clears only `name`:

```ts
export function saveSessionCollection(workspaceDir: string, sessionId: string, name: string | null): void {
  if (!sessionId) return;
  const store = readStore(workspaceDir);
  const entry: Selection = store[sessionId] ?? {};
  if (name === null) {
    // Auto-collection. Clear only the name — extraMembers added via
    // change_source must survive, or selecting "All sources" would silently
    // drop every out-of-tree source the user added this session.
    if (entry.name === undefined) return;
    delete entry.name;
  } else {
    if (entry.name === name) return;
    entry.name = name;
  }
  if (isEmptySelection(entry)) delete store[sessionId];
  else store[sessionId] = entry;
  writeStore(workspaceDir, store);
}
```

And append:

```ts
/**
 * Remember an out-of-tree source added this session via change_source.
 * buildCollectionFromDiscovery repopulates from sources/ on every session_start
 * (startup, switch, resume, fork), so without this the addition is lost and the
 * refs the agent was told to use start throwing mid-conversation.
 */
export function saveSessionExtraMember(workspaceDir: string, sessionId: string, sourcePath: string): void {
  if (!sessionId || !sourcePath) return;
  const store = readStore(workspaceDir);
  const entry: Selection = store[sessionId] ?? {};
  const existing = entry.extraMembers ?? [];
  if (existing.includes(sourcePath)) return;
  entry.extraMembers = [...existing, sourcePath];
  store[sessionId] = entry;
  writeStore(workspaceDir, store);
}

/** Out-of-tree source dirs added in this session (empty when none). */
export function loadSessionExtraMembers(workspaceDir: string, sessionId: string): string[] {
  if (!sessionId) return [];
  const entry = readStore(workspaceDir)[sessionId];
  const extras = entry?.extraMembers;
  return Array.isArray(extras) ? extras.filter((p): p is string => typeof p === "string") : [];
}
```

- [ ] **Step 4: Persist from `change_source`**

In `chronos/tools/change-source.ts`, after the idempotent `ctx.members.set(...)` (around line 53-55), persist the addition. The tool's `execute` receives `extCtx`, so the session id is available the same way `index.ts` obtains it — check the shape first:

```bash
grep -n "sessionManager\|getSessionId" chronos/tools/*.ts chronos/extensions/index.ts | head
```

Add the `saveSessionExtraMember(workspaceDir, sessionId, sourcePath)` call. If `extCtx` exposes no session id, thread it the way `index.ts:110` did on master (`ctx.sessionManager.getSessionId()`); if that is not reachable from a tool, persist from the `index.ts` side instead by having `change_source` return the added path and the caller record it — do **not** silently skip persistence.

- [ ] **Step 5: Replay on session start**

In `chronos/extensions/index.ts`, immediately **after** `buildCollectionFromDiscovery(collectionCtx, ctx.cwd)` and the named-collection restore (~`:244-248`), replay the extras. Order matters: `buildCollectionFromDiscovery` unconditionally resets `name`, `description` and `members`.

```ts
    // Re-add out-of-tree sources added via change_source this session.
    // buildCollectionFromDiscovery above wiped them, and a named-collection
    // restore does not know about them either.
    for (const sourcePath of loadSessionExtraMembers(ctx.cwd, ctx.sessionManager.getSessionId())) {
      if (!existsSync(join(sourcePath, "png"))) {
        console.warn(`[chronos] added source no longer has png/, skipping: ${sourcePath}`);
        continue;
      }
      const ref = deriveRef(ctx.cwd, sourcePath);
      if (collectionCtx.members.has(ref)) continue;
      collectionCtx.members.set(ref, {
        ref,
        path: sourcePath,
        dataDir: join(ctx.cwd, "data", dataKeyForRef(ref, sourcePath)),
      });
    }
```

Import `loadSessionExtraMembers`, and `deriveRef`/`dataKeyForRef` if not already imported. Use the **same** helpers `change-source.ts` uses so refs and data dirs agree exactly.

- [ ] **Step 6: Delete the dead store**

```bash
grep -rn "session-source-store\|saveSessionSource\|loadSessionSource" chronos/ --include=*.ts | grep -v dist
```

Expected: only `session-source-store.ts`'s own two exports. If so:

```bash
git rm chronos/utils/session-source-store.ts
```

If anything else references it, stop and report rather than deleting.

- [ ] **Step 7: Build and run all canaries**

```bash
cd chronos && npm run build && node scripts/collection-canary.mjs && node scripts/timeout-canary.mjs && node scripts/retry-canary.mjs && node scripts/downscale-canary.mjs
```

Expected: all OK.

- [ ] **Step 8: Verify the agent boots and lists sources**

```bash
cd chronos-vscode && node scripts/rpc-spike.mjs
```

Expected: `SPIKE OK`, including `fixture source listed` — the session_start path now does extra work and must not regress it.

- [ ] **Step 9: Commit**

```bash
git add chronos/utils/session-collection-store.ts chronos/tools/change-source.ts chronos/extensions/index.ts chronos/scripts/collection-canary.mjs
git commit -m "fix: change_source additions survive session_start

buildCollectionFromDiscovery clears and repopulates from sources/ on
every session_start, so an out-of-tree source added via change_source was
wiped with nothing to restore it from — refs the agent had been told to
use started throwing mid-conversation.

Additions now persist per-session in session-collections.json and are
replayed after discovery. Selecting 'All sources' clears only the
collection name, not the additions. Deletes session-source-store.ts,
which had no importers left."
```

---

### Task 6: Blocker 5 — collection identity must be the filename, not the display name

**Files:**
- Modify: `chronos/utils/collection-manifest.ts`, `chronos/extensions/index.ts` (~`:132-195`, `:245-248`, `:300`), `chronos-vscode/src/panel/sources.ts:9-40`, `chronos-vscode/src/panel/webview-protocol.ts`, `chronos-vscode/webview/components/chronos-app.ts:396-404`, `chronos-vscode/src/panel/chronos-panel.ts` (~`:594`, `:854-860`)
- Test: `chronos/scripts/collection-canary.mjs`, `chronos-vscode/test/collection-id-test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CollectionSummary { id: string; name: string; description?: string; memberCount: number }` in `collection-manifest.ts`; `CollectionInfo` gains the same `id` in `sources.ts`; `loadCollection(workspaceDir, id)` / `loadCollectionInto(ctx, workspaceDir, id)` are keyed on **id**.

**Why:** `listCollections` reads filenames but reports the in-JSON `name`, discarding the filename; `loadCollection` then resolves that value *as* a filename. So `collections/frankfurt.json` containing `{"name": "Frankfurt Directories"}` is **unselectable** — and restore fails identically, silently, via a `console.warn` the user never sees.

- [ ] **Step 1: Write the failing agent-side checks**

Insert into `chronos/scripts/collection-canary.mjs` before the final `console.log`:

```js
// --- Task 6: a manifest whose name differs from its filename is selectable --
{
  const { listCollections, loadCollection } = await import("../dist/utils/collection-manifest.js");
  const ws = workspace();
  const p = makeSource(ws, "Frankfurt_1864");
  mkdirSync(join(ws, "collections"), { recursive: true });
  writeFileSync(join(ws, "collections", "frankfurt.json"), JSON.stringify({
    name: "Frankfurt Directories",
    description: "City directories",
    members: [{ ref: "Frankfurt_1864", path: "sources/Frankfurt_1864" }],
  }));

  const list = listCollections(ws);
  check("listCollections returns one entry", list.length === 1, JSON.stringify(list));
  check("summary exposes the filename stem as id", list[0]?.id === "frankfurt", JSON.stringify(list[0]));
  check("summary keeps the display name", list[0]?.name === "Frankfurt Directories", JSON.stringify(list[0]));

  const loaded = loadCollection(ws, list[0].id);
  check("loadCollection resolves by id", loaded !== null,
        "returned null — the id/name round-trip is still broken");
  check("loaded collection has its member", loaded?.members?.size === 1, `size=${loaded?.members?.size}`);

  // A manifest with NO name field falls back to the filename for both.
  writeFileSync(join(ws, "collections", "mainz.json"), JSON.stringify({
    members: [{ ref: "Frankfurt_1864", path: "sources/Frankfurt_1864" }],
  }));
  const both = listCollections(ws);
  const mainz = both.find((c) => c.id === "mainz");
  check("nameless manifest -> id and name both the stem",
        mainz?.name === "mainz", JSON.stringify(mainz));
  void p;
}
```

- [ ] **Step 2: Build and run to verify it fails**

```bash
cd chronos && npm run build && node scripts/collection-canary.mjs
```

Expected: FAIL — `summary exposes the filename stem as id` (undefined) and `loadCollection resolves by id` (null).

- [ ] **Step 3: Add `id` to the manifest layer**

In `chronos/utils/collection-manifest.ts`:

- Add `id: string` to `CollectionSummary`, documented as "the filename stem — the collection's stable identity; `name` is display-only."
- In `listCollections`, keep the filename: `const id = f.replace(/\.json$/, "");` and push `{ id, name: m.name ?? id, description: m.description, memberCount: ... }`. Sort by `name` for display as today.
- Rename `loadCollection`'s parameter from `name` to `id` and keep `manifestPath(workspaceDir, id)`. Inside, `createCollectionContext(workspaceDir, manifest.name ?? id)` still sets the **display** name — but the context needs the id too, so add an `id` field to `CollectionContext` (`chronos/tools/collection-context.ts`) alongside `name`, and set it here. `buildCollectionFromDiscovery` sets `ctx.id = null` next to `ctx.name = null`.
- Do the same in `loadCollectionInto`.

Because ids now come from `readdirSync` and callers resolve them against `listCollections()` output, no path is ever built from a JSON-supplied string — which incidentally closes the `../` traversal noted as deferred in the spec, at no extra cost. Do not add regex validation.

- [ ] **Step 4: Key selection and persistence on the id**

In `chronos/extensions/index.ts`:

- `/select-collection`: match the requested argument against `c.id` **first**, then fall back to `c.name` for backward compatibility with anything a user already typed, and resolve to `found.id`.
- Pass `found.id` to `loadCollectionInto` and to `saveSessionCollection`.
- The session-start restore (~`:245-248`) passes the stored value to `loadCollectionInto`. Add the migration the spec requires: if the stored value matches no id, look it up once among display names; if that resolves, rewrite the store with the id; otherwise keep the existing silent fallback to all-sources.
- `emitActiveCollection` (~`:300`) currently sends `ctx.name`. It must send **both** — the webview needs `id` to match option values and `name` to display. Add `id` to the HTTP `collection` message in `chronos/http/http-client.ts` and mirror it in `chronos-vscode/src/protocol.ts` (these two files are hand-duplicated; keep them identical).

- [ ] **Step 5: Write the failing host-side test**

Create `chronos-vscode/test/collection-id-test.mjs`:

```js
// The host duplicates the agent's collection discovery (see sources.ts), so it
// needs the same id/name split or the picker sends a value the agent cannot
// resolve.
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
};

const outfile = join(mkdtempSync(join(tmpdir(), "ch-src-")), "sources.mjs");
await build({
  entryPoints: [join(here, "../src/panel/sources.ts")],
  outfile, bundle: true, format: "esm", platform: "node",
});
const { discoverCollections } = await import(outfile);

const ws = mkdtempSync(join(tmpdir(), "ch-ws-"));
mkdirSync(join(ws, "collections"), { recursive: true });
writeFileSync(join(ws, "collections", "frankfurt.json"),
  JSON.stringify({ name: "Frankfurt Directories", members: [{ path: "sources/x" }] }));
writeFileSync(join(ws, "collections", "mainz.json"),
  JSON.stringify({ members: [{ path: "sources/y" }] }));

const list = discoverCollections(ws);
const fr = list.find((c) => c.name === "Frankfurt Directories");
check("host exposes the filename stem as id", fr?.id === "frankfurt", JSON.stringify(fr));
check("host keeps the display name", fr?.name === "Frankfurt Directories", JSON.stringify(fr));
const mz = list.find((c) => c.id === "mainz");
check("nameless manifest -> name falls back to the stem", mz?.name === "mainz", JSON.stringify(mz));

console.log(failures === 0 ? "\ncollection id test OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

Run it to verify it fails:

```bash
cd chronos-vscode && node test/collection-id-test.mjs
```

Expected: FAIL — `host exposes the filename stem as id` (undefined).

- [ ] **Step 6: Add `id` host-side and use it as the option value**

- `chronos-vscode/src/panel/sources.ts`: add `id: string` to `CollectionInfo`; in `discoverCollections` compute `const id = f.replace(/\.json$/, "")` and push `{ id, name: typeof m.name === "string" ? m.name : id, ... }`.
- `chronos-vscode/src/panel/webview-protocol.ts`: the `collections` message's element type gains `id: string`. The `collection`/active-collection message must carry the id too.
- `chronos-vscode/webview/components/chronos-app.ts:396-404`: the option **value** becomes `c.id` while the label stays `c.name`; the `?selected` comparison and `.value` bind against the active **id**:

```ts
                  <option value="" ?selected=${this.activeCollection === null}>All sources</option>
                  ${this.collections.map(
                    (c) => html`<option value=${c.id} ?selected=${c.id === this.activeCollection}>
                      ${c.name} (${c.memberCount})
                    </option>`,
                  )}
```

Rename the `activeCollection` state to hold the **id**, and update where it is assigned from the `collection` message (`chronos-panel.ts` ~`:594` → `chronos-app.ts`). The `selectCollection` message now carries an id.
- `chronos-panel.ts` ~`:854-860`: `msg.name` becomes the id; keep the `(all sources)` sentinel for `null` exactly as-is.

- [ ] **Step 7: Run both tests and typecheck**

```bash
cd chronos && npm run build && node scripts/collection-canary.mjs
cd ../chronos-vscode && node test/collection-id-test.mjs && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p webview/tsconfig.json
```

Expected: `collection canary OK`, `collection id test OK`, both typechecks clean.

- [ ] **Step 8: Verify the round-trip end to end**

```bash
cd chronos-vscode && npm run build && node scripts/rpc-spike.mjs && node test/run-ui-test.mjs
```

Expected: `SPIKE OK` and `UI TEST OK`. The spike asserts `select-collection` is registered.

- [ ] **Step 9: Commit**

```bash
git add chronos/utils/collection-manifest.ts chronos/tools/collection-context.ts chronos/extensions/index.ts chronos/http/http-client.ts chronos/scripts/collection-canary.mjs chronos-vscode/src/panel/sources.ts chronos-vscode/src/protocol.ts chronos-vscode/src/panel/webview-protocol.ts chronos-vscode/src/panel/chronos-panel.ts chronos-vscode/webview/components/chronos-app.ts chronos-vscode/test/collection-id-test.mjs
git commit -m "fix: identify collections by filename, not display name

listCollections reported the in-JSON name and discarded the filename,
then loadCollection resolved that value AS a filename — so a manifest
whose name differed from its filename was unselectable, and restore
failed the same way via a console.warn the user never saw.

Adds an explicit id (the filename stem) used as the option value, the
manifest lookup key, and the persisted value; name stays display-only.
Migrates already-persisted display names to ids on load."
```

---

### Task 7: Blocker 4 — nested sources break the Data tab and the source dropdown

**Files:**
- Modify: `chronos-vscode/src/panel/chronos-panel.ts` (~`:656-662`, `:673-682`, and wherever `sources`/`show_page` are handled), `chronos-vscode/webview/components/chronos-app.ts:420`
- Test: `chronos-vscode/test/run-ui-test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a private `dataKeyForSourceDir(sourceDir: string): string` on `ChronosPanel`, backed by a `Map<string, string>`.

**Why:** the host derives `sourceName = basename(sourceDir)` in `openViewLink` and `previewSource`, while the agent derives `dataKeyForRef(ref, path)` = `ref.includes("/") ? toSlug(ref) : basename(path)`. For `sources/city/Frankfurt_1864` the agent writes `data/city--Frankfurt_1864` but a citation click sets `currentSourceName = "Frankfurt_1864"` → `dataDir()` = `data/Frankfurt_1864`, which does not exist → the Data tab silently empties and `postDataFiles` latches the wrong value. `chronos-app.ts:420`'s `endsWith("/" + currentSource)` matcher was written for a basename and no longer matches a slug, so the header snaps to "— none —".

**Approach (per the spec): do not duplicate the slug logic.** `dataKeyForRef` is asymmetric and depends on `deriveRef` too — three coupled functions across packages that share no code. The agent already sends the correct key as `sourceName` on every viewer message, so cache it.

- [ ] **Step 1: Confirm the mismatch and find the population points**

```bash
cd /home/hufe/Documents/code/chronos
grep -n "basename(sourceDir)" chronos-vscode/src/panel/chronos-panel.ts
grep -n "case \"show_page\"\|sourceName" chronos-vscode/src/panel/chronos-panel.ts | head -20
grep -n "postSources\|discoverSources" chronos-vscode/src/panel/chronos-panel.ts | head
```

Note every message that already carries a correct `sourceName` (`show_page`, `list_pages`, `show_text` all send `basename(m.dataDir)`), and where `sources` is built for the dropdown.

- [ ] **Step 2: Add the lookup**

In `ChronosPanel`, add:

```ts
  // The agent owns the data-dir key: flat sources use basename(path), nested
  // refs are slugged (city/X -> city--X). Rather than re-deriving it here —
  // which would mean duplicating dataKeyForRef, toSlug AND deriveRef across a
  // package boundary with no shared code — record the key the agent already
  // sends on every viewer message and look it up by directory.
  private dataKeyBySourceDir = new Map<string, string>();

  private rememberDataKey(sourceDir: string, dataKey: string): void {
    if (sourceDir && dataKey) this.dataKeyBySourceDir.set(sourceDir, dataKey);
  }

  // Falls back to basename only for a directory the agent has never named,
  // which is the pre-existing behaviour for flat sources and correct for them.
  private dataKeyForSourceDir(sourceDir: string): string {
    return this.dataKeyBySourceDir.get(sourceDir) ?? basename(sourceDir);
  }
```

- [ ] **Step 3: Populate it**

Call `this.rememberDataKey(msg.sourceDir, msg.sourceName)` in the HTTP handler for **every** message that carries both — `show_page`, `list_pages`, `show_text`, and the `index.ts` sends. Read `handleHttpMessage` first to catch them all:

```bash
sed -n '574,605p' chronos-vscode/src/panel/chronos-panel.ts
```

- [ ] **Step 4: Use it instead of `basename`**

Replace `sourceName = basename(sourceDir);` in **both** `previewSource` (~`:660`) and `openViewLink` (~`:678`) with:

```ts
      sourceName = this.dataKeyForSourceDir(sourceDir);
```

- [ ] **Step 5: Fix the dropdown matcher**

`chronos-app.ts:420` compares an option value (a `discoverSources` workspace-relative path like `city/Frankfurt_1864`) against `currentSource` (now a data key like `city--Frankfurt_1864`), using an `endsWith("/" + …)` hack written for basenames. Neither branch matches.

The robust fix is to stop comparing derived strings: have the host send the source list with the same key it uses for `currentSource`. Add a `dataKey` to each entry of the `sources` message (the host can compute it via `dataKeyForSourceDir` for known dirs) and compare `s.dataKey === this.currentSource`, keeping `s.name` for display:

```ts
              ${this.sources.map(
                (s) => html`<option value=${s.name} ?selected=${s.dataKey === this.currentSource}>
                  ${s.name} (${s.pageCount} pp.)
                </option>`,
              )}
```

Update `SourceInfo`/the `sources` protocol member and `postSources` accordingly. Keep `value=${s.name}` — `selectSource` resolves refs leniently agent-side, and task 4 now errors rather than guessing on a genuine ambiguity.

- [ ] **Step 6: Add a UI-test assertion for a nested source**

`test/run-ui-test.mjs` builds its fixture workspace itself. Extend the fixture with a **nested** source (`sources/city/Nested_1900/png/page_0001.png`) and assert that after the agent shows a page from it, the Data tab resolves — i.e. the panel's `currentSourceName` is the slug, not the basename. Read the fixture setup and the existing `dataViewer` assertions first:

```bash
grep -n "sources/\|mkdirSync\|dataset viewer" chronos-vscode/test/run-ui-test.mjs | head -20
```

Assert on the dumped state via the existing `chronosTest.dump` seam rather than adding new plumbing.

- [ ] **Step 7: Typecheck, build, and run the tests**

```bash
cd chronos-vscode && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p webview/tsconfig.json && npm run build && node test/run-ui-test.mjs
```

Expected: clean typechecks, `UI TEST OK` with the new nested-source check passing and all 18 pre-existing checks still passing.

- [ ] **Step 8: Commit**

```bash
git add chronos-vscode/src/panel/chronos-panel.ts chronos-vscode/src/panel/webview-protocol.ts chronos-vscode/src/panel/sources.ts chronos-vscode/webview/components/chronos-app.ts chronos-vscode/test/run-ui-test.mjs
git commit -m "fix: nested sources resolve to the agent's data dir

The host derived basename(sourceDir) while the agent slugs nested refs,
so clicking a citation for sources/city/X pointed the Data tab at
data/X instead of data/city--X — it silently emptied and latched.

Caches the data key the agent already sends on every viewer message
instead of duplicating dataKeyForRef, toSlug and deriveRef across a
package boundary. The dropdown now matches on that same key rather than
an endsWith hack written for basenames."
```

---

### Task 8: Land the branch in `dev`

**Files:** none modified — verification and merge only.

- [ ] **Step 1: Confirm every blocker has a fix and a test**

```bash
cd /home/hufe/Documents/code/chronos && git log --oneline dev..HEAD
```

Expected: seven commits (tasks 1–7). Check each blocker from the spec is represented: cheap cleanups, timeout-as-abort, output_file, ambiguity, persistence, collection id, data key.

- [ ] **Step 2: Run the complete gate**

```bash
cd chronos && npm run build
node scripts/retry-canary.mjs && node scripts/downscale-canary.mjs && node scripts/timeout-canary.mjs && node scripts/collection-canary.mjs
cd ../chronos-vscode && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p webview/tsconfig.json && npm run build
node test/collection-id-test.mjs && node scripts/rpc-spike.mjs && node test/run-ui-test.mjs
```

Expected, in order: `retry canary OK`, `downscale canary OK`, `timeout canary OK`, `collection canary OK`, two clean typechecks, `Build complete.`, `collection id test OK`, `SPIKE OK`, `UI TEST OK`.

**If any check fails, stop.** Do not merge a partially-green gate.

- [ ] **Step 3: Manual smoke on the collection paths**

The tests cannot cover these. Launch the extension against a real workspace and confirm:

1. A `collections/frankfurt.json` with `"name": "Frankfurt Directories"` appears in the picker under its display name and **selects successfully**.
2. Reload the window — the same collection is still selected.
3. A nested source (`sources/city/X`) shows pages, and its Data tab lists files.
4. `change_source` an out-of-tree directory, switch sessions and back, and confirm the added ref still resolves.
5. Cancel a running `task_batch` and confirm the summary is not reported as a plain failure.

- [ ] **Step 4: Sync with `dev` and re-verify**

```bash
git switch dev && git pull && git switch fix/archive-support-blockers
git -c user.name="Lorenz Hufe" -c user.email="lorenz.hufe@posteo.de" merge dev --no-edit
```

If the merge touches code, re-run Step 2 in full.

- [ ] **Step 5: Open the PR into `dev`**

```bash
gh pr create --base dev --head fix/archive-support-blockers \
  --title "Land archive-support: collection support + six blocker fixes" \
  --body "See docs/superpowers/specs/2026-07-28-archive-support-blockers-design.md.

Lands the 18 commits of collection/archive work with the six review
blockers fixed, plus the two issues the timeout fix made reachable.

Gate: both builds, both typechecks, rpc-spike, run-ui-test, and five
canaries (retry, downscale, timeout, collection, collection-id).

Deferred follow-ups are listed in the spec's Scope section — notably the
stale CLAUDE.md/DOCS.md describing the deleted SourceContext contract,
task_batch robustness, and the non-functional chronos.piAgentDir."
```

Merge as a **real merge commit**, not a squash — the branch carries its own specs and plans under `docs/superpowers/` worth preserving in history.

- [ ] **Step 6: Rebuild `dist/` from `dev` and unblock the next plan**

```bash
git switch dev && git pull && cd chronos && npm run build
```

`chronos/dist/` is gitignored and survives branch switches, so it must be rebuilt or local pi sessions keep running the old agent. This also satisfies the precondition for [the image-normalization plan](2026-07-28-image-normalization-and-import-button.md) — verify with:

```bash
git log dev --oneline | grep -c archive-support
```

Expected: non-zero.

---

## Self-Review

**Spec coverage.** Blocker 1 → task 3. Blocker 2 → task 4. Blocker 3 (decision A) → task 5. Blocker 4 (decision B) → task 7. Blocker 5 (decision C) → task 6. Blocker 6 (decision D) → task 2. D2 and D3 → task 2 (checks 2–5 of the timeout canary). Cheap fixes → task 1. Landing gate → task 8. The deferred list is restated in Global Constraints so no task drifts into it.

**Decision A's trap** (selecting "All sources" wiping `extraMembers`) is covered by an explicit canary check, since it is the failure most likely to be reintroduced by a later refactor.

**Placeholder scan.** Four steps deliberately say "read this first, then edit" rather than quoting a replacement: task 3 step 4 (`sessionSourceRef` needs the expert-store API), task 5 step 4 (session id reachability from a tool), task 6 steps 4 and 6 (many small call-site edits), task 7 steps 3 and 6 (message handlers and the fixture). Each names the exact grep to run and the decision rule, and each is a *wiring* question I could not resolve without reading code that the preceding task may itself change. These are not "add appropriate error handling" placeholders, but they are the plan's weakest points and should be expected to need judgement.

**Type consistency.** `completeWithRetry`'s `attempt` is `(signal?: AbortSignal) => Promise<T>` in task 2 and nowhere else. `RetryResult` gains `timedOut: boolean` in task 2 and is read in task 2 step 6 only. `saveSessionExtraMember`/`loadSessionExtraMembers` are defined and consumed in task 5. `CollectionSummary.id` (task 6) and `CollectionInfo.id` (task 6) are separate types in separate packages with the same field name, deliberately — they are hand-mirrored like `protocol.ts`. `dataKeyForSourceDir` is defined and consumed in task 7. `SourceInfo.dataKey` is added in task 7 step 5 and consumed by the webview in the same step.

**Ordering risk.** Task 6 and task 7 both edit `chronos-app.ts`, `webview-protocol.ts`, `sources.ts` and `chronos-panel.ts`. Running them out of order, or in parallel subagents, will conflict. They must be sequential and in this order — task 6 establishes the collection `id` before task 7 touches the same protocol members for source keys.
