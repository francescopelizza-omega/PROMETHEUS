/**
 * merge-conflict.test.ts — the PURE 3-way conflict parser + reducers (APP-039).
 *
 * Pins: segment parsing (common runs vs conflict blocks), diff3 base sections, the
 * `=======`-content-line false-positive guard, per-block accept ours/theirs/both +
 * manual, acceptBoth ordering (ours-then-theirs), CRLF EOL preservation, and lossless
 * marker round-trip for an unresolved block.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptBoth,
  acceptOurs,
  acceptTheirs,
  buildResult,
  parseConflicts,
  setManual,
  unresolvedCount,
} from "./merge-conflict.js";

const CONFLICT = [
  "line1",
  "<<<<<<< HEAD",
  "ours-a",
  "ours-b",
  "=======",
  "theirs-a",
  ">>>>>>> feature",
  "line2",
  "<<<<<<< HEAD",
  "ours2",
  "=======",
  "theirs2",
  ">>>>>>> feature",
  "line3",
].join("\n");

test("parseConflicts splits common runs and conflict blocks", () => {
  const m = parseConflicts(CONFLICT);
  assert.equal(m.conflictCount, 2);
  assert.equal(m.eol, "\n");
  assert.deepEqual(
    m.segments.map((s) => s.kind),
    ["common", "conflict", "common", "conflict", "common"],
  );
  const c0 = m.segments[1];
  assert.ok(c0.kind === "conflict");
  assert.deepEqual(c0.ours, ["ours-a", "ours-b"]);
  assert.deepEqual(c0.theirs, ["theirs-a"]);
  assert.equal(c0.base, null);
  assert.equal(c0.resolution, "unresolved");
});

test("parseConflicts reads a diff3 base section", () => {
  const t = ["<<<<<<< ours", "O", "||||||| base", "B", "=======", "T", ">>>>>>> theirs"].join("\n");
  const c = parseConflicts(t).segments[0];
  assert.ok(c.kind === "conflict");
  assert.deepEqual(c.base, ["B"]);
  assert.deepEqual(c.ours, ["O"]);
  assert.deepEqual(c.theirs, ["T"]);
});

test("a plain ======= line in common text is NOT treated as a separator", () => {
  const m = parseConflicts(["above", "=======", "below"].join("\n"));
  assert.equal(m.conflictCount, 0);
  assert.equal(m.segments.length, 1);
  assert.equal(m.segments[0]?.kind, "common");
});

test("acceptOurs/Theirs pick the right lines; buildResult preserves common text", () => {
  let m = parseConflicts(CONFLICT);
  m = acceptOurs(m, 0);
  m = acceptTheirs(m, 1);
  assert.equal(unresolvedCount(m), 0);
  assert.equal(
    buildResult(m),
    ["line1", "ours-a", "ours-b", "line2", "theirs2", "line3"].join("\n"),
  );
});

test("acceptBoth concatenates ours-then-theirs", () => {
  let m = parseConflicts(["<<<<<<< ours", "O", "=======", "T", ">>>>>>> theirs"].join("\n"));
  m = acceptBoth(m, 0);
  assert.equal(buildResult(m), ["O", "T"].join("\n"));
});

test("setManual overrides a block verbatim and survives an accept on ANOTHER block", () => {
  let m = parseConflicts(CONFLICT);
  m = setManual(m, 0, "custom1\ncustom2");
  m = acceptTheirs(m, 1);
  const seg0 = m.segments[1];
  assert.ok(seg0.kind === "conflict");
  assert.equal(seg0.resolution, "manual");
  assert.equal(
    buildResult(m),
    ["line1", "custom1", "custom2", "line2", "theirs2", "line3"].join("\n"),
  );
});

test("CRLF EOL is detected and re-emitted (no spurious whole-file diff)", () => {
  const t = ["a", "<<<<<<< ours", "O", "=======", "T", ">>>>>>> theirs", "b"].join("\r\n");
  let m = parseConflicts(t);
  assert.equal(m.eol, "\r\n");
  m = acceptOurs(m, 0);
  assert.equal(buildResult(m), ["a", "O", "b"].join("\r\n"));
});

test("an unresolved block round-trips its markers through buildResult", () => {
  const out = buildResult(
    parseConflicts(["<<<<<<< ours", "O", "=======", "T", ">>>>>>> theirs"].join("\n")),
  );
  assert.match(out, /^<{7}/m);
  assert.match(out, /^={7}$/m);
  assert.match(out, /^>{7}/m);
});

test("a file with no markers is a single common segment (0 conflicts)", () => {
  const m = parseConflicts("just\nplain\ntext");
  assert.equal(m.conflictCount, 0);
  assert.equal(buildResult(m), "just\nplain\ntext");
});
