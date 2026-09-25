/**
 * cat-in-integration.test.ts — `/cat` and `/in` driven through the REAL slash registry.
 *
 * cat.test.ts and in.test.ts cover the pure modules. This covers the wiring: the registry
 * entry, the arg string it passes, the `ctx.caps` it reads, the `ctx.outputDir` seam it calls
 * and the lines it writes. Both terminal hosts dispatch through `findSlash`, so a command that
 * works here works in both.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { makeFakeSlashCtx } from "./__fixtures__/slash-ctx.js";
import { findSlash } from "./slash-registry.js";

const DIR = mkdtempSync(join(tmpdir(), "prom-int-"));

/** Run a registered command exactly as a host would, and return what it wrote. */
async function run(
  name: string,
  rest: string,
  tweak?: (c: ReturnType<typeof makeFakeSlashCtx>) => void,
) {
  const fake = makeFakeSlashCtx();
  tweak?.(fake);
  const cmd = findSlash(name);
  assert.ok(cmd, `/${name} must be registered`);
  await cmd.run(rest, fake.ctx);
  return { out: fake.calls.writes, fake };
}

test("/cat is registered, and prints a real file through the registry", async () => {
  const file = join(DIR, "hello.py");
  writeFileSync(file, "# a comment\nprint('hi')\n");
  const { out } = await run("cat", file);
  const text = out.join("\n");
  assert.match(text, /hello\.py/, "the header names the file");
  assert.match(text, /2 lines/);
  assert.match(text, /1 │ # a comment/);
  assert.match(text, /2 │ print\('hi'\)/);
});

test("/cat with no argument writes a usage line (slash-smoke requires output)", async () => {
  const { out } = await run("cat", "");
  assert.match(out.join("\n"), /usage: \/cat/);
});

test("/cat refuses a binary file rather than printing it", async () => {
  const file = join(DIR, "blob.bin");
  writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  assert.match((await run("cat", file)).out.join("\n"), /binary file/);
});

test("/in through the registry sets the folder AND grants it for writing", async () => {
  const { out, fake } = await run("in", DIR);
  assert.match(out.join("\n"), /produced files →/);
  assert.equal(fake.ctx.outputDir.get(), fake.ctx.workingSet.list()[0]);
  assert.ok(
    fake.ctx.workingSet.list().length === 1,
    "the grant is what makes the exec sandbox permit a write there",
  );
});

test("/in with no argument reports the current state", async () => {
  const { out } = await run("in", "");
  assert.match(out.join("\n"), /Output folder/);
  assert.match(out.join("\n"), /not set/);
});

test("/in --clear unsets it", async () => {
  const fake = makeFakeSlashCtx();
  const cmd = findSlash("in");
  assert.ok(cmd);
  await cmd.run(DIR, fake.ctx);
  assert.ok(fake.ctx.outputDir.get());
  await cmd.run("--clear", fake.ctx);
  assert.equal(fake.ctx.outputDir.get(), null);
  assert.match(fake.calls.writes.join("\n"), /output folder cleared/);
});

test("/cat and /in offer path completion, like /cd and /cwd", async () => {
  const { PATH_ARG_COMMANDS } = await import("./path-completer.js");
  // /in names a destination FOLDER; /cat names a FILE — the one path-arg command that
  // must offer files as well as directories.
  assert.deepEqual(PATH_ARG_COMMANDS.get("in"), { dirsOnly: true });
  assert.deepEqual(PATH_ARG_COMMANDS.get("cat"), { dirsOnly: false });
  assert.deepEqual(PATH_ARG_COMMANDS.get("cd"), { dirsOnly: true });
});

test("/deps is registered and lists the external tools with their state", async () => {
  const { out } = await run("deps", "");
  const text = out.join("\n");
  assert.match(text, /External tools/);
  assert.match(text, /imagemagick/);
  assert.match(text, /yt-dlp/);
  // it names what each is FOR — a bare list of binaries answers nothing.
  assert.match(text, /download video\/audio/);
});

test("/deps rejects a bogus argument with usage, never silently", async () => {
  assert.match((await run("deps", "--wat")).out.join("\n"), /usage: \/deps/);
});

test("/deps install refuses a name outside the catalog before any spawn", async () => {
  // The injection guard at the command layer: the id reaches argv, so it is looked up.
  const { out, fake } = await run("deps", "install evil; rm -rf ~");
  assert.match(out.join("\n"), /unknown tool/);
  assert.deepEqual(fake.calls.spawns, [], "nothing was spawned");
  assert.deepEqual(fake.calls.gated, [], "nothing was gated");
});

test("/deps install with no tool prints usage", async () => {
  assert.match((await run("deps", "install")).out.join("\n"), /usage: \/deps install/);
});

test("/install still belongs to the engine's plugin installer, not to host tools", () => {
  // Two commands answering to one word is how a user installs the wrong thing. `/deps install`
  // exists precisely because `/install` was already taken.
  const cmd = findSlash("install");
  assert.ok(cmd, "the engine verb must still be registered");
  assert.notEqual(cmd.group, "config");
});
