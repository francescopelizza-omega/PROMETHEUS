/**
 * session/revert.e2e.test.ts — undoing a CREATE means the file is gone, not empty.
 *
 * The checkpoint recorded a pre-image per touched path, and a file the agent CREATED has no
 * previous content, so it was recorded as `""`. That is byte-identical to "a file that existed
 * and was empty", and `/revert` could not tell the two apart — so undoing "create hello.py"
 * wrote an empty `hello.py` instead of removing it. The user was left with a tree of zero-byte
 * files their build then had to explain, and the transcript said the revert succeeded.
 *
 * `move_file` was worse: it captured NOTHING, so `/revert` silently did nothing for it. The
 * source stayed gone, the destination stayed put, and an `overwrite:true` move had destroyed
 * the destination's contents with no record of them anywhere.
 *
 * Everything below runs the real tools against a real temp directory. The assertion is always
 * the state of the disk afterwards, never "the revert function was called".
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agent } from "@prometheus/core";
import type { ToolDef } from "@prometheus/core/agent-tools";
import { type EditRecord, makeToolRunner, restoreCheckpoint, revertEdit } from "./agent-runtime.js";

/** A temp workspace with one pre-existing file. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "prom-revert-"));
  writeFileSync(join(dir, "existing.txt"), "original contents\n", "utf8");
  return dir;
}

/** The real runner, with a live checkpoint + edit history, pointed at `dir`. */
function runner(dir: string) {
  const editHistory: EditRecord[] = [];
  const store = new agent.CheckpointStore();
  const run = makeToolRunner({} as never, {
    cwd: dir,
    roots: [dir],
    editHistory,
    checkpoint: {
      store,
      turnId: "turn-1",
      sessionId: "s1",
      turnNumber: 1,
      now: () => "2026-01-01T00:00:00.000Z",
    },
  });
  return { run, editHistory, store, tool };
}

