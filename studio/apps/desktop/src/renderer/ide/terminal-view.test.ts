/**
 * terminal-view.test.ts — pure Terminal Launcher display helpers (file 13 §1.2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BlockMarker,
  type CommandBlock,
  type SessionView,
  adjacentBlockLine,
  appendScrollback,
  groupSessions,
  joinWrappedRows,
  matchReadout,
  parseOsc133,
  reduceBlocks,
  searchLines,
  statusGlyph,
  stepMatch,
} from "./terminal-view.js";

const sessions: SessionView[] = [
  { id: "1", title: "zsh", status: "running", group: "project" },
  { id: "2", title: "pytest", status: "exited", group: "project" },
  { id: "3", title: "prom chat", status: "running", group: "ai" },
  { id: "5", title: "remote ssh", status: "running", group: "floating" },
];

test("statusGlyph reflects status + group (● running ○ idle ◆ ai ⧉ floating)", () => {
  assert.equal(statusGlyph(sessions[0] as SessionView), "●");
  assert.equal(statusGlyph(sessions[1] as SessionView), "○");
  assert.equal(statusGlyph(sessions[2] as SessionView), "◆");
  assert.equal(statusGlyph(sessions[3] as SessionView), "⧉");
});

test("groupSessions orders project → AI agents → floating, dropping empties", () => {
  const groups = groupSessions(sessions);
  assert.deepEqual(
    groups.map((g) => g.group),
    ["project", "AI agents", "floating"],
  );
  assert.equal(groups[0]?.sessions.length, 2);
  assert.equal(groupSessions([]).length, 0);
});

test("appendScrollback is bounded (drops the head past the cap)", () => {
  const out = appendScrollback("abcdef", "ghij", 8);
  assert.equal(out, "cdefghij");
  assert.equal(out.length, 8);
  assert.equal(appendScrollback("", "hi"), "hi");
});

/* ── APP-091: OSC-133 blocks ─────────────────────────────────────────────────*/

test("parseOsc133 handles A/B/C bare, D with exit, extra params, and junk", () => {
  assert.deepEqual(parseOsc133("A"), { kind: "A" });
  assert.deepEqual(parseOsc133("B"), { kind: "B" });
  assert.deepEqual(parseOsc133("C"), { kind: "C" });
  assert.deepEqual(parseOsc133("D;0"), { kind: "D", exitCode: 0 });
  assert.deepEqual(parseOsc133("D;137"), { kind: "D", exitCode: 137 });
  assert.deepEqual(parseOsc133("D"), { kind: "D" }); // no exit field
  assert.deepEqual(parseOsc133("A;aid=1;cl=m"), { kind: "A" }); // ignore extra params
  assert.equal(parseOsc133("Z"), null);
  assert.equal(parseOsc133(""), null);
});

test("reduceBlocks folds an A/B/C/D command lifecycle into a block", () => {
  const evs: BlockMarker[] = [
    { kind: "A", line: 10 },
    { kind: "B", line: 10 },
    { kind: "C", line: 10, command: "ls -la" },
    { kind: "D", line: 12, exitCode: 0 },
    { kind: "A", line: 13 },
    { kind: "C", line: 13, command: "false" },
    { kind: "D", line: 14, exitCode: 1 },
  ];
  const blocks = evs.reduce(reduceBlocks, [] as CommandBlock[]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { line: 10, command: "ls -la", exitCode: 0 });
  assert.deepEqual(blocks[1], { line: 13, command: "false", exitCode: 1 });
});

test("reduceBlocks ignores a stray C/D before any A (graceful degrade, AC5)", () => {
  let blocks: CommandBlock[] = [];
  blocks = reduceBlocks(blocks, { kind: "C", line: 1, command: "x" });
  blocks = reduceBlocks(blocks, { kind: "D", line: 2, exitCode: 0 });
  assert.deepEqual(blocks, []);
});

test("adjacentBlockLine jumps to the next/prev prompt relative to the viewport top", () => {
  const blocks: CommandBlock[] = [{ line: 5 }, { line: 20 }, { line: 42 }];
  assert.equal(adjacentBlockLine(blocks, 5, 1), 20); // next below
  assert.equal(adjacentBlockLine(blocks, 21, -1), 20); // prev above
  assert.equal(adjacentBlockLine(blocks, 42, 1), null); // nothing below → no-op
  assert.equal(adjacentBlockLine(blocks, 5, -1), null); // nothing above → no-op
  assert.equal(adjacentBlockLine([], 0, 1), null); // no blocks → no-op
});

/* ── APP-091: find-box search (buffer-walk fallback) ─────────────────────────*/

test("joinWrappedRows merges soft-wrapped continuation rows into one logical line", () => {
  const logical = joinWrappedRows([
    { text: "foo", wrapped: false },
    { text: "bar", wrapped: true }, // continuation of "foo"
    { text: "baz", wrapped: false },
  ]);
  assert.equal(logical.length, 2);
  assert.deepEqual(logical[0], { text: "foobar", startRow: 0 });
  assert.deepEqual(logical[1], { text: "baz", startRow: 2 });
});

test("searchLines: literal (case-insensitive default), findable across a wrap boundary", () => {
  const lines = ["Error: not found", "all clear", "another error here"];
  const m = searchLines(lines, "error");
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], { line: 0, start: 0, end: 5 });
  // case-sensitive misses the capital-E one.
  assert.equal(searchLines(lines, "error", { caseSensitive: true }).length, 1);
});

test("searchLines: wholeWord + regex + invalid-regex zero-state", () => {
  assert.equal(searchLines(["cat category cats"], "cat", { wholeWord: true }).length, 1);
  assert.equal(searchLines(["a1 b2 c3"], "[a-c]\\d", { regex: true }).length, 3);
  assert.deepEqual(searchLines(["x"], "(", { regex: true }), []); // invalid regex → no matches
  assert.deepEqual(searchLines(["x"], ""), []); // empty query → no matches
});

test("stepMatch wraps; matchReadout is 1-based with a 0/0 zero-state", () => {
  assert.equal(stepMatch(3, -1, 1), 0); // no active → first
  assert.equal(stepMatch(3, -1, -1), 2); // no active → last
  assert.equal(stepMatch(3, 2, 1), 0); // wrap forward
  assert.equal(stepMatch(3, 0, -1), 2); // wrap back
  assert.equal(stepMatch(0, 0, 1), -1); // no matches
  assert.equal(matchReadout(0, 3), "1/3");
  assert.equal(matchReadout(-1, 0), "0/0");
});
