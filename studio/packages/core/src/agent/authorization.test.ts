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
