import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEditView } from "./diff-view.js";

test("buildEditView: a single-line modification → line numbers, context, word spans", () => {
  const oldF = "def fib(n):\n    for i in range(n):\n        pass\n";
  const newF = oldF.replace("for i in range(n):", "for _ in range(max(0, n)):");
  const v = buildEditView(oldF, newF, { context: 1 });
  assert.equal(v.added, 1);
  assert.equal(v.removed, 1);
  assert.equal(v.hunks.length, 1);
  const rows = v.hunks[0]!.rows;
  const del = rows.find((r) => r.kind === "del")!;
  const add = rows.find((r) => r.kind === "add")!;
  assert.equal(del.oldNo, 2);
  assert.equal(del.newNo, null);
  assert.equal(add.oldNo, null);
  assert.equal(add.newNo, 2);
  // word-level: `i` changed on the del side, `_` changed on the add side; `for ` unchanged.
  assert.ok(del.spans!.some((s) => s.changed && s.text === "i"));
  assert.ok(add.spans!.some((s) => s.changed && s.text === "_"));
  assert.ok(del.spans!.some((s) => !s.changed && s.text.includes("for")));
});

test("buildEditView: pure insertion (no del) and pure deletion (no add)", () => {
  const ins = buildEditView("a\nb\n", "a\nNEW\nb\n", { context: 0 });
  assert.equal(ins.added, 1);
  assert.equal(ins.removed, 0);
  assert.equal(ins.hunks[0]!.rows.find((r) => r.kind === "add")!.newNo, 2);

  const del = buildEditView("a\ngone\nb\n", "a\nb\n", { context: 0 });
  assert.equal(del.added, 0);
  assert.equal(del.removed, 1);
  assert.equal(del.hunks[0]!.rows.find((r) => r.kind === "del")!.oldNo, 2);
});

test("buildEditView: two distant edits → two hunks; identical text → none", () => {
  const oldF = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
  const newF = oldF.replace("line2", "LINE2").replace("line17", "LINE17");
  const v = buildEditView(oldF, newF, { context: 2 });
  assert.equal(v.hunks.length, 2);
  assert.equal(buildEditView(oldF, oldF).hunks.length, 0);
});

test("buildEditView: line numbers are 1-based and correct across a hunk", () => {
  const oldF = "a\nb\nc\nd\ne\n";
  const newF = "a\nb\nX\nd\ne\n";
  const v = buildEditView(oldF, newF, { context: 1 });
  const rows = v.hunks[0]!.rows;
  assert.deepEqual(
    rows.map((r) => [r.kind, r.oldNo, r.newNo]),
    [
      ["context", 2, 2],
      ["del", 3, null],
      ["add", null, 3],
      ["context", 4, 4],
    ],
  );
});
