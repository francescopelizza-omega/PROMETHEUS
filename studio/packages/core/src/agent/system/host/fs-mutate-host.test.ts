/**
 * fs-mutate-host.test.ts — the Tier-W mutators, now shared by both hosts.
 *
 * These were declared in core and implemented only in the CLI, so `runSystemTool` answered "not
 * a system tool" and the desktop agent could read, edit and write a file but never remove or
 * rename one.
 *
 * Several tests below exist specifically because main ALREADY had `ide:fs.mkdir`/`rename`/
 * `delete`, and reusing them would have been one line each — but its delete is always recursive,
 * its mkdir is not, and its rename clobbers. Each of those is pinned here as the CONTRACT, so a
 * future "just call the existing handler" shortcut fails loudly instead of silently changing
 * what three tools mean.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type FsPreImage, runFsMutateTool } from "./fs-mutate-host.js";

function ws(): string {
  return mkdtempSync(join(tmpdir(), "prom-fsw-"));
}

/* ── delete_file ───────────────────────────────────────────────────────────*/

test("a file delete captures its pre-image so a host can undo it", () => {
  const dir = ws();
  writeFileSync(join(dir, "a.txt"), "contents");
  const captured: FsPreImage[] = [];
  const out = runFsMutateTool(
    "delete_file",
    { path: "a.txt" },
    { cwd: dir, onPreImage: (r) => captured.push(r) },
  );
  assert.equal(out?.ok, true);
  assert.equal(existsSync(join(dir, "a.txt")), false);
  assert.equal(captured[0]?.preImage, "contents");
});

test("a DIRECTORY is refused unless recursive was asked for", () => {
  // The whole point of the flag: a tree delete cannot be reverted, so it must be deliberate.
  const dir = ws();
  mkdirSync(join(dir, "sub"));
  const out = runFsMutateTool("delete_file", { path: "sub" }, { cwd: dir });
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /pass recursive:true/);
  assert.equal(existsSync(join(dir, "sub")), true, "the directory was removed anyway");
});

test("a recursive delete SAYS it cannot be reverted, and captures nothing", () => {
  // Pretending a tree could be snapshotted into one pre-image would make /revert lie.
  const dir = ws();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "x.txt"), "x");
  const captured: FsPreImage[] = [];
  const out = runFsMutateTool(
    "delete_file",
    { path: "sub", recursive: true },
    { cwd: dir, onPreImage: (r) => captured.push(r) },
  );
  assert.equal(out?.ok, true);
  assert.match(out?.summary ?? "", /not revertible/);
  assert.deepEqual(captured, []);
});

test("deleting something that is not there is an honest failure", () => {
  const out = runFsMutateTool("delete_file", { path: "nope.txt" }, { cwd: ws() });
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /no such path/);
});

/* ── move_file ─────────────────────────────────────────────────────────────*/

test("a move refuses to CLOBBER unless overwrite was asked for", () => {
  const dir = ws();
  writeFileSync(join(dir, "a.txt"), "A");
  writeFileSync(join(dir, "b.txt"), "B");
  const out = runFsMutateTool("move_file", { from: "a.txt", to: "b.txt" }, { cwd: dir });
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /already exists/);
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "B", "the destination was overwritten");
});

test("overwrite:true replaces the destination", () => {
  const dir = ws();
  writeFileSync(join(dir, "a.txt"), "A");
  writeFileSync(join(dir, "b.txt"), "B");
  const out = runFsMutateTool(
    "move_file",
    { from: "a.txt", to: "b.txt", overwrite: true },
    { cwd: dir },
  );
  assert.equal(out?.ok, true);
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "A");
});

test("a move CREATES missing parent directories", () => {
  const dir = ws();
  writeFileSync(join(dir, "a.txt"), "A");
  const out = runFsMutateTool("move_file", { from: "a.txt", to: "deep/er/a.txt" }, { cwd: dir });
  assert.equal(out?.ok, true);
  assert.equal(readFileSync(join(dir, "deep", "er", "a.txt"), "utf8"), "A");
});

test("a text move claims BOTH ends, so /revert can put it back", () => {
  const dir = ws();
  writeFileSync(join(dir, "a.txt"), "A");
  const captured: FsPreImage[] = [];
  const out = runFsMutateTool(
    "move_file",
    { from: "a.txt", to: "b.txt" },
    { cwd: dir, onPreImage: (r) => captured.push(r) },
  );
  assert.equal(out?.ok, true);
  assert.deepEqual(
    captured.map((r) => [r.path, r.preImage, r.existed]),
    [
      // destination first, source last: a one-step undo restores the source before anything
      // is deleted
      [join(dir, "b.txt"), "", false],
      [join(dir, "a.txt"), "A", true],
    ],
  );
});

