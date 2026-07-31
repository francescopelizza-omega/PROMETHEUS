/**
 * bottom-panel-state.test.ts — node:test for the pure BottomPanel height/badge math (APP-072).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOTTOM_MIN_HEIGHT,
  panelMaxHeight,
  resolvePanelHeight,
  shouldShowBadge,
} from "./bottom-panel-state.js";

test("panelMaxHeight: window height minus inset, floored at MIN", () => {
  assert.equal(panelMaxHeight(1000), 840); // 1000 - 160
  assert.equal(panelMaxHeight(100), BOTTOM_MIN_HEIGHT); // tiny window clamps to MIN
});

test("resolvePanelHeight: maximize expands to maxHeight, restore returns the dragged size", () => {
  const base = { collapsed: false, size: 300, maxHeight: 840, rowVar: "var(--row-h, 36px)" };
  // maximized → the window-max
  assert.equal(resolvePanelHeight({ ...base, maximized: true }), 840);
  // restored (un-maximized) → the prior dragged size, unchanged
  assert.equal(resolvePanelHeight({ ...base, maximized: false }), 300);
});

test("resolvePanelHeight: collapsed shows the row var; size clamps to a shrunk max", () => {
  assert.equal(
    resolvePanelHeight({
      collapsed: true,
      maximized: false,
      size: 300,
      maxHeight: 840,
      rowVar: "R",
    }),
    "R",
  );
  // a dragged size larger than the current (shrunk-window) max is clamped so it can't overflow.
  assert.equal(
    resolvePanelHeight({
      collapsed: false,
      maximized: false,
      size: 900,
      maxHeight: 500,
      rowVar: "R",
    }),
    500,
  );
});

test("shouldShowBadge: only a positive number shows (0 / undefined hide)", () => {
  assert.equal(shouldShowBadge(3), true);
  assert.equal(shouldShowBadge(0), false); // connected + clean → no badge
  assert.equal(shouldShowBadge(undefined), false); // not connected → no badge
});
