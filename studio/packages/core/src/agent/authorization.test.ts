import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTH_LEVELS,
  authDecision,
  authLevelMeta,
  authLevelName,
  authRunToDone,
  classifyAuth,
  modeToAuthLevel,
  parseAuthLevel,
  scopedWriteDecision,
} from "./authorization.js";
import { formatDuration } from "./duration.js";

test("AUTH_LEVELS: 8 crescent levels 0..7, each auto-set ⊇ the previous", () => {
  assert.equal(AUTH_LEVELS.length, 8);
  for (let i = 0; i < 8; i++) assert.equal(AUTH_LEVELS[i]?.level, i);
  for (let i = 1; i < 8; i++) {
    const prev = new Set(AUTH_LEVELS[i - 1]?.auto);
    for (const c of prev) assert.ok(AUTH_LEVELS[i]?.auto.includes(c), `level ${i} keeps ${c}`);
  }
  assert.equal(authLevelName(0), "paranoid");
  assert.equal(authLevelName(7), "runall");
});

test("classifyAuth: ref + annotations → category", () => {
  assert.equal(classifyAuth("prometheus_list", { readOnlyHint: true }), "read");
  assert.equal(classifyAuth("write_file", { destructiveHint: true }), "write");
  assert.equal(classifyAuth("propose_edit", { destructiveHint: true }), "write");
  assert.equal(classifyAuth("engine:install", { openWorldHint: true }), "install");
  assert.equal(classifyAuth("run_command", {}), "command");
  assert.equal(classifyAuth("prometheus_uninstall", { destructiveHint: true }), "destructive");
  assert.equal(classifyAuth("prometheus_enable", {}), "config");
});

test("authDecision: paranoid asks reads; higher levels progressively allow", () => {
  // level 0 asks EVERYTHING incl reads
  assert.equal(authDecision(0, "prometheus_list", { readOnlyHint: true }), "ask");
  // level 1 auto reads, asks writes
  assert.equal(authDecision(1, "prometheus_list", { readOnlyHint: true }), "allow");
  assert.equal(authDecision(1, "write_file", { destructiveHint: true }), "ask");
  // level 2 auto writes, asks commands/installs
  assert.equal(authDecision(2, "write_file", { destructiveHint: true }), "allow");
  assert.equal(authDecision(2, "run_command", {}), "ask");
  assert.equal(authDecision(2, "engine:install", { openWorldHint: true }), "ask");
  // level 4 auto commands, asks installs
  assert.equal(authDecision(4, "run_command", {}), "allow");
  assert.equal(authDecision(4, "engine:install", { openWorldHint: true }), "ask");
  // level 5 auto installs, asks destructive
  assert.equal(authDecision(5, "engine:install", { openWorldHint: true }), "allow");
  assert.equal(authDecision(5, "prometheus_uninstall", { destructiveHint: true }), "ask");
  // level 6/7 allow everything
  assert.equal(authDecision(6, "prometheus_uninstall", { destructiveHint: true }), "allow");
  assert.equal(authDecision(7, "prometheus_uninstall", { destructiveHint: true }), "allow");
});

test("scopedWriteDecision: an auto-approved write outside the working set falls back to ask", () => {
  const W = { destructiveHint: true } as const;
  // level 2 ("edits") auto-approves ONLY inside the working set…
  assert.equal(scopedWriteDecision(2, "write_file", W, true), "allow");
  assert.equal(scopedWriteDecision(2, "write_file", W, false), "ask");
  // …same for the levels between (3–5) that also auto-approve the write category
  for (const lvl of [3, 4, 5]) {
    assert.equal(scopedWriteDecision(lvl, "write_file", W, false), "ask", `level ${lvl} scopes`);
  }
  // levels 6/7 are an explicit global opt-in → auto everywhere
  assert.equal(scopedWriteDecision(6, "write_file", W, false), "allow");
  assert.equal(scopedWriteDecision(7, "write_file", W, false), "allow");
  // it never LOOSENS the base decision: a level that would ask still asks in scope
  assert.equal(scopedWriteDecision(1, "write_file", W, true), "ask");
  assert.equal(scopedWriteDecision(0, "write_file", W, true), "ask");
  // non-write categories are untouched (scope is a write-path concept)
  assert.equal(scopedWriteDecision(1, "prometheus_list", { readOnlyHint: true }, false), "allow");
});

test("authRunToDone: only level 7", () => {
  for (let i = 0; i <= 6; i++) assert.equal(authRunToDone(i), false);
  assert.equal(authRunToDone(7), true);
});

test("parseAuthLevel: digit OR name, else null; clamps meta", () => {
  assert.equal(parseAuthLevel("7"), 7);
  assert.equal(parseAuthLevel("0"), 0);
  assert.equal(parseAuthLevel("runall"), 7);
  assert.equal(parseAuthLevel("RunAll"), 7);
  assert.equal(parseAuthLevel(" paranoid "), 0);
  assert.equal(parseAuthLevel("8"), null);
  assert.equal(parseAuthLevel("bogus"), null);
  assert.equal(authLevelMeta(99).level, 7); // clamp
  assert.equal(authLevelMeta(-4).level, 0);
});

test("modeToAuthLevel: keeps the coarse mode and fine level in sync", () => {
  assert.equal(modeToAuthLevel("yolo"), 7);
  assert.equal(modeToAuthLevel("bypassPermissions"), 6);
  assert.equal(modeToAuthLevel("acceptEdits"), 2);
  assert.equal(modeToAuthLevel("plan"), 0);
  assert.equal(modeToAuthLevel("default"), 1);
});

test("formatDuration: drops zero counters", () => {
  assert.equal(formatDuration(40_000), "40s");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(3_601_000), "1h 1s"); // 0m dropped
  assert.equal(formatDuration(90_000_000), "1d 1h"); // 25h → 1d 1h, zeros dropped
  assert.equal(formatDuration(400), "0s"); // sub-second
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-5), "0s");
  assert.equal(formatDuration(120_000), "2m"); // exactly 2 minutes → no 0s
});

test("network reach outranks read-only when a tool carries both hints", () => {
  /**
   * `web_search` declares both hints truthfully — it mutates nothing, and it sends the query off
   * the machine. Testing readOnly first put it in the "read" category, which every authorisation
   * level auto-approves, so it ran with no prompt at the default level. That contradicted the
   * comment sitting on its own annotations, which says it must always be confirmed because the
   * human should see what is about to leave the machine.
   */
  assert.equal(classifyAuth("web_search", { readOnlyHint: true, openWorldHint: true }), "install");
  // and a genuinely local read-only tool is still free
  assert.equal(classifyAuth("list_dir", { readOnlyHint: true }), "read");
});
