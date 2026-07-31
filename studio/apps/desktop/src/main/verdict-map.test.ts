/**
 * verdict-map.test.ts — the C5 fail-closed contract for the IPC verdict mappers.
 *
 * Built-in node:test + node:assert only (no vitest/jest) so it runs after a
 * plain tsc emit. These mappers are pure data; the test constructs SecurityVerdict
 * literals and asserts the renderer-safe GateResult never upgrades toward "allow".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SecurityVerdict } from "@prometheus/engine-bridge";

import { failClosedGate, toGateResult, topSeverity } from "./verdict-map.js";

function verdict(partial: Partial<SecurityVerdict>): SecurityVerdict {
  return {
    verdict: "allow",
    risk_score: 0,
    signed: false,
    findings: [],
    scannedAt: "2026-01-01T00:00:00.000Z",
    target: "owner/repo",
    ...partial,
  };
}

test("topSeverity returns clean when there are no findings", () => {
  assert.equal(topSeverity(verdict({})), "clean");
});

test("topSeverity returns the highest finding severity", () => {
  const v = verdict({
    findings: [
      { klass: "sca", severity: "low", rule: "r1", where: "a" },
      { klass: "secret", severity: "critical", rule: "r2", where: "b" },
      { klass: "vuln", severity: "medium", rule: "r3", where: "c" },
    ],
  });
  assert.equal(topSeverity(v), "critical");
});

test("toGateResult passes an allow verdict through as ok:true", () => {
  const r = toGateResult(verdict({ verdict: "allow", risk_score: 3 }));
  assert.equal(r.verdict, "allow");
  assert.equal(r.ok, true);
  assert.equal(r.riskScore, 3);
});

test("toGateResult marks warn as ok:true (warn is informational, not blocking)", () => {
  const r = toGateResult(verdict({ verdict: "warn" }));
  assert.equal(r.verdict, "warn");
  assert.equal(r.ok, true);
});

test("toGateResult marks block as ok:false (C5: blocking)", () => {
  const r = toGateResult(verdict({ verdict: "block", risk_score: 80 }));
  assert.equal(r.verdict, "block");
  assert.equal(r.ok, false);
});

test("toGateResult marks error as ok:false (C5: fail-closed)", () => {
  const r = toGateResult(verdict({ verdict: "error" }));
  assert.equal(r.verdict, "error");
  assert.equal(r.ok, false);
});

test("toGateResult never upgrades — it mirrors the engine verdict exactly", () => {
  for (const tier of ["allow", "warn", "block", "error"] as const) {
    const r = toGateResult(verdict({ verdict: tier }));
    assert.equal(r.verdict, tier, `verdict ${tier} must pass through unchanged`);
  }
});

test("failClosedGate is always an error/BLOCK with risk 100 (C5)", () => {
  const r = failClosedGate("owner/repo", "scanner timed out");
  assert.equal(r.verdict, "error");
  assert.equal(r.ok, false);
  assert.equal(r.riskScore, 100);
  assert.equal(r.signed, false);
  assert.equal(r.findingsCount, 0);
  assert.equal(r.error, "scanner timed out");
  assert.equal(r.target, "owner/repo");
});

test("failClosedGate uses a deterministic scannedAt when provided", () => {
  const r = failClosedGate("", "no target supplied", "2026-01-01T00:00:00.000Z");
  assert.equal(r.scannedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(r.target, "");
});
