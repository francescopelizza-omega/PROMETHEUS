/**
 * agent.test.ts — the §3.2 agent loop: tool exposure, never-force, gate-first.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRef } from "../agents/types.js";
import { applyProposedEdit, diffHunk, parseHunks } from "./edit.js";
import type { AgentEvent } from "./events.js";
import {
  type AgentTuning,
  type LLMClient,
  type LlmTurn,
  type ToolOutcome,
  capBytes,
  defaultTuning,
  runAgentTurn,
} from "./loop.js";
import { exposedToolNames, isForceArg } from "./tools.js";

const MODEL: ModelRef = { provider: "local", modelId: "qwen3:8b" };

function scriptedLlm(turns: LlmTurn[]): LLMClient {
  // ONE-SHOT (CLI-032): a re-invoked script has nothing more to say, so a script that
  // ends WITHOUT a `final` stays effectively single-round (round 2 yields nothing).
  let spent = false;
  return {
    turn: async function* () {
      if (spent) return;
      spent = true;
      for (const t of turns) yield t;
    },
  };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test("exposedTools: the 14 prometheus tools + propose_edit + write_file + web_fetch (CLI-010/011)", () => {
  assert.equal(exposedToolNames({ enabled: false, allow: [], deny: [] }).size, 0);
  // the 14 prometheus.py tools PLUS the CLI-local propose_edit + write_file + web_fetch = 17
  const all = exposedToolNames({ enabled: true, allow: [], deny: [] });
  assert.equal(all.size, 17);
  assert.ok(all.has("propose_edit"), "propose_edit is exposed to the agent");
  assert.ok(all.has("write_file"), "write_file is exposed to the agent");
  assert.ok(all.has("web_fetch"), "web_fetch is exposed to the agent");
  assert.deepEqual(
    [...exposedToolNames({ enabled: true, allow: ["prometheus_list"], deny: [] })],
    ["prometheus_list"],
  );
  assert.equal(
    exposedToolNames({ enabled: true, allow: [], deny: ["prometheus_install"] }).has(
      "prometheus_install",
    ),
    false,
  );
});

test("isForceArg detects force:true / --force argv (incl. =value forms)", () => {
  assert.equal(isForceArg({ force: true }), true);
  assert.equal(isForceArg({ argv: ["--force"] }), true);
  assert.equal(isForceArg({ argv: ["--force-unsafe"] }), true);
  // F1: the `=value` form must also be caught (was missed pre-fix).
  assert.equal(isForceArg({ argv: ["--force=1"] }), true);
  assert.equal(isForceArg({ argv: ["--force-unsafe=true"] }), true);
  assert.equal(isForceArg({ name: "x" }), false);
});

test("loop: read-only auto-runs with yes; final ends the turn", async () => {
  const ran: string[] = [];
  const tuning: AgentTuning = { ...defaultTuning(MODEL), yes: true };
  const events = await collect(
    runAgentTurn({ messages: [] }, tuning, {
      llm: scriptedLlm([
        { kind: "text", text: "scanning…" },
        { kind: "tool_call", call: { name: "prometheus_list", args: {} } },
        { kind: "final", text: "done" },
      ]),
      runTool: async (tool) => {
        ran.push(tool.name);
        return { ok: true, summary: "ok" } satisfies ToolOutcome;
      },
    }),
  );
  assert.deepEqual(ran, ["prometheus_list"]); // read-only auto-ran
  assert.ok(events.some((e) => e.kind === "tool_result" && e.ok));
  assert.equal(events.at(-1)?.kind, "done");
});

test("loop: the agent can NEVER use --force (hard block)", async () => {
  const ran: string[] = [];
  const events = await collect(
    runAgentTurn({ messages: [] }, defaultTuning(MODEL), {
      llm: scriptedLlm([
        {
          kind: "tool_call",
          call: { name: "prometheus_install", args: { name: "x", force: true } },
        },
      ]),
      runTool: async (t) => {
        ran.push(t.name);
        return { ok: true, summary: "" };
      },
    }),
  );
  assert.equal(ran.length, 0); // never ran
  assert.ok(events.some((e) => e.kind === "blocked" && /force/.test(e.reason)));
});

test("loop: destructive needs confirm; gate BLOCK aborts", async () => {
  // declined confirm → not run
  let ran = 0;
  const declined = await collect(
    runAgentTurn({ messages: [] }, defaultTuning(MODEL), {
      llm: scriptedLlm([
        { kind: "tool_call", call: { name: "prometheus_install", args: { name: "x" } } },
      ]),
      runTool: async () => {
        ran++;
        return { ok: true, summary: "" };
      },
      confirm: () => false,
    }),
  );
  assert.equal(ran, 0);
  assert.ok(declined.some((e) => e.kind === "blocked"));

  // confirmed but gate returns BLOCK → tool ran (dry-run) but result aborted
  const events = await collect(
    runAgentTurn({ messages: [] }, defaultTuning(MODEL), {
      llm: scriptedLlm([
        { kind: "tool_call", call: { name: "prometheus_install", args: { name: "x" } } },
      ]),
      runTool: async () => ({
        ok: false,
        summary: "blocked",
        verdict: { verdict: "block", riskScore: 88 },
      }),
      confirm: () => true,
    }),
  );
  assert.ok(events.some((e) => e.kind === "verdict" && e.verdict === "block"));
  assert.ok(events.some((e) => e.kind === "blocked" && /BLOCK/.test(e.reason)));
  // no tool_result emitted after a block abort
  assert.equal(
    events.some((e) => e.kind === "tool_result"),
    false,
  );
});

test("loop: dry-run injects dryRun into mutating args", async () => {
  let seen: Record<string, unknown> = {};
  const tuning: AgentTuning = { ...defaultTuning(MODEL), dryRun: true };
  await collect(
    runAgentTurn({ messages: [] }, tuning, {
      llm: scriptedLlm([
        { kind: "tool_call", call: { name: "prometheus_install", args: { name: "x" } } },
      ]),
      runTool: async (_t, args) => {
        seen = args;
        return { ok: true, summary: "planned" };
      },
      confirm: () => true,
    }),
  );
  assert.equal(seen.dryRun, true);
});

/* ── CLI-032: feed approved command output back to the agent (multi-round) ──── */

