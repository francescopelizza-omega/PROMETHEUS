/**
 * carry-forward.test.ts — what the agent remembers between turns.
 *
 * The defect these guard against was not a crash and not an error message: the agent simply
 * began every turn having read nothing, because both hosts rebuilt the cross-turn thread as a
 * user/assistant TEXT PAIR and dropped the tool calls and results the loop had folded in. It
 * could spend six rounds reading a file, answer a question about it, and then be unable to
 * answer a follow-up without reading the file again.
 *
 * So these assert the CONSEQUENCE — "the file's contents are still in the thread" — rather than
 * that some function ran.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ELISION, carryBudgetFor, carryForward } from "./carry-forward.js";
import type { ThreadMessage } from "./loop.js";

/** One completed round: a question, a call, its result, an answer. */
const round = (n: number, result: string): ThreadMessage[] => [
  { role: "user", content: `question ${n}` },
  {
    role: "assistant",
    content: "calling a tool",
    toolCalls: [{ id: `c${n}`, name: "read_file", args: {} }],
  },
  { role: "tool", content: result, toolCallId: `c${n}` },
  { role: "assistant", content: `answer ${n}` },
];

test("what the agent READ survives into the next turn", () => {
  // The whole finding, in one assertion.
  const out = carryForward(round(1, "export const SECRET_TOKEN = 42;"), { budgetTokens: 10_000 });
  assert.ok(
    out.some((m) => m.content.includes("SECRET_TOKEN")),
    "the tool result was dropped — the agent has forgotten what it read",
  );
});

test("the call/result PAIRING survives, because the providers require it", () => {
  const out = carryForward(round(1, "contents"), { budgetTokens: 10_000 });
  const asst = out.find((m) => m.role === "assistant" && m.toolCalls);
  const tool = out.find((m) => m.role === "tool");
  assert.ok(asst, "the assistant turn lost its toolCalls");
  assert.equal(tool?.toolCallId, asst?.toolCalls?.[0]?.id);
});

test("system messages are NOT carried — they are reassembled every turn", () => {
  // Carrying one forward would duplicate the system prompt, and duplicate it again next turn.
  const out = carryForward([{ role: "system", content: "you are prometheus" }, ...round(1, "x")], {
    budgetTokens: 10_000,
  });
  assert.equal(
    out.some((m) => m.role === "system"),
    false,
  );
});

/* ── the budget ────────────────────────────────────────────────────────────*/

test("an enormous tool result is ELIDED, not carried whole", () => {
  // Tool output is an order of magnitude larger than prose; carrying it unbounded overflows the
  // window in about three turns, which fails mid-task rather than at the start.
  const huge = "x".repeat(200_000);
  const out = carryForward([...round(1, huge), ...round(2, "small")], { budgetTokens: 2_000 });
  const first = out.find((m) => m.role === "tool");
  assert.ok(first);
  assert.ok(first.content.length < huge.length, "the huge result was carried verbatim");
  assert.match(first.content, /elided/, "the cut must be marked");
});

test("the elision is MARKED, so the model can tell 'cut' from 'never read'", () => {
  // Those call for different next actions: re-read the middle, versus read the file at all.
  assert.match(ELISION(500), /elided/);
  assert.match(ELISION(500), /re-run the tool/);
});

test("the MOST RECENT round keeps its tool output whole", () => {
  // It is the round the model is most likely to be asked about next.
  const recent = "y".repeat(4_000);
  const out = carryForward([...round(1, "old"), ...round(2, recent)], { budgetTokens: 100_000 });
  const tools = out.filter((m) => m.role === "tool");
  assert.equal(tools.at(-1)?.content, recent);
});

