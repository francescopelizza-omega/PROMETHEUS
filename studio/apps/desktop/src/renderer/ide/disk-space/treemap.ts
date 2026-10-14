// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * treemap.ts — squarified treemap layout (Bruls, Huijing & van Wijk), pure.
 *
 * Area is proportional to value; rows are laid along the shorter side and a row is closed when
 * adding the next item would worsen its worst aspect ratio, which keeps tiles near-square and so
 * comparable by eye. Items with no size are dropped — a zero-area tile is not a tile.
 */
export interface TreemapItem {
  key: string;
  value: number;
}

export interface TreemapTile {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The worst aspect ratio of a row of areas laid along a side of length `side`. */
function worst(row: readonly number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = side * side;
  return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
}

export function squarify(items: readonly TreemapItem[], rect: Rect): TreemapTile[] {
  const live = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = live.reduce((a, b) => a + b.value, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const areas = live.map((i) => ({ key: i.key, area: i.value * scale }));
  const out: TreemapTile[] = [];
  let free: Rect = { ...rect };
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(free.w, free.h);
    const row: number[] = [(areas[i] as { area: number }).area];
    let j = i + 1;
    while (j < areas.length) {
      const next = (areas[j] as { area: number }).area;
      if (worst([...row, next], side) > worst(row, side)) break;
      row.push(next);
      j += 1;
    }
    const sum = row.reduce((a, b) => a + b, 0);
    const horizontal = free.w >= free.h; // lay the row down the left edge, else along the top
    const thick = sum / side;
    let offset = 0;
    for (let k = i; k < j; k += 1) {
      const a = areas[k] as { key: string; area: number };
      const len = a.area / thick;
      out.push(
        horizontal
          ? { key: a.key, x: free.x, y: free.y + offset, w: thick, h: len }
          : { key: a.key, x: free.x + offset, y: free.y, w: len, h: thick },
      );
      offset += len;
    }
    free = horizontal
      ? { x: free.x + thick, y: free.y, w: free.w - thick, h: free.h }
      : { x: free.x, y: free.y + thick, w: free.w, h: free.h - thick };
    i = j;
  }
  return out;
}
