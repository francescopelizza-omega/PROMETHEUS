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

test("metadata inspect: READ renders fields (exit 0)", async () => {
  const { deps, calls } = fake({
    ok: true,
    fields: [{ key: "EXIF:GPS", value: "x", privacy: true }],
  });
  const out = await runMetadataCommand(ctxFor(["metadata", "inspect", "/tmp/a.jpg"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["inspect", "--uri", "/tmp/a.jpg"]);
  assert.match(out.text ?? "", /privacy-sensitive/);
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

test("metadata edit without --field → usage error (exit 2)", async () => {
  const { deps, calls } = fake();
  const out = await runMetadataCommand(ctxFor(["metadata", "edit", "/tmp/a.jpg", "--yes"]), deps);
  assert.equal(out.exitCode, 2);
  assert.deepEqual(calls, []);
});
