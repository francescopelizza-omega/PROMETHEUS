import assert from "node:assert/strict";
/**
 * catalog/reconcile.test.ts — the PURE status → InstallState reconciliation (file 06 §7).
 *
 * Covers: status-block → InstallState (per-agent + component-derived enabled), the single
 * (`plugin`) vs bulk (`plugins[]`) status envelope, the optimistic↔truth merge (verdict/
 * version/port survive a status reconcile), items absent from status are left UNCHANGED (no
 * uninstalled-inference, file 06 §7), the optimistic UI ops, and verdict-ref binding (store
 * the ref, never recompute — C5). Fixtures mirror LIVE `status` output @ 0.15.0.
 */
import { test } from "node:test";

import type { NemesisVerdictRef } from "@prometheus/engine-bridge";

import { listRowToItem } from "./normalize.js";
import {
  type StatusEnvelopeLike,
  type StatusPluginBlock,
  applyOptimistic,
  bindVerdict,
  indexStatus,
  mergeState,
  reconcileItems,
  statusToInstallState,
} from "./reconcile.js";

// ── status block → InstallState ───────────────────────────────────────────────── //

const installedBlock: StatusPluginBlock = {
  name: "caveman",
  tier: "community",
  agents: [{ name: "claude", method: "claude_plugin", installed: true, marketplace_present: true }],
  components: [{ name: "caveman@caveman", kind: "subplugin", state: "enabled" }],
};

const disabledBlock: StatusPluginBlock = {
  name: "x",
  agents: [{ name: "claude", method: "claude_plugin", installed: true }],
  components: [{ name: "x@hooks", kind: "hook", state: "disabled" }],
};

const notInstalledBlock: StatusPluginBlock = {
  name: "y",
  agents: [{ name: "claude", method: "claude_plugin", installed: false }],
  components: [],
};

test("statusToInstallState: installed + enabled from an enabled component", () => {
  const s = statusToInstallState(installedBlock);
  assert.equal(s.installed, true);
  assert.equal(s.enabled, true);
  assert.equal(s.perAgent?.length, 1);
  assert.equal(s.perAgent?.[0].agent, "claude");
  assert.equal(s.perAgent?.[0].installed, true);
  assert.equal(s.perAgent?.[0].method, "claude_plugin");
});

test("statusToInstallState: present-but-disabled component => enabled:false", () => {
  const s = statusToInstallState(disabledBlock);
  assert.equal(s.installed, true);
  assert.equal(s.enabled, false);
});

test("statusToInstallState: no agents installed => installed:false", () => {
  const s = statusToInstallState(notInstalledBlock);
  assert.equal(s.installed, false);
});

test("statusToInstallState: no components -> enabled derived from agents", () => {
  const s = statusToInstallState({
    name: "z",
    agents: [{ name: "claude", method: "claude_plugin", installed: true }],
  });
  assert.equal(s.installed, true);
  assert.equal(s.enabled, true); // installed treated as armed when no component split
});

// ── status envelope indexing (single vs bulk) ─────────────────────────────────── //

test("indexStatus handles the single `plugin` shape (status <name>)", () => {
  const env: StatusEnvelopeLike = { command: "status", plugin: installedBlock };
  const idx = indexStatus(env);
  assert.equal(idx.size, 1);
  assert.equal(idx.get("caveman")?.installed, true);
});

test("indexStatus handles the bulk `plugins[]` shape (status all)", () => {
  const env: StatusEnvelopeLike = {
    command: "status",
    plugins: [installedBlock, notInstalledBlock],
  };
  const idx = indexStatus(env);
  assert.equal(idx.size, 2);
  assert.equal(idx.get("caveman")?.installed, true);
  assert.equal(idx.get("y")?.installed, false);
});

test("indexStatus on undefined/empty is an empty map", () => {
  assert.equal(indexStatus(undefined).size, 0);
  assert.equal(indexStatus({}).size, 0);
});

// ── mergeState: volatile truth wins, sticky refs survive ──────────────────────── //

const ref: NemesisVerdictRef = { verdict: "allow", score: 0, signedAt: "2026-06-15T00:00:00Z" };

test("mergeState: new install/enabled win; verdict/version/port survive", () => {
  const prev = {
    installed: true,
    enabled: true,
    installedVersion: "2.1",
    port: "11434",
    lastVerdict: ref,
  };
  const next = { installed: false, enabled: false };
  const merged = mergeState(prev, next);
  assert.equal(merged.installed, false); // truth wins
  assert.equal(merged.enabled, false);
  assert.equal(merged.installedVersion, "2.1"); // sticky
  assert.equal(merged.port, "11434");
  assert.equal(merged.lastVerdict, ref); // verdict survives
});

// ── reconcileItems: absent items untouched ────────────────────────────────────── //

test("reconcileItems replaces state for reported items, leaves others UNCHANGED", () => {
  const a = listRowToItem({ name: "caveman", tier: "community" });
  const b = listRowToItem({ name: "untouched", tier: "community" });
  b.state = { installed: true, enabled: true }; // a pre-existing (cached) truth
  const env: StatusEnvelopeLike = { plugins: [installedBlock] };
  const [ra, rb] = reconcileItems([a, b], env);
  assert.equal(ra.state.installed, true); // reconciled from status
  assert.equal(ra.state.enabled, true);
  // b is absent from the status envelope -> NOT inferred uninstalled (file 06 §7)
  assert.equal(rb.state.installed, true);
  assert.equal(rb.state.enabled, true);
});

test("reconcileItems on an undefined envelope is a no-op", () => {
  const a = listRowToItem({ name: "caveman", tier: "community" });
  const [ra] = reconcileItems([a], undefined);
  assert.equal(ra.state.installed, false);
});

// ── optimistic UI ─────────────────────────────────────────────────────────────── //

test("applyOptimistic: install/uninstall/enable/disable flip the right bits", () => {
  const base = listRowToItem({ name: "x", tier: "community" });

  assert.equal(applyOptimistic(base, { op: "install" }).state.installed, true);

  const installed = { ...base, state: { installed: true, enabled: true } };
  const removed = applyOptimistic(installed, { op: "uninstall" });
  assert.equal(removed.state.installed, false);
  assert.equal(removed.state.enabled, false); // uninstall also disarms

  assert.equal(applyOptimistic(base, { op: "enable" }).state.enabled, true);
  assert.equal(applyOptimistic(installed, { op: "disable" }).state.enabled, false);
});

test("applyOptimistic NEVER touches the bound verdict ref", () => {
  const base = { ...listRowToItem({ name: "x" }), state: { installed: false, lastVerdict: ref } };
  const after = applyOptimistic(base, { op: "install" });
  assert.equal(after.state.lastVerdict, ref);
});

// ── verdict-ref binding (store the ref, never recompute — C5) ─────────────────── //

test("bindVerdict attaches the engine's SIGNED ref onto the item state", () => {
  const base = listRowToItem({ name: "x", tier: "community" });
  const after = bindVerdict(base, ref);
  assert.equal(after.state.lastVerdict, ref);
  assert.equal(base.state.lastVerdict, undefined); // immutable: original untouched
});
