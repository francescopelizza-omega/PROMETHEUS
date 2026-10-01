// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ext-zip.ts — a dependency-free ZIP reader for `.promext` archives (APP-059).
 *
 * Node has NO stdlib ZIP reader (`node:zlib` only does raw DEFLATE/gzip streams, not the
 * ZIP container). So we parse the archive by hand: locate the End-Of-Central-Directory
 * record from the tail, walk the central directory, and inflate each entry's data from its
 * local file header. STORED (0) is copied; DEFLATE (8) goes through `inflateRawSync`.
 *
 * SECURITY (zip-slip): every entry name is validated BEFORE any write — absolute paths,
 * `..` segments, and backslash separators are rejected, and the resolved destination MUST
 * stay inside the target dir. A malicious `.promext` must never escape its staging dir.
 *
 * Electron-free (node:fs/zlib/path only) so the whole install pipeline is node:test-able.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CEN_SIG = 0x02014b50; // Central directory file header
const LFH_SIG = 0x04034b50; // Local File Header
const EOCD_MIN = 22;

/** A parsed archive entry (its raw, already-inflated bytes). */
export interface ZipEntry {
  name: string;
  /** true when the entry is a directory (name ends with "/"). */
  dir: boolean;
  data: Uint8Array;
}

/** Thrown on a malformed archive (bad signatures, truncation, unsupported compression). */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/** Locate the EOCD record by scanning backward from the tail (it's within the last 64KB). */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - EOCD_MIN - 0xffff);
  for (let i = buf.length - EOCD_MIN; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Is an entry name unsafe to extract (zip-slip)? Rejects absolute paths, any `..` segment,
 * backslash separators (Windows-style traversal), and NUL bytes. Pure — no fs.
 */
export function isUnsafeEntryName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return true;
  // a drive-letter absolute (C:\ or C:/) or a leading tilde is also rejected.
  if (/^[a-zA-Z]:/.test(name) || name.startsWith("~")) return true;
  return name.split("/").some((seg) => seg === "..");
}

/**
 * Parse a ZIP buffer into its entries (PURE — no fs). Throws ZipError on a malformed
 * archive. Data descriptors + zip64 are not supported (a `.promext` is a plain deflate zip);
 * an unsupported compression method throws rather than silently mis-reading.
 */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipError("not a zip archive (no end-of-central-directory record)");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries: ZipEntry[] = [];
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new ZipError("corrupt central directory entry");
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) {
      entries.push({ name, dir: true, data: new Uint8Array(0) });
      continue;
    }
    if (lfhOffset + 30 > buf.length || buf.readUInt32LE(lfhOffset) !== LFH_SIG) {
      throw new ZipError(`corrupt local header for ${name}`);
    }
    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data: Uint8Array;
    if (method === 0)
      data = comp; // STORED
    else if (method === 8) {
      try {
        data = inflateRawSync(comp);
      } catch (e) {
        throw new ZipError(`inflate failed for ${name}: ${e instanceof Error ? e.message : e}`);
      }
    } else throw new ZipError(`unsupported compression method ${method} for ${name}`);
    entries.push({ name, dir: false, data });
  }
  return entries;
}

/**
 * Extract a ZIP buffer into `destDir`. Every entry is zip-slip-validated (name + resolved
 * path) BEFORE writing; a single unsafe entry aborts the whole extraction (ZipError).
 * Returns the relative paths written. `destDir` must already exist.
 */
export async function extractZip(buf: Buffer, destDir: string): Promise<string[]> {
  const entries = readZipEntries(buf);
  const root = resolve(destDir);
  const written: string[] = [];
  for (const entry of entries) {
    if (isUnsafeEntryName(entry.name)) {
      throw new ZipError(`unsafe archive entry (zip-slip): ${entry.name}`);
    }
    const dest = resolve(root, entry.name);
    if (dest !== root && !dest.startsWith(root + sep)) {
      throw new ZipError(`archive entry escapes destination: ${entry.name}`);
    }
    if (entry.dir) {
      await mkdir(dest, { recursive: true });
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, entry.data);
    written.push(entry.name);
  }
  return written;
}
