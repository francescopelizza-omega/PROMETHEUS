import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type PendingCall,
  type PreviewIo,
  previewMutation,
  previewPaths,
  renderMutationPreview,
} from "./mutation-preview.js";

const abs = (p: string): string => (p.startsWith("/") ? p : `/repo/${p}`);

/** A fake filesystem: paths that exist map to text; a path in `dirs` is a directory. */
function io(files: Record<string, string>, dirs: Record<string, string[]> = {}): PreviewIo {
  return {
    readFile: (p) => (p in files ? files[p]! : null),
    listDir: (p) => (p in dirs ? dirs[p]! : null),
    exists: (p) => p in files || p in dirs,
  };
}

const call = (name: string, args: Record<string, unknown>): PendingCall => ({ name, args });

test("previewMutation returns null for tools with their own card or nothing to show", () => {
  const fs = io({});
  assert.equal(previewMutation(call("run_command", { command: "ls" }), abs, fs), null);
  assert.equal(previewMutation(call("propose_edit", { path: "a.ts" }), abs, fs), null);
  assert.equal(previewMutation(call("write_file", { path: "a.ts" }), abs, fs), null);
  assert.equal(previewMutation(call("read_file", { path: "a.ts" }), abs, fs), null);
});

// ── delete_file ──────────────────────────────────────────────────────────────── //

test("delete_file: the preview carries the CONTENT that will be lost, as a diff to nothing", () => {
  const fs = io({ "/repo/notes.md": "alpha\nbeta\ngamma\n" });
  const p = previewMutation(call("delete_file", { path: "notes.md" }), abs, fs);
  assert.ok(p);
  assert.equal(p.willFail, false);
  assert.equal(p.changes.length, 1);
  const ch = p.changes[0]!;
  assert.equal(ch.kind, "edit");
  if (ch.kind !== "edit") throw new Error("unreachable");
  assert.equal(ch.path, "/repo/notes.md");
  assert.equal(ch.oldText, "alpha\nbeta\ngamma\n");
  assert.equal(ch.newText, ""); // a delete IS a diff to the empty string
  // the headline states the size, because "delete notes.md" does not tell you what you lose.
  assert.match(p.headline, /3 lines/);
  assert.match(p.headline, /17 bytes/);
});

test("delete_file: deleting a path that does not exist is reported as a call that WILL FAIL", () => {
  const p = previewMutation(call("delete_file", { path: "gone.txt" }), abs, io({}));
  assert.ok(p);
  assert.equal(p.willFail, true);
  assert.equal(p.changes[0]?.kind, "blocked");
});

test("delete_file recursive: lists the tree, bounded, and never hides the true total", () => {
  const many = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
  const fs = io({}, { "/repo/build": many });
  const p = previewMutation(call("delete_file", { path: "build", recursive: true }), abs, fs);
  assert.ok(p);
  const ch = p.changes[0]!;
  assert.equal(ch.kind, "delete-dir");
  if (ch.kind !== "delete-dir") throw new Error("unreachable");
  assert.equal(ch.total, 100);
  assert.equal(ch.truncated, true);
  assert.ok(ch.entries.length < 100);
  // the undo warning belongs where the decision is made.
  assert.match(p.headline, /CANNOT BE UNDONE/);
  assert.match(p.headline, /100 entries/);
  // and the rendered form says how many it did not print.
  const lines = renderMutationPreview(p, { maxLines: 200 }).join("\n");
  assert.match(lines, /and 60 more/);
});

test("delete_file recursive on a FILE previews the file, not a phantom tree", () => {
  const fs = io({ "/repo/a.txt": "x\n" });
  const p = previewMutation(call("delete_file", { path: "a.txt", recursive: true }), abs, fs);
  assert.ok(p);
  assert.equal(p.changes[0]?.kind, "edit");
});

// ── move_file ────────────────────────────────────────────────────────────────── //

test("move_file: a plain rename names both ends and clobbers nothing", () => {
  const fs = io({ "/repo/a.ts": "x\n" });
  const p = previewMutation(call("move_file", { from: "a.ts", to: "b.ts" }), abs, fs);
  assert.ok(p);
  assert.equal(p.willFail, false);
  const ch = p.changes[0]!;
  assert.equal(ch.kind, "move");
  if (ch.kind !== "move") throw new Error("unreachable");
  assert.equal(ch.clobbers, false);
  assert.equal(ch.lostText, null);
  assert.deepEqual(previewPaths(p), ["/repo/a.ts", "/repo/b.ts"]);
});

