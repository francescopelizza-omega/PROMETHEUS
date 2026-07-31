/**
 * text-edit-apply.test.ts — node:test for the PURE LSP TextEdit/WorkspaceEdit applier.
 *
 * Pins offset math (multi-line), right-to-left application of multiple edits, insert +
 * delete, clamping, and both WorkspaceEdit forms ({changes} | {documentChanges}).
 * Plus the APP-027 Refactor Preview view-model: buildPreview snippets (clamped to file
 * bounds, stale ranges, missing text), zero-edit-file filtering, and the include-set
 * (toggle / selectedEdits keeps ORIGINAL edit arrays by reference). Pure.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type WorkspaceFileEdit,
  allPreviewUris,
  applyTextEdits,
  buildPreview,
  normalizeWorkspaceEdit,
  selectedEdits,
  togglePreviewUri,
} from "./text-edit-apply.js";

const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

test("single replace on one line", () => {
  const text = "const b = 2;";
  const out = applyTextEdits(text, [{ range: r(0, 10, 0, 11), newText: "3" }]);
  assert.equal(out, "const b = 3;");
});

test("multiple edits apply right-to-left (offsets stay valid)", () => {
  const text = "aaa bbb ccc";
  const out = applyTextEdits(text, [
    { range: r(0, 0, 0, 3), newText: "X" }, // aaa → X
    { range: r(0, 8, 0, 11), newText: "Z" }, // ccc → Z
  ]);
  assert.equal(out, "X bbb Z");
});

test("multi-line replace across lines", () => {
  const text = "line1\nline2\nline3";
  // replace from line2 col0 to line3 col0 → drops line2
  const out = applyTextEdits(text, [{ range: r(1, 0, 2, 0), newText: "" }]);
  assert.equal(out, "line1\nline3");
});

test("pure insertion (zero-width range)", () => {
  const text = "ab";
  const out = applyTextEdits(text, [{ range: r(0, 1, 0, 1), newText: "X" }]);
  assert.equal(out, "aXb");
});

test("out-of-range positions clamp, never throw", () => {
  const text = "hi";
  const out = applyTextEdits(text, [{ range: r(0, 0, 99, 99), newText: "BYE" }]);
  assert.equal(out, "BYE");
  assert.equal(applyTextEdits(text, []), "hi");
});

test("normalizeWorkspaceEdit reads the `changes` map", () => {
  const ws = {
    changes: {
      "file:///a.ts": [{ range: r(0, 0, 0, 1), newText: "X" }],
      "file:///b.ts": [{ range: r(0, 0, 0, 0), newText: "Y" }],
    },
  };
  const out = normalizeWorkspaceEdit(ws);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.uri).sort(), ["file:///a.ts", "file:///b.ts"]);
});

test("normalizeWorkspaceEdit reads `documentChanges` + ignores resource ops", () => {
  const ws = {
    documentChanges: [
      {
        textDocument: { uri: "file:///a.ts", version: 1 },
        edits: [{ range: r(0, 0, 0, 1), newText: "X" }],
      },
      { kind: "rename", oldUri: "file:///a.ts", newUri: "file:///c.ts" }, // resource op → dropped
    ],
  };
  const out = normalizeWorkspaceEdit(ws);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.uri, "file:///a.ts");
});

test("garbage WorkspaceEdit → empty", () => {
  assert.deepEqual(normalizeWorkspaceEdit(null), []);
  assert.deepEqual(normalizeWorkspaceEdit({}), []);
  assert.deepEqual(normalizeWorkspaceEdit({ changes: "nope" }), []);
});

/* ── Refactor Preview view-model (APP-027) ──────────────────────────────────── */

const fe = (uri: string, edits: WorkspaceFileEdit["edits"]): WorkspaceFileEdit => ({ uri, edits });

test("buildPreview: multi-file nodes with counts, display path, 1-based ranges", () => {
  const files = [
    fe("file:///src/a%20b.py", [
      { range: r(0, 4, 0, 7), newText: "new_name" },
      { range: r(2, 0, 2, 3), newText: "new_name" },
    ]),
    fe("file:///src/c.py", [{ range: r(1, 0, 1, 3), newText: "x" }]),
  ];
  const texts = {
    "file:///src/a%20b.py": "def old():\n    pass\nold()\n",
    "file:///src/c.py": "import a\nold\n",
  };
  const p = buildPreview(files, texts);
  assert.equal(p.files.length, 2);
  const a = p.files[0];
  assert.equal(a?.path, "/src/a b.py"); // %-decoded, scheme stripped
  assert.equal(a?.editCount, 2);
  assert.deepEqual(
    a?.edits.map((e) => [e.startLine, e.startCol, e.endLine, e.endCol]),
    [
      [1, 5, 1, 8],
      [3, 1, 3, 4],
    ],
  );
  assert.equal(a?.edits[0]?.oldText, "old");
  // snippet = edited line + one context line each side (clamped at file start).
  assert.deepEqual(a?.edits[0]?.before, ["def old():", "    pass"]);
  assert.deepEqual(a?.edits[0]?.after, ["def new_name():", "    pass"]);
  assert.deepEqual(a?.edits[1]?.before, ["    pass", "old()", ""]);
  assert.deepEqual(a?.edits[1]?.after, ["    pass", "new_name()", ""]);
});

