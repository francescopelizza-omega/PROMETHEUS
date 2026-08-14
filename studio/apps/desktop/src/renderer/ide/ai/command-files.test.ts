/**
 * command-files.test.ts — expanding a user-defined `/name` command in the AgentPane composer
 * (Task #5, desktop parity with apps/cli/src/session/command-files.test.ts).
 *
 * Same load-bearing property as the CLI's twin: detection happens on the file's ORIGINAL body,
 * and argument substitution happens LAST, into already-resolved text — never the other way
 * round, or a user's own typed argument could be substituted into the template and then
 * detected as a command to run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCommandFile } from "@prometheus/core/command-loader";

import type { IdeLoadedCommandFile } from "../../../shared/ipc-contract.js";
import {
  type ExpandCommandFileDeps,
  expandCommandFile,
  matchCommandFileInvocation,
} from "./command-files.js";

function cmd(body: string, scope: "user" | "project" = "user"): IdeLoadedCommandFile {
  const parsed = parseCommandFile("demo.md", body);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.reason}`);
  return { file: parsed.file, scope, path: `/tmp/${scope}/demo.md` };
}

const deps = (over: Partial<ExpandCommandFileDeps> = {}): ExpandCommandFileDeps => ({
  readFile: async (p: string) => `contents of ${p}`,
  runShell: async (c: string) => `output of ${c}`,
  ...over,
});

/* ── matching a typed composer line ──────────────────────────────────────────*/

test("matchCommandFileInvocation: only a loaded /name at the START matches", () => {
  const commands = [cmd("Review: $ARGUMENTS")]; // name derives from "demo.md" → "demo"
  assert.equal(matchCommandFileInvocation("hello", commands), null);
  assert.equal(matchCommandFileInvocation("/unknown foo", commands), null);
  const m = matchCommandFileInvocation("/demo foo.py bar.py", commands);
  assert.ok(m);
  assert.equal(m?.cmd.file.name, "demo");
  assert.deepEqual(m?.args, ["foo.py", "bar.py"]);
});

test("matchCommandFileInvocation: no args is fine (empty array)", () => {
  const commands = [cmd("Review: $ARGUMENTS")];
  const m = matchCommandFileInvocation("/demo", commands);
  assert.deepEqual(m?.args, []);
});

/* ── the order that makes an injection impossible ────────────────────────────*/

test("a user's ARGUMENT can never become a shell injection", async () => {
  const out = await expandCommandFile(
    cmd("Review this: $1"),
    ["!`rm -rf ~`"],
    deps({
      runShell: async () => {
        throw new Error("an argument was executed as a command");
      },
    }),
  );
  assert.match(out.prompt, /!`rm -rf ~`/, "the argument should survive as literal text");
  assert.deepEqual(out.rejected, []);
});

/* ── shell injection by scope (mirrors the core commandGate policy exactly) ──*/

test("a PROJECT file's shell injection is refused and MARKED, never silently dropped", async () => {
  let ran = false;
  const out = await expandCommandFile(
    cmd("Status: !`git status`", "project"),
    [],
    deps({
      runShell: async () => {
        ran = true;
        return "x";
      },
    }),
  );
  assert.equal(ran, false);
  assert.match(out.prompt, /refused|blocked|declined/i);
  assert.ok(out.rejected.some((r) => r.what.includes("git status")));
});

test("a USER file's shell run reaches deps.runShell (policy allows it; desktop's own runShell decides)", async () => {
  const ran: string[] = [];
  const out = await expandCommandFile(
    cmd("Status: !`git status`", "user"),
    [],
    deps({
      runShell: async (c) => {
        ran.push(c);
        return "clean";
      },
    }),
  );
  assert.deepEqual(ran, ["git status"]);
  assert.match(out.prompt, /clean/);
  assert.deepEqual(out.rejected, []);
});

test("desktop's conservative default: runShell → null is reported as a real refusal, not a silent gap", async () => {
  const out = await expandCommandFile(
    cmd("Status: !`git status`", "user"),
    [],
    deps({ runShell: async () => null }),
  );
  assert.doesNotMatch(out.prompt, /git status\n/); // the raw command text never leaks through
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0]?.reason ?? "", /gate/);
});

/* ── @file reads ──────────────────────────────────────────────────────────────*/

test("@file resolves via readFile; a read failure is marked, never a silent gap", async () => {
  const ok = await expandCommandFile(
    cmd("See @notes.md for context."),
    [],
    deps({ readFile: async (p) => `NOTES(${p})` }),
  );
  assert.match(ok.prompt, /NOTES\(notes\.md\)/);

  const fail = await expandCommandFile(
    cmd("See @missing.md for context."),
    [],
    deps({
      readFile: async () => {
        throw new Error("ENOENT");
      },
    }),
  );
  assert.doesNotMatch(fail.prompt, /@missing\.md$/m);
  assert.equal(fail.rejected.length, 1);
});

/* ── caps ─────────────────────────────────────────────────────────────────────*/

test("a huge @file read is clipped at maxPartChars", async () => {
  const big = "x".repeat(20_000);
  const out = await expandCommandFile(cmd("Dump: @big.txt"), [], {
    ...deps({ readFile: async () => big }),
    maxPartChars: 100,
  });
  assert.ok(out.prompt.includes("…[truncated at 100 chars]"));
});
