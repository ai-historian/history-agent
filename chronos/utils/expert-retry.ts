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
