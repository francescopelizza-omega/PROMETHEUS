// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * pie.ts — pie slice geometry, pure. Angles start at 12 o'clock and run clockwise; a single
 * slice is drawn as two half-arcs, because one SVG arc cannot start and end on the same point.
 */
export interface PieSlice {
  key: string;
  fraction: number;
  start: number;
  end: number;
  /** the SVG path for this slice */
  d: string;
}

const TAU = Math.PI * 2;

function point(cx: number, cy: number, r: number, angle: number): string {
  const x = cx + r * Math.sin(angle);
  const y = cy - r * Math.cos(angle);
  return `${x.toFixed(3)} ${y.toFixed(3)}`;
}

export function pieSlices(
  items: readonly { key: string; value: number }[],
  cx: number,
  cy: number,
  r: number,
): PieSlice[] {
  const live = items.filter((i) => i.value > 0);
  const total = live.reduce((a, b) => a + b.value, 0);
  if (total <= 0) return [];
  if (live.length === 1) {
    const only = live[0] as { key: string };
    return [
      {
        key: only.key,
        fraction: 1,
        start: 0,
        end: TAU,
        d: `M ${point(cx, cy, r, 0)} A ${r} ${r} 0 1 1 ${point(cx, cy, r, Math.PI)} A ${r} ${r} 0 1 1 ${point(cx, cy, r, 0)} Z`,
      },
    ];
  }
  const out: PieSlice[] = [];
  let start = 0;
  live.forEach((item, idx) => {
    const fraction = item.value / total;
    const end = idx === live.length - 1 ? TAU : start + fraction * TAU;
    const large = end - start > Math.PI ? 1 : 0;
    out.push({
      key: item.key,
      fraction,
      start,
      end,
      d: `M ${cx} ${cy} L ${point(cx, cy, r, start)} A ${r} ${r} 0 ${large} 1 ${point(cx, cy, r, end)} Z`,
    });
    start = end;
  });
  return out;
}
