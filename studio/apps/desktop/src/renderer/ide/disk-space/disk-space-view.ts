// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * disk-space-view.ts — the Disk Space panel's pure view logic.
 *
 * Colour follows the dataviz rules this repo's chart tokens were validated for: the pie uses
 * the categorical slots `--chart-1..7` in FIXED order with an eighth "Other" slice in
 * `--chart-other` (a ninth hue is never generated); the treemap is ONE hue (`--chart-1`)
 * mixed toward the surface by size, a sequential scale — not a rainbow — because tiles touch on
 * every side and no categorical palette stays distinguishable across all neighbours.
 */
import type { DiskNodeView } from "../../../shared/ipc-contract.js";

export type Slot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | "other";

export interface Slice {
  key: string;
  name: string;
  path: string;
  size: number;
  slot: Slot;
}

const MAX_NAMED = 7;

/** The biggest children, each with its fixed slot, the rest folded into one "Other" slice. */
export function topSlices(children: readonly DiskNodeView[]): Slice[] {
  const sorted = [...children].filter((c) => c.size > 0).sort((a, b) => b.size - a.size);
  const named = sorted.slice(0, MAX_NAMED).map((c, i) => ({
    key: c.path,
    name: c.name,
    path: c.path,
    size: c.size,
    slot: (i + 1) as Slot,
  }));
  const rest = sorted.slice(MAX_NAMED);
  if (rest.length > 0) {
    named.push({
      key: "__other__",
      name: `${rest.length} more`,
      path: "",
      size: rest.reduce((a, b) => a + b.size, 0),
      slot: "other",
    });
  }
  return named;
}

export function sliceVar(slot: Slot): string {
  return slot === "other" ? "var(--chart-other)" : `var(--chart-${slot})`;
}

/** The treemap's single-hue fill: 40% → 100% of `--chart-1` over the surface, by size share. */
export function seqFill(share: number): string {
  const s = Math.max(0, Math.min(1, share));
  const pct = Math.round(40 + 60 * Math.sqrt(s));
  return `color-mix(in oklab, var(--chart-1) ${pct}%, var(--bg-surface))`;
}

export interface Row {
  name: string;
  path: string;
  rawPath?: string;
  size: number;
  /** share of the parent, 0–100 */
  pct: number;
  dir: boolean;
  items?: number;
  note: string;
}

export function childRows(node: DiskNodeView): Row[] {
  return [...(node.children ?? [])]
    .sort((a, b) => b.size - a.size)
    .map((c) => ({
      name: c.name,
      path: c.path,
      ...(c.rawPath ? { rawPath: c.rawPath } : {}),
      size: c.size,
      pct: node.size > 0 ? Math.round((1000 * c.size) / node.size) / 10 : 0,
      dir: c.dir,
      ...(c.items !== undefined ? { items: c.items } : {}),
      note: [
        c.mount ? "other filesystem" : "",
        c.unreadable ? "unreadable" : "",
        c.frontier || c.truncated ? "deeper not measured" : "",
      ]
        .filter(Boolean)
        .join(", "),
    }));
}

export function findNode(tree: DiskNodeView, path: string): DiskNodeView | undefined {
  if (tree.path === path) return tree;
  for (const c of tree.children ?? []) {
    if (path === c.path || path.startsWith(`${c.path.replace(/\/$/, "")}/`)) {
      const hit = findNode(c, path);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** The path of the node holding `path`, or undefined at the root (or when it is not found). */
export function parentPath(tree: DiskNodeView, path: string): string | undefined {
  for (const c of tree.children ?? []) {
    if (c.path === path) return tree.path;
    if (path.startsWith(`${c.path.replace(/\/$/, "")}/`)) return parentPath(c, path);
  }
  return undefined;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[u]}`;
}
