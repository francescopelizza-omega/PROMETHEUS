/**
 * frame.test.ts — full-frame composition: box, dropdown placement, cursor offset,
 * bypass border, narrow-terminal collapse, width rule.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { syncAutocomplete } from "./autocomplete.js";
import type { AcItem } from "./autocomplete.js";
import { type FrameInput, renderFrame } from "./frame.js";
import { initialTuiState } from "./reducer.js";
import type { StatusModel } from "./status.js";

const STATUS: StatusModel = {
  permMode: "default",
  model: "qwen",
  modelSource: "local",
  tools: true,
  gate: "enforce",
  dryRun: false,
  profile: "default",
  cwd: "~/p",
};

const ITEMS: AcItem[] = [
  { name: "scan", summary: "scan" },
  { name: "status", summary: "status" },
];

const base = (over: Partial<FrameInput> = {}): FrameInput => ({
  state: initialTuiState(),
  status: STATUS,
  caps: "none",
  cols: 60,
  rows: 24,
  ...over,
});

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

test("default frame: box + status, caret inside the box", () => {
  const f = renderFrame(base({ state: initialTuiState({ input: "hi", cursor: 2 }) }));
  assert.ok(f.lines[0]?.includes("╭"));
  // a body row holds the prompt + text
  assert.ok(f.lines.some((l) => strip(l).includes("› hi")));
  // status bar present below the box
  assert.ok(f.lines.some((l) => strip(l).includes("[PROM:DEFAULT]")));
  assert.equal(f.cursorRow, 1); // top border row 0, body row 1
  assert.equal(f.cursorCol, 4 + 2); // text col 4 + caret 2
});

test("every line stays within cols-1 (magic-margin guard)", () => {
  const f = renderFrame(base({ cols: 40, state: initialTuiState({ input: "x".repeat(100) }) }));
  for (const l of f.lines) assert.ok([...strip(l)].length <= 40 - 1, `line ≤ cols-1: ${strip(l)}`);
});

test("open dropdown renders ABOVE the box and pushes the caret down", () => {
  const ac = syncAutocomplete("/s", 2, ITEMS);
  const f = renderFrame(base({ state: initialTuiState({ input: "/s", cursor: 2, ac }) }));
  // first lines are dropdown rows (contain command names), box comes after
  const boxTop = f.lines.findIndex((l) => l.includes("╭"));
  assert.ok(boxTop >= 1, "dropdown occupies rows above the box");
  assert.ok(strip(f.lines.slice(0, boxTop).join("\n")).includes("scan"));
  assert.equal(f.cursorRow, boxTop + 1);
});

test("bypass mode tints the box border danger (red)", () => {
  const f = renderFrame(
    base({ caps: "truecolor", state: initialTuiState({ permMode: "bypassPermissions" }) }),
  );
  // the danger role (red.400 #f85149-ish) appears on the top border line
  assert.match(f.lines[0] ?? "", /38;2;/);
  // and the bypass indicator shows in the status block
  assert.ok(f.lines.some((l) => strip(l).includes("⏵⏵ bypass permissions on")));
});

test("narrow terminal collapses to a single prompt line", () => {
  const f = renderFrame(base({ cols: 18, state: initialTuiState({ input: "hi", cursor: 2 }) }));
  assert.equal(f.lines.length, 1);
  assert.equal(strip(f.lines[0] ?? ""), "› hi");
  assert.equal(f.cursorCol, 4); // "› " + caret 2
  assert.equal(f.cursorRow, 0);
});

test("narrow collapse clamps a long line to cols-1 + the caret within bounds", () => {
  const f = renderFrame(
    base({ cols: 18, state: initialTuiState({ input: "x".repeat(100), cursor: 100 }) }),
  );
  assert.equal(f.lines.length, 1);
  assert.ok([...strip(f.lines[0] ?? "")].length <= 18 - 1, "collapsed line never exceeds cols-1");
  assert.ok(f.cursorCol <= 18 - 1, "caret stays on-screen");
});
