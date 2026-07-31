/**
 * a11y.test.ts — the PURE a11y helpers (APP-100): id derivation, ARIA prop objects, and the
 * focus/arrow index math. The DOM hook (useFocusTrap) is verified in the offscreen render, not
 * here (no jsdom). node:test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeDescendantProps,
  arrowMove,
  nextFocusIndex,
  nextRegion,
  optionId,
  optionProps,
  rovingTabIndex,
} from "./a11y.ts";

test("optionId: stable listbox-scoped option id", () => {
  assert.equal(optionId("cmdp", 3), "cmdp-opt-3");
});

test("activeDescendantProps: combobox wiring; activedescendant omitted when empty", () => {
  const withRows = activeDescendantProps("cmdp-list", 2, 5);
  assert.equal(withRows.role, "combobox");
  assert.equal(withRows["aria-controls"], "cmdp-list");
  assert.equal(withRows["aria-expanded"], true);
  assert.equal(withRows["aria-activedescendant"], "cmdp-list-opt-2");

  const empty = activeDescendantProps("cmdp-list", 0, 0);
  assert.equal(empty["aria-activedescendant"], undefined);
});

test("optionProps: role/id/selected", () => {
  assert.deepEqual(optionProps("cmdp-list", 1, true), {
    role: "option",
    id: "cmdp-list-opt-1",
    "aria-selected": true,
  });
  assert.equal(optionProps("cmdp-list", 4, false)["aria-selected"], false);
});

test("rovingTabIndex: selected tab is the only tab stop", () => {
  assert.equal(rovingTabIndex(true), 0);
  assert.equal(rovingTabIndex(false), -1);
});

test("nextFocusIndex: wraps both directions; empty → 0", () => {
  assert.equal(nextFocusIndex(3, 2, false), 0); // last → first
  assert.equal(nextFocusIndex(3, 0, true), 2); // first → last (shift)
  assert.equal(nextFocusIndex(3, 1, false), 2);
  assert.equal(nextFocusIndex(0, 0, false), 0);
});

test("nextRegion: F6 cycles + enters from no-region (-1)", () => {
  assert.equal(nextRegion(4, 0, 1), 1);
  assert.equal(nextRegion(4, 3, 1), 0); // wrap forward
  assert.equal(nextRegion(4, 0, -1), 3); // wrap back
  assert.equal(nextRegion(4, -1, 1), 0); // enter first
  assert.equal(nextRegion(4, -1, -1), 3); // enter last
  assert.equal(nextRegion(0, 0, 1), 0);
});

test("arrowMove: tablist Left/Right/Up/Down/Home/End; null for other keys", () => {
  assert.equal(arrowMove(3, 0, "ArrowRight"), 1);
  assert.equal(arrowMove(3, 2, "ArrowRight"), 0); // wrap
  assert.equal(arrowMove(3, 0, "ArrowLeft"), 2); // wrap
  assert.equal(arrowMove(3, 1, "ArrowUp"), 0);
  assert.equal(arrowMove(3, 1, "ArrowDown"), 2);
  assert.equal(arrowMove(3, 1, "Home"), 0);
  assert.equal(arrowMove(3, 1, "End"), 2);
  assert.equal(arrowMove(3, 1, "x"), null);
  assert.equal(arrowMove(0, 0, "Home"), null);
});
