/**
 * metadata-cmd.test.ts — the `prometheus metadata …` privacy surface over metadata.py:
 * inspect READ, the plan→confirm mutations (scrub/edit/timestomp use --confirm),
 * and usage errors. FAKE runSidecar; the original file is never touched.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { runMetadataCommand } from "./metadata-cmd.js";
import type { SidecarDeps } from "./sidecar-cmd.js";

function fake(reply: Record<string, unknown> = { ok: true, command: "x" }): {
  deps: SidecarDeps;
  calls: { script: string; argv: string[] }[];
} {
  const calls: { script: string; argv: string[] }[] = [];
  const runSidecar = (async (script: string, argv: string[]) => {
    calls.push({ script, argv });
    return { ok: true, command: "x", ...reply };
  }) as unknown as SidecarDeps["runSidecar"];
  return { deps: { runSidecar }, calls };
}

const ctxFor = (argv: string[]) => makeContext(parseArgs(argv));

/**
 * Regression: a mistyped action (e.g. "inspct" for "inspect") used to be silently swallowed —
 * sub() defaulted to "inspect" and the typo itself became the FILE argument, so `/metadata inspct
 * foo.jpg` tried to inspect a file literally named "inspct" and never touched "foo.jpg", with no
 * "unknown action" error anywhere. Fixed via parse.ts's `unmatchedSub`.
 */
test("a mistyped metadata action reports 'unknown metadata verb', not a silent inspect of the typo", async () => {
  const { deps, calls } = fake();
  const out = await runMetadataCommand(ctxFor(["metadata", "inspct", "foo.jpg"]), deps);
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /unknown metadata verb/);
  assert.match(out.text ?? "", /inspct/);
  assert.deepEqual(calls, []);
});

test("metadata inspect: READ renders every tag, flagging the sensitive ones (exit 0)", async () => {
  /**
   * The fixture below is the shape the REAL producer emits — `studio/python/sidecar/metadata.py`'s
   * `_inspect_payload` always returns `fs`, `tags` and `tools` as object MAPS. This test used to
   * pass `fields: [{key, value, privacy}]`, an array shape that sidecar has never emitted, and so
   * it exercised a branch no real invocation could reach. Meanwhile every real run fell through
   * to a flat key/value loop that did `String(v)` on each value and printed
   * `tags: [object Object]` — announcing `tagCount: 20` and then showing none of the 20.
   * Measured on a real PNG through the built binary. This is the privacy surface: it is the
   * screen a user reads before deciding whether to scrub a file.
   */
  const { deps, calls } = fake({
    ok: true,
    file: "/tmp/a.jpg",
    mime: "image/jpeg",
    tagCount: 3,
    tags: {
      "EXIF:GPSLatitude": "51.5",
      "EXIF:Artist": "Someone",
      "PNG:ImageWidth": "182",
    },
    fs: { size: 20563, mode: "0o644" },
  });
  const out = await runMetadataCommand(ctxFor(["metadata", "inspect", "/tmp/a.jpg"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["inspect", "--uri", "/tmp/a.jpg"]);

  const text = out.text ?? "";
  assert.doesNotMatch(text, /\[object Object\]/, "a whole block was stringified away");
  // every tag is actually shown, not merely counted
  for (const k of ["EXIF:GPSLatitude", "EXIF:Artist", "PNG:ImageWidth"]) {
    assert.match(text, new RegExp(k.replace(":", ":")), `${k} was not rendered`);
  }
  assert.match(text, /51\.5/);
  assert.match(text, /Someone/);
  // …and the nested fs block survives too
  assert.match(text, /20563/);
  // the two privacy-relevant keys are called out; the innocuous one is not
  assert.match(text, /privacy-sensitive/);
  assert.match(text, /EXIF:GPSLatitude/);
  assert.doesNotMatch(
    text.split("\n")[0] ?? "",
    /PNG:ImageWidth/,
    "an innocuous tag was flagged as sensitive",
  );
});

test("metadata inspect: a payload with no tags says so instead of flagging nothing", async () => {
  const { deps } = fake({ ok: true, file: "/tmp/a.bin", mime: "application/octet-stream" });
  const out = await runMetadataCommand(ctxFor(["metadata", "inspect", "/tmp/a.bin"]), deps);
  assert.equal(out.exitCode, 0);
  assert.doesNotMatch(out.text ?? "", /privacy-sensitive/);
  assert.doesNotMatch(out.text ?? "", /\[object Object\]/);
});

test("metadata scrub: PREVIEW by default, plan carries --confirm (no spawn)", async () => {
  const { deps, calls } = fake();
  const out = await runMetadataCommand(ctxFor(["metadata", "scrub", "/tmp/a.jpg"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status: string }).status, "preview");
  assert.deepEqual((out.json as { argv: string[] }).argv, [
    "scrub",
    "--uri",
    "/tmp/a.jpg",
    "--confirm",
  ]);
  assert.deepEqual(calls, []);
});

test("metadata scrub --yes: EXECUTES with --confirm", async () => {
  const { deps, calls } = fake();
  await runMetadataCommand(ctxFor(["metadata", "scrub", "/tmp/a.jpg", "--yes"]), deps);
  assert.deepEqual(calls[0]?.argv, ["scrub", "--uri", "/tmp/a.jpg", "--confirm"]);
});

test("metadata edit --yes → edit --uri --field --value --confirm", async () => {
  const { deps, calls } = fake();
  await runMetadataCommand(
    ctxFor([
      "metadata",
      "edit",
      "/tmp/a.jpg",
      "--field",
      "EXIF:Artist",
      "--value",
      "anon",
      "--yes",
    ]),
    deps,
  );
  assert.deepEqual(calls[0]?.argv, [
    "edit",
    "--uri",
    "/tmp/a.jpg",
    "--field",
    "EXIF:Artist",
    "--value",
    "anon",
    "--confirm",
  ]);
});

test("metadata edit without --field → usage error (exit 1)", async () => {
  const { deps, calls } = fake();
  const out = await runMetadataCommand(ctxFor(["metadata", "edit", "/tmp/a.jpg", "--yes"]), deps);
  assert.equal(out.exitCode, 1);
  assert.deepEqual(calls, []);
});
