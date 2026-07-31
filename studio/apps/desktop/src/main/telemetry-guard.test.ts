/**
 * telemetry-guard.test.ts — node:test for the PURE launch-guard math.
 *
 * Decoupled: imports ONLY the pure guard module (no node:os, no engine-bridge), so
 * the "don't saturate the machine" verdict is pinned without a live host. The guard
 * is the calculator that forbids a new heavy launch once CPU% OR RAM% ≥ 90%.
 *
 * Run: node --import ../../../apps/cli/dev-register.mjs --test telemetry-guard.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GUARD_THRESHOLD_PCT, evaluateResourceGuard } from "./telemetry-guard.js";

test("allows a launch with headroom on both CPU and RAM", () => {
  const g = evaluateResourceGuard(40, 55);
  assert.equal(g.allow, true);
  assert.deepEqual(g.tripped, []);
  assert.equal(g.reason, undefined);
  assert.equal(g.thresholdPct, GUARD_THRESHOLD_PCT);
});

test("blocks when RAM is at/above the ceiling", () => {
  const g = evaluateResourceGuard(10, 90);
  assert.equal(g.allow, false);
  assert.deepEqual(g.tripped, ["ram"]);
  assert.match(g.reason ?? "", /RAM 90%/);
});

test("blocks when CPU is at/above the ceiling", () => {
  const g = evaluateResourceGuard(95, 20);
  assert.equal(g.allow, false);
  assert.deepEqual(g.tripped, ["cpu"]);
  assert.match(g.reason ?? "", /CPU 95%/);
});

test("both resources tripped are reported together", () => {
  const g = evaluateResourceGuard(99, 92);
  assert.equal(g.allow, false);
  assert.deepEqual(g.tripped, ["cpu", "ram"]);
});

test("89.9% is still allowed (strictly below the ceiling)", () => {
  assert.equal(evaluateResourceGuard(89.9, 89.9).allow, true);
});

test("percentages are clamped + rounded to 0-100", () => {
  const g = evaluateResourceGuard(150, -5);
  assert.equal(g.cpuPct, 100);
  assert.equal(g.ramPct, 0);
  assert.equal(g.allow, false); // 100 ≥ 90
  assert.deepEqual(g.tripped, ["cpu"]);
});

test("a custom threshold is honored", () => {
  const g = evaluateResourceGuard(75, 10, 70);
  assert.equal(g.allow, false);
  assert.equal(g.thresholdPct, 70);
});