test("buildPreview: zero-edit file entries are dropped from the tree", () => {
  const p = buildPreview(
    [fe("file:///a.py", []), fe("file:///b.py", [{ range: r(0, 0, 0, 1), newText: "x" }])],
    {},
  );
  assert.deepEqual(
    p.files.map((f) => f.uri),
    ["file:///b.py"],
  );
});

test("buildPreview: stale range past EOF clamps to real lines (never slices undefined)", () => {
  const files = [fe("file:///a.py", [{ range: r(50, 0, 60, 5), newText: "tail" }])];
  const p = buildPreview(files, { "file:///a.py": "one\ntwo" });
  const row = p.files[0]?.edits[0];
  assert.equal(row?.startLine, 51); // display keeps the raw (stale) range
  assert.equal(row?.oldText, ""); // clamped extraction, no throw
  assert.deepEqual(row?.before, ["one", "two"]);
  assert.deepEqual(row?.after, ["one", "twotail"]);
});

test("buildPreview: missing file text degrades to newText-only rows", () => {
  const p = buildPreview([fe("file:///a.py", [{ range: r(0, 0, 0, 3), newText: "a\nb" }])]);
  const row = p.files[0]?.edits[0];
  assert.equal(row?.oldText, undefined);
  assert.deepEqual(row?.before, []);
  assert.deepEqual(row?.after, ["a", "b"]);
});

test("buildPreview: CRLF file — display lines strip \\r, splice keeps columns", () => {
  const files = [fe("file:///a.py", [{ range: r(1, 0, 1, 3), newText: "new" }])];
  const p = buildPreview(files, { "file:///a.py": "one\r\nold()\r\nthree\r\n" });
  const row = p.files[0]?.edits[0];
  assert.deepEqual(row?.before, ["one", "old()", "three"]);
  assert.deepEqual(row?.after, ["one", "new()", "three"]);
});

test("include-set: default all-on, toggle returns a NEW set", () => {
  const p = buildPreview(
    [
      fe("file:///a.py", [{ range: r(0, 0, 0, 1), newText: "x" }]),
      fe("file:///b.py", [{ range: r(0, 0, 0, 1), newText: "y" }]),
    ],
    {},
  );
  const all = allPreviewUris(p);
  assert.deepEqual([...all].sort(), ["file:///a.py", "file:///b.py"]);
  const off = togglePreviewUri(all, "file:///b.py");
  assert.notEqual(off, all);
  assert.equal(all.has("file:///b.py"), true); // original untouched
  assert.equal(off.has("file:///b.py"), false);
  const backOn = togglePreviewUri(off, "file:///b.py");
  assert.equal(backOn.has("file:///b.py"), true);
});

test("selectedEdits: excluded file dropped WHOLE; included keeps the ORIGINAL array reference + order", () => {
  // deliberately unsorted edits — the preview must hand the ORIGINAL (unsorted)
  // array to the applier, never a display reordering.
  const aEdits = [
    { range: r(5, 0, 5, 3), newText: "z" },
    { range: r(0, 0, 0, 3), newText: "a" },
  ];
  const files = [
    fe("file:///a.py", aEdits),
    fe("file:///b.py", [{ range: r(0, 0, 0, 1), newText: "y" }]),
  ];
  const p = buildPreview(files, {});
  const sel = selectedEdits(p, new Set(["file:///a.py"]));
  assert.equal(sel.length, 1);
  assert.equal(sel[0]?.uri, "file:///a.py");
  assert.equal(sel[0]?.edits, aEdits); // same reference — original order preserved
  assert.deepEqual(selectedEdits(p, new Set()), []);
});

test("selectedEdits output applies through applyTextEdits regardless of edit order (applier sorts)", () => {
  const text = "aaa\nbbb\nccc";
  const files = [
    fe("file:///a.py", [
      { range: r(2, 0, 2, 3), newText: "C" }, // out of order on purpose
      { range: r(0, 0, 0, 3), newText: "A" },
    ]),
  ];
  const sel = selectedEdits(
    buildPreview(files, { "file:///a.py": text }),
    new Set(["file:///a.py"]),
  );
  assert.equal(applyTextEdits(text, sel[0]?.edits ?? []), "A\nbbb\nC");
});