test("loop CLI-032: tool output re-enters the thread; round 2 references it + exit code", async () => {
  let round = 0;
  const llm: LLMClient = {
    async *turn(thread) {
      round++;
      if (round === 1) {
        yield { kind: "tool_call", call: { name: "prometheus_list", args: {} } };
      } else {
        const toolMsg = thread.messages.find((m) => m.role === "tool");
        yield { kind: "final", text: toolMsg ? `saw ${toolMsg.content}` : "no tool msg" };
      }
    },
  };
  const tuning: AgentTuning = { ...defaultTuning(MODEL), yes: true };
  const events = await collect(
    runAgentTurn({ messages: [] }, tuning, {
      llm,
      runTool: async () => ({ ok: true, summary: "STDOUT-CONTENT-42", data: { exitCode: 0 } }),
    }),
  );
  const text = events
    .filter((e) => e.kind === "text")
    .map((e) => (e as { text: string }).text)
    .join("");
  assert.match(text, /saw.*STDOUT-CONTENT-42/s, "round 2 saw the tool output in the thread");
  assert.match(text, /exit: 0/, "the exit code rode into the tool message");
  assert.equal(round, 2, "the loop re-invoked the model after the tool ran");
  assert.equal(events.at(-1)?.kind, "done");
});

test("loop CLI-032: a declined command feeds a refusal + the loop continues (done fires)", async () => {
  let round = 0;
  const llm: LLMClient = {
    async *turn(thread) {
      round++;
      if (round === 1) {
        yield { kind: "tool_call", call: { name: "prometheus_install", args: { name: "x" } } };
      } else {
        const denied = thread.messages.find((m) => m.role === "tool" && /denied/.test(m.content));
        yield { kind: "final", text: denied ? "re-planning safely" : "no refusal" };
      }
    },
  };
  const events = await collect(
    runAgentTurn({ messages: [] }, defaultTuning(MODEL), {
      llm,
      runTool: async () => ({ ok: true, summary: "" }),
      confirm: () => ({ approved: false, reason: "too risky" }),
    }),
  );
  const text = events
    .filter((e) => e.kind === "text")
    .map((e) => (e as { text: string }).text)
    .join("");
  assert.match(text, /re-planning safely/, "the model re-planned from the refusal context");
  assert.equal(round, 2);
  assert.equal(events.at(-1)?.kind, "done", "done still fires after a decline");
});

