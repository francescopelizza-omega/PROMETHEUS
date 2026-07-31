/**
 * diff-review-state.test.ts — node:test for the PURE DiffReview selection state (§7.4).
 *
 * Pins the accept/reject discipline over the ChangeSet tree: default-accept-all, the
 * file/changeset tri-state, per-hunk toggling, and the "Apply selected" plan that
 * flags AI-authored NEW files for the run-gate (§5.2). Pure — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ReviewChangeSet,
  acceptAll,
  acceptFile,
  acceptedOf,
  applyReviewFile,
  buildApplyPlan,
  changeSetFromTexts,
  changeSetTriState,
  computeReviewHunks,
  emptySelection,
  fileTriState,
  initialSelection,
  rejectAll,
  rejectFile,
  reviewFileFromTexts,
  toggleHunk,
  verifyHunksAgainstBase,
} from "./diff-review-state.js";

function cs(): ReviewChangeSet {
  return {
    id: "cs1",
    rationale: "add retry with backoff",
    edits: [
      {
        uri: "file:///runner.py",
        hunks: [
          {
            id: "h0",
            originalStart: 0,
            originalLines: 0,
            newLines: ["for attempt in range(3):"],
            oldLines: [],
          },
          {
            id: "h1",
            originalStart: 1,
            originalLines: 1,
            newLines: ["    sleep(2 ** attempt)"],
            oldLines: ["    pass"],
          },
        ],
      },
      {
        uri: "file:///retry.py",
        isNew: true,
        hunks: [
          {
            id: "h0",
            originalStart: 0,
            originalLines: 0,
            newLines: ["def retry(): ..."],
            oldLines: [],
          },
        ],
      },
    ],
  };
}

test("initialSelection accepts EVERY hunk (review-then-trim default)", () => {
  const sel = initialSelection(cs());
  assert.deepEqual(sel["file:///runner.py"], ["h0", "h1"]);
  assert.deepEqual(sel["file:///retry.py"], ["h0"]);
});

test("emptySelection rejects every hunk", () => {
  const sel = emptySelection(cs());
  assert.deepEqual(sel["file:///runner.py"], []);
  assert.deepEqual(sel["file:///retry.py"], []);
});

test("toggleHunk removes then re-adds a hunk id", () => {
  const c = cs();
  let sel = initialSelection(c);
  sel = toggleHunk(sel, "file:///runner.py", "h1");
  assert.deepEqual(acceptedOf(sel, "file:///runner.py"), ["h0"]);
  sel = toggleHunk(sel, "file:///runner.py", "h1");
  assert.deepEqual(acceptedOf(sel, "file:///runner.py").sort(), ["h0", "h1"]);
});

test("fileTriState reflects all/partial/none", () => {
  const c = cs();
  const file = c.edits[0]!;
  assert.equal(fileTriState(file, initialSelection(c)), "all");
  assert.equal(fileTriState(file, emptySelection(c)), "none");
  const partial = toggleHunk(initialSelection(c), file.uri, "h1");
  assert.equal(fileTriState(file, partial), "partial");
});

test("changeSetTriState reflects the whole tree", () => {
  const c = cs();
  assert.equal(changeSetTriState(c, acceptAll(c)), "all");
  assert.equal(changeSetTriState(c, rejectAll(c)), "none");
  const partial = toggleHunk(acceptAll(c), "file:///runner.py", "h0");
  assert.equal(changeSetTriState(c, partial), "partial");
});

test("acceptFile / rejectFile set a whole file's selection", () => {
  const c = cs();
  let sel = emptySelection(c);
  sel = acceptFile(sel, c.edits[0]!);
  assert.deepEqual(acceptedOf(sel, "file:///runner.py").sort(), ["h0", "h1"]);
  sel = rejectFile(sel, c.edits[0]!);
  assert.deepEqual(acceptedOf(sel, "file:///runner.py"), []);
});

test("buildApplyPlan includes only files with ≥1 accepted hunk", () => {
  const c = cs();
  let sel = emptySelection(c);
  sel = toggleHunk(sel, "file:///runner.py", "h0"); // accept one hunk of runner only
  const plan = buildApplyPlan(c, sel);
  assert.equal(plan.empty, false);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0]?.uri, "file:///runner.py");
  assert.deepEqual(plan.files[0]?.acceptedHunkIds, ["h0"]);
  assert.equal(plan.files[0]?.acceptedCount, 1);
  assert.equal(plan.files[0]?.totalHunks, 2);
});

test("buildApplyPlan flags AI-authored NEW files for the run-gate (§5.2)", () => {
  const c = cs();
  const plan = buildApplyPlan(c, acceptAll(c));
  assert.deepEqual(plan.newFilesToGate, ["file:///retry.py"]);
});

test("buildApplyPlan is empty when nothing is accepted (Apply disabled)", () => {
  const c = cs();
  const plan = buildApplyPlan(c, rejectAll(c));
  assert.equal(plan.empty, true);
  assert.equal(plan.files.length, 0);
  assert.deepEqual(plan.newFilesToGate, []);
});

test("buildApplyPlan ignores accepted ids that aren't real hunks", () => {
  const c = cs();
  const sel = { "file:///runner.py": ["ghost"], "file:///retry.py": [] };
  const plan = buildApplyPlan(c, sel);
  assert.equal(plan.empty, true); // "ghost" isn't a real hunk → filtered out
});

test("applyReviewFile splices accepted hunks bottom-up (positions stay valid)", () => {
  // original: a / b / c ; hunk h0 inserts at line 0, h1 replaces line 1 ("b"→"B").
  const file = c0().edits[0]!;
  const out = applyReviewFile("a\nb\nc", file, ["h0", "h1"]);
  // h0 inserts "X" before line0; h1 replaces "b" with "B": X / a / B / c
  assert.equal(out, "X\na\nB\nc");
});

test("applyReviewFile applies ONLY the accepted hunk", () => {
  const file = c0().edits[0]!;
  // accept only the replacement (h1), not the insertion (h0).
  const out = applyReviewFile("a\nb\nc", file, ["h1"]);
  assert.equal(out, "a\nB\nc");
});

test("applyReviewFile on an isNew file builds from scratch", () => {
  const file = cs().edits[1]!; // retry.py isNew, one insert hunk
  const out = applyReviewFile("", file, ["h0"]);
  assert.equal(out, "def retry(): ...");
});

test("applyReviewFile collapses an all-accepted isDelete to empty", () => {
  const file: ReviewChangeSet["edits"][number] = {
    uri: "file:///gone.py",
    isDelete: true,
    hunks: [{ id: "h0", originalStart: 0, originalLines: 1, newLines: [], oldLines: ["x"] }],
  };
  assert.equal(applyReviewFile("x", file, ["h0"]), "");
});

/** A changeset with explicit positions to exercise the bottom-up splice. */
function c0(): ReviewChangeSet {
  return {
    id: "cs0",
    rationale: "edit",
    edits: [
      {
        uri: "file:///f.py",
        hunks: [
          { id: "h0", originalStart: 0, originalLines: 0, newLines: ["X"], oldLines: [] },
          { id: "h1", originalStart: 1, originalLines: 1, newLines: ["B"], oldLines: ["b"] },
        ],
      },
    ],
  };
}

