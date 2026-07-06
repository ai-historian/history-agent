# Retry + timeout for expert LLM calls

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation
**Companion:** `2026-07-06-image-downscale-design.md` (same incident, upload-size half)

## Problem

Expert subagent LLM calls (`expert-turn.ts` → pi-ai `complete()`) run with the
Anthropic SDK's default 10-minute timeout and **zero retries** (pi-ai constructs
the client with `maxRetries: 0`; Chronos passes neither `timeoutMs` nor
`maxRetries`). One transient failure — "Request timed out.", a 429, a 529
overload — permanently fails that page in a `task_batch`, wasting all tokens
already spent on the expert's turn. On 2026-07-05 this failed 241/324 pages in
one batch, and each stalled attempt held a concurrency slot for the full 10
minutes.

## Decision summary

- **Chronos-side retry loop** around `complete()` — provider-agnostic (works
  identically for Anthropic/Gemini/OpenAI-compat), and pi-ai surfaces failures
  as a resolved response (`stopReason === "error"` + `errorMessage` string),
  not a thrown exception, so the SDK's own retry knob is the wrong layer.
  pi-ai's `maxRetries` stays at its default 0 so retries are controlled in
  exactly one place.
- **Per-attempt timeout 300 s** via the existing `options.timeoutMs`
  passthrough (`pi-ai` `types.d.ts:88`). Per pi-ai docs this bounds both the
  HTTP request and stream idleness after connection — one knob covers stalled
  uploads and dead streams.
- **Up to 3 retries** (4 attempts total) with exponential backoff. Worst case
  ~21 min per LLM call, vs. 10 min today with guaranteed page loss.

## Design

### Retry wrapper (chronos pi-package)

`completeWithRetry()` in `chronos/tools/expert-turn.ts` (private helper next to
the loop that calls it), replacing the bare `complete()` call at
`expert-turn.ts:259`:

```
attempts = 1 + EXPERT_RETRIES
for attempt in 1..attempts:
  response = await complete(model, ctx, { apiKey, headers, signal,
                                          timeoutMs: EXPERT_TIMEOUT_MS || undefined })
  if signal.aborted or stopReason == "aborted"  -> return response   (caller handles)
  if stopReason != "error"                      -> return response   (success)
  if isPermanentError(errorMessage)             -> return response   (fail now)
  if attempt < attempts                         -> abort-aware sleep(backoff[attempt])
return response                                  (retries exhausted)
```

- **Backoff:** ~2 s, 8 s, 30 s (capped) with ±25 % jitter, so a 50-expert batch
  doesn't retry in lockstep. The sleep races the abort signal — cancel is
  never delayed by a pending backoff.
- **Permanent-error classifier:** skip retries when `errorMessage` matches
  auth/validation patterns (`/invalid|unauthorized|authentication|api key|
  permission|not.found|billing/i`). Everything else — timeouts, 429, 5xx/529,
  connection resets, unclassifiable messages — is retried. Misclassifying a
  permanent error as transient costs at most 3 bounded extra attempts; the
  reverse (dropping a recoverable page) is the failure mode we're fixing, so
  the classifier errs toward retrying.
- **Error surfacing:** unchanged shape — after the final attempt the turn fails
  exactly as today (`Expert model error (provider/model): …`), with
  `" (after N attempts)"` appended so batch summaries distinguish exhausted
  retries from immediate failures.
- The retried request is byte-identical (same messages/images), so
  provider-side prompt caching can make retries cheaper than the first attempt.

### Configuration

Same pattern as the existing limits (`envInt` + `agentEnv` in
`extension.ts:758`):

| VS Code setting | Default | Range | Env var |
|---|---|---|---|
| `chronos.expertRetries` | 3 | 0–10 (0 = no retries, current behavior) | `CHRONOS_EXPERT_RETRIES` |
| `chronos.expertRequestTimeout` (seconds) | 300 | 0–3600 (0 = provider/SDK default) | `CHRONOS_EXPERT_TIMEOUT` |

Setting descriptions explain the trade-off: timeout bounds how long a stalled
upload or dead stream holds a batch concurrency slot; retries recover pages
from transient provider/network failures at the cost of extra attempts.

### Scope

Applies to the expert agentic loop only (`expert-turn.ts`). The orchestrator's
own model calls go through pi's main loop, which pi manages — out of scope.
Batch-level behavior is unchanged: a page that fails after all retries is
reported failed, and the orchestrator can re-batch the missing pages as it
does today.

## Risks / notes

- **Build-time vs runtime pi-ai drift:** `timeoutMs`/`maxRetries` exist in the
  installed pi 0.79's pi-ai. Verify `chronos/node_modules`' pi-ai types include
  them; if the peer dep is older, bump it — do not cast around missing types.
- Retries multiply worst-case latency (~21 min/call at defaults); the timeout
  reduction (600 s → 300 s) offsets this for the common stall case.

## Testing

1. `cd chronos && npm run build` + both `chronos-vscode` typechecks.
2. Unit-style node script for the wrapper with a stubbed `complete`:
   transient error → succeeds on attempt 2; permanent error (`"invalid x-api-key"`)
   → single attempt; abort during backoff → returns promptly as aborted;
   retries exhausted → error message carries attempt count.
3. Manual smoke: point `.chronos/.env` at a bogus key → task fails once, fast,
   no retries (permanent). Then a real batch on a few pages → succeeds; check
   a synthetic timeout (set `chronos.expertRequestTimeout` to ~5 s) produces
   retry log/backoff then a clean failure.
