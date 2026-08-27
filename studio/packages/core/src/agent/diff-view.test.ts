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

test("a minified one-line file does not build a quadratic word table", () => {
  /**
   * `SIZE_GUARD` bounds the LINE-level table only. `wordSpans` then builds a second O(n·m) table
   * over the TOKENS of a single line, and `tokenize` emits one token per punctuation character —
   * so a minified or generated one-liner is tens of thousands of tokens and the table is
   * quadratic in that. A V8 heap OOM is a fatal abort rather than a catchable error, so the
   * process died mid-confirm, while the user was being asked to approve the very edit that
   * produced the line. The module header asserted both passes were bounded; only one was.
   *
   * Two 60k-token lines would need ~3.6 billion array slots. This completing at all is the
   * assertion; the timing check keeps it honest if the guard is ever removed.
   */
  const minified = `${"a=1;b=2;c=3;".repeat(5000)}\n`;
  const changed = `${"a=1;b=2;c=4;".repeat(5000)}\n`;

  const started = Date.now();
  const view = buildEditView(minified, changed);
  const elapsed = Date.now() - started;

  assert.ok(view.hunks.length > 0, "the edit still produces a reviewable hunk");
  assert.ok(elapsed < 5000, `word-level diff took ${elapsed}ms — the table is unbounded again`);

  // over the budget the whole line reads as changed, which is what a minified line means
  const del = view.hunks.flatMap((h) => h.rows).find((r) => r.kind === "del");
  assert.ok(del, "a deletion row is present");
  if (del?.spans) {
    assert.ok(
      del.spans.every((w) => w.changed),
      "a line past the token budget must be marked wholly changed, not partly matched",
    );
  }

  // and an ordinary short line still gets real word-level spans
  const small = buildEditView("const a = 1;\n", "const a = 2;\n");
  const smallDel = small.hunks.flatMap((h) => h.rows).find((r) => r.kind === "del");
  assert.ok(
    smallDel?.spans?.some((w) => !w.changed),
    "normal lines must still diff at word level — the guard must not fire for them",
  );
});
