/**
 * patch.test.ts — one edit across N files, all of it or none of it.
 *
 * The atomicity tests are the reason this module exists. Repeated `propose_edit` already
 * "works"; what it cannot do is fail safely. Calls 1-3 apply, call 4's hunk no longer matches,
 * and the user is left holding a half-migrated tree while the model believes it succeeded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyProposedEdit, diagnoseHunkMiss } from "./edit.js";
import { APPLY_PATCH_TOOL, describePatch, parsePatchFiles, resolvePatch } from "./patch.js";

const FILES: Record<string, string> = {
  "a.ts": "export const name = 'old';\n",
  "b.ts": "import { name } from './a';\nconsole.log(name);\n",
};
const read = (p: string): string | null => FILES[p] ?? null;

/* ── the point: all or nothing ──────────────────────────────────────────────*/

test("a patch across two files resolves both", () => {
  const r = resolvePatch(
    [
      { path: "a.ts", hunks: [{ old: "'old'", new: "'new'" }] },
      { path: "b.ts", hunks: [{ old: "console.log", new: "console.info" }] },
    ],
    read,
  );
  assert.ok(r.ok);
  assert.equal(r.totalHunks, 2);
  assert.match(r.files[0]?.next ?? "", /'new'/);
  assert.match(r.files[1]?.next ?? "", /console\.info/);
});

test("ONE bad hunk means NOTHING resolves — the half-migrated tree is impossible", () => {
  const r = resolvePatch(
    [
      { path: "a.ts", hunks: [{ old: "'old'", new: "'new'" }] },
      { path: "b.ts", hunks: [{ old: "this text is not in the file", new: "x" }] },
    ],
    read,
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.path, "b.ts", "the failure did not name the offending file");
  assert.equal(r.code, "no-match");
});

test("a missing file fails the whole patch and says to use write_file", () => {
  const r = resolvePatch(
    [
      { path: "a.ts", hunks: [{ old: "'old'", new: "'new'" }] },
      { path: "nope.ts", hunks: [{ old: "x", new: "y" }] },
    ],
    read,
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.path, "nope.ts");
  assert.match(r.message, /write_file/, "the model was not told how to create a file");
});

test("an AMBIGUOUS hunk fails rather than picking a match", () => {
  // Guessing which of two identical spans to edit is how a patch corrupts a file quietly.
  const dup = (p: string) => (p === "d.ts" ? "x = 1;\nx = 1;\n" : null);
  const r = resolvePatch([{ path: "d.ts", hunks: [{ old: "x = 1;", new: "x = 2;" }] }], dup);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "ambiguous");
});

test("an empty patch, a pathless entry and a hunkless file are all refused", () => {
  assert.equal(resolvePatch([], read).ok, false);
  assert.equal(resolvePatch([{ path: "", hunks: [{ old: "a", new: "b" }] }], read).ok, false);
  assert.equal(resolvePatch([{ path: "a.ts", hunks: [] }], read).ok, false);
});

test("several hunks in ONE file all apply", () => {
  const multi = (p: string) => (p === "m.ts" ? "one\ntwo\nthree\n" : null);
  const r = resolvePatch(
    [
      {
        path: "m.ts",
        hunks: [
          { old: "one", new: "1" },
          { old: "three", new: "3" },
        ],
      },
    ],
    multi,
  );
  assert.ok(r.ok);
  assert.equal(r.files[0]?.applied, 2);
  assert.equal(r.files[0]?.next, "1\ntwo\n3\n");
});

/* ── parsing what the model sent ────────────────────────────────────────────*/

test("edits arrive as an array, or as a JSON string — models send both", () => {
  const asArray = parsePatchFiles([{ path: "a.ts", hunks: [{ old: "x", new: "y" }] }]);
  const asString = parsePatchFiles('[{"path":"a.ts","hunks":[{"old":"x","new":"y"}]}]');
  assert.deepEqual(asArray, asString);
  assert.equal(asArray[0]?.path, "a.ts");
});

test("a per-file hunks STRING is parsed too", () => {
  const files = parsePatchFiles([{ path: "a.ts", hunks: '[{"old":"x","new":"y"}]' }]);
  assert.deepEqual(files[0]?.hunks, [{ old: "x", new: "y" }]);
});

test("a malformed hunk is dropped, and the file then fails the resolve rather than silently doing nothing", () => {
  // Dropping the hunk but keeping the file is what turns "your patch was wrong" into "your
  // patch applied and changed nothing".
  const files = parsePatchFiles([{ path: "a.ts", hunks: [{ old: 5, new: "y" }] }]);
  assert.deepEqual(files[0]?.hunks, []);
  assert.equal(resolvePatch(files, read).ok, false);
});

