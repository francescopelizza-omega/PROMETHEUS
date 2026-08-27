/**
 * continuation.test.ts — a plan is not the work, and a finished answer is not a plan.
 *
 * Live report: `mkdir` ran in round 1, round 2 said "I'll create the folder and build out all 10
 * scripts. Let me get started." and called nothing, and the turn ENDED at round 2 of 48 with nine
 * of the ten requested files never written. The same model carried straight on when told by hand
 * that nothing had been created.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { announcesUnfinishedWork } from "./continuation.js";
import {
  type AgentEvent,
  type AgentTuning,
  type LLMClient,
  type ThreadMessage,
  type ToolRunner,
  defaultTuning,
  runAgentTurn,
} from "./loop.js";
import type { ToolDef } from "./tools.js";

const WRITE: ToolDef = {
  name: "write_file",
  title: "write",
  description: "write a file",
  schema: {},
  annotations: {},
  toArgv: () => [],
};

const tuning = (over: Partial<AgentTuning> = {}): AgentTuning =>
  ({
    ...defaultTuning({ provider: "local", name: "qwen3.6" } as AgentTuning["model"]),
    tools: { enabled: true, allow: [], deny: [], extra: [WRITE] },
    yes: true,
    maxRounds: 48,
    ...over,
  }) as AgentTuning;

/** Drive a turn whose model script is a function of the round number. */
async function drive(
  script: (round: number) => { kind: string; [k: string]: unknown }[],
  over: Partial<AgentTuning> = {},
): Promise<{ rounds: number; written: string[]; events: AgentEvent[] }> {
  let rounds = 0;
  const written: string[] = [];
  const llm = {
    async *turn() {
      rounds += 1;
      for (const t of script(rounds)) yield t;
    },
  } as unknown as LLMClient;
  const runTool = (async (_t: ToolDef, a: Record<string, unknown>) => {
    written.push(String(a.path));
    return { ok: true, summary: "created" };
  }) as ToolRunner;
  const events: AgentEvent[] = [];
  const thread = { messages: [{ role: "user", content: "create 10 files" }] as ThreadMessage[] };
  for await (const e of runAgentTurn(thread, tuning(over), {
    llm,
    runTool,
    confirm: () => true, // the write tool is not readOnlyHint — `yes` alone does not lift it
  })) {
    events.push(e);
  }
  return { rounds, written, events };
}

/* ── the predicate ─────────────────────────────────────────────────────────── */

test("an announcement of imminent work is recognised", () => {
  for (const text of [
    "I'll create the folder and build out all 10 scripts. Let me get started.",
    "Let me write them all now!",
    "Now I'll write each of the ten files.",
    "I will now create the files.",
    "I'm going to create the scripts.",
    "Let's begin.",
  ]) {
    assert.equal(announcesUnfinishedWork(text), true, `missed: ${text}`);
  }
});

test("a FINISHED answer is never mistaken for a plan", () => {
  // The false-positive direction is the dangerous one: it argues with a model that has already
  // answered, and does it invisibly. "Let me know if …" is the commonest sign-off in the language.
  for (const text of [
    "I created 10 files in BULBMLEBEE. Let me know if you need anything else.",
    "Done. The folder now contains 10 scripts.",
    "The answer is 42.",
    "I've written all ten scripts. Here they are: matrix.py, fft.py",
    "I can't do that — the directory is read-only.",
    "Let me know if you'd like me to add more.",
    "I'll be happy to help with anything else.",
    "I finished. Let me get you the summary: all ten scripts are in place.",
    "",
    "   ",
  ]) {
    assert.equal(announcesUnfinishedWork(text), false, `false positive: ${text}`);
  }
});

test("planning language mid-message does not count — only the tail does", () => {
  // "I'll create ten scripts" followed by the actual answer is a normal, finished reply.
  const answered = `I'll create ten scripts.${" ".repeat(5)}${"x".repeat(400)} All ten are done.`;
  assert.equal(announcesUnfinishedWork(answered), false);
});

/* ── the loop ──────────────────────────────────────────────────────────────── */

test("a turn that narrates instead of acting is nudged, and the work actually happens", async () => {
  const { rounds, written } = await drive((r) => {
    if (r === 1) return [{ kind: "tool_call", call: { name: "write_file", args: { path: "f1" } } }];
    if (r === 2) return [{ kind: "final", text: "I'll build all 10 scripts. Let me get started." }];
    if (r <= 11)
      return [{ kind: "tool_call", call: { name: "write_file", args: { path: `f${r}` } } }];
    return [{ kind: "final", text: "All 10 are created. Let me know if you need anything else." }];
  });
  assert.ok(rounds > 2, `the turn ended at round ${rounds} — the plan was taken for an answer`);
  assert.equal(written.length, 10, `only ${written.length} of 10 files were written`);
});

test("the nudge is announced — a turn that silently resurrects itself is worse than one that stops", async () => {
  const { events } = await drive((r) =>
    r === 1
      ? [{ kind: "tool_call", call: { name: "write_file", args: { path: "f1" } } }]
      : [{ kind: "final", text: "Let me get started." }],
  );
  assert.ok(
    events.some((e) => e.kind === "status" && /described work without doing it/.test(e.text)),
    "the user was given no sign the loop had re-prompted the model",
  );
});

test("nudging is BOUNDED — a model that only ever narrates still ends the turn", async () => {
  // without a ceiling this is a doom loop dressed as helpfulness.
  const { rounds } = await drive((r) =>
    r === 1
      ? [{ kind: "tool_call", call: { name: "write_file", args: { path: "f1" } } }]
      : [{ kind: "final", text: "Let me get started." }],
  );
  assert.ok(rounds <= 5, `ran ${rounds} rounds on a model that never acts`);
});

test("a genuine answer ends the turn immediately — no extra round is spent", async () => {
  const { rounds } = await drive((r) =>
    r === 1
      ? [{ kind: "tool_call", call: { name: "write_file", args: { path: "f1" } } }]
      : [{ kind: "final", text: "Done — I created the file. Let me know if you need more." }],
  );
  assert.equal(rounds, 2, "a finished answer was argued with");
});

test("continuationNudges: 0 opts out entirely", async () => {
  const { rounds } = await drive(
    (r) =>
      r === 1
        ? [{ kind: "tool_call", call: { name: "write_file", args: { path: "f1" } } }]
        : [{ kind: "final", text: "Let me get started." }],
    { continuationNudges: 0 },
  );
  assert.equal(rounds, 2, "the opt-out did not opt out");
});
