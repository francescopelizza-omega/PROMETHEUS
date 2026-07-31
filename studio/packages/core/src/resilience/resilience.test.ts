/**
 * resilience.test.ts — retry/backoff, circuit breaker, timeout (Reliability pack).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";
import { AbortError, backoffDelay, retry } from "./retry.js";
import { TimeoutError, type TimerLike, withTimeout } from "./timeout.js";

// ---- retry ----------------------------------------------------------------- //

test("backoffDelay is exponential + capped", () => {
  assert.equal(backoffDelay(0, { baseMs: 100, factor: 2 }), 100);
  assert.equal(backoffDelay(1, { baseMs: 100, factor: 2 }), 200);
  assert.equal(backoffDelay(3, { baseMs: 100, factor: 2 }), 800);
  assert.equal(backoffDelay(10, { baseMs: 100, factor: 2, maxMs: 1000 }), 1000, "capped at maxMs");
});

test("retry returns on first success (no sleep)", async () => {
  let calls = 0;
  const slept: number[] = [];
  const v = await retry(
    async () => {
      calls += 1;
      return "ok";
    },
    { sleep: async (ms) => void slept.push(ms) },
  );
  assert.equal(v, "ok");
  assert.equal(calls, 1);
  assert.equal(slept.length, 0);
});

test("retry succeeds after transient failures; schedule uses injected sleep + rng", async () => {
  let calls = 0;
  const slept: number[] = [];
  const v = await retry(
    async (attempt) => {
      calls += 1;
      if (attempt < 2) throw new Error("transient");
      return attempt;
    },
    {
      retries: 3,
      baseMs: 100,
      factor: 2,
      sleep: async (ms) => void slept.push(ms),
      rng: () => 0.5,
    },
  );
  assert.equal(v, 2);
  assert.equal(calls, 3);
  // full jitter with rng=0.5 → half of 100, then half of 200
  assert.deepEqual(slept, [50, 100]);
});

test("retry stops on a non-retryable error (retryOn=false)", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls += 1;
          throw new Error("fatal");
        },
        { retries: 5, retryOn: () => false, sleep: async () => {} },
      ),
    /fatal/,
  );
  assert.equal(calls, 1, "no retries when retryOn returns false");
});

test("retry throws the LAST error after exhausting retries", async () => {
  let n = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          n += 1;
          throw new Error(`fail-${n}`);
        },
        { retries: 2, sleep: async () => {} },
      ),
    /fail-3/,
  );
});

test("retry fails fast on an already-aborted signal", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => retry(async () => "x", { signal: ac.signal }), AbortError);
});

// ---- circuit breaker ------------------------------------------------------- //

test("breaker trips open after the failure threshold, then fails fast", async () => {
  const clock = 0;
  const cb = new CircuitBreaker({ failureThreshold: 2, coolDownMs: 1000, now: () => clock });
  const boom = async () => {
    throw new Error("boom");
  };
  await assert.rejects(() => cb.exec(boom), /boom/);
  await assert.rejects(() => cb.exec(boom), /boom/);
  assert.equal(cb.snapshot().state, "open");
  // now OPEN → fail-fast without calling fn
  let called = false;
  await assert.rejects(
    () =>
      cb.exec(async () => {
        called = true;
        return 1;
      }),
    CircuitOpenError,
  );
  assert.equal(called, false, "open breaker does not call fn");
});

test("breaker half-opens after cool-down; a successful probe closes it", async () => {
  let clock = 0;
  const cb = new CircuitBreaker({ failureThreshold: 1, coolDownMs: 500, now: () => clock });
  await assert.rejects(
    () =>
      cb.exec(async () => {
        throw new Error("x");
      }),
    /x/,
  );
  assert.equal(cb.snapshot().state, "open");
  clock = 600; // past cool-down
  const v = await cb.exec(async () => "recovered");
  assert.equal(v, "recovered");
  assert.equal(cb.snapshot().state, "closed");
});

test("breaker re-opens when the half-open probe fails", async () => {
  let clock = 0;
  const cb = new CircuitBreaker({ failureThreshold: 1, coolDownMs: 500, now: () => clock });
  await assert.rejects(
    () =>
      cb.exec(async () => {
        throw new Error("x");
      }),
    /x/,
  );
  clock = 600;
  await assert.rejects(
    () =>
      cb.exec(async () => {
        throw new Error("still down");
      }),
    /still down/,
  );
  assert.equal(cb.snapshot().state, "open", "a failed probe re-opens");
  cb.reset();
  assert.equal(cb.snapshot().state, "closed");
});

// ---- timeout --------------------------------------------------------------- //

const fakeTimer = (): { timer: TimerLike; fire: () => void } => {
  let cb: (() => void) | null = null;
  return {
    timer: {
      set: (fn) => {
        cb = fn;
        return 1;
      },
      clear: () => {
        cb = null;
      },
    },
    fire: () => cb?.(),
  };
};

test("withTimeout resolves when the promise settles first", async () => {
  const { timer } = fakeTimer();
  assert.equal(await withTimeout(Promise.resolve("v"), 1000, "op", timer), "v");
});

test("withTimeout rejects TimeoutError when the deadline fires first", async () => {
  const ft = fakeTimer();
  const never = new Promise<string>(() => {});
  const p = withTimeout(never, 50, "stuck", ft.timer);
  ft.fire();
  await assert.rejects(
    () => p,
    (e: unknown) => e instanceof TimeoutError && e.ms === 50 && e.label === "stuck",
  );
});

test("withTimeout propagates the promise's own rejection", async () => {
  const { timer } = fakeTimer();
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error("inner")), 1000, "op", timer),
    /inner/,
  );
});
