/**
 * launch-guard.test.ts — the shared 90% CPU/RAM launch ceiling (CLI-021).
 * The verdict is pure (injected sample); the sampler is smoke-tested for range only.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { LAUNCH_CEILING_PCT, launchGuardVerdict, sampleLaunchGuard } from "./launch-guard.js";

test("verdict: clears when both CPU and RAM are below the ceiling", () => {
  const v = launchGuardVerdict({ cpuPct: 40, ramPct: 55 });
  assert.equal(v.ok, true);
  assert.equal(v.reason, undefined);
});

test("verdict: refuses at the ceiling, naming CPU", () => {
  const v = launchGuardVerdict({ cpuPct: LAUNCH_CEILING_PCT, ramPct: 10 });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /CPU at 90% ≥ 90% ceiling/);
});

test("verdict: refuses when RAM alone is saturated", () => {
  const v = launchGuardVerdict({ cpuPct: 5, ramPct: 97 });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /RAM at 97%/);
});

test("verdict: CPU is reported first when both are over the ceiling", () => {
  const v = launchGuardVerdict({ cpuPct: 99, ramPct: 99 });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /CPU/);
});

test("verdict: custom ceiling is honored", () => {
  assert.equal(launchGuardVerdict({ cpuPct: 60, ramPct: 10 }, 50).ok, false);
  assert.equal(launchGuardVerdict({ cpuPct: 49, ramPct: 10 }, 50).ok, true);
});

test("sampleLaunchGuard: returns integer percentages within [0,100]", async () => {
  const s = await sampleLaunchGuard(2);
  for (const pct of [s.cpuPct, s.ramPct]) {
    assert.ok(Number.isInteger(pct), "percentage is an integer");
    assert.ok(pct >= 0 && pct <= 100, `percentage ${pct} is in range`);
  }
});
