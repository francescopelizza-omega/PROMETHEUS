/**
 * permission-modes.test.ts — Claude-parity modes: cycle, classify, decision matrix,
 * indicators, and the engine-policy bridge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PROMETHEUS_TOOLS } from "../mcp/server/tools.js";
import {
  AUDIT_LINE_MAX_BYTES,
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  PERMISSION_MODE_CYCLE,
  PLAN_REFUSAL_HINT,
  type PermissionModeId,
  classifyTool,
  cyclePermissionMode,
  decideToolForMode,
  formatAuditLine,
  permissionModeIndicator,
  permissionModeMeta,
  permissionModePolicy,
  planModeRefusal,
} from "./permission-modes.js";

test("registry has the four Claude-parity modes plus yolo, default is `default`", () => {
  assert.deepEqual(
    PERMISSION_MODES.map((m) => m.id),
    ["default", "acceptEdits", "plan", "bypassPermissions", "yolo"],
  );
  assert.equal(DEFAULT_PERMISSION_MODE, "default");
});

test("bypass + yolo are the out-of-cycle modes (explicit opt-in)", () => {
  assert.deepEqual(PERMISSION_MODE_CYCLE, ["default", "acceptEdits", "plan"]);
  assert.equal(PERMISSION_MODES.find((m) => m.id === "bypassPermissions")?.inCycle, false);
  assert.equal(PERMISSION_MODES.find((m) => m.id === "yolo")?.inCycle, false);
});

test("Shift-Tab cycles default → acceptEdits → plan → default; bypass → default", () => {
  assert.equal(cyclePermissionMode("default"), "acceptEdits");
  assert.equal(cyclePermissionMode("acceptEdits"), "plan");
  assert.equal(cyclePermissionMode("plan"), "default");
  // bypass is out of the SAFE cycle → Shift-Tab returns to the safe default.
  assert.equal(cyclePermissionMode("bypassPermissions"), "default");
});

test("with allowBypass, the cycle dials up into bypass → yolo → default", () => {
  assert.equal(cyclePermissionMode("plan", { allowBypass: true }), "bypassPermissions");
  assert.equal(cyclePermissionMode("bypassPermissions", { allowBypass: true }), "yolo");
  assert.equal(cyclePermissionMode("yolo", { allowBypass: true }), "default");
  // locked (default opts) keeps bypass + yolo out of reach
  assert.equal(cyclePermissionMode("plan"), "default");
});

test("indicators: default shows nothing, bypass shows the danger line", () => {
  assert.equal(permissionModeIndicator("default"), "");
  assert.equal(permissionModeIndicator("acceptEdits"), "⏵⏵ accept edits on");
  assert.equal(permissionModeIndicator("plan"), "⏸ plan mode on");
  assert.equal(permissionModeIndicator("bypassPermissions"), "⏵⏵ bypass permissions on");
  assert.equal(permissionModeMeta("bypassPermissions").tone, "danger");
});

test("classifyTool maps annotations → read / edit / exec", () => {
  assert.equal(classifyTool({ readOnlyHint: true }), "read");
  assert.equal(classifyTool({ destructiveHint: true, openWorldHint: true }), "exec"); // install
  assert.equal(classifyTool({ destructiveHint: true }), "edit"); // enable/disable
  assert.equal(classifyTool(undefined), "edit"); // unknown → treat as a mutation, never read
  assert.equal(classifyTool({}), "edit");
});

const READ = { readOnlyHint: true };
const EDIT = { destructiveHint: true };
const EXEC = { destructiveHint: true, openWorldHint: true };

test("decision matrix: reads always allowed in every mode", () => {
  for (const id of ["default", "acceptEdits", "plan", "bypassPermissions"] as PermissionModeId[]) {
    assert.equal(decideToolForMode(id, READ), "allow", `${id} read`);
  }
});

test("default: mutations ask", () => {
  assert.equal(decideToolForMode("default", EDIT), "ask");
  assert.equal(decideToolForMode("default", EXEC), "ask");
});

test("acceptEdits: local edits auto, remote fetch/install asks", () => {
  assert.equal(decideToolForMode("acceptEdits", EDIT), "allow");
  assert.equal(decideToolForMode("acceptEdits", EXEC), "ask");
});

test("plan: every mutation denied (read-only)", () => {
  assert.equal(decideToolForMode("plan", EDIT), "deny");
  assert.equal(decideToolForMode("plan", EXEC), "deny");
});

test("bypass: everything allowed (gate still enforces downstream)", () => {
  assert.equal(decideToolForMode("bypassPermissions", EDIT), "allow");
  assert.equal(decideToolForMode("bypassPermissions", EXEC), "allow");
});

test("permissionModePolicy bridges to the generic engine baseDefault", () => {
  assert.equal(permissionModePolicy("default").baseDefault, "ask");
  assert.equal(permissionModePolicy("acceptEdits").baseDefault, "ask"); // exec posture
  assert.equal(permissionModePolicy("plan").baseDefault, "deny");
  assert.equal(permissionModePolicy("bypassPermissions").baseDefault, "allow");
  // read refs always carry the read posture (allow)
  const dflt = permissionModePolicy("default");
  assert.ok(dflt.rules.some((r) => r.match === "*:read" && r.decision === "allow"));
  // acceptEdits edits flip to allow at the rule level
  assert.equal(
    permissionModePolicy("acceptEdits").rules.find((r) => r.match === "*:edit")?.decision,
    "allow",
  );
});

/* ── CLI-033: real-tool classification + plan refusal + bypass audit line ────── */

