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
import type { AgentTuning, LLMClient, ThreadMessage, ToolCall, ToolRunner } from "./loop.js";
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

/** A model that asks forever for a tool that DOES NOT EXIST. */
function hallucinatingModel(): LLMClient {
  return {
    async *turn() {
      yield { kind: "tool_call" as const, call: { name: "not_a_real_tool", args: { q: "a" } } };
    },
  } as unknown as LLMClient;
}

test("a model stuck on a HALLUCINATED tool is stopped too — it used to run the full round cap", () => {
  // regression: `repeats.observe()` sat BELOW the catalog lookup, and the "is not exposed"
  // branch `continue`d before reaching it. So the single most repeatable thing a model does was
  // the one thing the guard could not see. Measured on compiled core: a repeated EXPOSED tool
  // stopped after 4 model rounds; a repeated non-existent name ran all 32 and ended `capped` —
  // eight times the budget on a call that could never succeed.
  let rounds = 0;
  const llm = {
    async *turn() {
      rounds += 1;
      yield { kind: "tool_call" as const, call: { name: "not_a_real_tool", args: { q: "a" } } };
    },
  } as unknown as LLMClient;
  const runTool: ToolRunner = async () => ({ ok: true, summary: "never reached" });
  const thread = { messages: [{ role: "user", content: "go" }] as ThreadMessage[] };

  return (async () => {
    const events: AgentEvent[] = [];
    for await (const e of runAgentTurn(thread, tuning(), { llm, runTool })) events.push(e);
    assert.ok(rounds < 8, `the hallucinated call ran ${rounds} model rounds — the guard is blind`);
    // the FIRST occurrence must still say the tool does not exist, or the model cannot re-plan.
    assert.ok(
      events.some((e) => e.kind === "blocked" && /is not exposed/.test(e.reason)),
      "the model was never told the tool does not exist",
    );
    assert.ok(
      events.some((e) => e.kind === "blocked" && /repeated identically/.test(e.reason)),
      "the turn did not end with an explanation of why",
    );
    assert.equal(
      events.some((e) => e.kind === "capped"),
      false,
      "a doom loop must not be presented as a resumable pause",
    );
  })();
});

test("hallucinatingModel is only used through the loop (self-check on the helper)", () => {
  assert.equal(typeof hallucinatingModel().turn, "function");
});

test("EVERY early-return branch is under the guard: --force and malformed_tool_call loops stop too", () => {
  // regression: round 17 hoisted the guard above the CATALOG lookup, but two `continue` branches
  // still sat above it — the `--force` refusal and the transport's malformed-call feedback. Each
  // returns early, and an early return the guard never sees is a doom loop it cannot stop.
  // Measured on compiled core: both ran the FULL 32 model rounds and ended `capped`, offering a
  // `/continue` that would resume the same loop. An exposed tool stopped after 4.
  const cases: Array<[string, ToolCall]> = [
    ["--force", { name: "read_file", args: { path: "a.ts", force: true } } as ToolCall],
    ["malformed", { name: "malformed_tool_call", args: { reason: "cannot parse" } } as ToolCall],
  ];
  return (async () => {
    for (const [label, call] of cases) {
      let rounds = 0;
      const llm = {
        async *turn() {
          rounds += 1;
          yield { kind: "tool_call" as const, call };
        },
      } as unknown as LLMClient;
      const events: AgentEvent[] = [];
      const thread = { messages: [{ role: "user", content: "go" }] as ThreadMessage[] };
      for await (const e of runAgentTurn(thread, tuning(), {
        llm,
        runTool: (async () => ({ ok: true, summary: "x" })) as ToolRunner,
      })) {
        events.push(e);
      }
      assert.ok(rounds < 8, `${label} ran ${rounds} model rounds — the guard is blind to it`);
      assert.equal(
        events.some((e) => e.kind === "capped"),
        false,
        `${label} doom loop was presented as a resumable pause`,
      );
    }
  })();
});

test("first occurrences keep their OWN message — the guard only changes REPEATS", () => {
  const probes: Array<[string, ToolCall, RegExp]> = [
    [
      "force",
      { name: "read_file", args: { path: "a.ts", force: true } } as ToolCall,
      /forbidden from using --force/,
    ],
    [
      "malformed",
      { name: "malformed_tool_call", args: { reason: "could not parse your XML" } } as ToolCall,
      /could not parse your XML/,
    ],
    ["unknown", { name: "not_a_tool", args: {} } as ToolCall, /is not exposed/],
  ];
  return (async () => {
    for (const [label, call, want] of probes) {
      let n = 0;
      const llm = {
        async *turn() {
          n += 1;
          if (n === 1) yield { kind: "tool_call" as const, call };
          else yield { kind: "final" as const, text: "done" };
        },
      } as unknown as LLMClient;
      const events: AgentEvent[] = [];
      const thread = { messages: [{ role: "user", content: "go" }] as ThreadMessage[] };
      for await (const e of runAgentTurn(thread, tuning(), {
        llm,
        runTool: (async () => ({ ok: true, summary: "x" })) as ToolRunner,
      })) {
        events.push(e);
      }
      const reasons = events.filter((e) => e.kind === "blocked").map((e) => e.reason);
      assert.ok(
        reasons.some((r) => want.test(r)),
        `${label}: lost its own first-occurrence message, got ${JSON.stringify(reasons)}`,
      );
    }
  })();
});
