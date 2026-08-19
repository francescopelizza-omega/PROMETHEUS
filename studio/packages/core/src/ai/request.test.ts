/**
 * ai/request.test.ts — `fetchModelWithRetry`'s own retry assembly, and the circuit breaker.
 *
 * The retry mechanics themselves (backoff, jitter, `retryOn`, `delayFor`) are `resilience/
 * retry.ts`'s own unit tests; what matters here is that THIS function assembles them correctly
 * against a real per-attempt signal factory and a real endpoint id, and that the circuit
 * breaker — built, unit-tested, and until now never wired to anything real — actually fails
 * fast on a dead endpoint when a caller opts in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CircuitBreaker, CircuitOpenError } from "../resilience/circuitBreaker.js";
import { endpointBreaker, fetchModelWithRetry } from "./request.js";

interface FakeRes {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

const ok200: FakeRes = { ok: true, status: 200, statusText: "OK", text: async () => "" };

function baseOpts(overrides: Partial<Parameters<typeof fetchModelWithRetry>[0]> = {}) {
  return {
    endpointId: "local:test",
    url: "http://127.0.0.1:11434/v1/chat/completions",
    init: { method: "POST", headers: {}, body: "{}" },
    retries: 0,
    sleep: async () => {},
    ...overrides,
  };
}

test("no breaker ⇒ behaviour is exactly what it was before (opt-in, not a default)", async () => {
  const res = await fetchModelWithRetry({
    ...baseOpts(),
    doFetch: async () => ok200,
  });
  assert.equal(res, ok200);
});

test("a down endpoint (doFetch throws) still succeeds once reachable — no breaker involved", async () => {
  let calls = 0;
  const res = await fetchModelWithRetry({
    ...baseOpts({ retries: 2 }),
    doFetch: async () => {
      calls += 1;
      if (calls < 2) throw new Error("ECONNREFUSED");
      return ok200;
    },
  });
  assert.equal(res, ok200);
  assert.equal(calls, 2);
});

test("endpointBreaker returns the SAME instance for one id, a DIFFERENT one for another", () => {
  const a1 = endpointBreaker("local:a");
  const a2 = endpointBreaker("local:a");
  const b = endpointBreaker("local:b");
  assert.equal(a1, a2, "the same endpoint id got two different breakers");
  assert.notEqual(
    a1,
    b,
    "two different endpoints share one breaker — a dead one would trip a healthy one",
  );
});

test("with a breaker: sustained failure trips it, and the NEXT call fails fast without ever fetching", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2, coolDownMs: 30_000 });
  let calls = 0;
  const dead = async (): Promise<FakeRes> => {
    calls += 1;
    throw new Error("ECONNREFUSED");
  };

  await assert.rejects(() => fetchModelWithRetry({ ...baseOpts(), doFetch: dead, breaker }));
  await assert.rejects(() => fetchModelWithRetry({ ...baseOpts(), doFetch: dead, breaker }));
  assert.equal(calls, 2, "two exhausted calls should each have reached doFetch once");

  await assert.rejects(
    () => fetchModelWithRetry({ ...baseOpts(), doFetch: dead, breaker }),
    CircuitOpenError,
    "the breaker should have tripped after the failure threshold",
  );
  assert.equal(calls, 2, "a tripped breaker must fail fast — doFetch must not run a third time");
});

test("a request that eventually SUCCEEDS (even after failed attempts of its own) resets the breaker", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2, coolDownMs: 30_000 });
  let calls = 0;

  // One exhausted-failure call — one strike.
  await assert.rejects(() =>
    fetchModelWithRetry({
      ...baseOpts(),
      doFetch: async () => {
        calls += 1;
        throw new Error("ECONNREFUSED");
      },
      breaker,
    }),
  );

  // A call that retries internally and then succeeds — a WHOLE-call success, not a strike.
  let innerAttempts = 0;
  const res = await fetchModelWithRetry({
    ...baseOpts({ retries: 2 }),
    doFetch: async () => {
      calls += 1;
      innerAttempts += 1;
      if (innerAttempts < 2) throw new Error("ECONNRESET");
      return ok200;
    },
    breaker,
  });
  assert.equal(res, ok200);

  // Had the prior success NOT cleared the strike, this failure would be strike #2 and trip.
  let stillOpen = false;
  try {
    await fetchModelWithRetry({
      ...baseOpts(),
      doFetch: async () => {
        calls += 1;
        throw new Error("ECONNREFUSED");
      },
      breaker,
    });
  } catch (err) {
    stillOpen = err instanceof CircuitOpenError;
  }
  assert.equal(stillOpen, false, "an intervening success should have cleared the earlier strike");
});
