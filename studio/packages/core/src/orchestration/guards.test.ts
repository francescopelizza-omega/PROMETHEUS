/**
 * guards.test.ts — depth/fanout/cycle checks + the RunBudget gate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { RunBudget, checkCycle, checkDepth, checkFanout } from "./guards.js";
import type { RunLimits } from "./topology.js";

const LIMITS: RunLimits = {
  maxDepth: 2,
  maxFanout: 3,
  maxAgents: 4,
  timeoutMs: 1000,
  maxCostUsd: 1,
};

test("checkDepth / checkFanout / checkCycle", () => {
  assert.equal(checkDepth(2, LIMITS).ok, true);
  assert.equal(checkDepth(3, LIMITS).ok, false);
  assert.equal(checkFanout(3, LIMITS).ok, true);
  assert.equal(checkFanout(4, LIMITS).ok, false);
  assert.equal(checkCycle("api", ["ui", "lead"]).ok, true);
  assert.equal(checkCycle("lead", ["api", "lead"]).ok, false);
});

test("RunBudget charges invocations + cost", () => {
  const t = 0;
  const b = new RunBudget(LIMITS, () => t);
  assert.deepEqual(b.charge(0.2), { agents: 1, costUsd: 0.2 });
  assert.deepEqual(b.charge(0.3), { agents: 2, costUsd: 0.5 });
  assert.equal(b.invocations, 2);
  assert.equal(b.spentUsd, 0.5);
});

test("RunBudget: agents exhausted after maxAgents", () => {
  const b = new RunBudget(LIMITS, () => 0);
  for (let i = 0; i < 4; i++) b.charge();
  assert.equal(b.agentsExhausted().ok, false);
});

test("RunBudget: timeout via the injected clock", () => {
  let t = 0;
  const b = new RunBudget(LIMITS, () => t);
  assert.equal(b.timedOut().ok, true); // ok=true means NOT timed out yet
  t = 1500; // past the 1000ms budget
  assert.equal(b.timedOut().ok, false);
  assert.match(b.timedOut().reason ?? "", /timed out/);
});

test("RunBudget: spend ceiling", () => {
  const b = new RunBudget(LIMITS, () => 0);
  b.charge(0.5);
  assert.equal(b.overBudget().ok, true);
  b.charge(0.6); // total 1.1 ≥ 1
  assert.equal(b.overBudget().ok, false);
});

test("canProceed returns the first failing guard", () => {
  const t = 0;
  const b = new RunBudget(LIMITS, () => t);
  // depth too deep
  assert.match(b.canProceed(3, ["lead"], "x").reason ?? "", /max depth/);
  // cycle
  assert.match(b.canProceed(1, ["lead", "api"], "lead").reason ?? "", /cycle/);
  // healthy
  assert.equal(b.canProceed(1, ["lead"], "api").ok, true);
});
