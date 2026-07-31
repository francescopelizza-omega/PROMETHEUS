/**
 * changeset.test.ts — the ChangeSet apply/reject engine (file 07 §7.4).
 *
 * This is the most-tested module: a model proposal is NEVER applied directly, so
 * the apply/reject/hunk math must be deterministic and correct. We assert:
 *  - computeHunks produces real line hunks (replace / pure-insert / pure-delete),
 *  - acceptAll round-trips before→after,
 *  - accepting SOME hunks applies only those (the §7.4 "Apply selected"),
 *  - rejectAll yields the original,
 *  - new-file and delete-file edits,
 *  - the multi-file plan summary (counts + newFiles for the run-gate, §5.2),
 *  - apply order independence (bottom-up splice never shifts a later anchor).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ChangeSet,
  type FileEdit,
  acceptAll,
  acceptHunk,
  applyChangeSet,
  applyFileEditFully,
  computeHunks,
  fileEditFromTexts,
  rejectAll,
  summarizeChangeSet,
} from "./changeset.js";

const URI = "file:///ws/src/runner.py";

test("computeHunks: a single in-place replacement is one hunk", () => {
  const before = "a\nb\nc";
  const after = "a\nB\nc";
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 1);
  const h = hunks[0]!;
  assert.equal(h.originalStart, 1);
  assert.equal(h.originalLines, 1);
  assert.deepEqual(h.oldLines, ["b"]);
  assert.deepEqual(h.newLines, ["B"]);
});

test("computeHunks: a pure insertion has originalLines 0 anchored at the next line", () => {
  const before = "a\nc";
  const after = "a\nb\nc";
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 1);
  const h = hunks[0]!;
  assert.equal(h.originalLines, 0);
  assert.equal(h.originalStart, 1); // splices BEFORE original line 1 ("c")
  assert.deepEqual(h.newLines, ["b"]);
  assert.deepEqual(h.oldLines, []);
});

test("computeHunks: a pure deletion has empty newLines", () => {
  const before = "a\nb\nc";
  const after = "a\nc";
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 1);
  const h = hunks[0]!;
  assert.equal(h.originalLines, 1);
  assert.deepEqual(h.oldLines, ["b"]);
  assert.deepEqual(h.newLines, []);
});

test("computeHunks: identical inputs produce no hunks", () => {
  assert.deepEqual(computeHunks("x\ny", "x\ny"), []);
});

test("computeHunks: two separated changes produce two hunks with stable ids", () => {
  const before = "1\n2\n3\n4\n5";
  const after = "1\nX\n3\n4\nY";
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]!.id, "h0");
  assert.equal(hunks[1]!.id, "h1");
});

test("applyChangeSet: acceptAll round-trips before -> after", () => {
  const before = "1\n2\n3\n4\n5";
  const after = "1\nX\n3\n4\nY";
  const edit = fileEditFromTexts(URI, before, after);
  assert.equal(applyChangeSet(before, edit, acceptAll(edit)), after);
  assert.equal(applyFileEditFully(before, edit), after);
});

test("applyChangeSet: accept SOME hunks applies only those (Apply selected)", () => {
  const before = "1\n2\n3\n4\n5";
  const after = "1\nX\n3\n4\nY";
  const edit = fileEditFromTexts(URI, before, after);
  // accept only the FIRST hunk (line 2 -> X), leave line 5 untouched.
  const justFirst = applyChangeSet(before, edit, ["h0"]);
  assert.equal(justFirst, "1\nX\n3\n4\n5");
  // accept only the SECOND hunk (line 5 -> Y), leave line 2 untouched.
  const justSecond = applyChangeSet(before, edit, ["h1"]);
  assert.equal(justSecond, "1\n2\n3\n4\nY");
});

test("applyChangeSet: rejectAll yields the original unchanged", () => {
  const before = "1\n2\n3";
  const after = "1\nZ\n3";
  const edit = fileEditFromTexts(URI, before, after);
  assert.equal(applyChangeSet(before, edit, rejectAll(edit)), before);
});

test("applyChangeSet: accepting hunks in any order is deterministic (bottom-up splice)", () => {
  const before = "1\n2\n3\n4\n5";
  const after = "1\nX\n3\n4\nY";
  const edit = fileEditFromTexts(URI, before, after);
  const a = applyChangeSet(before, edit, ["h0", "h1"]);
  const b = applyChangeSet(before, edit, ["h1", "h0"]);
  assert.equal(a, b);
  assert.equal(a, after);
});

test("acceptHunk toggles a hunk in/out of the selection immutably", () => {
  const sel0: string[] = [];
  const sel1 = acceptHunk(sel0, "h0");
  assert.deepEqual(sel1, ["h0"]);
  const sel2 = acceptHunk(sel1, "h1");
  assert.deepEqual(sel2, ["h0", "h1"]);
  const sel3 = acceptHunk(sel2, "h0");
  assert.deepEqual(sel3, ["h1"]);
  // original untouched (immutability).
  assert.deepEqual(sel0, []);
});

test("new file: isNew inferred, acceptAll yields the proposed content from empty", () => {
  const edit = fileEditFromTexts("file:///ws/new.py", "", "line1\nline2");
  assert.equal(edit.isNew, true);
  assert.equal(applyChangeSet("", edit, acceptAll(edit)), "line1\nline2");
  // rejecting all leaves it empty (file not created).
  assert.equal(applyChangeSet("", edit, []), "");
});

test("delete file: isDelete inferred, accepting all collapses to empty", () => {
  const edit = fileEditFromTexts(URI, "old\ncontent", "");
  assert.equal(edit.isDelete, true);
  assert.equal(applyChangeSet("old\ncontent", edit, acceptAll(edit)), "");
});

test("summarizeChangeSet: multi-file counts + newFiles flagged for the run-gate", () => {
  const newFile = fileEditFromTexts("file:///ws/added.py", "", "x\ny\nz");
  const editFile = fileEditFromTexts("file:///ws/runner.py", "a\nb\nc", "a\nB\nc");
  const cs: ChangeSet = {
    id: "cs1",
    rationale: "add retry with backoff",
    edits: [newFile, editFile],
  };
  const sum = summarizeChangeSet(cs);
  assert.equal(sum.id, "cs1");
  assert.equal(sum.rationale, "add retry with backoff");
  assert.equal(sum.files.length, 2);
  // newFile: +3 / -0 ; editFile: +1 / -1
  assert.equal(sum.totalAdded, 4);
  assert.equal(sum.totalRemoved, 1);
  // AI-authored new file is flagged untrusted-until-gated (§5.2/§7.4).
  assert.deepEqual(sum.newFiles, ["file:///ws/added.py"]);
  const added = sum.files.find((f) => f.uri === "file:///ws/added.py")!;
  assert.equal(added.isNew, true);
  assert.equal(added.added, 3);
  assert.equal(added.removed, 0);
});

test("applyChangeSet handles a multi-line replacement (3 lines -> 2 lines)", () => {
  const before = "h\nfoo\nbar\nbaz\nt";
  const after = "h\nA\nB\nt";
  const edit = fileEditFromTexts(URI, before, after);
  assert.equal(applyChangeSet(before, edit, acceptAll(edit)), after);
});
