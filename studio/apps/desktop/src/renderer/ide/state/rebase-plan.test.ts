/**
 * rebase-plan.test.ts — the PURE interactive-rebase view-model reducer (APP-082).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type RebasePlanRow,
  foldPlan,
  moveRow,
  needsMessage,
  setRowAction,
  setRowMessage,
  validatePlan,
} from "./rebase-plan.js";

function rows(...specs: [string, RebasePlanRow["action"]][]): RebasePlanRow[] {
  return specs.map(([sha, action]) => ({ sha, subject: `s-${sha}`, action }));
}

test("needsMessage: only reword/squash fire the message editor", () => {
  assert.equal(needsMessage("reword"), true);
  assert.equal(needsMessage("squash"), true);
  assert.equal(needsMessage("pick"), false);
  assert.equal(needsMessage("fixup"), false);
  assert.equal(needsMessage("drop"), false);
});

test("moveRow: swaps up/down, immutable, out-of-range is a no-op", () => {
  const base = rows(["a", "pick"], ["b", "pick"], ["c", "pick"]);
  assert.deepEqual(
    moveRow(base, 2, -1).map((r) => r.sha),
    ["a", "c", "b"],
  );
  assert.deepEqual(
    moveRow(base, 0, 1).map((r) => r.sha),
    ["b", "a", "c"],
  );
  // clamped: top row up / bottom row down do not move
  assert.deepEqual(
    moveRow(base, 0, -1).map((r) => r.sha),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    moveRow(base, 2, 1).map((r) => r.sha),
    ["a", "b", "c"],
  );
  // the source array is never mutated
  assert.deepEqual(
    base.map((r) => r.sha),
    ["a", "b", "c"],
  );
});

test("setRowAction / setRowMessage patch one row immutably", () => {
  const base = rows(["a", "pick"], ["b", "pick"]);
  const acted = setRowAction(base, 1, "squash");
  assert.equal(acted[1]?.action, "squash");
  assert.equal(acted[0]?.action, "pick");
  assert.equal(base[1]?.action, "pick"); // original untouched
  const messaged = setRowMessage(acted, 1, "folded msg");
  assert.equal(messaged[1]?.message, "folded msg");
  assert.equal(messaged[0]?.message, undefined);
});

test("foldPlan: squash/fixup fold under the preceding leader; drop vanishes", () => {
  const plan = rows(["a", "pick"], ["b", "squash"], ["c", "fixup"], ["d", "drop"], ["e", "pick"]);
  const groups = foldPlan(plan);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.leader.sha, "a");
  assert.deepEqual(
    groups[0]?.folded.map((f) => [f.row.sha, f.index]),
    [
      ["b", 1],
      ["c", 2],
    ],
  );
  // 'd' (drop) is not shown at all; 'e' is its own leader at flat index 4
  assert.equal(groups[1]?.leader.sha, "e");
  assert.equal(groups[1]?.leaderIndex, 4);
  assert.equal(groups[1]?.folded.length, 0);
});

test("foldPlan: a leading squash becomes its own visible leader (invalid, but shown)", () => {
  const groups = foldPlan(rows(["a", "squash"], ["b", "pick"]));
  assert.equal(groups[0]?.leader.sha, "a");
  assert.equal(groups[0]?.folded.length, 0);
});

test("validatePlan: rejects all-dropped and a leading squash/fixup", () => {
  assert.equal(validatePlan(rows(["a", "pick"], ["b", "squash"])).ok, true);
  assert.match(validatePlan(rows(["a", "drop"], ["b", "drop"])).error ?? "", /nothing to apply/);
  assert.match(validatePlan(rows(["a", "squash"], ["b", "pick"])).error ?? "", /first commit/);
  assert.match(validatePlan(rows(["a", "fixup"])).error ?? "", /first commit/);
  // a drop BEFORE the first real commit still validates (the kept-first is a pick)
  assert.equal(validatePlan(rows(["a", "drop"], ["b", "pick"], ["c", "squash"])).ok, true);
});
