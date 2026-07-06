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
