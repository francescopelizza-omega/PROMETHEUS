/**
 * host-authz.test.ts — the autonomy ladder must mean the SAME thing on every host.
 *
 * `/authorisation N` is persisted once and shared by every surface. The `--plain`/`--tmux` host
 * decided auto-approval with `agent.authDecision(level, name, annotations)` alone, while the TUI
 * host and the one-shot host both refine that answer for the two tools whose NAME does not carry
 * their risk. Same level, same tool call, two different answers — and the weaker one was the
 * headless surface a script or cron job would use.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { agent } from "@prometheus/core";

const WRITE_ANN = { destructiveHint: true } as const;

test("the name-only decision is NOT sufficient for write_file — that is the whole trap", () => {
  // At level 2 ("auto-approve edits") the name-only answer is allow for ANY path...
  assert.equal(agent.authDecision(2, "write_file", WRITE_ANN), "allow");
  // ...but write_file has no working-set guard of its own, so an OUT-of-scope target must ask.
  assert.notEqual(agent.scopedWriteDecision(2, "write_file", WRITE_ANN, false), "allow");
  // in-scope stays auto — raising your autonomy still buys you something.
  assert.equal(agent.scopedWriteDecision(2, "write_file", WRITE_ANN, true), "allow");
});

test("the name-only decision is NOT sufficient for run_command — risk lives in the COMMAND", () => {
  const parsed = agent.parseCommand("npm install evil-pkg", { vars: {} });
  assert.equal(parsed.ok, true);
  const cls = agent.classifyCommand(parsed.command);
  assert.equal(cls.ok, true);
  if (!cls.ok) return;
  // level 4 says "allow" for the NAME...
  assert.equal(agent.authDecision(4, "run_command", {}), "allow");
  // ...while the tier-aware answer for an install at the same level still asks.
  assert.equal(agent.execAuthDecision(4, cls.tier), "ask");
});

test("every host routes write_file / run_command through the SCOPE- and TIER-aware decisions", () => {
  /**
   * A source guard, deliberately: the drift it catches is a host reaching for the wrong
   * function, and that is a property of the code, not of any one call. Each of the three hosts
   * must name `scopedWriteDecision` and `execAuthDecision` — the TUI and one-shot hosts always
   * did; `session/host.ts` did not, which is what let `--plain` auto-write `~/.zshrc` at
   * level 2 and auto-run installs at level 4.
   */
  const here = new URL(".", import.meta.url);
  for (const [label, rel] of [
    ["--plain / --tmux host", "./host.ts"],
    ["one-shot host", "./one-shot.ts"],
    ["TUI host", "../tui/session-bridge.ts"],
  ] as const) {
    const src = readFileSync(new URL(rel, here), "utf8");
    assert.ok(
      src.includes("scopedWriteDecision"),
      `${label} decides write_file without the working-set-aware decision`,
    );
    assert.ok(
      src.includes("execAuthDecision"),
      `${label} decides run_command without the tier-aware decision`,
    );
  }
});
