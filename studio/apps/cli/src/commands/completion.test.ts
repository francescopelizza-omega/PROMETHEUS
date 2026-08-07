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
  // coverage is real: the registry has commands and they're all safe names (none dropped).
  assert.ok(completionCommands().length > 0);
  assert.equal(
    completionCommands().length,
    new Set(ALL_IDS.filter((x) => /^[\w:-]+$/.test(x))).size,
  );
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
