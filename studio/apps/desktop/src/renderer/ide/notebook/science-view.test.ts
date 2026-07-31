/**
 * science-view.test.ts — pure APP-088 helpers (paging math, viewable predicate, bytes).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { dataframePageMeta, formatBytes, isViewableFrame } from "./science-view.js";

test("dataframePageMeta: page/maxPage/row-span from offset+limit+total", () => {
  const m = dataframePageMeta(0, 100, 250);
  assert.equal(m.page, 0);
  assert.equal(m.maxPage, 2); // ceil(250/100)-1
  assert.equal(m.startRow, 1);
  assert.equal(m.endRow, 100);

  const mid = dataframePageMeta(100, 100, 250);
  assert.equal(mid.page, 1);
  assert.equal(mid.startRow, 101);
  assert.equal(mid.endRow, 200);

  const last = dataframePageMeta(200, 100, 250);
  assert.equal(last.page, 2);
  assert.equal(last.startRow, 201);
  assert.equal(last.endRow, 250); // clamped to total, not 300
});

test("dataframePageMeta: clamps an out-of-range offset to the last page", () => {
  const m = dataframePageMeta(9999, 50, 120);
  assert.equal(m.maxPage, 2);
  assert.equal(m.page, 2);
});

test("dataframePageMeta: empty frame yields page 0 and a 0/0 row span", () => {
  const m = dataframePageMeta(0, 100, 0);
  assert.equal(m.page, 0);
  assert.equal(m.maxPage, 0);
  assert.equal(m.startRow, 0);
  assert.equal(m.endRow, 0);
});

test("isViewableFrame: containers + pandas types (incl. subclasses) are viewable", () => {
  for (const t of ["list", "dict", "tuple", "ndarray", "DataFrame", "Series"]) {
    assert.equal(isViewableFrame(t), true, t);
  }
  assert.equal(isViewableFrame("GeoDataFrame"), true);
  assert.equal(isViewableFrame("int"), false);
  assert.equal(isViewableFrame("str"), false);
});

test("formatBytes: unit scaling + guard on bad input", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
  assert.equal(formatBytes(-1), "—");
  assert.equal(formatBytes(Number.NaN), "—");
});
