/**
 * verdictMapping.test.ts — node:test for the ONLY verdict→display map (§3).
 *
 * Pins:
 *   - the §3 table for EVERY tier (color/label/defaultAction/override),
 *   - the role names agree with @prometheus/ui tokens' VERDICT_ROLE (no drift),
 *   - C5: an unknown tier fails closed to UNVERIFIED/refuse, never to allow,
 *   - needsExplicitApproval reads ONLY engine counts (CRIT/HIGH ⇒ gated; MEDIUM
 *     gated only under strict; block/error always; allow never) — no scoring.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test verdictMapping.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { VerdictTier } from "@prometheus/engine-bridge";
// Import VERDICT_ROLE from the ui tokens SOURCE directly. @prometheus/ui is not
// mapped in the dev-resolver (and core doesn't depend on ui at the package
// level), but tokens.ts is runtime-dep-free, so the relative .js→.ts rewrite
// resolves it. This pins the role-name reconciliation to the REAL ui source.
import { VERDICT_ROLE } from "../../../ui/src/tokens.js";

import {
  VERDICT_DISPLAY,
  isRefusedByDefault,
  needsExplicitApproval,
  verdictColor,
  verdictDefaultAction,
  verdictDisplay,
  verdictLabel,
  verdictOverride,
} from "./verdictMapping.js";

const ALL_TIERS: VerdictTier[] = ["allow", "warn", "block", "error"];

/* ── the §3 table, verbatim, for every tier ─────────────────────────────────*/

test("allow → green SAFE / proceed / no override (§3)", () => {
  const d = verdictDisplay("allow");
  assert.equal(d.color, "ok");
  assert.equal(d.label, "SAFE — no known threats found");
  assert.equal(d.defaultAction, "proceed");
  assert.equal(d.override, "none");
});

test("warn → amber REVIEW / hold / install-anyway (§3)", () => {
  const d = verdictDisplay("warn");
  assert.equal(d.color, "warn");
  assert.equal(d.label, "REVIEW");
  assert.equal(d.defaultAction, "hold");
  assert.equal(d.override, "install-anyway");
});

test("block → red DEEP-RED BLOCK / refuse / force (§3)", () => {
  const d = verdictDisplay("block");
  assert.equal(d.color, "danger");
  assert.equal(d.label, "DEEP-RED BLOCK");
  assert.equal(d.defaultAction, "refuse");
  assert.equal(d.override, "force");
});

test("error → red UNVERIFIED / refuse / force (§3, fail-closed)", () => {
  const d = verdictDisplay("error");
  assert.equal(d.color, "danger");
  assert.equal(d.label, "UNVERIFIED");
  assert.equal(d.defaultAction, "refuse");
  assert.equal(d.override, "force");
});

test("every tier has a complete, frozen display descriptor", () => {
  for (const tier of ALL_TIERS) {
    const d = VERDICT_DISPLAY[tier];
    assert.ok(d, `missing display for ${tier}`);
    assert.equal(typeof d.label, "string");
    assert.ok(d.label.length > 0);
    assert.ok(["ok", "warn", "danger"].includes(d.color));
    assert.ok(["proceed", "hold", "refuse"].includes(d.defaultAction));
    assert.ok(["none", "install-anyway", "force"].includes(d.override));
    // frozen: a mutation attempt must not change the canonical map.
    assert.throws(() => {
      (d as { color: string }).color = "ok";
    });
  }
});

/* ── thin accessors agree with the map ──────────────────────────────────────*/

test("accessors mirror the table for every tier", () => {
  for (const tier of ALL_TIERS) {
    const d = VERDICT_DISPLAY[tier];
    assert.equal(verdictColor(tier), d.color);
    assert.equal(verdictLabel(tier), d.label);
    assert.equal(verdictDefaultAction(tier), d.defaultAction);
    assert.equal(verdictOverride(tier), d.override);
    assert.equal(isRefusedByDefault(tier), d.defaultAction === "refuse");
  }
});

/* ── role names do NOT drift from @prometheus/ui VERDICT_ROLE ────────────────*/

test("color role agrees with ui tokens VERDICT_ROLE (reconciliation)", () => {
  // VERDICT_ROLE maps a tier to "ok"|"warn"|"danger"|... ; ours is the same
  // semantic role for the colored verdicts. They must never contradict (§3 note).
  assert.equal(verdictColor("allow"), VERDICT_ROLE.allow); // ok
  assert.equal(verdictColor("warn"), VERDICT_ROLE.warn); //   warn
  assert.equal(verdictColor("block"), VERDICT_ROLE.block); // danger
  assert.equal(verdictColor("error"), VERDICT_ROLE.error); // danger
});

/* ── C5: fail-closed on a garbage tier ──────────────────────────────────────*/

test("an unknown tier fails closed to UNVERIFIED/refuse (never allow) — C5", () => {
  const d = verdictDisplay("nonsense" as VerdictTier);
  assert.equal(d.label, "UNVERIFIED");
  assert.equal(d.defaultAction, "refuse");
  assert.equal(d.color, "danger");
});

/* ── needsExplicitApproval: reads engine counts ONLY (no scoring) ────────────*/

test("allow never needs explicit approval", () => {
  assert.equal(needsExplicitApproval("allow", { CRITICAL: 9, HIGH: 9 }), false);
});

test("block and error ALWAYS need explicit handling (the Force flow)", () => {
  assert.equal(needsExplicitApproval("block", {}), true);
  assert.equal(needsExplicitApproval("error", {}), true);
  assert.equal(needsExplicitApproval("block", undefined), true);
});

test("warn with a CRITICAL or HIGH finding needs explicit approval (§5.2)", () => {
  assert.equal(needsExplicitApproval("warn", { CRITICAL: 1 }), true);
  assert.equal(needsExplicitApproval("warn", { HIGH: 2 }), true);
  assert.equal(needsExplicitApproval("warn", { CRITICAL: 0, HIGH: 0, MEDIUM: 5, LOW: 9 }), false);
});

test("warn with only MEDIUM needs explicit approval ONLY under strict (§5.2)", () => {
  assert.equal(needsExplicitApproval("warn", { MEDIUM: 3 }), false);
  assert.equal(needsExplicitApproval("warn", { MEDIUM: 3 }, { strict: true }), true);
});

test("warn with no findings and no strict ⇒ a soft hold (no explicit approval)", () => {
  assert.equal(needsExplicitApproval("warn", {}), false);
  assert.equal(needsExplicitApproval("warn", undefined), false);
  assert.equal(needsExplicitApproval("warn", { LOW: 4, INFO: 10 }), false);
});

test("a non-finite / negative count is treated as zero (fail toward warning)", () => {
  assert.equal(needsExplicitApproval("warn", { HIGH: Number.NaN }), false);
  assert.equal(needsExplicitApproval("warn", { HIGH: -1 }), false);
  assert.equal(needsExplicitApproval("warn", { HIGH: 1 }), true);
});
