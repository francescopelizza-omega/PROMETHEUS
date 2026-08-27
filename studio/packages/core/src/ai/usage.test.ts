/**
 * usage.test.ts — accumulating a turn's usage across frames that are each incomplete.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeWireUsage } from "./usage.js";

test("Anthropic's two frames combine instead of the last one winning", () => {
  /**
   * Anthropic reports a turn's usage in two frames and NEITHER is complete: `message_start`
   * carries input_tokens plus the prompt-cache counters, `message_delta` carries only
   * output_tokens. Every consumer kept the last frame it saw, so a Claude turn was recorded as
   * `{inputTokens: 0, outputTokens: N}` with the cache counters dropped — and the desktop budget
   * gate is fed exactly that, so a configured USD cap counted only the output half of the bill.
   * On a long-context model the input side is usually the larger half, so the cap under-counted
   * badly and tripped far later than the user asked for.
   */
  const messageStart = {
    inputTokens: 12_000,
    outputTokens: 0,
    totalTokens: 12_000,
    cacheRead: 9_000,
    cacheCreate: 1_500,
  };
  const messageDelta = { inputTokens: 0, outputTokens: 350, totalTokens: 350 };

  const merged = mergeWireUsage(mergeWireUsage(undefined, messageStart), messageDelta);
  assert.equal(merged?.inputTokens, 12_000, "the input count was erased by the delta frame");
  assert.equal(merged?.outputTokens, 350);
  assert.equal(merged?.totalTokens, 12_350);
  assert.equal(merged?.cacheRead, 9_000, "the cache counters were dropped");
  assert.equal(merged?.cacheCreate, 1_500);
});

test("a provider that repeats running totals is not double-counted", () => {
  // Counts are REPLACED, not summed: every provider reports totals for the turn so far, so
  // summing would inflate any provider that restates the figure on each frame.
  const a = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
  const b = { inputTokens: 100, outputTokens: 25, totalTokens: 125 };
  const merged = mergeWireUsage(mergeWireUsage(undefined, a), b);
  assert.equal(merged?.inputTokens, 100);
  assert.equal(merged?.outputTokens, 25);
  assert.equal(merged?.totalTokens, 125);
});

test("the degenerate cases behave", () => {
  const u = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
  assert.equal(mergeWireUsage(undefined, undefined), undefined);
  assert.deepEqual(mergeWireUsage(u, undefined), u, "a frame with no usage must not erase one");
  assert.deepEqual(mergeWireUsage(undefined, u), u);
  // a single OpenAI-style frame carrying everything at once passes straight through
  assert.deepEqual(mergeWireUsage(undefined, { ...u, cacheRead: 3 }), { ...u, cacheRead: 3 });
});
