/**
 * appearance-view.test.ts — pure Appearance display helpers (file 13 §3.2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PREVIEW_EDITOR, PREVIEW_TERMINAL, swatchTile } from "./appearance-view.js";

test("swatchTile pulls 3 surface bars + accent + brand from a color map", () => {
  const tile = swatchTile({
    "bg-app": "#101317",
    "bg-surface": "#161a1f",
    "bg-surface-2": "#1c2127",
    accent: "#22d3ee",
    brand: "#a855f7",
  });
  assert.deepEqual(tile.bars, ["#101317", "#161a1f", "#1c2127"]);
  assert.equal(tile.accent, "#22d3ee");
  assert.equal(tile.brand, "#a855f7");
});

test("swatchTile tolerates a sparse color map", () => {
  const tile = swatchTile({ "bg-app": "#000000" });
  assert.equal(tile.bars[0], "#000000");
  assert.equal(tile.accent, "");
});

test("the editor preview includes a nemesis-flagged danger line (verdict legibility visible)", () => {
  const flagged = PREVIEW_EDITOR.find((l) => l.role === "danger");
  assert.ok(
    flagged,
    "preview must show a verdict-colored line so security legibility is checkable",
  );
  assert.match(flagged?.text ?? "", /PROM-OS-EXEC/);
  assert.ok(PREVIEW_TERMINAL.some((l) => l.role === "ok"));
});
