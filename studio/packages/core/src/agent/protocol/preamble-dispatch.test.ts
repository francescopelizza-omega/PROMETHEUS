/**
 * preamble-dispatch.test.ts — the shared assembler: priority order, budget, merge targets.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTRUCTION_BUDGET_MAX,
  INSTRUCTION_BUDGET_MIN,
  INSTRUCTION_BUDGET_SHARE,
  assemblePreamble,
  instructionBudget,
} from "./preamble-dispatch.js";
import type { PreambleContributor, PreambleCtx } from "./preamble-dispatch.js";

const baseCtx: PreambleCtx = {
  surface: "cli",
  isSubAgent: false,
  readOnly: false,
  locality: "local",
  tools: [],
};

const fixed = (
  id: string,
  priority: number,
  text: string,
  mergeTarget?: "persona" | "block",
): PreambleContributor => ({
  id,
  priority,
  applies: () => true,
  render: () => ({ text, ...(mergeTarget ? { mergeTarget } : {}) }),
});

test("priority order: lower priority number is assembled (and appears) first", () => {
  const out = assemblePreamble(
    [fixed("a", 20, "a's text"), fixed("b", 10, "b's text")],
    baseCtx,
    1000,
  );
  assert.equal(out.personaAppend, "b's text\n\na's text");
});

test("shared budget: a contributor that doesn't fit is omitted, not truncated", () => {
  const big = fixed("big", 10, "x".repeat(500 * 4)); // ~500 tokens
  const small = fixed("small", 20, "y".repeat(200 * 4)); // ~200 tokens
  const out = assemblePreamble([big, small], baseCtx, 600);
  assert.equal(out.contributions.length, 1);
  assert.equal(out.contributions[0]?.id, "big");
  assert.deepEqual(out.omittedForBudget, ["small"]);
});

test("mergeTarget: persona vs block land in different output fields; default is persona", () => {
  const out = assemblePreamble(
    [fixed("p", 10, "persona text"), fixed("b", 20, "block text", "block")],
    baseCtx,
    1000,
  );
  assert.equal(out.personaAppend, "persona text");
  assert.deepEqual(out.blocks, ["block text"]);
});

test("applies() === false ⇒ no entry anywhere, not even omitted", () => {
  const never: PreambleContributor = {
    id: "never",
    priority: 10,
    applies: () => false,
    render: () => ({ text: "should not appear" }),
  };
  const out = assemblePreamble([never], baseCtx, 1000);
  assert.equal(out.personaAppend, "");
  assert.equal(out.contributions.length, 0);
  assert.equal(out.omittedForBudget.length, 0);
});

test("a null, empty, or whitespace-only render() is treated as not applying", () => {
  const nullish: PreambleContributor = {
    id: "n",
    priority: 10,
    applies: () => true,
    render: () => null,
  };
  const empty = fixed("e", 20, "");
  const blank = fixed("w", 30, "   ");
  const out = assemblePreamble([nullish, empty, blank], baseCtx, 1000);
  assert.equal(out.personaAppend, "");
  assert.equal(out.contributions.length, 0);
});

test("instructionBudget: clamps to MIN/MAX and falls back sensibly for no window", () => {
  assert.equal(instructionBudget(1000), INSTRUCTION_BUDGET_MIN);
  assert.equal(instructionBudget(1_000_000), INSTRUCTION_BUDGET_MAX);
  const mid = 40_000;
  assert.equal(instructionBudget(mid), Math.floor(mid * INSTRUCTION_BUDGET_SHARE));
  const fallback = instructionBudget(undefined);
  assert.equal(instructionBudget(0), fallback);
  assert.equal(instructionBudget(-5), fallback);
  assert.ok(fallback >= INSTRUCTION_BUDGET_MIN && fallback <= INSTRUCTION_BUDGET_MAX);
  // regression: the no-window fallback must literally equal what an 8192-context window
  // produces (the doc comment's own stated intent) — not a nearby-but-different formula.
  assert.equal(fallback, instructionBudget(8192));
});
