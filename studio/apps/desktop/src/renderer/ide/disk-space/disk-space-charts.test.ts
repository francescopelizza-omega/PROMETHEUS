// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiskNodeView } from "../../../shared/ipc-contract.js";
import {
  childRows,
  findNode,
  parentPath,
  seqFill,
  sliceVar,
  topSlices,
} from "./disk-space-view.js";
import { pieSlices } from "./pie.js";
import { squarify } from "./treemap.js";

const R = { x: 0, y: 0, w: 400, h: 200 };

test("treemap: every tile inside the box, areas proportional, no overlaps, biggest first", () => {
  const items = [
    { key: "a", value: 60 },
    { key: "b", value: 25 },
    { key: "c", value: 10 },
    { key: "d", value: 5 },
    { key: "zero", value: 0 },
  ];
  const tiles = squarify(items, R);
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["a", "b", "c", "d"],
  );
  const total = R.w * R.h;
  for (const t of tiles) {
    assert.ok(
      t.x >= -1e-6 && t.y >= -1e-6 && t.x + t.w <= R.w + 1e-6 && t.y + t.h <= R.h + 1e-6,
      t.key,
    );
    const want = (items.find((i) => i.key === t.key)?.value ?? 0) / 100;
    assert.ok(Math.abs((t.w * t.h) / total - want) < 1e-6, t.key);
  }
  for (const a of tiles) {
    for (const b of tiles) {
      if (a === b) continue;
      const overlap =
        Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 &&
        Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
      assert.equal(overlap, false, `${a.key}/${b.key}`);
    }
  }
});

test("treemap: squarified tiles stay close to square", () => {
  const tiles = squarify(
    Array.from({ length: 12 }, (_, i) => ({ key: String(i), value: 12 - i })),
    R,
  );
  const worst = Math.max(...tiles.map((t) => Math.max(t.w / t.h, t.h / t.w)));
  assert.ok(worst < 6, `worst aspect ${worst}`);
});

test("treemap: nothing to draw is an empty list", () => {
  assert.deepEqual(squarify([], R), []);
  assert.deepEqual(squarify([{ key: "a", value: 0 }], R), []);
});

test("pie: fractions sum to one, slices are contiguous, a lone slice is a full disc", () => {
  const s = pieSlices(
    [
      { key: "a", value: 3 },
      { key: "b", value: 1 },
    ],
    50,
    50,
    40,
  );
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s.reduce((n, x) => n + x.fraction, 0) - 1) < 1e-9);
  assert.equal(s[0]?.start, 0);
  assert.ok(Math.abs((s[0]?.end ?? 0) - (s[1]?.start ?? -1)) < 1e-9);
  assert.ok(Math.abs((s[1]?.end ?? 0) - Math.PI * 2) < 1e-9);
  for (const x of s) assert.match(x.d, /^M /);
  const lone = pieSlices([{ key: "a", value: 5 }], 50, 50, 40);
  assert.equal(lone.length, 1);
  assert.match(lone[0]?.d ?? "", /A 40 40 0 1 1 .* A 40 40 0 1 1/);
});

const node = (name: string, size: number, children?: DiskNodeView[]): DiskNodeView => ({
  name,
  path: `/r/${name}`,
  size,
  dir: true,
  ...(children ? { children } : {}),
});

test("top slices: eight fixed slots at most — the 8th is Other, holding the rest", () => {
  const kids = Array.from({ length: 10 }, (_, i) => node(`k${i}`, 100 - i));
  const sl = topSlices(kids);
  assert.equal(sl.length, 8);
  assert.deepEqual(
    sl.slice(0, 7).map((s) => s.slot),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(sl[7]?.slot, "other");
  assert.equal(sl[7]?.size, 93 + 92 + 91);
  assert.equal(sliceVar(3), "var(--chart-3)");
  assert.equal(sliceVar("other"), "var(--chart-other)");
});

test("rows carry share of the parent; finding and climbing the tree", () => {
  const deep = node("deep", 70);
  deep.path = "/r/a/deep";
  const tree = node("root", 100, [node("a", 75, [deep]), node("b", 25)]);
  tree.path = "/r";
  const rows = childRows(tree);
  assert.deepEqual(
    rows.map((r) => [r.name, r.pct]),
    [
      ["a", 75],
      ["b", 25],
    ],
  );
  assert.equal(findNode(tree, "/r/a/deep")?.name, "deep");
  assert.equal(findNode(tree, "/nope"), undefined);
  assert.equal(parentPath(tree, "/r/a/deep"), "/r/a");
  assert.equal(parentPath(tree, "/r"), undefined);
});

test("treemap fill is ONE hue, stronger for bigger tiles (sequential, never a rainbow)", () => {
  const big = seqFill(1);
  const small = seqFill(0.01);
  assert.match(big, /var\(--chart-1\)/);
  assert.match(small, /var\(--chart-1\)/);
  assert.notEqual(big, small);
});
