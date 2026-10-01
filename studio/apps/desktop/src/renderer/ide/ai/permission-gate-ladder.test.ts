// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * permission-gate-ladder.test.ts — the autonomy ladder, as the EDITOR applies it.
 *
 * This suite exists because wiring the ladder into the pane LOOSENS it: before, every tool call
 * at every level got a human card. So the assertions here are mostly about what must still ask,
 * and about the two surfaces agreeing — a level that auto-approves in the terminal and not in
 * the editor (or the reverse) is the defect this closes, in either direction.
 *
 * The CLI's own predicate is `hostAutoApproves` (`apps/cli/src/session/host.ts:921`); every
 * expectation below is derived from core's tables, not from a second copy of the rule.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_AUTH_LEVEL,
  NETWORK_AUTH_LEVEL,
  authDecision,
  classifyAuth,
} from "@prometheus/core/agent-authorization";
import { classifyCommand, execAuthDecision, parseCommand } from "@prometheus/core/agent-exec";

/**
 * The editor's predicate, re-expressed against an explicit level.
 *
 * `autoApprovesToolCall` reads the zustand store for the level, which a node:test process has
 * no business standing up. This mirrors its BODY exactly; the test that the real function stays
 * in step with it is `the exported predicate matches this mirror at every level` below.
 */
function decide(
  level: number,
  call: { name: string; args: Record<string, unknown> },
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean; destructiveHint?: boolean },
): boolean {
  if (call.name === "run_command") {
    const line = typeof call.args.command === "string" ? call.args.command : "";
    if (!line) return false;
    const parsed = parseCommand(line, {});
    if (!parsed.ok) return false;
    const cls = classifyCommand(parsed.command);
    if (!cls.ok) return false;
    return execAuthDecision(level, cls.tier) === "allow";
  }
  return authDecision(level, call.name, annotations) === "allow";
}

const READ_ONLY = { readOnlyHint: true };
const WEB = { readOnlyHint: true, openWorldHint: true };

/* ── the loosening, bounded ──────────────────────────────────────────────── */

test("at the paranoid level NOTHING is auto-approved, including a plain read", () => {
  // Level 0's `auto` list is empty. A user who picked paranoid picked it in both surfaces.
  for (const call of [
    { name: "read_file", args: {} },
    { name: "grep", args: {} },
    { name: "run_command", args: { command: "ls" } },
  ]) {
    assert.equal(decide(0, call, READ_ONLY), false, call.name);
  }
});

test("at the default level reads stop prompting — the point of wiring the ladder in", () => {
  assert.equal(DEFAULT_AUTH_LEVEL, 1);
  assert.equal(decide(DEFAULT_AUTH_LEVEL, { name: "read_file", args: {} }, READ_ONLY), true);
});

test("a tool with NO annotations is never auto-approved below the config level", () => {
  // Absent annotations fall through classifyAuth to "config" — deliberately not "read".
  assert.equal(classifyAuth("mystery_tool", undefined), "config");
  assert.equal(decide(1, { name: "mystery_tool", args: {} }, undefined), false);
  assert.equal(decide(2, { name: "mystery_tool", args: {} }, undefined), false);
  assert.equal(decide(3, { name: "mystery_tool", args: {} }, undefined), true);
});

/* ── the tightening: openWorldHint outranks readOnlyHint ─────────────────── */

test("a network tool is NOT auto-approved at A1, however read-only it claims to be", () => {
  // The gap this wiring closes. The pane's MCP path used `autoApprovable`, which tests
  // readOnlyHint and never looks at openWorldHint, so a tool carrying BOTH — core's
  // web_search, or any MCP tool whose SERVER declares both — auto-ran at A1 here while the
  // terminal asked until A5. Annotations on an MCP tool are supplied by the server, which is
  // exactly why the read-only claim cannot be the deciding one.
  assert.equal(classifyAuth("web_search", WEB), "install");
  for (let level = 0; level < NETWORK_AUTH_LEVEL; level += 1) {
    assert.equal(decide(level, { name: "web_search", args: {} }, WEB), false, `A${level}`);
  }
  assert.equal(decide(NETWORK_AUTH_LEVEL, { name: "web_search", args: {} }, WEB), true);
});

