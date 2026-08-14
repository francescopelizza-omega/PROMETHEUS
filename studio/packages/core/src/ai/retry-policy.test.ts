/**
 * retry-policy.test.ts — classifying a model endpoint's failure.
 *
 * The client made one attempt and threw, so a 429 — the most common cloud failure, and the one
 * the provider tells you how to recover from — ended the turn. Meanwhile `resilience/retry.ts`
 * had backoff, jitter and abort support with zero callers.
 *
 * The tests that matter are the NEGATIVE ones. Retrying a 400 spends the user's money four
 * times to produce the same rejection, and retrying a 401 waits politely for a credential to
 * fix itself. Getting "what is transient" wrong in that direction is worse than not retrying.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_RETRY_DEFAULTS,
  AiHttpError,
  ContextOverflowError,
  PREFLIGHT_MARGIN,
  advisedWaitTooLong,
  describeAiFailure,
  isAbort,
  isRetryableAiError,
  isRetryableStatus,
  parseRetryAfter,
  preflightContext,
  retryDelayMs,
} from "./retry-policy.js";

const httpErr = (status: number, retryAfterMs?: number): AiHttpError =>
  new AiHttpError({
    endpointId: "e",
    status,
    statusText: "x",
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

/* ── what is transient ─────────────────────────────────────────────────────*/

test("rate limits, timeouts and server errors retry", () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(s), true, `${s} should retry`);
  }
});

test("a request the endpoint UNDERSTOOD and rejected does not retry", () => {
  // Repeating a malformed request produces the same rejection, three times slower and at three
  // times the cost. 409 is a state conflict, which repeating cannot resolve.
  for (const s of [400, 401, 403, 404, 409, 413, 422, 501]) {
    assert.equal(isRetryableStatus(s), false, `${s} must not retry`);
  }
});

test("a network-level throw retries, but an ABORT never does", () => {
  // A connection reset provably never got an answer. An abort is the user's decision.
  assert.equal(isRetryableAiError(new Error("ECONNRESET")), true);
  const abort = new Error("stopped");
  abort.name = "AbortError";
  assert.equal(isRetryableAiError(abort), false);
  assert.equal(isAbort(abort), true);
  const timeout = new Error("slow");
  timeout.name = "TimeoutError";
  assert.equal(isAbort(timeout), true);
});

/* ── Retry-After ───────────────────────────────────────────────────────────*/

test("Retry-After is parsed in BOTH legal forms", () => {
  // Handling only the integer form silently ignores the date form — which is exactly the case
  // where the wait is long and guessing wrong matters most.
  assert.equal(parseRetryAfter("30"), 30_000);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:45 GMT", now), 45_000);
});

test("a Retry-After in the past is zero, never negative", () => {
  const now = Date.parse("2026-01-01T00:01:00Z");
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now), 0);
});

test("junk and absence both yield no advice, not a zero delay", () => {
  // A `0` here would read as "retry immediately", which is the opposite of safe.
  for (const h of [null, undefined, "", "   ", "soon", "-5"]) {
    assert.equal(parseRetryAfter(h), undefined, `${JSON.stringify(h)} produced a delay`);
  }
});

test("the provider's advice WINS over our backoff curve", () => {
  // Our arithmetic is a guess competing with a fact — and hammering a rate limiter earns a
  // longer ban than waiting.
  assert.equal(retryDelayMs(httpErr(429, 5_000), 400), 5_000);
  // …but it is capped, so a turn never silently hangs for an hour.
  assert.equal(retryDelayMs(httpErr(429, 3_600_000), 400), 60_000);
  // With no advice, the backoff stands.
  assert.equal(retryDelayMs(httpErr(500), 800), 800);
  assert.equal(retryDelayMs(new Error("reset"), 800), 800);
});

test("advice longer than the cap means GIVE UP, not wait the cap and fail anyway", () => {
  assert.equal(advisedWaitTooLong(httpErr(429, 3_600_000)), true);
  assert.equal(advisedWaitTooLong(httpErr(429, 5_000)), false);
  assert.equal(advisedWaitTooLong(httpErr(500)), false);
});

/* ── what the human is told ────────────────────────────────────────────────*/

test("a failure explains itself in words, including the wait it was given", () => {
  assert.match(describeAiFailure(httpErr(429, 12_000)), /rate limited.*12s/);
  assert.match(describeAiFailure(httpErr(401)), /credentials/);
  assert.match(describeAiFailure(httpErr(503)), /server error \(503\)/);
  const abort = new Error("x");
  abort.name = "AbortError";
  assert.equal(describeAiFailure(abort), "cancelled");
});

test("the defaults are tuned for a rate limiter, not a file lock", () => {
  // 100ms — the generic default — is far too eager for a provider quota.
  assert.ok(AI_RETRY_DEFAULTS.baseMs >= 400);
  assert.ok(AI_RETRY_DEFAULTS.retries >= 1 && AI_RETRY_DEFAULTS.retries <= 3);
});

/* ── the pre-flight check ──────────────────────────────────────────────────*/

test("an impossible request is refused locally, with a sentence and a number", () => {
  // It used to surface as a provider 400 — the turn ended, the user was billed for nothing,
  // and the transcript read like a bug in Prometheus.
  const res = preflightContext({ estimatedPromptTokens: 50_000, contextWindow: 8192 });
  assert.equal(res.ok, false);
  assert.ok(res.overflowTokens > 40_000);
  assert.match(res.reason ?? "", /context window is 8192/);
  assert.match(res.reason ?? "", /compact the conversation/);
});

test("the reserve for the reply counts against the window", () => {
  // The window has to hold BOTH sides; ignoring max_tokens is how a request that "fits"
  // still 400s.
  assert.equal(preflightContext({ estimatedPromptTokens: 7000, contextWindow: 8192 }).ok, true);
  const withReply = preflightContext({
    estimatedPromptTokens: 7000,
    contextWindow: 8192,
    maxTokens: 4000,
  });
  assert.equal(withReply.ok, false);
});

test("a borderline request is NOT refused — the endpoint is the authority", () => {
  // chars/4 under-counts on code and over-counts on prose. Refusing something that would have
  // worked is a worse failure than passing it through to a clear provider error.
  assert.equal(
    preflightContext({ estimatedPromptTokens: Math.floor(8192 * 1.1), contextWindow: 8192 }).ok,
    true,
  );
  assert.equal(PREFLIGHT_MARGIN > 1, true);
});

test("an UNKNOWN window disables the check rather than refusing everything", () => {
  // Same load-bearing sentinel as compaction: "no information" must not mean "refuse".
  for (const win of [0, Number.NaN, -1]) {
    assert.equal(preflightContext({ estimatedPromptTokens: 1e9, contextWindow: win }).ok, true);
  }
});

test("the overflow error carries the numbers a host needs to offer a fix", () => {
  const res = preflightContext({ estimatedPromptTokens: 50_000, contextWindow: 8192 });
  const err = new ContextOverflowError(res, 8192);
  assert.equal(err.name, "ContextOverflowError");
  assert.equal(err.contextWindow, 8192);
  assert.ok(err.overflowTokens > 0);
  // Distinguishable from an HTTP failure, so a host can react differently (offer to compact).
  assert.equal(err instanceof AiHttpError, false);
});
