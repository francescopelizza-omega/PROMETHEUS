/**
 * checkpoint.test.ts — the per-turn workspace snapshot, and what `/revert` does with it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Checkpoint, checkpointSize, restorePlan } from "./checkpoint.js";

test("a checkpoint records ABSENCE, so a created file reverts to nothing", () => {
  // `files[p] = ""` cannot distinguish "was empty" from "did not exist", and `/revert` wrote
  // the empty string back — leaving a zero-byte file where the correct undo was removal.
  const cp: Checkpoint = {
    id: "t1",
    sessionId: "s",
    turnNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    files: { "/repo/edited.ts": "before\n" },
    absent: ["/repo/created.ts"],
  };
  const plan = restorePlan(cp, ["/repo/edited.ts", "/repo/created.ts"]);
  assert.deepEqual(plan.write, { "/repo/edited.ts": "before\n" });
  assert.deepEqual(plan.delete, ["/repo/created.ts"]);
  // and it is never ALSO written — a path cannot both be restored and be removed
  assert.equal("/repo/created.ts" in plan.write, false);
});

test("an absent path wins over a captured one — the earlier truth is that it was not there", () => {
  const cp: Checkpoint = {
    id: "t1",
    sessionId: "s",
    turnNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    files: { "/repo/x.ts": "intermediate\n" },
    absent: ["/repo/x.ts"],
  };
  const plan = restorePlan(cp, ["/repo/x.ts"]);
  assert.deepEqual(plan.write, {});
  assert.deepEqual(plan.delete, ["/repo/x.ts"]);
});

test("delete de-duplicates a path that is both recorded-absent and observed-now", () => {
  const cp: Checkpoint = {
    id: "t1",
    sessionId: "s",
    turnNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    files: {},
    absent: ["/repo/new.ts"],
  };
  assert.deepEqual(restorePlan(cp, ["/repo/new.ts"]).delete, ["/repo/new.ts"]);
});

test("a checkpoint with no `absent` behaves exactly as it did before", () => {
  const cp: Checkpoint = {
    id: "t1",
    sessionId: "s",
    turnNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    files: { "/repo/a.ts": "x" },
  };
  const plan = restorePlan(cp, ["/repo/a.ts", "/repo/b.ts"]);
  assert.deepEqual(plan.write, { "/repo/a.ts": "x" });
  assert.deepEqual(plan.delete, ["/repo/b.ts"]);
});

test("checkpointSize counts created files too — `/checkpoints` under-reported without it", () => {
  const cp: Checkpoint = {
    id: "t1",
    sessionId: "s",
    turnNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    files: { "/repo/a.ts": "x" },
    absent: ["/repo/b.ts", "/repo/c.ts"],
  };
  assert.equal(checkpointSize(cp), 3);
  assert.equal(checkpointSize({ ...cp, absent: undefined }), 1);
});