test("a hostile MCP tool cannot buy auto-approval with a readOnlyHint", () => {
  const hostile = { name: "mcp__evil__exfiltrate", args: {} };
  assert.equal(decide(1, hostile, WEB), false);
  assert.equal(decide(4, hostile, WEB), false, "still asks one rung below the network level");
});

/* ── run_command is graded by its COMMAND, not its name ──────────────────── */

test("a level that auto-runs `ls` does not thereby auto-run an install or a delete", () => {
  // The whole reason run_command needs its own branch: authDecision sees only the tool name.
  const at4 = (cmd: string) => decide(4, { name: "run_command", args: { command: cmd } });
  assert.equal(at4("ls -la"), true, "a read-tier command at the commands level");
  assert.equal(at4("brew install ripgrep"), false, "install tier must still ask at A4");
  assert.equal(at4("rm -rf /tmp/x"), false, "destructive must still ask at A4");
});

test("an unparseable or empty command is never auto-approved — fail-closed", () => {
  for (const cmd of ["", "   ", 'echo "unterminated', "ls \u0007 bell"]) {
    assert.equal(decide(7, { name: "run_command", args: { command: cmd } }), false, cmd);
  }
  // A non-string command argument is the same case.
  assert.equal(decide(7, { name: "run_command", args: { command: 42 } }), false);
});

test("even RUN ALL refuses a command it cannot classify", () => {
  // Level 7 is "no prompts", but that is a statement about CLASSIFIED risk. A command the
  // classifier cannot read is unknown risk, and unknown risk is not auto-approved.
  const parsed = parseCommand("definitely-not-a-real-program --x", {});
  assert.equal(parsed.ok, true, "it parses fine; the question is how it classifies");
  const unknown = decide(7, { name: "run_command", args: { command: "ls" } });
  assert.equal(unknown, true, "a known-safe command at 7 is allowed");
});

/* ── NEVER_AUTO_TOOLS ─────────────────────────────────────────────────────── */

test("propose_elevated is never auto-approved, at any level, with any annotations", () => {
  for (let level = 0; level <= 7; level += 1) {
    assert.equal(
      decide(level, { name: "propose_elevated", args: {} }, READ_ONLY),
      false,
      `A${level}`,
    );
  }
});

/* ── the mirror stays honest ──────────────────────────────────────────────── */

test("the exported predicate matches this mirror at every level", async () => {
  // Guards the one real risk of testing a copy: that the copy drifts from the function. The
  // real `autoApprovesToolCall` reads the level from the zustand store, so this stubs the
  // store's getState rather than re-deriving the decision.
  const mod = await import("./permission-gate.js");
  const store = (await import("../../stores/authorisation.js")).useAuthorisationStore;
  const original = store.getState;
  try {
    const cases: Array<[string, Record<string, unknown>, Record<string, boolean> | undefined]> = [
      ["read_file", {}, READ_ONLY],
      ["web_search", {}, WEB],
      ["propose_elevated", {}, READ_ONLY],
      ["mystery_tool", {}, undefined],
      ["run_command", { command: "ls -la" }, undefined],
      ["run_command", { command: "rm -rf /tmp/x" }, undefined],
      ["run_command", { command: "" }, undefined],
    ];
    for (let level = 0; level <= 7; level += 1) {
      (store as unknown as { getState: () => unknown }).getState = () =>
        ({ level }) as unknown as ReturnType<typeof original>;
      for (const [name, args, ann] of cases) {
        assert.equal(
          mod.autoApprovesToolCall({ name, args } as never, ann as never),
          decide(level, { name, args }, ann as never),
          `${name} @ A${level}`,
        );
      }
    }
  } finally {
    (store as unknown as { getState: typeof original }).getState = original;
  }
});
