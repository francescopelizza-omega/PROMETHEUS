/**
 * catalog-uninstall-view.test.ts — the confirm-gates-mutation contract (APP-006).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { uninstallFailure, uninstallStep } from "./catalog-uninstall-view.js";

test("clean dry-run arms the typed-confirm with the engine plan — no refetch yet", () => {
  const s = uninstallStep({ name: "foo", dryRun: true }, { ok: true, message: "removes 3 files" });
  assert.deepEqual(s.pending, { name: "foo", plan: "removes 3 files" });
  assert.equal(s.error, null);
  assert.equal(s.refetch, false);
});

test("dry-run plan: Record summary stringifies, absent plan → null, huge plan caps", () => {
  assert.equal(
    uninstallStep({ name: "foo", dryRun: true }, { ok: true, summary: { files: 3 } }).pending?.plan,
    '{"files":3}',
  );
  assert.equal(uninstallStep({ name: "foo", dryRun: true }, { ok: true }).pending?.plan, null);
  const big = uninstallStep({ name: "foo", dryRun: true }, { ok: true, message: "x".repeat(1000) });
  assert.ok((big.pending?.plan?.length ?? 0) <= 401);
});

test("ok:false preview surfaces inline — confirm never opens, no refetch", () => {
  const s = uninstallStep({ name: "foo", dryRun: true }, { ok: false, error: "unknown plugin" });
  assert.equal(s.pending, null);
  assert.deepEqual(s.error, { name: "foo", error: "unknown plugin" });
  assert.equal(s.refetch, false);
});

test("committed uninstall (dryRun:false, ok) is the ONLY refetch path", () => {
  const s = uninstallStep({ name: "foo", dryRun: false }, { ok: true });
  assert.equal(s.pending, null);
  assert.equal(s.error, null);
  assert.equal(s.refetch, true);
});

test("ok:false commit shows the engine error and never optimistically removes", () => {
  const s = uninstallStep({ name: "foo", dryRun: false }, { ok: false, error: "engine refused" });
  assert.deepEqual(s.error, { name: "foo", error: "engine refused" });
  assert.equal(s.refetch, false);
});

test("nullish envelope is treated as failure (partial IPC payload guard)", () => {
  assert.equal(uninstallStep({ name: "foo", dryRun: false }, undefined).refetch, false);
  assert.ok(uninstallStep({ name: "foo", dryRun: true }, null).error);
});

test("uninstallFailure: IPC rejection maps to inline error, no refetch", () => {
  const s = uninstallFailure("foo", new Error("bridge gone"));
  assert.deepEqual(s.error, { name: "foo", error: "bridge gone" });
  assert.equal(s.pending, null);
  assert.equal(s.refetch, false);
});