test("a BINARY move claims nothing: /revert must never delete the only copy", () => {
  // The destination record alone ("did not exist → delete it") made /revert rm the moved PNG
  // and restore nothing at the source, because a binary source has no text pre-image.
  const dir = ws();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
  writeFileSync(join(dir, "a.png"), png);
  const captured: FsPreImage[] = [];
  const out = runFsMutateTool(
    "move_file",
    { from: "a.png", to: "assets/a.png" },
    { cwd: dir, onPreImage: (r) => captured.push(r) },
  );
  assert.equal(out?.ok, true);
  assert.match(out?.summary ?? "", /not revertible/);
  assert.deepEqual(captured, [], "no half-claim that a revert would act on");
  assert.deepEqual(readFileSync(join(dir, "assets", "a.png")), png, "moved byte-identical");
});

/* ── mkdir ─────────────────────────────────────────────────────────────────*/

test("mkdir is RECURSIVE and an existing directory is a success", () => {
  const dir = ws();
  assert.equal(runFsMutateTool("mkdir", { path: "a/b/c" }, { cwd: dir })?.ok, true);
  assert.equal(existsSync(join(dir, "a", "b", "c")), true);
  assert.equal(
    runFsMutateTool("mkdir", { path: "a/b/c" }, { cwd: dir })?.ok,
    true,
    "re-mkdir failed",
  );
});

/* ── the working-set guard ─────────────────────────────────────────────────*/

test("a path outside the working set is refused for every mutator", () => {
  const dir = ws();
  const outside = ws();
  writeFileSync(join(outside, "victim.txt"), "x");
  const deps = { cwd: dir, roots: [dir] };
  for (const [name, args] of [
    ["delete_file", { path: join(outside, "victim.txt") }],
    ["move_file", { from: join(outside, "victim.txt"), to: "here.txt" }],
    ["mkdir", { path: join(outside, "new") }],
  ] as const) {
    const out = runFsMutateTool(name, args, deps);
    assert.equal(out?.ok, false, `${name} escaped the working set`);
    assert.match(out?.summary ?? "", /outside the working set/);
  }
  assert.equal(existsSync(join(outside, "victim.txt")), true);
});

test("an explicitly approved out-of-scope path is allowed through", () => {
  // The confirm seam can grant one path for one turn; the guard consults that, not a blanket off.
  const dir = ws();
  const outside = ws();
  const target = join(outside, "ok.txt");
  writeFileSync(target, "x");
  const out = runFsMutateTool(
    "delete_file",
    { path: target },
    { cwd: dir, roots: [dir], approvedOutside: new Set([target]) },
  );
  assert.equal(out?.ok, true);
});

test("an option-shaped path is refused rather than resolved", () => {
  // `-rf` as a filename is far likelier to be a model mistake than a real file.
  const out = runFsMutateTool("delete_file", { path: "-rf" }, { cwd: ws() });
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /refusing invalid path/);
});

test("a non-mutator name returns null so the caller's dispatch falls through", () => {
  assert.equal(runFsMutateTool("read_file", { path: "a" }, { cwd: ws() }), null);
});

test("delete_file does NOT capture a lossy pre-image for a binary file", async () => {
  /**
   * `readFileSync(path, "utf8")` does not throw on binary — it substitutes U+FFFD for every
   * invalid sequence — so the catch that was supposed to mean "cannot be captured" never fired,
   * and `/revert` wrote that lossy string back as if it were the file. Measured on a PNG-shaped
   * buffer: 264 bytes in, 522 bytes out, not identical. The user was told the delete had been
   * reverted and got a corrupted file, which is worse than not reverting at all.
   */
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "prom-del-bin-"));

  const png = join(dir, "img.png");
  writeFileSync(
    png,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    ]),
  );
  const txt = join(dir, "a.txt");
  writeFileSync(txt, "hello\n");

  const captured: string[] = [];
  const deps = {
    cwd: dir,
    roots: [dir],
    authLevel: 7,
    onPreImage: (rec: { path: string }) => captured.push(rec.path),
  } as never;

  const bin = await runFsMutateTool("delete_file", { path: png }, deps);
  assert.equal(bin?.ok, true, "a binary file still deletes");
  assert.match(bin?.summary ?? "", /not revertible/, "…and says so, like the directory branch");

  const text = await runFsMutateTool("delete_file", { path: txt }, deps);
  assert.equal(text?.ok, true);
  assert.doesNotMatch(text?.summary ?? "", /not revertible/);

  assert.deepEqual(
    captured.map((p) => p.split("/").pop()),
    ["a.txt"],
    "only the file whose bytes round-trip exactly may enter the checkpoint",
  );
});
