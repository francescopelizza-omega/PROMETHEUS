/**
 * invoke-overlay.test.ts — the pure `/invoke` arrow-nav overlay (CLI-059): filter, key nav, the
 * Enter→args→dispatch flow, Esc close, and width-clamped rendering at 60×15 / 120×40.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { setColorEnabled } from "../render.js";
import {
  type InvokeItem,
  onInvokeKey,
  openInvokeOverlay,
  renderInvokeOverlay,
} from "./invoke-overlay.js";
import type { KeyEvent } from "./keys.js";
import { stringWidth } from "./width.js";

setColorEnabled(false);
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const k = (name: KeyEvent["name"], ch?: string): KeyEvent => (ch ? { name, ch } : { name });

const ITEMS: InvokeItem[] = [
  { name: "nemesis", summary: "security scanner", presence: "present" },
  { name: "gate-check", summary: "gate a directory", presence: "absent" },
  { name: "gatekeeper", summary: "another gate tool", presence: "unknown" },
  { name: "remnutrition", summary: "diet engine", presence: "absent" },
];

/** Feed a sequence of keys, returning the final state + the LAST action. */
function drive(state = openInvokeOverlay(ITEMS), keys: KeyEvent[] = []) {
  let s = state;
  let action = { type: "none" } as ReturnType<typeof onInvokeKey>["action"];
  for (const key of keys) {
    const r = onInvokeKey(s, key);
    s = r.state;
    action = r.action;
  }
  return { state: s, action };
}

test("typing 'gate' isolates the gate-related entries (CLI-059)", () => {
  const { state } = drive(undefined, [..."gate".split("").map((ch) => k("char", ch))]);
  const names = state.filtered.map((i) => i.name);
  assert.ok(names.includes("gate-check"));
  assert.ok(names.includes("gatekeeper"));
  assert.ok(!names.includes("remnutrition"), "unrelated entries filtered out");
  // backspace widens the filter again.
  const back = drive(state, [k("backspace"), k("backspace"), k("backspace"), k("backspace")]);
  assert.equal(back.state.query, "");
  assert.equal(back.state.filtered.length, ITEMS.length);
});

test("↑/↓ move the selection and wrap (CLI-059)", () => {
  const start = openInvokeOverlay(ITEMS);
  assert.equal(start.index, 0);
  assert.equal(drive(start, [k("down")]).state.index, 1);
  assert.equal(drive(start, [k("up")]).state.index, ITEMS.length - 1); // wraps up
  assert.equal(drive(start, [k("down"), k("down"), k("down"), k("down")]).state.index, 0); // wraps down
});

test("Enter → args stage → typed args → dispatch action (CLI-059)", () => {
  // filter to gatekeeper, select it, type args, run.
  const filtered = drive(
    undefined,
    "gatekeep".split("").map((ch) => k("char", ch)),
  );
  assert.equal(filtered.state.filtered[0]?.name, "gatekeeper");
  const selected = drive(filtered.state, [k("enter")]);
  assert.equal(selected.state.stage, "args");
  assert.equal(selected.state.selected, "gatekeeper");
  const typed = drive(selected.state, [k("char", "-"), k("char", "y")]);
  const run = onInvokeKey(typed.state, k("enter"));
  assert.deepEqual(run.action, { type: "dispatch", name: "gatekeeper", args: "-y" });
});

test("Esc closes with no dispatch, from either stage (CLI-059)", () => {
  assert.deepEqual(drive(undefined, [k("esc")]).action, { type: "close" });
  const inArgs = drive(undefined, [k("enter")]).state; // now in args stage
  assert.deepEqual(onInvokeKey(inArgs, k("esc")).action, { type: "close" });
});

test("render never exceeds cols at 60×15 and 120×40, and after a resize (CLI-059)", () => {
  const state = drive(undefined, [k("down")]).state; // a selection row present
  for (const [cols, rows] of [
    [60, 15],
    [120, 40],
    [40, 8],
  ] as const) {
    for (const line of renderInvokeOverlay(state, cols, rows, "none")) {
      assert.ok(
        stringWidth(strip(line)) <= cols,
        `line exceeds ${cols}: ${JSON.stringify(strip(line))}`,
      );
    }
  }
  // resize repaint is pure-from-state: same state, different size → still clamped.
  const narrow = renderInvokeOverlay(state, 30, 6, "none");
  for (const line of narrow) assert.ok(stringWidth(strip(line)) <= 30);
});

test("render: args stage shows the selected name + typed args (CLI-059)", () => {
  const inArgs = drive(undefined, [k("enter")]).state;
  const typed = drive(inArgs, [k("char", "x")]).state;
  const out = renderInvokeOverlay(typed, 80, 12, "none").map(strip).join("\n");
  assert.match(out, /args: x/);
  assert.match(out, /Enter run · Esc cancel/);
});

test("empty filter result renders '(no matches)' without crashing (CLI-059)", () => {
  const none = drive(
    undefined,
    "zzzznope".split("").map((ch) => k("char", ch)),
  );
  assert.equal(none.state.filtered.length, 0);
  const out = renderInvokeOverlay(none.state, 60, 15, "none").map(strip).join("\n");
  assert.match(out, /no matches/);
  // Enter with no selection is a no-op (no dispatch, stays in list).
  assert.deepEqual(onInvokeKey(none.state, k("enter")).action, { type: "none" });
});