test("loop CLI-032/072: maxRounds bounds a runaway loop + emits a distinct capped event", async () => {
  let round = 0;
  const llm: LLMClient = {
    // eslint-disable-next-line require-yield
    async *turn() {
      round++;
      yield { kind: "tool_call", call: { name: "prometheus_list", args: {} } };
    },
  };
  const tuning: AgentTuning = { ...defaultTuning(MODEL), yes: true, maxRounds: 3 };
  const events = await collect(
    runAgentTurn({ messages: [] }, tuning, {
      llm,
      runTool: async () => ({ ok: true, summary: "ok" }),
    }),
  );
  assert.equal(round, 3, "stopped at maxRounds, not the token budget");
  // CLI-072: the cap is a structured `capped` event (NOT a fake text/final), so the host can
  // offer /continue — with the round count + a resumable flag.
  const cap = events.find((e) => e.kind === "capped");
  assert.ok(cap, "a capped event is emitted at the cap");
  assert.equal((cap as { rounds: number }).rounds, 3);
  assert.equal((cap as { canContinue: boolean }).canContinue, true);
  assert.equal(events.at(-1)?.kind, "done");
});

test("loop CLI-072: a run that finishes under the cap emits NO capped event", async () => {
  const tuning: AgentTuning = { ...defaultTuning(MODEL), yes: true, maxRounds: 8 };
  const events = await collect(
    runAgentTurn({ messages: [] }, tuning, {
      llm: scriptedLlm([
        { kind: "tool_call", call: { name: "prometheus_list", args: {} } },
        { kind: "final", text: "done" },
      ]),
      runTool: async () => ({ ok: true, summary: "ok" }),
    }),
  );
  assert.ok(!events.some((e) => e.kind === "capped"), "no cap notice under the cap");
  assert.equal(events.at(-1)?.kind, "done");
});

test("loop CLI-072: capped run folds tool state into the thread → resume completes from it", async () => {
  // Round 1 caps (maxRounds:1, always asks for a tool). The loop must fold the assistant text +
  // tool result into the thread BEFORE the cap, so a resume sees them.
  const thread = { messages: [{ role: "user" as const, content: "do it" }] };
  const capTuning: AgentTuning = { ...defaultTuning(MODEL), yes: true, maxRounds: 1 };
  const capped = await collect(
    runAgentTurn(thread, capTuning, {
      llm: scriptedLlm([
        { kind: "text", text: "calling…" },
        { kind: "tool_call", call: { name: "prometheus_list", args: {} } },
      ]),
      runTool: async () => ({ ok: true, summary: "RESULT-ABC", data: { exitCode: 0 } }),
    }),
  );
  assert.ok(capped.some((e) => e.kind === "capped"));
  // the tool result rode into the SAME thread object (resume state intact).
  assert.ok(
    thread.messages.some((m) => m.role === "tool" && /RESULT-ABC/.test(m.content)),
    "the tool result is folded into the thread for resume",
  );
  // resume: re-run on the SAME thread; the model now sees the tool result and finalizes.
  const resumed = await collect(
    runAgentTurn(
      thread,
      { ...defaultTuning(MODEL), yes: true, maxRounds: 8 },
      {
        llm: {
          async *turn(t) {
            const sawTool = t.messages.find(
              (m) => m.role === "tool" && /RESULT-ABC/.test(m.content),
            );
            yield { kind: "final", text: sawTool ? "finished with RESULT-ABC" : "no state" };
          },
        },
        runTool: async () => ({ ok: true, summary: "" }),
      },
    ),
  );
  const text = resumed
    .filter((e) => e.kind === "text")
    .map((e) => (e as { text: string }).text)
    .join("");
  assert.match(text, /finished with RESULT-ABC/, "resume continued from preserved tool state");
  assert.ok(!resumed.some((e) => e.kind === "capped"), "the resumed turn completed under the cap");
});

test("loop CLI-072: a pending gate wins over the cap (a cap never bypasses a BLOCK)", async () => {
  // maxRounds:1 + a destructive call that the gate BLOCKs: the block must surface, not a clean cap.
  const events = await collect(
    runAgentTurn(
      { messages: [] },
      { ...defaultTuning(MODEL), maxRounds: 1 },
      {
        llm: scriptedLlm([
          { kind: "tool_call", call: { name: "prometheus_install", args: { name: "x" } } },
        ]),
        runTool: async () => ({
          ok: false,
          summary: "blocked",
          verdict: { verdict: "block", riskScore: 90 },
        }),
        confirm: () => true,
      },
    ),
  );
  assert.ok(
    events.some((e) => e.kind === "blocked" && /BLOCK/.test(e.reason)),
    "gate BLOCK surfaced",
  );
});

