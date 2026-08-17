/**
 * repeat-guard.test.ts — a model stuck calling the same tool forever.
 *
 * The previous doom-loop guard was dead three ways: no host populated its `callHistory`, its
 * branch required an `allow` its only caller could not produce, and it sat under the broker's
 * CONFIRM path — while the loop that actually happens is `read_file` on the same path, a
 * read-only tool the broker auto-approves and which therefore never reaches a confirm at all.
 * Driving the real `runAgentTurn` with such a model produced thirty-two round-trips and zero
 * guard events.
 *
 * So the important test here is the last one: it drives the REAL loop, not the guard class.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "./events.js";
import type { AgentTuning, LLMClient, ThreadMessage, ToolRunner } from "./loop.js";
import { runAgentTurn } from "./loop.js";
import {
  DEFAULT_REPEAT_LIMIT,
  RepeatGuard,
  callFingerprint,
  stableStringify,
} from "./repeat-guard.js";

/* ── the identity of a call ────────────────────────────────────────────────*/

test("the fingerprint includes the ARGUMENTS, not just the tool name", () => {
  // Keying on the name alone cannot express "the same call": it fires on three reads of three
  // different files while missing a thousand reads of one.
  assert.notEqual(
    callFingerprint({ name: "read_file", args: { path: "a.ts" } }),
    callFingerprint({ name: "read_file", args: { path: "b.ts" } }),
  );
  assert.equal(
    callFingerprint({ name: "read_file", args: { path: "a.ts" } }),
    callFingerprint({ name: "read_file", args: { path: "a.ts" } }),
  );
});

test("key ORDER does not make one call look like two", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(
    callFingerprint({ name: "t", args: { x: 1, y: [1, { b: 2, a: 1 }] } }),
    callFingerprint({ name: "t", args: { y: [1, { a: 1, b: 2 }], x: 1 } }),
  );
});

/* ── the counter ───────────────────────────────────────────────────────────*/

test("two identical calls are fine; the third is refused; a fourth aborts", () => {
  const g = new RepeatGuard();
  const call = { name: "read_file", args: { path: "a.ts" } };
  assert.equal(g.observe(call), "ok");
  assert.equal(g.observe(call), "ok");
  assert.equal(g.observe(call), "stop");
  assert.equal(g.observe(call), "abort");
});

test("a DIFFERENT call resets the run — progress is not punished", () => {
  const g = new RepeatGuard();
  g.observe({ name: "read_file", args: { path: "a.ts" } });
  g.observe({ name: "read_file", args: { path: "a.ts" } });
  assert.equal(g.observe({ name: "read_file", args: { path: "b.ts" } }), "ok");
  assert.equal(g.observe({ name: "read_file", args: { path: "b.ts" } }), "ok");
});

test("a limit of 0 disables the guard entirely", () => {
  const g = new RepeatGuard(0);
  const call = { name: "x", args: {} };
  for (let i = 0; i < 50; i++) assert.equal(g.observe(call), "ok");
});

/* ── the loop, driven for real ─────────────────────────────────────────────*/

/** A model that asks for the exact same tool call forever. */
function stuckModel(): LLMClient {
  return {
    async *turn() {
      yield { kind: "tool_call" as const, call: { name: "prometheus_list", args: { q: "a" } } };
    },
  } as unknown as LLMClient;
}

const tuning = (over: Partial<AgentTuning> = {}): AgentTuning =>
  ({
    model: { provider: "test", modelId: "m" },
    systemPrompt: "",
    tools: { enabled: true, allow: [], deny: [] },
    gateMode: "off",
    dryRun: false,
    verbosity: "quiet",
    yes: true,
    ...over,
  }) as AgentTuning;

test("a stuck model is STOPPED — it used to run to the round cap unchecked", () => {
  // The live repro before this guard: 32 tool runs, 0 blocked events, and a turn that ended by
  // inviting the human to /continue the same loop.
  let ran = 0;
  const runTool: ToolRunner = async () => {
    ran += 1;
    return { ok: true, summary: "contents" };
  };
  const thread = { messages: [{ role: "user", content: "read it" }] as ThreadMessage[] };

  return (async () => {
    const events: AgentEvent[] = [];
    for await (const e of runAgentTurn(thread, tuning(), { llm: stuckModel(), runTool })) {
      events.push(e);
    }
    assert.ok(ran < 5, `the stuck tool ran ${ran} times — the guard did not fire`);
    assert.ok(
      events.some((e) => e.kind === "blocked" && /repeated identically/.test(e.reason)),
      "the turn did not end with an explanation of why",
    );
    // NOT capped: this is a model that is not listening, not a pause worth resuming. Offering
    // `/continue` here would resume the loop.
    assert.equal(
      events.some((e) => e.kind === "capped"),
      false,
      "a doom loop must not be presented as a resumable pause",
    );
  })();
});

test("the MODEL is told why, so a refusal it cannot read is not simply repeated", () => {
  const runTool: ToolRunner = async () => ({ ok: true, summary: "contents" });
  const thread = { messages: [{ role: "user", content: "read it" }] as ThreadMessage[] };
  return (async () => {
    const events: AgentEvent[] = [];
    for await (const e of runAgentTurn(thread, tuning(), { llm: stuckModel(), runTool })) {
      events.push(e);
    }
    const refusal = events.find(
      (e) => e.kind === "tool_result" && !e.ok && /identical arguments/.test(e.summary),
    );
    assert.ok(refusal, "the model was never told why its call was refused");
    // …and it reached the THREAD, which is what the model actually reads next round.
    assert.ok(
      thread.messages.some((m) => m.role === "tool" && /identical arguments/.test(m.content)),
    );
  })();
});

test("a model doing real work is untouched by the guard", () => {
  // The guard must not become a tax on ordinary multi-round work.
  let i = 0;
  const walking: LLMClient = {
    async *turn() {
      i += 1;
      if (i > 4) {
        yield { kind: "text" as const, text: "done" };
        return;
      }
      yield { kind: "tool_call" as const, call: { name: "prometheus_list", args: { q: `f${i}` } } };
    },
  } as unknown as LLMClient;
  let ran = 0;
  const runTool: ToolRunner = async () => {
    ran += 1;
    return { ok: true, summary: "ok" };
  };
  const thread = { messages: [{ role: "user", content: "read them" }] as ThreadMessage[] };
  return (async () => {
    const events: AgentEvent[] = [];
    for await (const e of runAgentTurn(thread, tuning(), { llm: walking, runTool })) events.push(e);
    assert.equal(ran, 4, "distinct calls were wrongly refused");
    assert.equal(
      events.some((e) => e.kind === "blocked"),
      false,
    );
  })();
});

test("the default limit is stated once and is what the loop uses", () => {
  assert.equal(DEFAULT_REPEAT_LIMIT, 3);
});
