/**
 * turn-outcome.test.ts — a turn that produced nothing must SAY so, and the prompt estimate must
 * count the tool schemas.
 *
 * Both are the 2026-09-24 incident: a local thinking model was cut off at the context limit
 * (7,254-token prompt, 8,192-token serving window), Prometheus showed nothing at all, and its
 * own accounting recorded the prompt as 755 tokens because the tool catalog is not in `messages`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyTurnNotice, estimateRequestTokens, truncationNotice } from "./turn-outcome.js";
import { OPENAI_WIRE, normalizeStopReason, selectWire } from "./wire.js";

test("a cut-off turn names the cause, the budget and a way out", () => {
  const msg = emptyTurnNotice({
    stopReason: "length",
    sawReasoning: true,
    promptTokens: 7254,
    contextWindow: 8192,
    runtime: "ollama",
  });
  assert.match(msg, /ran out of room/);
  assert.match(msg, /while still thinking/);
  assert.match(msg, /~7,254 of ~8,192 tokens \(89%\)/);
  assert.match(msg, /OLLAMA_CONTEXT_LENGTH/, "the remedy names the actual knob");
});

test("the other empty-turn causes each get their own line", () => {
  assert.match(emptyTurnNotice({ sawReasoning: true }), /only reasoning/);
  assert.match(emptyTurnNotice({ stopReason: "content_filter" }), /content filter/);
  assert.match(emptyTurnNotice({}), /empty reply/);
  // Always something: silence is what sent the user hunting for a crash that never happened.
  assert.ok(emptyTurnNotice().length > 0);
});

test("a truncated ANSWER is flagged as incomplete, not as empty", () => {
  const msg = truncationNotice({ stopReason: "length", promptTokens: 100, contextWindow: 8192 });
  assert.match(msg, /cut off/);
  assert.match(msg, /incomplete/);
});

test("the estimate counts tool schemas, which is where the 755-vs-7254 gap lived", () => {
  const messages = ["you are a helpful agent", "write vafammok.py"];
  const tools = Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${i}`,
    description: "d".repeat(200),
    parameters: { type: "object", properties: { path: { type: "string" } } },
  }));
  const withoutTools = estimateRequestTokens(messages);
  const withTools = estimateRequestTokens(messages, tools);
  assert.ok(withTools > withoutTools * 10, `${withTools} vs ${withoutTools}`);
});

test("OpenAI finish_reason reaches the caller as stopReason", () => {
  assert.equal(
    OPENAI_WIRE.parse('{"choices":[{"finish_reason":"length","delta":{}}]}').stopReason,
    "length",
  );
  assert.equal(
    OPENAI_WIRE.parse('{"choices":[{"finish_reason":"stop","delta":{"content":"hi"}}]}').stopReason,
    "stop",
  );
  // it stays a normal frame: the text still comes through
  assert.equal(
    OPENAI_WIRE.parse('{"choices":[{"finish_reason":"stop","delta":{"content":"hi"}}]}').delta,
    "hi",
  );
  assert.equal(OPENAI_WIRE.parse('{"choices":[{"delta":{"content":"x"}}]}').stopReason, undefined);
});

test("Anthropic's max_tokens is the same event under a different name", () => {
  const wire = selectWire("anthropic");
  const ev = wire.parse('{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}');
  assert.equal(ev.stopReason, "length");
  assert.equal(normalizeStopReason("end_turn"), "stop");
  assert.equal(normalizeStopReason("something_new"), "other");
});
