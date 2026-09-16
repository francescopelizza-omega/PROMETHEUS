/**
 * launch-guard.test.ts — the shared 90% CPU/RAM launch ceiling (CLI-021).
 * The verdict is pure (injected sample); the sampler is smoke-tested for range only.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CRITICAL_POLLS_REQUIRED,
  CRITICAL_RAM_CEILING_PCT,
  LAUNCH_CEILING_PCT,
  launchGuardVerdict,
  nextCriticalStreak,
  ramCeilingVerdict,
  ramPctNow,
  sampleLaunchGuard,
} from "./launch-guard.js";

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

test("ramCeilingVerdict: clears below the ceiling", () => {
  const v = ramCeilingVerdict(55);
  assert.equal(v.ok, true);
  assert.equal(v.reason, undefined);
});

test("ramCeilingVerdict: refuses at/above the ceiling, naming RAM", () => {
  const v = ramCeilingVerdict(LAUNCH_CEILING_PCT);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /RAM at 90% ≥ 90% ceiling/);
});

test("ramCeilingVerdict: custom ceiling is honored", () => {
  assert.equal(ramCeilingVerdict(60, 50).ok, false);
  assert.equal(ramCeilingVerdict(49, 50).ok, true);
});

test("ramPctNow: returns a value within [0,100], synchronously (no sleep)", () => {
  const start = Date.now();
  const pct = ramPctNow();
  assert.ok(Date.now() - start < 50, "must not sleep — sync callers depend on this");
  assert.ok(pct >= 0 && pct <= 100, `pct ${pct} is in range`);
});

test("nextCriticalStreak: a below-ceiling reading resets the streak to 0", () => {
  assert.equal(nextCriticalStreak(3, 50, 95), 0);
});

test("nextCriticalStreak: a critical reading increments the streak by 1", () => {
  assert.equal(nextCriticalStreak(0, 96, 95), 1);
  assert.equal(nextCriticalStreak(1, 96, 95), 2);
});

test("nextCriticalStreak: a single critical spike never reaches CRITICAL_POLLS_REQUIRED on its own", () => {
  const streak = nextCriticalStreak(0, 99, 95);
  assert.ok(streak < CRITICAL_POLLS_REQUIRED, "one reading alone must never trigger eviction");
});

test("nextCriticalStreak: an interrupted streak (one good reading) resets progress entirely", () => {
  let streak = 0;
  streak = nextCriticalStreak(streak, 96, 95); // 1
  streak = nextCriticalStreak(streak, 50, 95); // back to 0 — the machine recovered
  streak = nextCriticalStreak(streak, 96, 95); // 1 again, not 2
  assert.equal(streak, 1);
});

test("nextCriticalStreak: exactly at the ceiling counts as critical (>= , not >)", () => {
  assert.equal(nextCriticalStreak(0, 95, 95), 1);
});

test("nextCriticalStreak: defaults to CRITICAL_RAM_CEILING_PCT when no ceiling is passed", () => {
  assert.equal(nextCriticalStreak(0, CRITICAL_RAM_CEILING_PCT - 1), 0);
  assert.equal(nextCriticalStreak(0, CRITICAL_RAM_CEILING_PCT), 1);
});

test("CRITICAL_RAM_CEILING_PCT is stricter than LAUNCH_CEILING_PCT — eviction is a last resort, not the same bar as refusing a new launch", () => {
  assert.ok(CRITICAL_RAM_CEILING_PCT > LAUNCH_CEILING_PCT);
});
