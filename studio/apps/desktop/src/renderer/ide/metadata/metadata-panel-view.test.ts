/**
 * metadata-panel-view.test.ts — the pure Metadata-panel view-model (file 0C).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MetadataInspectResult } from "../../../shared/ipc-contract.js";
import {
  type ConfirmGate,
  buildMetadataRows,
  canScrub,
  formatBytes,
  formatEpoch,
  isSensitiveKey,
  summarize,
} from "./metadata-panel-view.js";

test("formatBytes scales units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(-1), "—");
});

test("formatEpoch renders deterministic UTC; missing → dash", () => {
  assert.equal(formatEpoch(1577836800), "2020-01-01T00:00:00Z");
  assert.equal(formatEpoch(undefined), "—");
});

test("isSensitiveKey flags privacy-leaking fields, ignores benign", () => {
  for (const k of [
    "GPSLatitude",
    "EXIF:Artist",
    "XMP:Creator",
    "DeviceModel",
    "Owner email",
    "DocumentID",
  ]) {
    assert.equal(isSensitiveKey(k), true, k);
  }
  for (const k of ["ImageWidth", "ColorSpace", "BitDepth"]) {
    assert.equal(isSensitiveKey(k), false, k);
  }
});

const INSPECT: MetadataInspectResult = {
  ok: true,
  file: "/u/me/photo.jpg",
  mime: "image/jpeg",
  fs: {
    size: 2048,
    mode: "0o644",
    mtime: 1577836800,
    atime: 1577836800,
    ctime: 1577836800,
    birthtime: 1577836800,
  },
  xattrs: ["com.apple.quarantine", "com.test.gps"],
  tagSource: "exiftool",
  tags: { "EXIF:Artist": "Jane", "EXIF:GPSLatitude": "51.5", ImageWidth: "4000" },
  tagCount: 3,
  tools: { exiftool: true, pil: false, pikepdf: false },
};

test("buildMetadataRows groups File / xattrs / Content tags + flags sensitivity + editability", () => {
  const rows = buildMetadataRows(INSPECT);
  const byKey = (k: string) => rows.find((r) => r.key === k);
  assert.equal(byKey("Path")?.group, "File");
  assert.equal(byKey("Size")?.value, "2.0 KB");
  assert.equal(
    byKey("Modified")?.sensitive,
    false,
    "timestamps are normalizable, not a content leak",
  );
  assert.equal(byKey("com.test.gps")?.group, "Extended attributes");
  assert.equal(byKey("EXIF:Artist")?.sensitive, true);
  assert.equal(byKey("EXIF:Artist")?.editable, true, "content tags are editable");
  assert.equal(byKey("ImageWidth")?.sensitive, false);
  assert.equal(byKey("Path")?.editable, false, "fs rows are not editable");
});

test("summarize counts sensitive fields with a privacy label", () => {
  const s = summarize(INSPECT);
  assert.equal(s.tagCount, 3);
  assert.equal(s.xattrCount, 2);
  assert.ok(s.sensitive >= 3);
  assert.match(s.label, /leak/);
  const clean = summarize({
    ok: true,
    file: "/x",
    mime: "text/plain",
    fs: { size: 1, mode: "0o644", mtime: 0, atime: 0, ctime: 0 },
    xattrs: [],
    tags: {},
    tagCount: 0,
    tools: { exiftool: false, pil: false, pikepdf: false },
  });
  assert.match(clean.label, /no obvious privacy leaks/);
});

test("canScrub gates on a selected file + not mid-apply", () => {
  const apply: ConfirmGate = "applying";
  assert.equal(canScrub(null, "idle"), false);
  assert.equal(canScrub("/u/f", "idle"), true);
  assert.equal(canScrub("/u/f", apply), false);
});
