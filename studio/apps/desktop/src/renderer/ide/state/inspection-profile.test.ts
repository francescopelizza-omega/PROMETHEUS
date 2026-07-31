/**
 * inspection-profile.test.ts — node:test for the PURE inspection-profile model (plan 03).
 *
 * Pins inspection-id derivation, LSP severity mapping, override precedence, immutable
 * set/clear, and applyProfile (drop "off" + stable severity sort).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type InspectableDiagnostic,
  applyProfile,
  clearOverride,
  defaultProfile,
  deserializeProfile,
  effectiveSeverity,
  inspectionId,
  serializeProfile,
  setOverride,
  severityFromLsp,
  severityToLsp,
} from "./inspection-profile.js";

const d = (severity?: number, source?: string, code?: string | number): InspectableDiagnostic => ({
  severity,
  source,
  code,
});

test("inspectionId is source:code, source, or unknown", () => {
  assert.equal(inspectionId(d(1, "pyright", "reportUnusedImport")), "pyright:reportUnusedImport");
  assert.equal(inspectionId(d(1, "ruff")), "ruff");
  assert.equal(inspectionId(d(1, undefined, "E501")), "E501");
  assert.equal(inspectionId(d(1)), "unknown");
});

test("LSP severity mapping round-trips (off ⇒ undefined)", () => {
  assert.equal(severityFromLsp(1), "error");
  assert.equal(severityFromLsp(2), "warning");
  assert.equal(severityFromLsp(undefined), "warning");
  assert.equal(severityToLsp("hint"), 4);
  assert.equal(severityToLsp("off"), undefined);
});

test("effectiveSeverity: override wins over the diagnostic's own severity", () => {
  const p = setOverride(defaultProfile(), "ruff:E501", "error");
  assert.equal(effectiveSeverity(d(3, "ruff", "E501"), p), "error"); // was info → error
  assert.equal(effectiveSeverity(d(3, "ruff", "E502"), p), "info"); // untouched
});

test("set/clear override are immutable", () => {
  const base = defaultProfile();
  const p1 = setOverride(base, "x", "off");
  assert.deepEqual(base.overrides, {}); // base untouched
  assert.equal(p1.overrides.x, "off");
  const p2 = clearOverride(p1, "x");
  assert.equal("x" in p2.overrides, false);
  assert.equal(clearOverride(base, "absent"), base); // no-op returns same ref
});

test("applyProfile drops suppressed + sorts by severity, stable within a level", () => {
  const p = setOverride(defaultProfile(), "ruff:NOISY", "off");
  const diags = [
    d(3, "a", "info1"), // info
    d(1, "b", "err1"), // error
    d(2, "ruff", "NOISY"), // suppressed
    d(1, "c", "err2"), // error (after err1 in input)
    d(2, "e", "warn1"), // warning
  ];
  const out = applyProfile(diags, p);
  assert.equal(out.length, 4); // NOISY dropped
  assert.deepEqual(
    out.map((x) => x.code),
    ["err1", "err2", "warn1", "info1"], // errors first (stable order), then warning, then info
  );
});

test("serialize/deserialize round-trips; import is validated + fail-soft (APP-062)", () => {
  const profile = setOverride(
    setOverride(defaultProfile(), "ruff:F401", "error"),
    "mypy:assignment",
    "off",
  );
  const round = deserializeProfile(serializeProfile(profile));
  assert.deepEqual(round.overrides, profile.overrides);
  // corrupt / non-object → Default (never throws).
  assert.deepEqual(deserializeProfile("{not json").overrides, {});
  assert.deepEqual(deserializeProfile(JSON.stringify([1, 2])).overrides, {});
  assert.deepEqual(deserializeProfile(null).name, "Default");
  // an invalid severity value is DROPPED, not coalesced to a real level.
  const imported = deserializeProfile(
    JSON.stringify({ name: "X", overrides: { "ruff:E501": "warning", "bad:rule": "LOUD" } }),
  );
  assert.equal(imported.overrides["ruff:E501"], "warning");
  assert.equal("bad:rule" in imported.overrides, false);
});
