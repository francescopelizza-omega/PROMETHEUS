/**
 * health-view.test.ts — the pure health-visual math (Reliability & Polish pack).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampScore,
  ringGeometry,
  scoreBand,
  scoreRole,
  statusGlyph,
  statusRole,
  tierGlyph,
  tierRole,
} from "./health-view.js";

test("clampScore bounds + rounds to 0..100", () => {
  assert.equal(clampScore(-5), 0);
  assert.equal(clampScore(150), 100);
  assert.equal(clampScore(73.6), 74);
});

test("scoreBand / scoreRole: ≥80 ok · ≥50 warn · else danger", () => {
  assert.equal(scoreBand(100), "ok");
  assert.equal(scoreBand(80), "ok");
  assert.equal(scoreBand(79), "warn");
  assert.equal(scoreBand(50), "warn");
  assert.equal(scoreBand(49), "danger");
  assert.equal(scoreRole(10), "danger");
});

test("tier + status glyphs/roles (never color-only)", () => {
  assert.equal(tierGlyph("ok"), "●");
  assert.equal(tierGlyph("degraded"), "▲");
  assert.equal(tierGlyph("down"), "⛔");
  assert.equal(tierRole("down"), "danger");
  assert.equal(statusGlyph("ok"), "✓");
  assert.equal(statusGlyph("unknown"), "•");
  assert.equal(statusRole("ok"), "ok");
  assert.equal(statusRole("degraded"), "warn");
  assert.equal(statusRole("down"), "danger");
  assert.equal(statusRole("unknown"), "text-secondary");
});

test("ringGeometry: circumference = 2πr; dashOffset shrinks as the score rises", () => {
  const r = 40;
  const circ = 2 * Math.PI * r;
  assert.ok(Math.abs(ringGeometry(0, r).circumference - circ) < 1e-9);
  assert.ok(
    Math.abs(ringGeometry(0, r).dashOffset - circ) < 1e-9,
    "score 0 → full offset (empty arc)",
  );
  assert.ok(Math.abs(ringGeometry(100, r).dashOffset) < 1e-9, "score 100 → zero offset (full arc)");
  assert.ok(Math.abs(ringGeometry(50, r).dashOffset - circ / 2) < 1e-9);
});
