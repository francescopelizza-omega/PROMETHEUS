/**
 * editor-vision.test.ts — node:test for the pure reading-aid helpers (APP-074).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODE_VISION_SYMBOL_CAP,
  capSymbols,
  defaultVisionToggles,
  implsLensTitle,
  indentFoldingRanges,
  lspFoldingToRanges,
  parseVisionToggles,
  refsLensTitle,
  serializeVisionToggles,
} from "./editor-vision.js";

test("lspFoldingToRanges: 0-based → 1-based, kind passthrough, drops zero-height", () => {
  const out = lspFoldingToRanges([
    { startLine: 0, endLine: 4, kind: "imports" },
    { startLine: 10, endLine: 12, kind: "comment" },
    { startLine: 20, endLine: 22, kind: "region" },
    { startLine: 30, endLine: 31, kind: "bogus" }, // unknown kind → dropped kind
    { startLine: 40, endLine: 40 }, // zero-height → dropped entirely
  ]);
  assert.deepEqual(out[0], { start: 1, end: 5, kind: "imports" });
  assert.deepEqual(out[1], { start: 11, end: 13, kind: "comment" });
  assert.deepEqual(out[2], { start: 21, end: 23, kind: "region" });
  assert.deepEqual(out[3], { start: 31, end: 32 }); // kind undefined
  assert.equal(out.length, 4);
});

test("indentFoldingRanges: an indented block folds; blanks are transparent", () => {
  const lines = [
    "def f():", //        0  block header
    "    a = 1", //       1
    "", //                2  blank inside block
    "    b = 2", //       3
    "c = 3", //           4  back to col 0
  ];
  const out = indentFoldingRanges(lines);
  // the block under `def f():` spans lines 1..4 (1-based: 1 → 4)
  assert.ok(out.some((r) => r.start === 1 && r.end === 4));
});

test("refsLensTitle / implsLensTitle: singular/plural + em-dash for unknown", () => {
  assert.equal(refsLensTitle(0), "0 refs");
  assert.equal(refsLensTitle(1), "1 ref");
  assert.equal(refsLensTitle(7), "7 refs");
  assert.equal(refsLensTitle(null), "— refs");
  assert.equal(refsLensTitle(undefined), "— refs");
  assert.equal(implsLensTitle(1), "1 impl");
  assert.equal(implsLensTitle(3), "3 impls");
});

test("capSymbols: caps to the LSP-spam ceiling", () => {
  const many = Array.from({ length: 100 }, (_, i) => i);
  assert.equal(capSymbols(many).length, CODE_VISION_SYMBOL_CAP);
  assert.deepEqual(capSymbols([1, 2, 3], 30), [1, 2, 3]);
});

test("vision toggles: defaults + parse fail-soft + round-trip", () => {
  const d = defaultVisionToggles();
  assert.deepEqual(d, { folding: true, inlayHints: true, codeVision: false });
  assert.deepEqual(parseVisionToggles(null), d); // absent → defaults
  assert.deepEqual(parseVisionToggles("{bad"), d); // corrupt → defaults
  assert.deepEqual(parseVisionToggles('{"codeVision":true}'), {
    folding: true,
    inlayHints: true,
    codeVision: true,
  });
  const round = parseVisionToggles(
    serializeVisionToggles({ folding: false, inlayHints: false, codeVision: true }),
  );
  assert.deepEqual(round, { folding: false, inlayHints: false, codeVision: true });
});