test("garbage yields no files at all", () => {
  for (const bad of [null, undefined, 7, "nope", {}, [1, 2]]) {
    assert.deepEqual(parsePatchFiles(bad), [], `invented files from ${String(bad)}`);
  }
});

/* ── the tool ───────────────────────────────────────────────────────────────*/

test("apply_patch is destructive — ONE approval for the whole patch", () => {
  // Six files used to mean six prompts, and a user clicking through six prompts is not
  // reviewing any of them.
  assert.equal(APPLY_PATCH_TOOL.annotations.destructiveHint, true);
  assert.notEqual(APPLY_PATCH_TOOL.annotations.readOnlyHint, true);
});

test("edits is declared an ARRAY, and toArgv throws", () => {
  assert.equal(APPLY_PATCH_TOOL.schema.edits?.type, "array");
  assert.equal(APPLY_PATCH_TOOL.schema.edits?.required, true);
  assert.throws(() => APPLY_PATCH_TOOL.toArgv({}), /host runtime/);
});

test("the summary names every file it touched", () => {
  const s = describePatch(
    [
      { path: "a.ts", next: "", applied: 1 },
      { path: "b.ts", next: "", applied: 2 },
    ],
    3,
  );
  assert.match(s, /3 hunks across 2 files/);
  assert.match(s, /a\.ts, b\.ts/);
});

/* ── why a hunk missed: the message a live model has to act on ──────────────*/

/**
 * These four cases are transcribed from live runs, not imagined. Watching qwen3.6 receive a
 * bare "old text not found", the next three rounds were guesses — indentation? newlines?
 * re-read? — and one of them ended with the model reaching for a blunter tool. The diagnosis
 * exists to turn that into a single corrected retry.
 */

test("a copied line-number gutter is named as the cause", () => {
  // read_file is HOW the model got the text, so quoting its gutter back is the likeliest
  // mistake there is.
  const file = "export function f() {\n  return 1;\n}\n";
  const hint = diagnoseHunkMiss(file, "1  export function f() {\n2    return 1;\n");
  assert.match(hint, /line-number gutter/);
});

test("an indentation-only difference says so, instead of `not found`", () => {
  const file = "class A {\n    method() {\n      return 1;\n    }\n}\n";
  const hint = diagnoseHunkMiss(file, "method() {\n  return 1;\n}");
  assert.match(hint, /leading whitespace differs/);
  assert.match(hint, /verbatim/);
});

test("a dropped line break is located and NAMED", () => {
  // The live failure: a model reconstructing from a numbered listing joined two lines into one.
  // Note there is no matching "first line" to find — the joined text is a line the file does
  // not contain — which is why the diagnosis works on the longest matching PREFIX.
  const file = 'import { a } from "./a.js";\n\nconsole.log(a(1));\n';
  const hint = diagnoseHunkMiss(file, 'import { a } from "./a.js";console.log(a(1));');
  assert.match(hint, /matches from line 1/);
  assert.match(hint, /LINE BREAK/);
});

test("a divergence that is NOT a newline says where without inventing a cause", () => {
  const file = "const total = compute(alpha, beta);\n";
  const hint = diagnoseHunkMiss(file, "const total = compute(alpha, GAMMA);");
  assert.match(hint, /then diverges/);
  assert.doesNotMatch(hint, /LINE BREAK/);
});

test("a short accidental overlap is not dressed up as a near miss", () => {
  // Two characters in common is coincidence, not a diagnosis.
  assert.match(diagnoseHunkMiss("const x = 1;\n", "co!!"), /no part of `old` appears/);
});

test("text that is simply absent says the file may have changed", () => {
  const hint = diagnoseHunkMiss("a\nb\n", "totally unrelated");
  assert.match(hint, /no part of `old` appears/);
  assert.match(hint, /re-read/);
});

test("the diagnosis never claims a location it did not find", () => {
  // A wrong line number is worse than none: the model edits the wrong place with confidence.
  const hint = diagnoseHunkMiss("a\nb\n", "zzz");
  assert.doesNotMatch(hint, /at line/);
});

test("an empty old yields no hint rather than a confident wrong one", () => {
  assert.equal(diagnoseHunkMiss("a\n", ""), "");
  assert.equal(diagnoseHunkMiss("a\n", "\n\n  \n"), "");
});

test("the hint rides the real failure message, keeping the hunk index", () => {
  const r = applyProposedEdit('import { a } from "./a.js";\n\nconsole.log(a(1));\n', [
    { old: 'import { a } from "./a.js";console.log(a(1));', new: "x" },
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.message, /^hunk 0: old text not found/);
    assert.match(r.message, /then diverges/);
  }
});

test("an ambiguous match now says how to disambiguate", () => {
  // "matches more than one location" left the model to guess that MORE context is the fix.
  const r = applyProposedEdit("x\nsame\ny\nsame\n", [{ old: "same", new: "z" }]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /extend it with surrounding lines/);
});
