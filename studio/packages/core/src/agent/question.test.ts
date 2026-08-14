/**
 * question.test.ts — the agent asks instead of guessing, and does not ask instead of working.
 *
 * Both failure directions are real and the second is the likelier one. A tool that asks is a tool
 * a weak model reaches for in place of reading a file, so most of what is pinned here is the
 * guardrail: the per-TURN budget, the refusal that tells the model what to do instead, and the
 * honest answer when there is no human to ask.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MAX_QUESTIONS,
  NO_ASKER_MESSAGE,
  QUESTION_TOOL,
  canAsk,
  initialQuestionBudget,
  renderAnswer,
  renderQuestion,
} from "./question.js";

/* ── the budget ─────────────────────────────────────────────────────────────*/

test("the budget is per TURN — a per-call cap would be no cap at all", () => {
  // The loop simply makes another call, which is why the spawn budget is per-turn too.
  const b = initialQuestionBudget({ maxQuestions: 2 });
  assert.equal(canAsk(b).allowed, true);
  b.asked = 2;
  assert.equal(canAsk(b).allowed, false);
});

test("running out of questions returns an INSTRUCTION, not a bare denial", () => {
  // A model told only "no" asks again in different words, which spends the rest of the turn.
  const b = initialQuestionBudget({ maxQuestions: 1 });
  b.asked = 1;
  const d = canAsk(b);
  assert.equal(d.allowed, false);
  if (!d.allowed) {
    assert.match(d.reason, /most reasonable interpretation/);
    assert.match(d.reason, /Do not ask again/);
    assert.match(d.reason, /SAY which one/);
  }
});

test("the default budget funds a real ambiguity and not a conversation", () => {
  assert.equal(DEFAULT_MAX_QUESTIONS, 3);
  assert.equal(initialQuestionBudget().asked, 0);
});

/* ── no human to ask ────────────────────────────────────────────────────────*/

test("with no asker the model is told to PROCEED, never to wait", () => {
  // A hang is the worst outcome here: a non-interactive run would sit forever on a question
  // nobody will ever see.
  assert.match(NO_ASKER_MESSAGE, /no interactive user/i);
  assert.match(NO_ASKER_MESSAGE, /Do NOT wait/);
  assert.match(NO_ASKER_MESSAGE, /state the assumption/);
});

/* ── rendering ──────────────────────────────────────────────────────────────*/

test("context earns its line only when it exists", () => {
  assert.equal(renderQuestion({ question: "Rename or delete?" }), "Rename or delete?");
  assert.equal(
    renderQuestion({ question: "Rename or delete?", context: "both are valid here" }),
    "Rename or delete?\n  (both are valid here)",
  );
});

test("a missing question renders as empty so the caller can refuse it", () => {
  assert.equal(renderQuestion({}), "");
  assert.equal(renderQuestion({ question: "   " }), "");
  assert.equal(renderQuestion({ question: 42 }), "");
});

test("an EMPTY answer is distinguishable from no answer at all", () => {
  // "the user did not answer" and "the user answered with nothing" call for different next
  // moves — the second can legitimately mean "no preference, you choose".
  const empty = renderAnswer("   ");
  assert.match(empty, /no answer/);
  assert.match(empty, /most reasonable interpretation/);
  assert.equal(renderAnswer("use delete"), "The user answered: use delete");
});

/* ── the tool ───────────────────────────────────────────────────────────────*/

test("question is readOnly — a confirm in front of it would be absurd", () => {
  // The broker would otherwise ask the human to approve being asked a question, then ask it.
  assert.equal(QUESTION_TOOL.annotations.readOnlyHint, true);
  assert.notEqual(QUESTION_TOOL.annotations.destructiveHint, true);
  assert.equal(QUESTION_TOOL.schema.question?.required, true);
  assert.equal(QUESTION_TOOL.schema.context?.required, undefined);
  assert.throws(() => QUESTION_TOOL.toArgv({}), /host runtime/);
});

test("the description names what NOT to use it for", () => {
  // Without this a model asks instead of looking. Each clause is load-bearing.
  const d = QUESTION_TOOL.description;
  assert.match(d, /genuinely ambiguous/);
  assert.match(d, /reading a file|listing a directory|searching/);
  assert.match(d, /tools have their own approval/);
  assert.match(d, /reasonable assumption/);
});