/* ── the (uri, before, after) → ReviewFile converter (the propose_edit seam) ── */

test("computeReviewHunks groups replace / insert / delete runs into hunks", () => {
  const hunks = computeReviewHunks("a\nb\nc\nd", "a\nB\nc\nd\ne", "t");
  assert.deepEqual(hunks, [
    { id: "t-0", originalStart: 1, originalLines: 1, oldLines: ["b"], newLines: ["B"] },
    { id: "t-1", originalStart: 4, originalLines: 0, oldLines: [], newLines: ["e"] },
  ]);
  const del = computeReviewHunks("a\nb\nc", "a\nc");
  assert.deepEqual(del, [
    { id: "h-0", originalStart: 1, originalLines: 1, oldLines: ["b"], newLines: [] },
  ]);
});

test("computeReviewHunks: before === after yields ZERO hunks (no-op proposal)", () => {
  assert.deepEqual(computeReviewHunks("a\nb", "a\nb"), []);
  assert.deepEqual(computeReviewHunks("", ""), []);
});

test("reviewFileFromTexts infers isNew / isDelete from the empty side", () => {
  const fresh = reviewFileFromTexts("file:///new.py", "", "x\ny");
  assert.equal(fresh.isNew, true);
  assert.equal(fresh.isDelete, undefined);
  assert.deepEqual(fresh.hunks, [
    { id: "h-0", originalStart: 0, originalLines: 0, oldLines: [], newLines: ["x", "y"] },
  ]);
  const gone = reviewFileFromTexts("file:///gone.py", "x\ny", "");
  assert.equal(gone.isDelete, true);
  assert.equal(
    applyReviewFile(
      "x\ny",
      gone,
      gone.hunks.map((h) => h.id),
    ),
    "",
  );
});

test("converter accept-all roundtrips through applyReviewFile", () => {
  const before = "one\ntwo\nthree\nfour";
  const after = "one\n2\nthree\nfour\nfive";
  const file = reviewFileFromTexts("u", before, after);
  const out = applyReviewFile(
    before,
    file,
    file.hunks.map((h) => h.id),
  );
  assert.equal(out, after);
});