test("classification pins the REAL registered tool annotations (CLI-033)", () => {
  const byName = new Map(PROMETHEUS_TOOLS.map((t) => [t.name, t]));
  // a read-only tool → read (runs un-prompted in every mode)
  assert.equal(classifyTool(byName.get("prometheus_list")?.annotations), "read");
  // a destructive local mutation → edit; a destructive + open-world (install) → exec
  assert.equal(classifyTool(byName.get("prometheus_install")?.annotations), "exec");
  // EVERY tool classifies to one of the three (no undefined leak)
  for (const t of PROMETHEUS_TOOLS) {
    assert.ok(["read", "edit", "exec"].includes(classifyTool(t.annotations)), t.name);
  }
});

test("planModeRefusal is a JSON-serializable structured refusal (CLI-033)", () => {
  const r = planModeRefusal("propose_edit");
  assert.deepEqual(r, {
    denied: true,
    tool: "propose_edit",
    mode: "plan",
    hint: PLAN_REFUSAL_HINT,
  });
  // round-trips through the CLI-032 tool-message channel (JSON string) unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test("formatAuditLine: fields present, ends in newline, truncates to < 512 bytes (CLI-033)", () => {
  const line = formatAuditLine(
    "2026-07-17T00:00:00.000Z",
    "prometheus_install",
    "name=x argv=--yes",
    "auto-approved",
  );
  assert.match(
    line,
    /^2026-07-17T00:00:00\.000Z \| prometheus_install \| name=x argv=--yes \| auto-approved\n$/,
  );
  // a huge argv is truncated so the whole line stays atomic-appendable (< 512 bytes).
  const huge = formatAuditLine(
    "2026-07-17T00:00:00.000Z",
    "prometheus_install",
    "x".repeat(5000),
    "auto-approved",
  );
  assert.ok(
    Buffer.byteLength(huge, "utf8") <= AUDIT_LINE_MAX_BYTES,
    "line stays under the PIPE_BUF floor",
  );
  assert.match(huge, /…/, "the argv field is marked truncated");
  assert.ok(huge.endsWith("auto-approved\n"), "the outcome field survives truncation");
});

test("a tool that reaches the network is 'exec' even when it mutates nothing", () => {
  /**
   * `readOnlyHint` and `openWorldHint` are orthogonal, and a tool can honestly carry both:
   * `web_search` changes nothing on the machine, yet it sends the query out to a provider.
   * Classifying on readOnly first made it "read", and "read" is ALLOWED in plan mode — so the
   * one mode whose entire contract is "look, decide, change nothing" performed network egress
   * without a prompt. Egress is precisely what plan mode denies through the "exec" class.
   */
  const bothHints = { readOnlyHint: true, openWorldHint: true };
  assert.equal(classifyTool(bothHints), "exec");
  assert.equal(decideToolForMode("plan", bothHints), "deny");
  assert.equal(decideToolForMode("default", bothHints), "ask");

  // the ordinary cases are untouched
  assert.equal(classifyTool({ readOnlyHint: true }), "read");
  assert.equal(decideToolForMode("plan", { readOnlyHint: true }), "allow");
  assert.equal(classifyTool({ openWorldHint: true }), "exec");
  assert.equal(classifyTool(undefined), "edit");
});