test("over budget, WHOLE rounds are dropped — never half of one", () => {
  // A `tool_result` for a call the provider cannot see is a 400, not a smaller prompt. So a
  // naive oldest-first trim turns an over-long thread into a failed request.
  const out = carryForward(
    [...round(1, "a".repeat(20_000)), ...round(2, "b".repeat(20_000)), ...round(3, "c")],
    { budgetTokens: 1_500 },
  );
  const announced = new Set(out.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
  for (const m of out) {
    if (m.role === "tool" && m.toolCallId) {
      assert.ok(announced.has(m.toolCallId), `orphaned tool result ${m.toolCallId}`);
    }
  }
});

test("the LAST round is never dropped entirely, however tight the budget", () => {
  // Losing the question to fit the answer's output is not a trade worth making.
  const out = carryForward([...round(1, "a".repeat(50_000)), ...round(2, "b".repeat(50_000))], {
    budgetTokens: 100,
  });
  assert.ok(out.length > 0, "everything was dropped");
  assert.ok(
    // The oldest surviving round's opening message now carries the ROUND_DROP marker ahead of
    // its original text (round 1 was dropped to make room) — so it ends with, rather than
    // equals, the original question.
    out.some((m) => m.role === "user" && m.content.endsWith("question 2")),
    "the most recent question was dropped",
  );
});

test("a whole-round drop MARKS the surviving round, so the model can tell dropped from never-sent", () => {
  const out = carryForward([...round(1, "a".repeat(50_000)), ...round(2, "b".repeat(50_000))], {
    budgetTokens: 100,
  });
  const opening = out.find((m) => m.role === "user" && m.content.endsWith("question 2"));
  assert.ok(opening, "no surviving question found");
  assert.match(opening?.content ?? "", /earlier rounds? of this conversation were dropped/);
});

test("no rounds dropped ⇒ no marker anywhere", () => {
  const out = carryForward([...round(1, "a"), ...round(2, "b")], { budgetTokens: 10_000 });
  for (const m of out) {
    assert.doesNotMatch(m.content, /this conversation were dropped/);
  }
});

test("an empty thread carries nothing, and does not throw", () => {
  assert.deepEqual(carryForward([], { budgetTokens: 1000 }), []);
  assert.deepEqual(carryForward([{ role: "system", content: "s" }], { budgetTokens: 1000 }), []);
});

/* ── the budget is derived from the MODEL, not hard-coded ──────────────────*/

test("the carry budget scales with the model's context window", () => {
  // The same session is worth 8k tokens of memory on a small local model and 200k on Claude; a
  // fixed number is wrong in one direction or the other on every endpoint.
  assert.ok(carryBudgetFor(200_000) > carryBudgetFor(8_192));
  assert.ok(carryBudgetFor(1_048_576) > carryBudgetFor(200_000));
  // …and it is a FRACTION: the window also holds the system prompt, steering, the repo map, the
  // tool schemas, this turn's work and the reply.
  assert.ok(carryBudgetFor(200_000) < 200_000);
});

test("an unknown window falls back to a usable floor rather than to zero", () => {
  // Zero would mean "remember nothing", which is the bug this module exists to fix.
  assert.ok(carryBudgetFor(undefined) >= 1024);
  assert.ok(carryBudgetFor(0) >= 1024);
});

/* ── the thread must be a COMPLETE transcript, not a half of one ───────────── */

test("the agent remembers what it SAID, not only what it read", () => {
  // The first version of this fix carried `res.thread` forward without the loop folding the
  // terminal assistant message — so the agent remembered every file it had read and nothing it
  // had answered. "What did you just tell me?" became unanswerable, and it re-derived
  // conclusions it had already reached. A regression only visible by looking at the CONTENT.
  const thread: ThreadMessage[] = [
    { role: "user", content: "what does it define?" },
    {
      role: "assistant",
      content: "calling a tool",
      toolCalls: [{ id: "c1", name: "read_file", args: {} }],
    },
    { role: "tool", content: "export const SECRET_TOKEN = 42;", toolCallId: "c1" },
    { role: "assistant", content: "It defines SECRET_TOKEN = 42." },
  ];
  const out = carryForward(thread, { budgetTokens: 10_000 });
  assert.ok(
    out.some((m) => m.role === "assistant" && m.content.includes("SECRET_TOKEN = 42.")),
    "the answer was dropped — the agent forgets what it said",
  );
  assert.ok(
    out.some((m) => m.role === "tool" && m.content.includes("SECRET_TOKEN = 42;")),
    "the tool result was dropped — the agent forgets what it read",
  );
});
