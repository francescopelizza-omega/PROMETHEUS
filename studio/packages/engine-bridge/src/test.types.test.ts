/**
 * test.types.test.ts — the Test Explorer roll-up + coverage math (file 14 §3.19).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CoverageReport,
  type TestNode,
  type TestRunEvent,
  applyRunEvents,
  computeTotalCoverage,
  coverageRows,
  fileCoverage,
  findTestNode,
  flattenTestTree,
  lineCoverage,
  lineStripes,
  mergeCoverageReports,
  nodeState,
  rerunFailedIds,
  rollupStatus,
  testCases,
  worstState,
} from "./test.types.js";

const TREE: TestNode[] = [
  {
    id: "tests/test_a.py",
    kind: "file",
    label: "test_a.py",
    file: "tests/test_a.py",
    children: [
      {
        id: "tests/test_a.py::test_one",
        kind: "case",
        label: "test_one",
        file: "tests/test_a.py",
        line: 1,
      },
      {
        id: "tests/test_a.py::test_two",
        kind: "case",
        label: "test_two",
        file: "tests/test_a.py",
        line: 5,
      },
    ],
  },
  {
    id: "tests/test_b.py",
    kind: "file",
    label: "test_b.py",
    file: "tests/test_b.py",
    children: [
      {
        id: "tests/test_b.py::test_three",
        kind: "case",
        label: "test_three",
        file: "tests/test_b.py",
        line: 1,
      },
    ],
  },
];

test("flattenTestTree + testCases + findTestNode", () => {
  assert.equal(flattenTestTree(TREE).length, 5);
  assert.equal(testCases(TREE).length, 3);
  assert.equal(findTestNode(TREE, "tests/test_b.py::test_three")?.label, "test_three");
  assert.equal(findTestNode(TREE, "nope"), undefined);
});

test("applyRunEvents + rollupStatus counts cases (pending until a result arrives)", () => {
  const events: TestRunEvent[] = [
    { node: "tests/test_a.py::test_one", state: "pass" },
    { node: "tests/test_a.py::test_two", state: "fail", message: "AssertionError" },
  ];
  const states = applyRunEvents(events);
  const stats = rollupStatus(TREE, states);
  assert.equal(stats.total, 3);
  assert.equal(stats.pass, 1);
  assert.equal(stats.fail, 1);
  assert.equal(stats.pending, 1, "test_three has no result yet");
});

test("nodeState rolls a parent up to the worst of its cases", () => {
  const states = applyRunEvents([
    { node: "tests/test_a.py::test_one", state: "pass" },
    { node: "tests/test_a.py::test_two", state: "fail" },
  ]);
  const fileNode = TREE[0] as TestNode;
  assert.equal(nodeState(fileNode, states), "fail", "a file with one failing case is failing");
  assert.equal(worstState(["pass", "skip", "error"]), "error");
  assert.equal(worstState([]), undefined);
});

test("rerunFailedIds returns only failed/errored cases", () => {
  const states = applyRunEvents([
    { node: "tests/test_a.py::test_one", state: "pass" },
    { node: "tests/test_a.py::test_two", state: "fail" },
    { node: "tests/test_b.py::test_three", state: "error" },
  ]);
  assert.deepEqual(rerunFailedIds(TREE, states).sort(), [
    "tests/test_a.py::test_two",
    "tests/test_b.py::test_three",
  ]);
});

// ---- coverage math --------------------------------------------------------- //

test("fileCoverage + computeTotalCoverage + lineCoverage", () => {
  const report: CoverageReport = {
    perFile: {
      "a.py": { lines: [1, 2, 3], missed: [4] }, // 75%
      "b.py": { lines: [1], missed: [] }, // 100%
    },
    totalPct: 80,
  };
  assert.equal(fileCoverage(report.perFile["a.py"] as CoverageReport["perFile"][string]), 0.75);
  assert.equal(computeTotalCoverage(report), 80); // 4 covered / 5 total = 80%
  assert.equal(lineCoverage(report, "a.py", 2), "covered");
  assert.equal(lineCoverage(report, "a.py", 4), "missed");
  assert.equal(lineCoverage(report, "a.py", 9), "untracked");
  assert.equal(lineCoverage(report, "ghost.py", 1), "untracked");
});

test("computeTotalCoverage handles an empty report (100%, no division by zero)", () => {
  assert.equal(computeTotalCoverage({ perFile: {}, totalPct: 0 }), 100);
});

/* ── coverage merge + stripes + rows (APP-086) ──────────────────────────────*/

test("mergeCoverageReports: union of executed lines; disjoint halves → 100%", () => {
  // A covers lines 1-2 (missed 3-4); B covers 3-4 (missed 1-2) — merged = all covered.
  const a: CoverageReport = {
    perFile: { "f.py": { lines: [1, 2], missed: [3, 4] } },
    totalPct: 50,
  };
  const b: CoverageReport = {
    perFile: { "f.py": { lines: [3, 4], missed: [1, 2] } },
    totalPct: 50,
  };
  const m = mergeCoverageReports(a, b);
  assert.deepEqual(m.perFile["f.py"]?.lines, [1, 2, 3, 4]);
  assert.deepEqual(m.perFile["f.py"]?.missed, []);
  assert.equal(m.totalPct, 100);
});

test("mergeCoverageReports: a line missed in BOTH and executed in NEITHER stays missed", () => {
  const a: CoverageReport = { perFile: { "f.py": { lines: [1], missed: [2, 3] } }, totalPct: 0 };
  const b: CoverageReport = { perFile: { "f.py": { lines: [1], missed: [3] } }, totalPct: 0 };
  const m = mergeCoverageReports(a, b);
  assert.deepEqual(m.perFile["f.py"]?.lines, [1]);
  assert.deepEqual(m.perFile["f.py"]?.missed, [2, 3]); // 2 (missed in A, absent in B) + 3 (both)
});

test("mergeCoverageReports: files unique to one report survive; branchPct = max", () => {
  const a: CoverageReport = {
    perFile: { "a.py": { lines: [1], missed: [], branchPct: 40 } },
    totalPct: 100,
  };
  const b: CoverageReport = {
    perFile: {
      "b.py": { lines: [1], missed: [2] },
      "a.py": { lines: [1], missed: [], branchPct: 80 },
    },
    totalPct: 50,
  };
  const m = mergeCoverageReports(a, b);
  assert.ok(m.perFile["a.py"] && m.perFile["b.py"]);
  assert.equal(m.perFile["a.py"]?.branchPct, 80);
});

test("lineStripes: covered + missed lines, line-sorted", () => {
  assert.deepEqual(lineStripes({ lines: [3, 1], missed: [2] }), [
    { line: 1, covered: true },
    { line: 2, covered: false },
    { line: 3, covered: true },
  ]);
});

test("coverageRows: per-file %, sorted worst-first", () => {
  const report: CoverageReport = {
    perFile: {
      "good.py": { lines: [1, 2, 3, 4], missed: [] }, // 100%
      "bad.py": { lines: [1], missed: [2, 3] }, // 33.3%
    },
    totalPct: 0,
  };
  const rows = coverageRows(report);
  assert.equal(rows[0]?.file, "bad.py"); // worst first
  assert.equal(rows[0]?.missed, 2);
  assert.equal(rows[1]?.file, "good.py");
  assert.equal(rows[1]?.pct, 100);
});
