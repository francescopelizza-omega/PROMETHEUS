// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * test-view.ts — PURE Test Explorer display helpers (file 14 §3.19).
 *
 * The authoritative discover/run/coverage roll-up lives in @prometheus/engine-bridge
 * (test.types, tested there) + the testmgr.py sidecar; results reach the renderer over
 * window.prometheus (C5 sandbox — the renderer imports neither core nor engine-bridge).
 * This owns the renderer's DISPLAY concerns (status glyph, tree filter, stat line),
 * node:test-tested without a DOM.
 */

export type TestState = "running" | "pass" | "fail" | "skip" | "error" | "pending";

/** A test node as the renderer receives it (mirrors engine-bridge TestNode + a state). */
export interface TestNodeView {
  id: string;
  kind: "dir" | "file" | "class" | "case";
  label: string;
  file: string;
  line?: number;
  state?: TestState;
  /** the run's failure/skip message for a case (streamed per-test event, APP-014). */
  message?: string;
  children?: TestNodeView[];
}

export interface TestStatsView {
  total: number;
  pass: number;
  fail: number;
  skip: number;
  error: number;
}

const GLYPH: Record<TestState, string> = {
  pass: "✓",
  fail: "✖",
  error: "⚠",
  skip: "○",
  running: "⧖",
  pending: "·",
};

/** The gutter/tree status glyph for a node state (default pending). */
export function statusGlyph(state: TestState | undefined): string {
  return GLYPH[state ?? "pending"];
}

/** Apply per-case states to a tree, rolling parents up to their worst case. */
const RANK: Record<TestState, number> = {
  error: 6,
  fail: 5,
  running: 4,
  skip: 3,
  pending: 2,
  pass: 1,
};
export function applyStates(
  node: TestNodeView,
  states: ReadonlyMap<string, TestState>,
  messages?: ReadonlyMap<string, string>,
): TestNodeView {
  if (node.kind === "case") {
    const message = messages?.get(node.id);
    return { ...node, state: states.get(node.id) ?? "pending", ...(message ? { message } : {}) };
  }
  const children = (node.children ?? []).map((c) => applyStates(c, states, messages));
  const worst = children
    .map((c) => c.state ?? "pending")
    .reduce<TestState>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "pass");
  return { ...node, state: children.length ? worst : "pending", children };
}

/** Count leaf-case states for the panel header. */
export function computeStats(roots: readonly TestNodeView[]): TestStatsView {
  const stats: TestStatsView = { total: 0, pass: 0, fail: 0, skip: 0, error: 0 };
  const visit = (n: TestNodeView) => {
    if (n.kind === "case") {
      stats.total += 1;
      const s = n.state;
      if (s === "pass" || s === "fail" || s === "skip" || s === "error") stats[s] += 1;
    }
    for (const c of n.children ?? []) visit(c);
  };
  for (const r of roots) visit(r);
  return stats;
}

/** Prune the tree to cases matching `query` (by label/id) + keep their ancestors. */
export function filterTests(roots: readonly TestNodeView[], query: string): TestNodeView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...roots];
  const prune = (n: TestNodeView): TestNodeView | null => {
    if (n.kind === "case") {
      return `${n.label} ${n.id}`.toLowerCase().includes(q) ? { ...n } : null;
    }
    const kids = (n.children ?? []).map(prune).filter((c): c is TestNodeView => c !== null);
    return kids.length ? { ...n, children: kids } : null;
  };
  return roots.map(prune).filter((n): n is TestNodeView => n !== null);
}

/** The header summary line, e.g. "12 passed · 1 failed · 1 skipped (14)". */
export function statLine(stats: TestStatsView): string {
  const parts: string[] = [];
  if (stats.pass) parts.push(`${stats.pass} passed`);
  if (stats.fail) parts.push(`${stats.fail} failed`);
  if (stats.error) parts.push(`${stats.error} errored`);
  if (stats.skip) parts.push(`${stats.skip} skipped`);
  return `${parts.join(" · ") || "no results"} (${stats.total})`;
}

/** Case ids that failed/errored (the "rerun failed" input). */
export function failedCaseIds(roots: readonly TestNodeView[]): string[] {
  const out: string[] = [];
  const visit = (n: TestNodeView) => {
    if (n.kind === "case" && (n.state === "fail" || n.state === "error")) out.push(n.id);
    for (const c of n.children ?? []) visit(c);
  };
  for (const r of roots) visit(r);
  return out;
}
