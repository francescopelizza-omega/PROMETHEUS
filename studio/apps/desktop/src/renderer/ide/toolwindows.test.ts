/**
 * toolwindows.test.ts — pure view-models for the file-14 tool windows (§3.19/§3.25/§3.26/§3.28).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { paginate, parseConnString, resultSummary } from "./db/sql-view.js";
import { type Cell, cellReducer, executionSummary, nextCellId } from "./notebook/notebook-view.js";
import {
  diffTrees,
  flameRowsWithPath,
  flameSamplesToTree,
  flattenFlame,
  formatProfileValue,
  hottestPath,
  invertBottomUp,
  matchesFlame,
  selfTime,
  sortByAbsValue,
  sortHotFirst,
  zoomTo,
} from "./profile/profile-view.js";
import {
  type TestNodeView,
  applyStates,
  computeStats,
  failedCaseIds,
  filterTests,
  statLine,
  statusGlyph,
} from "./test/test-view.js";

// ---- §3.19 test explorer --------------------------------------------------- //

const TREE: TestNodeView[] = [
  {
    id: "f.py",
    kind: "file",
    label: "f.py",
    file: "f.py",
    children: [
      { id: "f.py::a", kind: "case", label: "a", file: "f.py" },
      { id: "f.py::b", kind: "case", label: "b", file: "f.py" },
    ],
  },
];

test("applyStates rolls a file up to the worst case; computeStats counts cases", () => {
  const states = new Map([["f.py::a", "pass"] as const, ["f.py::b", "fail"] as const]);
  const applied = applyStates(TREE[0] as TestNodeView, states);
  assert.equal(applied.state, "fail");
  const stats = computeStats([applied]);
  assert.equal(stats.total, 2);
  assert.equal(stats.pass, 1);
  assert.equal(stats.fail, 1);
  assert.match(statLine(stats), /1 passed · 1 failed \(2\)/);
  assert.equal(statusGlyph("pass"), "✓");
  assert.deepEqual(failedCaseIds([applied]), ["f.py::b"]);
});

test("filterTests prunes to matching cases + keeps ancestors", () => {
  const filtered = filterTests(TREE, "a");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.children?.length, 1);
  assert.equal(filtered[0]?.children?.[0]?.id, "f.py::a");
  assert.equal(filterTests(TREE, "zzz").length, 0);
});

// ---- §3.25 notebook -------------------------------------------------------- //

test("cellReducer add/remove/update/move + run lifecycle", () => {
  let cells: Cell[] = [];
  cells = cellReducer(cells, { type: "add", id: "c1", source: "print(1)" });
  cells = cellReducer(cells, { type: "add", id: "c2", afterId: "c1", source: "print(2)" });
  assert.deepEqual(
    cells.map((c) => c.id),
    ["c1", "c2"],
  );
  cells = cellReducer(cells, { type: "update", id: "c1", source: "print(11)" });
  assert.equal(cells[0]?.source, "print(11)");
  cells = cellReducer(cells, { type: "run-start", id: "c1" });
  assert.equal(cells[0]?.status, "running");
  cells = cellReducer(cells, {
    type: "run-ok",
    id: "c1",
    outputs: [{ mime: "text/plain", data: "11" }],
    execCount: 1,
  });
  assert.equal(cells[0]?.status, "ok");
  assert.equal(cells[0]?.outputs?.[0]?.data, "11");
  cells = cellReducer(cells, { type: "move", id: "c2", dir: "up" });
  assert.deepEqual(
    cells.map((c) => c.id),
    ["c2", "c1"],
  );
  cells = cellReducer(cells, { type: "remove", id: "c2" });
  assert.deepEqual(
    cells.map((c) => c.id),
    ["c1"],
  );
});

test("executionSummary + nextCellId", () => {
  const cells: Cell[] = [
    { id: "a", kind: "code", source: "", status: "ok" },
    { id: "b", kind: "code", source: "", status: "error" },
    { id: "c", kind: "code", source: "", status: "running" },
  ];
  assert.deepEqual(executionSummary(cells), { running: 1, ok: 1, errors: 1 });
  assert.equal(nextCellId(cells, "a"), "b");
  assert.equal(nextCellId(cells, "c"), undefined);
});

// ---- §3.26 sql ------------------------------------------------------------- //

test("paginate clamps the page + slices; parseConnString redacts the password", () => {
  const rows = Array.from({ length: 25 }, (_v, i) => [i, `r${i}`]);
  const p = paginate(rows, 10, 1);
  assert.equal(p.rows.length, 10);
  assert.equal(p.page, 1);
  assert.equal(p.maxPage, 2);
  assert.equal(paginate(rows, 10, 99).page, 2, "clamps past the end");
  const conn = parseConnString("postgresql://admin:s3cret@db.local:5432/app");
  assert.equal(conn.driver, "postgresql");
  assert.equal(conn.user, "admin");
  assert.equal(conn.password, "***", "the real password is NEVER surfaced");
  assert.equal(conn.host, "db.local");
  assert.equal(conn.port, 5432);
  assert.equal(conn.database, "app");
  assert.match(
    resultSummary({ columns: [], rows: [], rowCount: 3, durationMs: 12.4 }),
    /3 rows · 12.4ms/,
  );
});

// ---- §3.28 profiler -------------------------------------------------------- //

test("flameSamplesToTree folds stacks; selfTime + hottestPath + sort", () => {
  const tree = flameSamplesToTree([
    { stack: ["main", "a", "x"], value: 3 },
    { stack: ["main", "a", "y"], value: 1 },
    { stack: ["main", "b"], value: 2 },
  ]);
  assert.equal(tree.name, "all");
  assert.equal(tree.value, 6);
  const main = tree.children.find((c) => c.name === "main");
  assert.equal(main?.value, 6);
  assert.equal(selfTime(main as NonNullable<typeof main>), 0, "main's time is all in children");
  const sorted = sortHotFirst(tree);
  const a = sorted.children[0]?.children[0];
  assert.equal(a?.name, "a", "a (4) sorts before b (2)");
  assert.deepEqual(hottestPath(tree), ["all", "main", "a", "x"]);
  const rows = flattenFlame(tree);
  assert.equal(rows[0]?.name, "all");
  assert.ok(rows.every((r) => r.ratio >= 0 && r.ratio <= 1));
});

// ---- §3.28 zoom / search / paths (APP-047) ---------------------------------- //

const FLAME = flameSamplesToTree([
  { stack: ["main", "a", "x"], value: 3 },
  { stack: ["main", "a", "y"], value: 1 },
  { stack: ["main", "b"], value: 2 },
]);

test("flameRowsWithPath carries a zoom path per row; caps depth", () => {
  const rows = flameRowsWithPath(FLAME);
  assert.deepEqual(rows[0]?.path, [], "root path is empty");
  const x = rows.find((r) => r.name === "x");
  assert.deepEqual(x?.path, ["main", "a", "x"]);
  // maxDepth caps the rendered rows
  const capped = flameRowsWithPath(FLAME, 1);
  assert.ok(capped.every((r) => r.depth <= 1));
});

test("zoomTo re-roots at the path, children unchanged; bad path stops at deepest match", () => {
  const a = zoomTo(FLAME, ["main", "a"]);
  assert.equal(a.name, "a");
  assert.equal(a.value, 4);
  assert.equal(a.children.length, 2, "a keeps x + y subtree");
  assert.equal(zoomTo(FLAME, []).name, "all", "empty path = reset");
  assert.equal(zoomTo(FLAME, ["main", "nope"]).name, "main", "diverged path stops at main");
});

test("matchesFlame returns matches ∪ ancestors; empty query = empty set", () => {
  const keep = matchesFlame(FLAME, "x");
  assert.deepEqual([...keep].sort(), ["a", "all", "main", "x"], "x + its ancestor chain");
  assert.ok(!keep.has("b"), "unrelated subtree not highlighted");
  assert.equal(matchesFlame(FLAME, "").size, 0, "empty query dims nothing");
  assert.ok(matchesFlame(FLAME, "MAIN").has("main"), "case-insensitive");
});

// ---- §3.28 APP-089: bottom-up inversion + compare (delta) ------------------- //

test("invertBottomUp roots at the self-heavy leaf with its caller beneath", () => {
  // x has self 3 (leaf), y self 1, b self 2; main/a have self 0 (all in children).
  const inverted = invertBottomUp(FLAME);
  const byName = Object.fromEntries(inverted.children.map((c) => [c.name, c]));
  assert.equal(inverted.value, 6, "total self preserved");
  assert.equal(byName.x?.value, 3, "x is a bottom-up root weighted by its self time");
  // under x, its immediate caller `a` (then main) appears.
  assert.equal(byName.x?.children[0]?.name, "a");
  assert.equal(byName.x?.children[0]?.children[0]?.name, "main");
  assert.equal(byName.b?.value, 2);
});

test("diffTrees emits a signed delta aligned by call-path; new call site = pure regression", () => {
  const a = flameSamplesToTree([
    { stack: ["main", "hot"], value: 100 },
    { stack: ["main", "warm"], value: 50 },
  ]);
  const b = flameSamplesToTree([
    { stack: ["main", "hot"], value: 160 }, // +60
    { stack: ["main", "warm"], value: 20 }, // -30
    { stack: ["main", "new"], value: 40 }, // a=0 → +40 regression
  ]);
  const delta = diffTrees(a, b);
  assert.equal(delta.name, "Δ");
  assert.equal(delta.value, 220 - 150, "root delta = b.total - a.total");
  const main = delta.children.find((c) => c.name === "main");
  const kids = Object.fromEntries((main?.children ?? []).map((c) => [c.name, c.value]));
  assert.equal(kids.hot, 60);
  assert.equal(kids.warm, -30);
  assert.equal(kids.new, 40, "call site present only in b");
});

test("sortByAbsValue surfaces the biggest change regardless of sign", () => {
  const delta = diffTrees(
    flameSamplesToTree([{ stack: ["m", "slow"], value: 100 }]),
    flameSamplesToTree([{ stack: ["m", "slow"], value: 10 }]), // -90 improvement
  );
  const m = sortByAbsValue(delta).children.find((c) => c.name === "m");
  assert.equal(m?.children[0]?.name, "slow", "the -90 change is not buried as 'coldest'");
});

test("formatProfileValue renders per-unit, sign-preserving", () => {
  assert.equal(formatProfileValue(500, "us"), "500 µs");
  assert.equal(formatProfileValue(2500, "us"), "2.5 ms");
  assert.equal(formatProfileValue(1024, "bytes"), "1 KB");
  assert.equal(formatProfileValue(5 * 1024 * 1024, "bytes"), "5 MB");
  assert.equal(formatProfileValue(3, "samples"), "3 samples");
  assert.equal(formatProfileValue(-90, "us"), "−90 µs"); // improvement sign
});
