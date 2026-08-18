/**
 * authorisation-mode.test.ts — the permission POSTURE in Studio.
 *
 * `setPermissionMode` clamped its input, persisted to localStorage, drove `modeToAuthLevel`,
 * and rode the tuning into core's loop, which enforces the plan-mode DENY. Every piece worked
 * and NOTHING called it: plan mode was reachable in Studio only by hand-editing
 * `prometheus.permissionMode.v1`, while the CLI has offered it on Shift-Tab all along. Same
 * product, same words, one surface where they did nothing. `AuthPicker` now offers it.
 *
 * These tests cover the STORE contract the picker depends on — that picking a mode really does
 * change the posture the agent runs under, and that the two dials cannot disagree.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { modeToAuthLevel } from "@prometheus/core/agent-authorization";
import { PERMISSION_MODES } from "@prometheus/core/agent-permission-modes";

test("every mode the picker offers is one the loop actually knows", () => {
  // The picker renders `PERMISSION_MODES.filter(m => m.inCycle)`. If that filter ever produced
  // an id core does not recognise, the pick would set a posture nothing enforces.
  const offered = PERMISSION_MODES.filter((m) => m.inCycle).map((m) => m.id);
  assert.deepEqual(offered, ["default", "acceptEdits", "plan"]);
  for (const id of offered) {
    assert.equal(typeof modeToAuthLevel(id), "number", `${id} has no authorisation mapping`);
  }
});

test("bypass and YOLO are NOT offered in the picker — they stay deliberate acts", () => {
  // Exactly as in the TUI, where Shift-Tab cannot reach them either. A posture that can
  // auto-run everything must never be one click away from "default" in a dropdown.
  const offered = PERMISSION_MODES.filter((m) => m.inCycle).map((m) => m.id);
  assert.equal(offered.includes("bypassPermissions"), false);
  assert.equal(offered.includes("yolo"), false);
});

test("plan mode maps to a READ-ONLY authorisation level — the two dials cannot disagree", () => {
  // `setPermissionMode` calls `setLevel(modeToAuthLevel(next))` precisely so the ladder and the
  // posture stay one concept. Picking plan mode must not leave the level at "run commands".
  const plan = modeToAuthLevel("plan");
  const def = modeToAuthLevel("default");
  assert.ok(plan <= def, `plan (${plan}) must not authorise more than default (${def})`);
  assert.ok(plan <= 1, `plan mode must be read-only, got level ${plan}`);
});

test("acceptEdits authorises MORE than default but less than running commands", () => {
  const edits = modeToAuthLevel("acceptEdits");
  assert.ok(edits >= modeToAuthLevel("default"));
  assert.ok(edits < 4, `acceptEdits must not reach the command rung, got ${edits}`);
});

test("every mode carries the text the picker renders", () => {
  // The picker shows `label` and `description`; an empty one would render a blank row that
  // still changes the agent's posture when clicked.
  for (const m of PERMISSION_MODES) {
    assert.ok(m.label.trim().length > 0, `${m.id} has no label`);
    assert.ok(m.description.trim().length > 0, `${m.id} has no description`);
  }
});
