/**
 * list-overlay.test.ts — the pure generic pick-one overlay (CLI-1xx): filter, key nav, the
 * "current"-highlight seed, Enter→pick, Esc close, and width-clamped rendering at 60×15 / 120×40.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { setColorEnabled } from "../render.js";
import type { KeyEvent } from "./keys.js";
import {
  type ListOverlayItem,
  onListKey,
  openListOverlay,
  renderListOverlay,
} from "./list-overlay.js";
import { stringWidth } from "./width.js";

setColorEnabled(false);
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const k = (name: KeyEvent["name"], ch?: string): KeyEvent => (ch ? { name, ch } : { name });

const ITEMS: ListOverlayItem[] = [
  { label: "off", submitText: "/think off" },
  { label: "low", submitText: "/think low" },
  { label: "medium", current: true, submitText: "/think medium" },
  { label: "high", submitText: "/think high" },
  { label: "max", submitText: "/think max" },
];

function drive(state = openListOverlay("Reasoning effort", ITEMS), keys: KeyEvent[] = []) {
  let s = state;
  let action = { type: "none" } as ReturnType<typeof onListKey>["action"];
  for (const key of keys) {
    const r = onListKey(s, key);
    s = r.state;
    action = r.action;
  }
  return { state: s, action };
}

test("opening the overlay pre-highlights the item marked `current`, not row 0", () => {
  const state = openListOverlay("Reasoning effort", ITEMS);
  assert.equal(state.index, 2);
  assert.equal(state.filtered[state.index]?.label, "medium");
});

test("with no item marked current, the overlay highlights row 0", () => {
  const state = openListOverlay("Subagents", [{ label: "1", submitText: "/agents 1" }]);
  assert.equal(state.index, 0);
});

test("typing filters by label prefix/substring, then detail; backspace widens again", () => {
  const { state } = drive(undefined, [..."hi".split("").map((ch) => k("char", ch))]);
  assert.deepEqual(
    state.filtered.map((i) => i.label),
    ["high"],
  );
  const back = drive(state, [k("backspace"), k("backspace")]);
  assert.equal(back.state.query, "");
  assert.equal(back.state.filtered.length, ITEMS.length);
});

test("↑/↓ move the selection and wrap", () => {
  const start = openListOverlay("t", ITEMS);
  assert.equal(drive(start, [k("down")]).state.index, (start.index + 1) % ITEMS.length);
  assert.equal(drive(start, [k("up"), k("up"), k("up")]).state.index, 4); // 2 → 1 → 0 → wraps to 4
});

test("Enter emits a pick action carrying the item's exact submitText", () => {
  const zeroed = openListOverlay("t", ITEMS);
  const picked = onListKey({ ...zeroed, index: 0 }, k("enter"));
  assert.deepEqual(picked.action, { type: "pick", text: "/think off" });
});

test("Esc closes with no pick", () => {
  assert.deepEqual(drive(undefined, [k("esc")]).action, { type: "close" });
});

test("Ctrl-C also closes with no pick", () => {
  assert.deepEqual(drive(undefined, [k("ctrl-c")]).action, { type: "close" });
});

test("empty filter result renders '(no matches)' and Enter is a no-op, never a stale pick", () => {
  const none = drive(
    undefined,
    "zzzznope".split("").map((ch) => k("char", ch)),
  );
  assert.equal(none.state.filtered.length, 0);
  const out = renderListOverlay(none.state, 60, 15, "none").map(strip).join("\n");
  assert.match(out, /no matches/);
  assert.deepEqual(onListKey(none.state, k("enter")).action, { type: "none" });
});

test("render shows the title, the current marker, and never exceeds cols at several sizes", () => {
  const state = openListOverlay("Reasoning effort", ITEMS);
  for (const [cols, rows] of [
    [60, 15],
    [120, 40],
    [40, 8],
  ] as const) {
    const lines = renderListOverlay(state, cols, rows, "none");
    for (const line of lines) {
      assert.ok(
        stringWidth(strip(line)) <= cols,
        `line exceeds ${cols}: ${JSON.stringify(strip(line))}`,
      );
    }
  }
  const out = renderListOverlay(state, 80, 20, "none").map(strip).join("\n");
  assert.match(out, /Reasoning effort/);
  assert.match(out, /← current/);
  assert.match(out, /↑↓ move · Enter select · Esc cancel/);
});

test("a long list (e.g. the full command registry) scrolls without crashing or overflowing", () => {
  const many: ListOverlayItem[] = Array.from({ length: 170 }, (_, i) => ({
    label: `/cmd${i}`,
    detail: `command number ${i}`,
    submitText: `/cmd${i}`,
  }));
  const start = openListOverlay("Commands", many);
  const moved = drive(
    start,
    Array.from({ length: 100 }, () => k("down")),
  );
  const lines = renderListOverlay(moved.state, 80, 20, "none");
  for (const line of lines) assert.ok(stringWidth(strip(line)) <= 80);
  assert.ok(lines.length <= 20);
});
