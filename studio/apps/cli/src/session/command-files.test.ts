/**
 * command-files.test.ts — expanding a user-defined `/name` command.
 *
 * The load-bearing property is the ORDER. Detection happens on the file's original body (which
 * `parseCommandFile` already did) and argument substitution happens LAST, into already-resolved
 * text. The other order is a hole: a user's own typed argument would be substituted into the
 * template and then detected as a command to run, so `/review "!\`rm -rf ~\`"` would execute.
 * The two orders are not equivalent and nothing in the parser picks one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { commandLoader } from "@prometheus/core";

import { type LoadedCommand, expandCommand } from "./command-files.js";

function cmd(body: string, scope: "user" | "project" = "user"): LoadedCommand {
  const parsed = commandLoader.parseCommandFile("demo.md", body);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.reason}`);
  return { file: parsed.file, scope, path: `/tmp/${scope}/demo.md` };
}

const deps = (over: Partial<Parameters<typeof expandCommand>[2]> = {}) => ({
  readFile: async (p: string) => `contents of ${p}`,
  runShell: async (c: string) => `output of ${c}`,
  ...over,
});

/* ── the order that makes an injection impossible ──────────────────────────*/

test("a user's ARGUMENT can never become a shell injection", () => {
  // The whole reason substitution runs last. If the result were re-scanned, this argument would
  // be detected and executed.
  return expandCommand(
    cmd("Review this: $1"),
    ["!`rm -rf ~`"],
    deps({
      runShell: async () => {
        throw new Error("an argument was executed as a command");
      },
    }),
  ).then((out) => {
    assert.match(out.prompt, /!`rm -rf ~`/, "the argument should survive as literal text");
    assert.deepEqual(out.rejected, []);
  });
});

/* ── shell injection by scope ──────────────────────────────────────────────*/

test("a PROJECT file's shell injection is refused and MARKED, never silently dropped", async () => {
  let ran = false;
  const out = await expandCommand(
    cmd("Status: !`git status`", "project"),
    [],
    deps({
      runShell: async () => {
        ran = true;
        return "x";
      },
    }),
  );
  assert.equal(ran, false, "a repo file ran a shell command");
  assert.match(out.prompt, /refused/);
  assert.doesNotMatch(out.prompt, /output of/);
  assert.equal(out.rejected.length, 1);
});

test("a USER file's injection runs and its output lands in the prompt", async () => {
  const out = await expandCommand(cmd("Status: !`git status`", "user"), [], deps());
  assert.match(out.prompt, /output of git status/);
  assert.deepEqual(out.rejected, []);
});

test("a DECLINED command leaves a marker and is reported, not a gap", async () => {
  // `runShell` returning null is the human saying no, or the gate blocking.
  const out = await expandCommand(
    cmd("Status: !`git status`", "user"),
    [],
    deps({ runShell: async () => null }),
  );
  assert.match(out.prompt, /refused/);
  assert.equal(out.rejected.length, 1);
});

/* ── file refs ─────────────────────────────────────────────────────────────*/

test("a file ref is replaced by its contents, fenced and labelled", async () => {
  const out = await expandCommand(cmd("Look at @src/a.ts please"), [], deps());
  assert.match(out.prompt, /--- src\/a\.ts ---/);
  assert.match(out.prompt, /contents of src\/a\.ts/);
});

test("an unreadable file ref is reported and marked", async () => {
  const out = await expandCommand(
    cmd("Look at @src/a.ts"),
    [],
    deps({
      readFile: async () => {
        throw new Error("outside the working set");
      },
    }),
  );
  assert.match(out.prompt, /refused/);
  assert.match(out.rejected[0]?.reason ?? "", /working set/);
});

test("an ESCAPING ref never reaches readFile at all", async () => {
  let asked = "";
  await expandCommand(
    cmd("Read @../../etc/passwd"),
    [],
    deps({
      readFile: async (p) => {
        asked = p;
        return "";
      },
    }),
  );
  assert.equal(asked, "", "a traversal ref was handed to the reader");
});

/* ── substitution still works ──────────────────────────────────────────────*/

test("positional and $ARGUMENTS substitution survive the reordering", async () => {
  const out = await expandCommand(cmd("Fix $1 in $2"), ["the bug", "main.ts"], deps());
  assert.match(out.prompt, /Fix the bug in main\.ts/);
});

test("a shell command containing an `@` still gets its OUTPUT spliced in", async () => {
  /**
   * The reads loop rewrites every `@ref` occurrence in the template before the runs loop splits
   * on the run token. When the parser reported an `@` INSIDE a command as a fileRef, that
   * rewrite mutated the token, `text.split(token)` matched nothing, and the command's output —
   * for a command the human had already been prompted about and approved, and which really did
   * execute through the gate — was silently dropped on the floor.
   */
  const ran: string[] = [];
  const out = await expandCommand(cmd("Version: !`npm view react@latest version`"), [], {
    readFile: async () => {
      throw new Error("no file should be read for a ref that lives inside a command");
    },
    runShell: async (c: string) => {
      ran.push(c);
      return "19.2.0";
    },
  });

  assert.deepEqual(ran, ["npm view react@latest version"], "the command did not run as written");
  assert.match(out.prompt, /19\.2\.0/, "the approved command's output was thrown away");
  assert.doesNotMatch(out.prompt, /refused/i);
  assert.deepEqual(out.rejected, []);

  // self-validating: a real `@ref` in the same template is still resolved as a read
  const both = await expandCommand(cmd("!`echo a@b` and @notes.md"), [], {
    readFile: async (p: string) => `body of ${p}`,
    runShell: async () => "ok",
  });
  assert.match(both.prompt, /body of notes\.md/);
  assert.match(both.prompt, /--- \$ echo a@b ---/);
});
