/**
 * coverage-view.test.ts — the pure terminal coverage-bar renderer (CLI-095).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { stringWidth } from "../tui/width.js";
import { coverageBar, preferAscii } from "./coverage-view.js";

test("coverageBar: boundary fractions 0% / 50% / 100% (CLI-095)", () => {
  assert.equal(coverageBar(0, 10), "░░░░░░░░░░");
  assert.equal(coverageBar(50, 10), "█████░░░░░");
  assert.equal(coverageBar(100, 10), "██████████");
});

test("coverageBar: mid-cell fractions floor to an eighth-block partial, never round up (CLI-095)", () => {
  // 95% of 10 = 9.5 cells → 9 full + a half block ▌
  assert.equal(coverageBar(95, 10), "█████████▌");
  // 37% of 10 = 3.7 cells → 3 full + floor(0.7*8)=5 → ▋
  assert.equal(coverageBar(37, 10), "███▋░░░░░░");
  // just-below-full must show ▉ (7/8), NOT a full cell (the U+2588 off-by-one trap)
  assert.equal(coverageBar(99.9, 10), "█████████▉");
});

test("coverageBar: exactly `width` display columns for any pct (never corrupts the table) (CLI-095)", () => {
  assert.equal(stringWidth("█"), 1, "block glyph must measure width 1 or column math breaks");
  for (const pct of [0, 12.5, 33.3, 50, 66.6, 87.5, 95, 99.9, 100]) {
    for (const w of [1, 3, 6, 10, 20]) {
      assert.equal(stringWidth(coverageBar(pct, w)), w, `pct=${pct} w=${w}`);
      assert.equal(stringWidth(coverageBar(pct, w, { ascii: true })), w, `ascii pct=${pct} w=${w}`);
    }
  }
});

test("coverageBar: ASCII fallback uses #/. and rounds to whole cells (CLI-095)", () => {
  assert.equal(coverageBar(0, 10, { ascii: true }), "..........");
  assert.equal(coverageBar(100, 10, { ascii: true }), "##########");
  assert.equal(coverageBar(50, 10, { ascii: true }), "#####.....");
  assert.equal(coverageBar(95, 10, { ascii: true }), "##########"); // round(9.5)=10
});

test("coverageBar: clamps out-of-range + non-finite pct (CLI-095)", () => {
  assert.equal(coverageBar(-20, 5), "░░░░░");
  assert.equal(coverageBar(250, 5), "█████");
  assert.equal(coverageBar(Number.NaN, 5), "░░░░░");
});

test("preferAscii: UTF-8 locale → unicode; C/POSIX/empty → ascii fallback (CLI-095)", () => {
  assert.equal(preferAscii({ LANG: "en_US.UTF-8" }), false);
  assert.equal(preferAscii({ LC_ALL: "en_US.utf8" }), false);
  assert.equal(preferAscii({ LC_ALL: "C" }), true);
  assert.equal(preferAscii({ LANG: "POSIX" }), true);
  assert.equal(preferAscii({}), true); // no locale info → play safe
  // LC_ALL wins over LANG
  assert.equal(preferAscii({ LC_ALL: "C", LANG: "en_US.UTF-8" }), true);
});
