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

/* ───────── the model-browser additions: detail pane, status, blocked rows ───────── */

test("a highlighted row's BODY is shown below the list; other rows' bodies are not", () => {
  /**
   * One line cannot carry what a person needs to choose a model: the size, the quantisation,
   * the licence, whether it fits this machine. The pane is per-row and follows the highlight.
   */
  const items = [
    { label: "a", submitText: "/x a", body: ["size 4.1 GB", "Apache-2.0"] },
    { label: "b", submitText: "/x b", body: ["size 22.6 GB", "MIT"] },
  ];
  const first = strip(
    renderListOverlay(openListOverlay("Models", items), 60, 15, "none").join("\n"),
  );
  assert.match(first, /size 4\.1 GB/);
  assert.doesNotMatch(first, /22\.6 GB/, "only the highlighted row's body is drawn");

  const moved = onListKey(openListOverlay("Models", items), k("down")).state;
  assert.match(strip(renderListOverlay(moved, 60, 15, "none").join("\n")), /size 22\.6 GB/);
});

test("a DISABLED row cannot be picked, and says why instead of its body", () => {
  /**
   * A model too large for this machine stays visible — hiding it invites "why isn't X listed?" —
   * but Enter does nothing. Submitting it would fail only after a 20 GB download.
   */
  const items = [
    {
      label: "huge",
      submitText: "/x huge",
      body: ["ignored"],
      disabled: "needs 64 GB RAM; this machine has 36 GB",
    },
  ];
  const state = openListOverlay("Models", items);
  const r = onListKey(state, k("enter"));
  assert.deepEqual(r.action, { type: "none" }, "Enter on a blocked row does nothing");
  const out = strip(renderListOverlay(state, 70, 15, "none").join("\n"));
  assert.match(out, /needs 64 GB RAM/);
  assert.doesNotMatch(out, /ignored/, "the reason replaces the body");
});

test("a STATUS line distinguishes `no matches` from `the source was unreachable`", () => {
  // In an empty list those two look identical, and only one of them is the filter's fault.
  const out = strip(
    renderListOverlay(
      openListOverlay("Models", [], "HuggingFace unreachable — showing nothing"),
      60,
      12,
      "none",
    ).join("\n"),
  );
  assert.match(out, /HuggingFace unreachable/);
  assert.match(out, /\(no matches\)/);
});

test("the detail pane never squeezes the list below three rows", () => {
  /**
   * The pane and the list compete for the same budget. An item with a long body must not make
   * the overlay unnavigable — the list keeps at least three rows, whatever the body asks for.
   */
  const body = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const items = Array.from({ length: 8 }, (_, i) => ({
    label: `m${i}`,
    submitText: `/x ${i}`,
    body,
  }));
  const lines = renderListOverlay(openListOverlay("Models", items), 60, 10, "none").map(strip);
  const rowLines = lines.filter((l) => /\bm\d\b/.test(l));
  assert.ok(rowLines.length >= 3, `list kept ${rowLines.length} rows`);
  assert.ok(lines.length <= 10, `stayed within the ${10}-row budget, used ${lines.length}`);
});

test("the pane costs nothing when no item has a body — every existing picker is unchanged", () => {
  const plain = [{ label: "a", submitText: "/x a" }];
  const before = renderListOverlay(openListOverlay("t", plain), 40, 12, "none");
  assert.ok(before.every((l) => !l.includes("undefined")));
  // Same shape as it has always produced: title, filter, one row, hint.
  assert.equal(before.length, 4);
});
