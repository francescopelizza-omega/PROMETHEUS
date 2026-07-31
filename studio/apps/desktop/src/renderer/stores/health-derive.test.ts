/**
 * health-derive.test.ts — node:test for the PURE engine-pill derivation (§5).
 *
 * Decoupled: imports ONLY the pure module (no zustand, no react, no DOM), so it
 * runs under node --test right now. Pins the fail-closed bias — any doubt about
 * the engine/scanner resolves AWAY from "ready" (green) (C5 in spirit).
 *
 * Run: node --import ../../../apps/cli/dev-register.mjs --test health-derive.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HealthResult } from "../../shared/ipc-contract.js";
import { deriveHealthPill } from "./health-derive.js";

const base: HealthResult = {
  ok: true,
  version: "0.15.0",
  contractOk: true,
  nemesisPresent: true,
  problems: [],
};

test("null probe ⇒ unknown", () => {
  assert.equal(deriveHealthPill(null), "unknown");
});

test("all green ⇒ ready", () => {
  assert.equal(deriveHealthPill(base), "ready");
});

test("nemesis missing ⇒ degraded (installs fail-closed, amber)", () => {
  assert.equal(deriveHealthPill({ ...base, nemesisPresent: false }), "degraded");
});

test("no version ⇒ down", () => {
  const noVersion: HealthResult = {
    ok: false,
    contractOk: true,
    nemesisPresent: true,
    problems: ["engine not found"],
  };
  assert.equal(deriveHealthPill(noVersion), "down");
});

test("broken --json contract ⇒ down even if a version was read", () => {
  assert.equal(deriveHealthPill({ ...base, contractOk: false, ok: false }), "down");
});

test("ok:false always ⇒ down (fail-closed bias)", () => {
  assert.equal(deriveHealthPill({ ...base, ok: false }), "down");
});