test("capBytes: small verbatim; over-budget truncated head+tail with a marker", () => {
  assert.equal(capBytes("hello", 100), "hello");
  const big = "A".repeat(50_000);
  const capped = capBytes(big, 16 * 1024);
  assert.ok(Buffer.byteLength(capped) < 20_000, "capped to roughly the budget");
  assert.match(capped, /…\[truncated \d+ bytes\]…/);
  assert.ok(capped.startsWith("A") && capped.endsWith("A"), "head + tail preserved");
});

/* ── CLI-010: propose_edit applier + diff + broker never-auto + reason seam ─── */

test("applyProposedEdit: exact unique match, order-applied", () => {
  const r = applyProposedEdit("a\nb\nc\n", [{ old: "b", new: "B" }]);
  assert.ok(r.ok && r.next === "a\nB\nc\n");
});

test("applyProposedEdit: no-match and ambiguous are typed errors, never throws", () => {
  const miss = applyProposedEdit("a\nb\n", [{ old: "zzz", new: "x" }]);
  assert.ok(!miss.ok && miss.code === "no-match");
  const amb = applyProposedEdit("x\nx\n", [{ old: "x", new: "y" }]);
  assert.ok(!amb.ok && amb.code === "ambiguous"); // 2 matches → NOT first-wins
  const empty = applyProposedEdit("a", []);
  assert.ok(!empty.ok && empty.code === "empty");
});

test("applyProposedEdit: CRLF + BOM + trailing-newline round-trip byte-identical", () => {
  // CRLF file, model sends \n hunks → matched, original \r\n re-applied
  const crlf = applyProposedEdit("one\r\ntwo\r\nthree\r\n", [{ old: "two", new: "TWO" }]);
  assert.ok(crlf.ok && crlf.next === "one\r\nTWO\r\nthree\r\n");
  // BOM preserved
  const bom = applyProposedEdit("﻿hello world\n", [{ old: "world", new: "there" }]);
  assert.ok(bom.ok && bom.next === "﻿hello there\n");
  // no trailing newline stays no trailing newline
  const noNl = applyProposedEdit("a\nb", [{ old: "b", new: "B" }]);
  assert.ok(noNl.ok && noNl.next === "a\nB");
});

test("diffHunk: shared context vs changed lines; parseHunks tolerates a JSON string", () => {
  const d = diffHunk("a\nb\nc", "a\nB\nc");
  assert.deepEqual(d, [
    { tag: " ", text: "a" },
    { tag: "-", text: "b" },
    { tag: "+", text: "B" },
    { tag: " ", text: "c" },
  ]);
  assert.deepEqual(parseHunks('[{"old":"x","new":"y"}]'), [{ old: "x", new: "y" }]);
  assert.deepEqual(parseHunks([{ old: "x", new: "y" }, { bad: 1 }]), [{ old: "x", new: "y" }]);
});

test("loop: propose_edit is NEVER auto-approved, even under tuning.yes (broker)", async () => {
  let ran = false;
  const call = { name: "propose_edit", args: { path: "f.txt", hunks: [{ old: "a", new: "b" }] } };
  const events = await collect(
    runAgentTurn(
      { messages: [] },
      { ...defaultTuning(MODEL), yes: true },
      {
        llm: scriptedLlm([{ kind: "tool_call", call }, { kind: "final" }]),
        runTool: async (): Promise<ToolOutcome> => {
          ran = true;
          return { ok: true, summary: "applied" };
        },
        // no confirm → default deny
      },
    ),
  );
  assert.equal(ran, false, "propose_edit must not run without explicit confirm, even with yes");
  assert.ok(events.some((e) => e.kind === "blocked"));
});

test("loop: a reasoned rejection surfaces as a tool_result (model re-plans), not blocked", async () => {
  const call = { name: "propose_edit", args: { path: "f.txt", hunks: [{ old: "a", new: "b" }] } };
  const events = await collect(
    runAgentTurn({ messages: [] }, defaultTuning(MODEL), {
      llm: scriptedLlm([{ kind: "tool_call", call }, { kind: "final" }]),
      runTool: async (): Promise<ToolOutcome> => ({ ok: true, summary: "applied" }),
      confirm: () => ({ approved: false, reason: "not what I wanted" }),
    }),
  );
  const tr = events.find((e) => e.kind === "tool_result");
  assert.ok(tr && !("ok" in tr && tr.ok), "a reasoned reject is a failed tool_result");
  assert.match((tr as { summary: string }).summary, /user rejected: not what I wanted/);
  assert.ok(!events.some((e) => e.kind === "blocked"), "reasoned reject is NOT a blocked event");
});
