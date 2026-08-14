/**
 * overlay.test.ts — `clampToViewport`, the one that replaced four hand-rolled copies (§9.2).
 *
 * Each of the four had a different bug and they are all pinned here: two clamped only the
 * FAR edge (so a right-click near the top-left placed a menu at a negative offset), the SSR
 * fallbacks disagreed (`none` / `1024×768` / a `9999` sentinel that silently disabled the
 * clamp), and the paddings were `4`, `8`, and nothing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { clampToViewport } from "./primitives/overlay.js";

/** Install a fake viewport; `restore()` puts the environment back. */
function viewport(w: number, h: number): void {
  (globalThis as { window?: unknown }).window = { innerWidth: w, innerHeight: h };
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = undefined;
});

test("a layer that fits is left where it was asked for", () => {
  viewport(1200, 800);
  assert.deepEqual(clampToViewport(100, 100, 200, 300), { x: 100, y: 100 });
});

test("clamps the FAR edge — a bottom-right click keeps the whole layer on screen", () => {
  viewport(1000, 600);
  // 980 + 200 would run 180px off the right; 590 + 300 would run 290px off the bottom.
  assert.deepEqual(clampToViewport(980, 590, 200, 300), { x: 792, y: 292 });
});

test("clamps the NEAR edge too — the bug two of the four copies had", () => {
  viewport(1000, 600);
  assert.deepEqual(clampToViewport(-40, -10, 200, 300), { x: 8, y: 8 });
});

test("pad is honoured on both edges and is configurable", () => {
  viewport(1000, 600);
  assert.deepEqual(clampToViewport(0, 0, 100, 100, 20), { x: 20, y: 20 });
  assert.deepEqual(clampToViewport(9999, 9999, 100, 100, 20), { x: 880, y: 480 });
});

test("on a viewport SMALLER than the layer, the near edge wins", () => {
  // A clipped bottom is recoverable (scroll/resize); a negative offset is not — the layer's
  // first row, which is where a menu's first item lives, would be unreachable.
  viewport(120, 90);
  assert.deepEqual(clampToViewport(50, 50, 400, 400), { x: 8, y: 8 });
});

test("returns integers (a fractional `left` blurs text on a non-retina display)", () => {
  viewport(1000, 600);
  const r = clampToViewport(10.4, 10.6, 100, 100);
  assert.equal(Number.isInteger(r.x), true);
  assert.equal(Number.isInteger(r.y), true);
  assert.deepEqual(r, { x: 10, y: 11 });
});

test("under SSR (no window) the input passes through, bounded only by pad", () => {
  (globalThis as { window?: unknown }).window = undefined;
  assert.deepEqual(clampToViewport(500, 400, 200, 200), { x: 500, y: 400 });
  assert.deepEqual(clampToViewport(-99, -99, 200, 200), { x: 8, y: 8 });
});
