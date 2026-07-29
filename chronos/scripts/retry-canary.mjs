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
