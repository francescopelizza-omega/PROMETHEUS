/**
 * authorisation-dials.test.ts — the two posture dials must never disagree.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { useAuthorisationStore } from "./authorisation.js";

test("raising the authorisation level clears plan mode", () => {
  /**
   * `setPermissionMode` syncs the level (`plan` pins it to 0 so no ladder rung can auto-approve
   * underneath a read-only posture) — but `setLevel` did NOT sync the mode. Picking a level while
   * in plan mode left `permissionMode: "plan"` beside a level that auto-approves: the indicator
   * said read-only while the behaviour was not. That is exactly the failure this store's own
   * docstring records — "two independent dials over one concept is how the TUI's indicator and
   * its actual behaviour came apart once already".
   */
  const s = () => useAuthorisationStore.getState();

  s().setPermissionMode("plan");
  assert.equal(s().permissionMode, "plan");
  assert.equal(s().level, 0, "precondition: plan pins the level to 0");

  s().setLevel(5);
  assert.equal(s().level, 5);
  assert.notEqual(
    s().permissionMode,
    "plan",
    "the indicator still says plan while the level auto-approves",
  );

  // …and dropping back to 0 does NOT silently re-enter plan mode: plan is a deliberate posture,
  // not merely "level 0".
  s().setLevel(0);
  assert.notEqual(s().permissionMode, "plan");
});

test("setPermissionMode still drives the level, in both directions", () => {
  // self-validating: the sync that already worked must keep working.
  const s = () => useAuthorisationStore.getState();
  s().setPermissionMode("plan");
  assert.equal(s().level, 0);
  s().setPermissionMode("default");
  assert.equal(s().permissionMode, "default");
});