test("converter partial accept applies ONLY the accepted hunk", () => {
  const before = "one\ntwo\nthree";
  const after = "ONE\ntwo\nTHREE";
  const file = reviewFileFromTexts("u", before, after);
  assert.equal(file.hunks.length, 2);
  const out = applyReviewFile(before, file, [file.hunks[1]!.id]);
  assert.equal(out, "one\ntwo\nTHREE");
});

test("converter reject-all leaves the file BYTE-identical (CRLF, no trailing newline)", () => {
  const before = "alpha\r\nbeta\r\ngamma"; // CRLF + no trailing newline
  const after = "alpha\r\nBETA\r\ngamma";
  const file = reviewFileFromTexts("u", before, after);
  const out = applyReviewFile(before, file, []);
  assert.ok(Buffer.from(out).equals(Buffer.from(before)));
  // and with a trailing newline the final blank line survives too.
  const before2 = "a\nb\n";
  const file2 = reviewFileFromTexts("u", before2, "a\nB\n");
  assert.ok(Buffer.from(applyReviewFile(before2, file2, [])).equals(Buffer.from(before2)));
});

test("converter preserves a CRLF file's EOL style when the model answers LF", () => {
  const before = "alpha\r\nbeta\r\ngamma";
  // the model rewrote the file with plain LF endings — only line 2 really changed.
  const file = reviewFileFromTexts("u", before, "alpha\nBETA\ngamma");
  assert.equal(file.hunks.length, 1); // NOT every-line-changed noise
  const out = applyReviewFile(
    before,
    file,
    file.hunks.map((h) => h.id),
  );
  assert.equal(out, "alpha\r\nBETA\r\ngamma"); // untouched lines byte-original, new line CRLF
});

test("changeSetFromTexts builds the whole set and keeps zero-hunk files visible", () => {
  const set = changeSetFromTexts("cs9", "why", [
    { uri: "file:///a.py", before: "x", after: "y" },
    { uri: "file:///same.py", before: "x", after: "x" },
    { uri: "file:///new.py", before: "", after: "hi" },
  ]);
  assert.equal(set.id, "cs9");
  assert.equal(set.rationale, "why");
  assert.equal(set.edits.length, 3);
  assert.equal(set.edits[1]?.hunks.length, 0); // no-op file stays (pane shows "no changes")
  assert.equal(set.edits[2]?.isNew, true);
  assert.deepEqual(buildApplyPlan(set, initialSelection(set)).newFilesToGate, ["file:///new.py"]);
});

test("converter EOL detection is a MAJORITY vote (one stray CRLF ≠ a CRLF file)", () => {
  const before = "a\r\nb\nc\nd\ne"; // 1 CRLF vs 3 LF → an LF file
  const file = reviewFileFromTexts("u", before, "a\nb\nc\nd\nE");
  // only the real change (e→E) plus the normalized stray line may hunk — NOT every line.
  assert.ok(file.hunks.length <= 2);
  assert.ok(Buffer.from(applyReviewFile(before, file, [])).equals(Buffer.from(before)));
});

test("verifyHunksAgainstBase passes on the original base, fails closed on drift", () => {
  const before = "one\ntwo\nthree";
  const file = reviewFileFromTexts("u", before, "one\nTWO\nthree");
  assert.equal(
    verifyHunksAgainstBase(
      before,
      file,
      file.hunks.map((h) => h.id),
    ),
    null,
  );
  // the file changed on disk since the proposal (e.g. the hunk was already applied).
  const drift = verifyHunksAgainstBase(
    "one\nTWO\nthree",
    file,
    file.hunks.map((h) => h.id),
  );
  assert.match(drift ?? "", /changed on disk/);
  // a shrunken file (anchor past EOF) also fails closed.
  const eof = verifyHunksAgainstBase(
    "one",
    file,
    file.hunks.map((h) => h.id),
  );
  assert.match(eof ?? "", /end of the file|changed on disk/);
  // unaccepted hunks are not verified; isNew files have no base.
  assert.equal(verifyHunksAgainstBase("anything", file, []), null);
  const fresh = reviewFileFromTexts("u", "", "hi");
  assert.equal(
    verifyHunksAgainstBase(
      "",
      fresh,
      fresh.hunks.map((h) => h.id),
    ),
    null,
  );
});

test("changeSetFromTexts collapses duplicate uris LAST-WINS", () => {
  const set = changeSetFromTexts("cs", "why", [
    { uri: "file:///a.py", before: "x", after: "y" },
    { uri: "file:///a.py", before: "x", after: "z" },
  ]);
  assert.equal(set.edits.length, 1);
  const file = set.edits[0]!;
  assert.equal(
    applyReviewFile(
      "x",
      file,
      file.hunks.map((h) => h.id),
    ),
    "z",
  );
});
