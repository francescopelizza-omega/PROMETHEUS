/**
 * ext-zip.test.ts — the hand-rolled ZIP reader + zip-slip guard (APP-059).
 *
 * Builds real ZIP buffers (STORED + DEFLATE entries) with a tiny in-test writer, so the
 * central-directory parse + inflate + extraction paths are exercised end to end without a
 * dependency. Malformed archives and zip-slip names must be rejected (ZipError).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";

import { ZipError, extractZip, isUnsafeEntryName, readZipEntries } from "./ext-zip.js";

interface ZipInput {
  name: string;
  data: Buffer;
  deflate?: boolean;
}

/** Build a minimal (non-zip64) ZIP buffer with STORED or raw-DEFLATE entries. */
function buildZip(inputs: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const inp of inputs) {
    const nameBuf = Buffer.from(inp.name, "utf8");
    const method = inp.deflate ? 8 : 0;
    const stored = inp.deflate ? deflateRawSync(inp.data) : inp.data;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(0, 14); // crc (unchecked by our reader)
    lfh.writeUInt32LE(stored.length, 18); // compressed size
    lfh.writeUInt32LE(inp.data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len
    const localRecord = Buffer.concat([lfh, nameBuf, stored]);
    locals.push(localRecord);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(0, 16); // crc
    cen.writeUInt32LE(stored.length, 20);
    cen.writeUInt32LE(inp.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42); // local header offset
    centrals.push(Buffer.concat([cen, nameBuf]));
    offset += localRecord.length;
  }
  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(inputs.length, 8); // entries this disk
  eocd.writeUInt16LE(inputs.length, 10); // total entries
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16); // central dir offset
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prom-extzip-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readZipEntries: STORED + DEFLATE entries decode to their original bytes", () => {
  const zip = buildZip([
    { name: "prometheus.extension.json", data: Buffer.from('{"schema":"extension@1"}') },
    { name: "dist/main.js", data: Buffer.from("export const x = 1;\n".repeat(50)), deflate: true },
  ]);
  const entries = readZipEntries(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.name, "prometheus.extension.json");
  assert.equal(Buffer.from(entries[0]?.data ?? []).toString(), '{"schema":"extension@1"}');
  // the DEFLATE entry inflates back to the original (compression round-trips).
  assert.equal(Buffer.from(entries[1]?.data ?? []).toString(), "export const x = 1;\n".repeat(50));
});

test("extractZip: writes entries under destDir; nested dirs created", async () => {
  await withTmp(async (dir) => {
    const zip = buildZip([
      { name: "prometheus.extension.json", data: Buffer.from("{}") },
      { name: "dist/main.js", data: Buffer.from("ok") },
    ]);
    const written = await extractZip(zip, dir);
    assert.deepEqual(written.sort(), ["dist/main.js", "prometheus.extension.json"]);
    assert.equal(await readFile(join(dir, "prometheus.extension.json"), "utf8"), "{}");
    assert.equal(await readFile(join(dir, "dist", "main.js"), "utf8"), "ok");
  });
});

test("readZipEntries: a non-zip buffer throws ZipError", () => {
  assert.throws(() => readZipEntries(Buffer.from("not a zip archive at all")), ZipError);
});

test("isUnsafeEntryName: rejects traversal / absolute / backslash; allows normal paths", () => {
  assert.equal(isUnsafeEntryName("../escape"), true);
  assert.equal(isUnsafeEntryName("a/../../b"), true);
  assert.equal(isUnsafeEntryName("/abs/path"), true);
  assert.equal(isUnsafeEntryName("a\\b"), true);
  assert.equal(isUnsafeEntryName("C:/win"), true);
  assert.equal(isUnsafeEntryName("~/home"), true);
  assert.equal(isUnsafeEntryName("dist/main.js"), false);
  assert.equal(isUnsafeEntryName("prometheus.extension.json"), false);
});

test("extractZip: a zip-slip entry throws + writes nothing outside destDir", async () => {
  await withTmp(async (dir) => {
    const zip = buildZip([{ name: "../pwned.js", data: Buffer.from("owned") }]);
    await assert.rejects(() => extractZip(zip, join(dir, "staging")), ZipError);
    // the sibling escape path must not exist.
    await assert.rejects(() => stat(join(dir, "pwned.js")));
  });
});