/** The real ToolDef for a mutator, by name — the same object a session would dispatch. */
function tool(name: string): ToolDef {
  const found = [agent.WRITE_FILE_TOOL, ...agent.SYSTEM_FS_WRITE_TOOLS].find(
    (t) => t.name === name,
  );
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

test("write_file that CREATES a file records absence — revert deletes it, not blanks it", async () => {
  const dir = workspace();
  try {
    const { run, editHistory } = runner(dir);
    const made = join(dir, "made.py");
    const out = await run(tool("write_file"), { path: "made.py", content: "print('hi')\n" });
    assert.equal(out.ok, true, out.summary);
    assert.equal(readFileSync(made, "utf8"), "print('hi')\n");

    // the record knows the file was NEW — the fact the old design could not carry
    const rec = editHistory.find((r) => r.path === made);
    assert.ok(rec, "no edit record was captured for the create");
    assert.equal(rec.existed, false);

    assert.equal(revertEdit(rec), true);
    assert.equal(
      existsSync(made),
      false,
      "revert left the created file behind (empty) instead of deleting it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write_file that OVERWRITES restores the old bytes and does not delete the file", async () => {
  const dir = workspace();
  try {
    const { run, editHistory } = runner(dir);
    const target = join(dir, "existing.txt");
    const out = await run(tool("write_file"), { path: "existing.txt", content: "clobbered\n" });
    assert.equal(out.ok, true, out.summary);
    assert.equal(readFileSync(target, "utf8"), "clobbered\n");

    const rec = editHistory.find((r) => r.path === target);
    assert.ok(rec);
    assert.equal(rec.existed, true);
    assert.equal(revertEdit(rec), true);
    assert.equal(
      readFileSync(target, "utf8"),
      "original contents\n",
      "an overwrite must revert to the old bytes, never to deletion",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreCheckpoint deletes what the turn created and rewrites what it changed", async () => {
  const dir = workspace();
  try {
    const { run, store } = runner(dir);
    const made = join(dir, "new-file.txt");
    const existing = join(dir, "existing.txt");

    await run(tool("write_file"), { path: "new-file.txt", content: "brand new\n" });
    await run(tool("write_file"), { path: "existing.txt", content: "modified\n" });
    assert.equal(readFileSync(made, "utf8"), "brand new\n");
    assert.equal(readFileSync(existing, "utf8"), "modified\n");

    const cp = store.get("turn-1");
    assert.ok(cp, "no checkpoint was recorded for the turn");
    assert.deepEqual(cp.absent, [made], "the created path was not recorded as absent");

    const res = restoreCheckpoint(cp, { roots: [dir] });
    assert.equal(existsSync(made), false, "/revert left the created file on disk");
    assert.deepEqual(res.deleted, [made]);
    assert.equal(readFileSync(existing, "utf8"), "original contents\n");
    assert.deepEqual(res.restored, [existing]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file CREATED then EDITED in one turn still reverts to nothing", async () => {
  // First-touch wins, and the first touch was a create. Reverting to the intermediate content
  // would leave a file that never existed before the turn.
  const dir = workspace();
  try {
    const { run, store } = runner(dir);
    const made = join(dir, "twice.txt");
    await run(tool("write_file"), { path: "twice.txt", content: "first\n" });
    await run(tool("write_file"), { path: "twice.txt", content: "second\n" });
    assert.equal(readFileSync(made, "utf8"), "second\n");

    const cp = store.get("turn-1");
    assert.ok(cp);
    restoreCheckpoint(cp, { roots: [dir] });
    assert.equal(existsSync(made), false, "the file survived a revert of the turn that made it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete_file is reverted by writing the file back", async () => {
  const dir = workspace();
  try {
    const { run, store } = runner(dir);
    const existing = join(dir, "existing.txt");
    const out = await run(tool("delete_file"), { path: "existing.txt" });
    assert.equal(out.ok, true, out.summary);
    assert.equal(existsSync(existing), false);

    const cp = store.get("turn-1");
    assert.ok(cp);
    restoreCheckpoint(cp, { roots: [dir] });
    assert.equal(readFileSync(existing, "utf8"), "original contents\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("move_file is revertible at BOTH ends — it used to capture nothing at all", async () => {
  const dir = workspace();
  try {
    const { run, store } = runner(dir);
    const from = join(dir, "existing.txt");
    const to = join(dir, "moved.txt");
    const out = await run(tool("move_file"), { from: "existing.txt", to: "moved.txt" });
    assert.equal(out.ok, true, out.summary);
    assert.equal(existsSync(from), false);
    assert.equal(readFileSync(to, "utf8"), "original contents\n");

    const cp = store.get("turn-1");
    assert.ok(cp, "move_file recorded no checkpoint — it is not revertible");
    restoreCheckpoint(cp, { roots: [dir] });
    assert.equal(readFileSync(from, "utf8"), "original contents\n", "the source was not restored");
    assert.equal(existsSync(to), false, "the destination the move created was not removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a CLOBBERING move restores the destination's destroyed contents", async () => {
  const dir = workspace();
  try {
    writeFileSync(join(dir, "victim.txt"), "the destination's own contents\n", "utf8");
    const { run, store } = runner(dir);
    const out = await run(tool("move_file"), {
      from: "existing.txt",
      to: "victim.txt",
      overwrite: true,
    });
    assert.equal(out.ok, true, out.summary);
    assert.equal(readFileSync(join(dir, "victim.txt"), "utf8"), "original contents\n");

    const cp = store.get("turn-1");
    assert.ok(cp);
    restoreCheckpoint(cp, { roots: [dir] });
    assert.equal(
      readFileSync(join(dir, "victim.txt"), "utf8"),
      "the destination's own contents\n",
      "the bytes the overwrite destroyed were never captured",
    );
    assert.equal(readFileSync(join(dir, "existing.txt"), "utf8"), "original contents\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reverting a create twice is not an error — already-gone is the requested state", () => {
  const dir = workspace();
  try {
    const rec: EditRecord = { path: join(dir, "nope.txt"), preImage: "", existed: false };
    assert.equal(revertEdit(rec), true);
    assert.equal(revertEdit(rec), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record with no `existed` field still writes — an old record keeps its old meaning", () => {
  const dir = workspace();
  try {
    const target = join(dir, "existing.txt");
    writeFileSync(target, "changed\n", "utf8");
    const legacy: EditRecord = { path: target, preImage: "original contents\n" };
    assert.equal(revertEdit(legacy), true);
    assert.equal(readFileSync(target, "utf8"), "original contents\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
