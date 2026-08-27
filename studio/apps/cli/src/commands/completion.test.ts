/**
 * completion.test.ts — shell-completion generators + man page (CLI-100). Verifies the 3 shells
 * produce valid, syntactically-checked output AND the registry-coverage regression guard (every
 * CommandSpec id appears in every generated script — generated, never hand-listed).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { COMMAND_SPECS } from "@prometheus/core";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { ROUTED_VERBS } from "../route-table.js";
import {
  bashCompletion,
  completionCommands,
  completionFlags,
  fishCompletion,
  runCompletion,
  zshCompletion,
} from "./completion.js";
import { manPage } from "./man.js";

const ALL_IDS = [...new Set(COMMAND_SPECS.map((c) => c.id))];

test("CLI-100 bash: valid shape + `bash -n` syntax check passes", () => {
  const script = bashCompletion();
  assert.match(script, /complete -F _prometheus prometheus/);
  assert.match(script, /compgen -W/);
  // syntactically valid to the actual shell (a metachar name would fail here even if it "appears").
  const bash = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  if (bash.error && (bash.error as NodeJS.ErrnoException).code === "ENOENT") return; // no bash → skip
  assert.equal(bash.status, 0, `bash -n failed: ${bash.stderr}`);
});

test("CLI-100 zsh: #compdef header + _describe", () => {
  const script = zshCompletion();
  assert.match(script, /^#compdef prometheus/);
  assert.match(script, /_describe -t commands/);
  // zsh -n if available.
  const zsh = spawnSync("zsh", ["-n"], { input: script, encoding: "utf8" });
  if (!zsh.error) assert.equal(zsh.status, 0, `zsh -n failed: ${zsh.stderr}`);
});

test("CLI-100 fish: complete -c prometheus lines, single-quoted + auto-load convention", () => {
  const script = fishCompletion();
  assert.match(script, /complete -c prometheus -f/);
  assert.match(script, /complete -c prometheus -n '__fish_use_subcommand' -a '/);
});

test("CLI-100 REGRESSION GUARD: every CommandSpec id appears in every generated script", () => {
  const bash = bashCompletion();
  const zsh = zshCompletion();
  const fish = fishCompletion();
  for (const id of completionCommands()) {
    assert.ok(bash.includes(id), `bash missing command "${id}"`);
    assert.ok(zsh.includes(id), `zsh missing command "${id}"`);
    assert.ok(fish.includes(id), `fish missing command "${id}"`);
  }
  // Coverage is real, and it is the ROUTER's list rather than the registry's internal ids —
  // `ALL_IDS` (the CommandSpec ids) contains `env-list`/`model-hw`/`provider-list`/`secure-scan`,
  // none of which is a command a user can type. Equating the two counts is what let the old bug
  // sit here looking like a guard.
  assert.ok(completionCommands().length > 0);
  assert.deepEqual(completionCommands(), [...new Set(ROUTED_VERBS)].sort());
});

test("CLI-100 security: interpolated command/flag names are metachar-free (can't break the shell)", () => {
  // the ONLY user-visible interpolated tokens are the command + flag names — each must be safe.
  for (const name of completionCommands()) {
    assert.match(name, /^[A-Za-z0-9:_-]+$/, `unsafe command name would break a shell: ${name}`);
  }
  for (const flag of completionFlags()) {
    assert.match(flag, /^--[A-Za-z0-9:_-]+$/, `unsafe flag name: ${flag}`);
  }
  // the bash `cmds="..."` wordlist (the substitution-sensitive spot) carries no bare `$`/backtick/`;`.
  const cmdLine =
    bashCompletion()
      .split("\n")
      .find((l) => l.trim().startsWith("local cmds=")) ?? "";
  assert.ok(cmdLine.length > 0);
  assert.doesNotMatch(cmdLine, /[`$;]/);
});

test("CLI-100 runCompletion: bash/zsh/fish print scripts; unknown shell → exit 2", () => {
  const ctx = (argv: string[]) => makeContext(parseArgs(argv));
  assert.match(runCompletion(ctx(["completion", "bash"])).text ?? "", /complete -F _prometheus/);
  assert.equal(runCompletion(ctx(["completion", "zsh"])).exitCode, 0);
  assert.equal(runCompletion(ctx(["completion", "fish"])).exitCode, 0);
  const bad = runCompletion(ctx(["completion", "powershell"]));
  assert.equal(bad.exitCode, 2);
  assert.match(bad.text ?? "", /specify a shell/);
  // an Object.prototype key must NOT resolve a generator (a plain-object map would return the
  // inherited constructor → exit 0 + "[object Object]"). The prototype-free map rejects it.
  for (const proto of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const r = runCompletion(ctx(["completion", proto]));
    assert.equal(r.exitCode, 2, `"${proto}" must be an unknown shell (exit 2)`);
  }
  // --json wraps the script.
  const j = runCompletion(ctx(["completion", "bash", "--json"]));
  assert.equal((j.json as { ok: boolean }).ok, true);
});

test("CLI-100 man: valid roff header + a .TP per command + copyable flags (\\-)", () => {
  const page = manPage({ version: "0.1.0", date: "2026-07-18" });
  assert.match(page, /^\.TH PROMETHEUS 1 "2026-07-18" "prometheus 0\.1\.0"/);
  assert.match(page, /\.SH NAME/);
  assert.match(page, /\.SH SYNOPSIS/);
  assert.match(page, /\.SH COMMANDS/);
  // every command has a bold entry (ids are roff-escaped: a `-` becomes `\-`).
  for (const id of completionCommands()) {
    assert.ok(page.includes(`\\fB${id.replace(/-/g, "\\-")}\\fR`), `man missing command "${id}"`);
  }
  assert.match(page, /\\fB\\-\\-json\\fR/); // OPTIONS use \- for a copyable minus
  assert.match(page, /\.SH EXIT STATUS/);
});

test("the generated completion offers only verbs that actually exist", () => {
  /**
   * `completionCommands()` used to map `COMMAND_SPECS` to their `id`, but a spec id is an
   * INTERNAL identifier, not the token a user types — `env-list` is the spec behind
   * `prometheus env list`. The completion therefore offered `env-list`, `model-hw`,
   * `provider-list` and `secure-scan`, all four of which exit 2 with "unknown command", while
   * omitting 32 verbs that do exist. Verified by running each against the built binary.
   *
   * `ROUTED_VERBS` already excludes those four by name (`INTERNAL_SPEC_IDS`); this generator
   * simply was not reading it.
   */
  const offered = completionCommands();

  for (const phantom of ["env-list", "model-hw", "provider-list", "secure-scan", "nemesis"]) {
    assert.ok(!offered.includes(phantom), `completion offers "${phantom}", which is not a command`);
  }
  // a spread of real verbs across every routing style: §2 nouns, sub-command trees, and the
  // three that are routed directly in index.ts
  for (const real of [
    "mcp",
    "env",
    "model",
    "repo",
    "keymap",
    "sessions",
    "profile",
    "agents",
    "metadata",
    "completion",
    "man",
    "ls",
    "scan",
    "secure",
  ]) {
    assert.ok(offered.includes(real), `completion omits "${real}", which is a real command`);
  }

  // and it is exactly the router's own list — the same one `index.ts` suggests from, so the two
  // can never disagree about what exists
  assert.deepEqual(offered, [...new Set(ROUTED_VERBS)].sort());
});

test("completion, man and ls are in the router's own verb list", () => {
  /**
   * All three are routed directly in `index.ts` (`completion`/`man`) or as a top-level alias
   * (`ls` → `list`, byte-identical `--json` output, checked against the binary), yet none was in
   * `RECOGNIZED_VERBS` — whose own docstring calls itself "the ground truth of direct routing".
   * So neither the completion nor the router's "did you mean" could offer them.
   */
  for (const v of ["completion", "man", "ls"]) {
    assert.ok(ROUTED_VERBS.includes(v), `${v} runs but is not in ROUTED_VERBS`);
  }
});
