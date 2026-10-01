// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * test.types.ts — the Test Explorer contract (file 14 §3.19), PURE types + helpers.
 *
 * The test-runner sidecar (`testmgr.py`, C7) discovers + runs tests under the selected
 * env and streams results as JSON-lines (parsed by the bridge into `TestRunEvent`s); a
 * `coverage` verb returns a `CoverageReport`. THIS module is the dependency-free model +
 * the pure roll-up/coverage math the Test tool window renders — it never spawns and
 * never decides "safe" (C5): the first test run crosses the run-gate elsewhere.
 */

/** A node in the discovered test tree (§3.19). */
export interface TestNode {
  id: string; // stable id, e.g. "tests/test_app.py::TestX::test_y"
  kind: "dir" | "file" | "class" | "case";
  label: string;
  file: string;
  line?: number;
  children?: TestNode[];
}

/** The state of a single test as it runs (§3.19). */
export type TestState = "running" | "pass" | "fail" | "skip" | "error";

/** One streamed test-run event (JSON-line from `testmgr.py run`). */
export interface TestRunEvent {
  node: string; // a TestNode.id
  state: TestState;
  durMs?: number;
  message?: string;
  /** failed-assertion diff (rendered in the Monaco diff editor, §3.19). */
  diff?: { expected: string; actual: string };
}

/**
 * The terminal `{ok, command, summary}` envelope `testmgr.py run`/`rerun-failed`
 * emit LAST (after the streamed per-test JSON-lines), aligned to the real sidecar
 * output (CLI-006). A positive `--timeout` sets `timedOut` + the offending id.
 */
export interface TestRunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  exitCode: number;
  durationMs: number;
  /** present only when pytest collected nothing (exit 5). */
  collected?: number;
  /** true when the run was killed by `--timeout`. */
  timedOut?: boolean;
  /** the timed-out test id when exactly one was requested, else null. */
  timedOutId?: string | null;
}

/** The terminal run envelope (the LAST JSON object on stdout for a `run`). */
export interface TestRunEnvelope {
  ok: boolean;
  command: "run" | "rerun-failed";
  summary: TestRunSummary;
  /** fail-closed error text (unknown framework, timeout, launch failure, …). */
  error?: string;
}

/** Per-file + total coverage (from `testmgr.py coverage` wrapping coverage.py). */
export interface CoverageReport {
  perFile: Record<string, { lines: number[]; missed: number[]; branchPct?: number }>;
  totalPct: number;
}

/** Rolled-up counts for the Test tool window header. */
export interface TestStats {
  total: number;
  pass: number;
  fail: number;
  skip: number;
  error: number;
  running: number;
  pending: number;
}

