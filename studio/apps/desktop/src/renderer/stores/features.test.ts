/**
 * features.test.ts — node:test for the §5 per-feature Zustand slice reducers.
 *
 * The feature slices (security/packages/models/repos) hold ONLY UI/session state
 * (TanStack Query owns fetching). Their reducers are pure state transitions, so
 * they are testable with node:test WITHOUT electron, engine-bridge, or a DOM —
 * just zustand + the plain-data contract types. This pins the install-tracking
 * map (add/clear), the verdict→shieldTier projection, and the selection setters.
 *
 * Run: node --import ../../../../cli/dev-register.mjs --test features.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { GateResult } from "../../shared/ipc-contract.js";
import { useModelsStore, usePackagesStore, useReposStore, useSecurityStore } from "./features.js";

/** A minimal valid GateResult for the security slice tests. */
function gate(verdict: GateResult["verdict"]): GateResult {
  return {
    ok: verdict === "allow",
    verdict,
    severity: "clean",
    riskScore: verdict === "allow" ? 0 : 100,
    signed: false,
    findingsCount: 0,
    target: "owner/repo",
    scannedAt: "2026-01-01T00:00:00.000Z",
  };
}

/* ── security slice ─────────────────────────────────────────────────────────*/

test("securityStore.setVerdict records the verdict + projects shieldTier", () => {
  const s = useSecurityStore.getState();
  s.setVerdict(gate("block"));
  const after = useSecurityStore.getState();
  assert.equal(after.lastVerdict?.verdict, "block");
  assert.equal(after.shieldTier, "block");
});

test("securityStore counts CONFIRMED overrides only (no arm-without-confirm reducer)", () => {
  // The `requestForce`/`clearForce`/`pendingForce` trio this test used to cover is gone —
  // nothing rendered `pendingForce`, so it armed an override that painted no UI. See
  // force-gate.test.ts for the full reasoning; the typed confirm in shell/ForceGate.tsx
  // is the only path to an override now.
  const base = useSecurityStore.getState().forcedThisSession;
  useSecurityStore.getState().noteForced();
  assert.equal(useSecurityStore.getState().forcedThisSession, base + 1);
});

/* ── packages slice: the install-tracking map ───────────────────────────────*/

test("packagesStore.markInstalling adds a name→runId entry immutably", () => {
  const s = usePackagesStore.getState();
  s.markInstalling("caveman", "run-1");
  s.markInstalling("nemesis", "run-2");
  const map = usePackagesStore.getState().installing;
  assert.equal(map.caveman, "run-1");
  assert.equal(map.nemesis, "run-2");
});

test("packagesStore.clearInstalling removes only the named entry", () => {
  const s = usePackagesStore.getState();
  s.markInstalling("caveman", "run-1");
  s.markInstalling("nemesis", "run-2");
  s.clearInstalling("caveman");
  const map = usePackagesStore.getState().installing;
  assert.equal("caveman" in map, false);
  assert.equal(map.nemesis, "run-2");
});

test("packagesStore.select toggles the open detail pane", () => {
  const s = usePackagesStore.getState();
  s.select("caveman");
  assert.equal(usePackagesStore.getState().selected, "caveman");
  usePackagesStore.getState().select(null);
  assert.equal(usePackagesStore.getState().selected, null);
});

/* ── models + repos selection slices ────────────────────────────────────────*/

test("modelsStore + reposStore selection setters round-trip", () => {
  useModelsStore.getState().select("llama-3.1");
  assert.equal(useModelsStore.getState().selected, "llama-3.1");
  useReposStore.getState().select("world-sim");
  assert.equal(useReposStore.getState().selected, "world-sim");
});