test("move_file with overwrite carries the DESTINATION's content — what the move destroys", () => {
  const fs = io({ "/repo/a.ts": "new\n", "/repo/b.ts": "old one\nold two\n" });
  const p = previewMutation(
    call("move_file", { from: "a.ts", to: "b.ts", overwrite: true }),
    abs,
    fs,
  );
  assert.ok(p);
  const ch = p.changes[0]!;
  if (ch.kind !== "move") throw new Error("unreachable");
  assert.equal(ch.clobbers, true);
  assert.equal(ch.lostText, "old one\nold two\n");
  assert.match(p.headline, /REPLACING 2 lines/);
  const text = renderMutationPreview(p).join("\n");
  assert.match(text, /− old one/);
  assert.match(text, /− old two/);
});

test("move_file onto an existing destination WITHOUT overwrite is reported as doomed", () => {
  const fs = io({ "/repo/a.ts": "x\n", "/repo/b.ts": "y\n" });
  const p = previewMutation(call("move_file", { from: "a.ts", to: "b.ts" }), abs, fs);
  assert.ok(p);
  assert.equal(p.willFail, true);
  assert.match(p.changes[0]?.kind === "blocked" ? p.changes[0].message : "", /overwrite/);
});

test("move_file from a missing source is doomed, and says so before approval", () => {
  const p = previewMutation(call("move_file", { from: "nope.ts", to: "b.ts" }), abs, io({}));
  assert.ok(p);
  assert.equal(p.willFail, true);
});

// ── apply_patch ──────────────────────────────────────────────────────────────── //

test("apply_patch: every file gets a real old→new pair a diff renderer can paint", () => {
  const fs = io({
    "/repo/one.ts": "const a = 1;\nconst b = 2;\n",
    "/repo/two.ts": "export const x = 0;\n",
  });
  const p = previewMutation(
    call("apply_patch", {
      edits: [
        { path: "one.ts", hunks: [{ old: "const a = 1;", new: "const a = 42;" }] },
        { path: "two.ts", hunks: [{ old: "export const x = 0;", new: "export const x = 9;" }] },
      ],
    }),
    abs,
    fs,
  );
  assert.ok(p);
  assert.equal(p.willFail, false);
  assert.equal(p.changes.length, 2);
  const first = p.changes[0]!;
  if (first.kind !== "edit") throw new Error("unreachable");
  assert.equal(first.oldText, "const a = 1;\nconst b = 2;\n");
  assert.match(first.newText, /const a = 42;/);
  assert.match(p.headline, /2 hunks across 2 files/);
  assert.deepEqual(previewPaths(p), ["/repo/one.ts", "/repo/two.ts"]);
});

test("apply_patch: a hunk that no longer matches is shown as REJECTED, not as a diff", () => {
  const fs = io({ "/repo/one.ts": "const a = 1;\n" });
  const p = previewMutation(
    call("apply_patch", {
      edits: [{ path: "one.ts", hunks: [{ old: "const zzz = 1;", new: "x" }] }],
    }),
    abs,
    fs,
  );
  assert.ok(p);
  assert.equal(p.willFail, true);
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0]?.kind, "blocked");
  assert.match(p.headline, /WILL BE REJECTED/);
  // the whole patch is atomic — the human must learn nothing will be written.
  assert.match(
    p.changes[0]?.kind === "blocked" ? p.changes[0].message : "",
    /nothing will be written/,
  );
});

test("apply_patch: a missing file is named, and the patch is doomed", () => {
  const p = previewMutation(
    call("apply_patch", { edits: [{ path: "nope.ts", hunks: [{ old: "a", new: "b" }] }] }),
    abs,
    io({}),
  );
  assert.ok(p);
  assert.equal(p.willFail, true);
  assert.match(p.changes[0]?.kind === "blocked" ? p.changes[0].message : "", /no such file/);
});

test("apply_patch: an empty edits array is doomed rather than silently previewing nothing", () => {
  const p = previewMutation(call("apply_patch", { edits: [] }), abs, io({}));
  assert.ok(p);
  assert.equal(p.willFail, true);
});

test("apply_patch tolerates the JSON-string `edits` models keep sending", () => {
  const fs = io({ "/repo/one.ts": "a\n" });
  const p = previewMutation(
    call("apply_patch", {
      edits: JSON.stringify([{ path: "one.ts", hunks: [{ old: "a", new: "b" }] }]),
    }),
    abs,
    fs,
  );
  assert.ok(p);
  assert.equal(p.willFail, false);
  assert.equal(p.changes.length, 1);
});

// ── rendering ────────────────────────────────────────────────────────────────── //

test("renderMutationPreview is bounded — a huge delete cannot flood the terminal", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const fs = io({ "/repo/big.txt": big });
  const p = previewMutation(call("delete_file", { path: "big.txt" }), abs, fs);
  assert.ok(p);
  const lines = renderMutationPreview(p, { maxLines: 30 });
  assert.ok(lines.length < 40, `expected a bounded render, got ${lines.length} lines`);
  assert.ok(lines.join("\n").includes("more lines removed"));
});