/** Flatten a test tree depth-first (parents before children). */
export function flattenTestTree(roots: readonly TestNode[]): TestNode[] {
  const out: TestNode[] = [];
  const visit = (n: TestNode) => {
    out.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  for (const r of roots) visit(r);
  return out;
}

/** All leaf test cases (the runnable units) in id order. */
export function testCases(roots: readonly TestNode[]): TestNode[] {
  return flattenTestTree(roots).filter((n) => n.kind === "case");
}

/** Find a node by id anywhere in the tree. */
export function findTestNode(roots: readonly TestNode[], id: string): TestNode | undefined {
  return flattenTestTree(roots).find((n) => n.id === id);
}

/**
 * Apply a stream of run events to a per-case state map (last event wins). Pure: returns
 * a NEW map. Only leaf cases carry state; parents roll up via `rollupStatus`.
 */
export function applyRunEvents(events: readonly TestRunEvent[]): Map<string, TestState> {
  const map = new Map<string, TestState>();
  for (const ev of events) map.set(ev.node, ev.state);
  return map;
}

/** The worst state among a set (error > fail > running > skip > pass) for parent roll-up. */
const STATE_RANK: Record<TestState, number> = { error: 5, fail: 4, running: 3, skip: 2, pass: 1 };
export function worstState(states: readonly TestState[]): TestState | undefined {
  if (states.length === 0) return undefined;
  return states.reduce((acc, s) => (STATE_RANK[s] > STATE_RANK[acc] ? s : acc));
}

/** The effective state of any node (a leaf's own; a parent's = worst of its cases). */
export function nodeState(
  node: TestNode,
  states: ReadonlyMap<string, TestState>,
): TestState | undefined {
  if (node.kind === "case") return states.get(node.id);
  const childStates = testCases([node])
    .map((c) => states.get(c.id))
    .filter((s): s is TestState => s !== undefined);
  return worstState(childStates);
}

/** Roll up pass/fail/skip/error/running counts over all cases (§3.19 header). */
export function rollupStatus(
  roots: readonly TestNode[],
  states: ReadonlyMap<string, TestState>,
): TestStats {
  const cases = testCases(roots);
  const stats: TestStats = {
    total: cases.length,
    pass: 0,
    fail: 0,
    skip: 0,
    error: 0,
    running: 0,
    pending: 0,
  };
  for (const c of cases) {
    const s = states.get(c.id);
    if (s === undefined) stats.pending += 1;
    else stats[s] += 1;
  }
  return stats;
}

/** Case ids that failed or errored — the input to "rerun failed" (§3.19). */
export function rerunFailedIds(
  roots: readonly TestNode[],
  states: ReadonlyMap<string, TestState>,
): string[] {
  return testCases(roots)
    .filter((c) => {
      const s = states.get(c.id);
      return s === "fail" || s === "error";
    })
    .map((c) => c.id);
}

/* ── coverage math (§3.19) ─────────────────────────────────────────────────── */

/** Covered-line fraction for one file (covered / (covered + missed)), 0..1. */
export function fileCoverage(entry: CoverageReport["perFile"][string]): number {
  const covered = entry.lines.length;
  const total = covered + entry.missed.length;
  return total === 0 ? 1 : covered / total;
}

/** Compute the total coverage % across all files (0..100), independent of `totalPct`. */
export function computeTotalCoverage(report: CoverageReport): number {
  let covered = 0;
  let total = 0;
  for (const entry of Object.values(report.perFile)) {
    covered += entry.lines.length;
    total += entry.lines.length + entry.missed.length;
  }
  return total === 0 ? 100 : Math.round((covered / total) * 1000) / 10;
}

/** Whether a specific line is covered/missed/untracked in a file (gutter decoration). */
export function lineCoverage(
  report: CoverageReport,
  file: string,
  line: number,
): "covered" | "missed" | "untracked" {
  const entry = report.perFile[file];
  if (!entry) return "untracked";
  if (entry.missed.includes(line)) return "missed";
  if (entry.lines.includes(line)) return "covered";
  return "untracked";
}

/**
 * Merge two coverage reports (APP-086). Line coverage is the UNION of executed lines
 * (a line covered in EITHER run is covered in the merge), so a line is "missed" in the
 * merge only if it was missed somewhere AND executed nowhere: `missed = (missedA ∪
 * missedB) \ (executedA ∪ executedB)`. Totals are recomputed via computeTotalCoverage
 * (never carried over). branchPct keeps the better (max) of the two when present.
 */
export function mergeCoverageReports(a: CoverageReport, b: CoverageReport): CoverageReport {
  const files = new Set<string>([...Object.keys(a.perFile), ...Object.keys(b.perFile)]);
  const perFile: CoverageReport["perFile"] = {};
  for (const f of files) {
    const ea = a.perFile[f];
    const eb = b.perFile[f];
    const executed = new Set<number>([...(ea?.lines ?? []), ...(eb?.lines ?? [])]);
    const missedCand = new Set<number>([...(ea?.missed ?? []), ...(eb?.missed ?? [])]);
    const lines = [...executed].sort((x, y) => x - y);
    const missed = [...missedCand].filter((l) => !executed.has(l)).sort((x, y) => x - y);
    const entry: CoverageReport["perFile"][string] = { lines, missed };
    if (ea?.branchPct != null || eb?.branchPct != null) {
      entry.branchPct = Math.max(ea?.branchPct ?? 0, eb?.branchPct ?? 0);
    }
    perFile[f] = entry;
  }
  const merged: CoverageReport = { perFile, totalPct: 0 };
  merged.totalPct = computeTotalCoverage(merged);
  return merged;
}

/** One file's covered/uncovered lines as gutter stripes (line-sorted, APP-086). */
export function lineStripes(
  entry: CoverageReport["perFile"][string],
): { line: number; covered: boolean }[] {
  const out: { line: number; covered: boolean }[] = [];
  for (const l of entry.lines) out.push({ line: l, covered: true });
  for (const l of entry.missed) out.push({ line: l, covered: false });
  return out.sort((a, b) => a.line - b.line);
}

/** Per-file rows for the Coverage window, sorted WORST coverage first (APP-086). */
export function coverageRows(
  report: CoverageReport,
): { file: string; pct: number; missed: number }[] {
  return Object.entries(report.perFile)
    .map(([file, entry]) => ({
      file,
      pct: Math.round(fileCoverage(entry) * 1000) / 10,
      missed: entry.missed.length,
    }))
    .sort((a, b) => a.pct - b.pct || a.file.localeCompare(b.file));
}
