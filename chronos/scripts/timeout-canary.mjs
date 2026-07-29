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
  check("timeout then success -> timedOut resets to false", res.timedOut === false, JSON.stringify(res));
}

// 3. A USER abort stops immediately and is not retried.
{
  const ac = new AbortController();
  let seen = 0;
  ac.abort();
  const res = await completeWithRetry(
    // Derives its result from the signal it's handed (rather than always
    // returning "aborted") so this genuinely exercises propagation of the
    // user's abort into the per-attempt signal, including the synchronous
    // already-aborted pre-check.
    (signal) => { seen++; return Promise.resolve({ stopReason: signal?.aborted ? "aborted" : "stop" }); },
    { retries: 3, timeoutMs: 1000, delayMs: fast },
    ac.signal,
  );
  check("user abort -> single attempt", seen === 1, `attempts=${seen}`);
  check("user abort -> timedOut false", res.timedOut === false, JSON.stringify(res));
  check("user abort -> propagated into per-attempt signal", res.response.stopReason === "aborted", JSON.stringify(res.response));
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
// uncaught exception.
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

// 8. A timeout racing a genuinely successful attempt must not discard the
//    real response: the mock ignores its signal and always resolves "stop",
//    but only AFTER the per-attempt timeout has already fired, forcing the
//    timer callback to win the race against the attempt's own resolution.
//    The late-firing timer must not cause the good response to be retried
//    or reported as a timeout.
{
  let seen = 0;
  const TIMEOUT_MS = 30;
  const res = await completeWithRetry(
    () => {
      seen++;
      return new Promise((resolve) => {
        setTimeout(() => resolve({ stopReason: "stop" }), TIMEOUT_MS * 3);
      });
    },
    { retries: 2, timeoutMs: TIMEOUT_MS, delayMs: fast },
  );
  check("late-firing timer does not discard a real success", res.response.stopReason === "stop", JSON.stringify(res.response));
  check("late-firing timer does not trigger a retry", seen === 1, `attempts=${seen}`);
  check("late-firing timer is not reported as timedOut", res.timedOut === false, JSON.stringify(res));
}

console.log(failures === 0 ? "\ntimeout canary OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
