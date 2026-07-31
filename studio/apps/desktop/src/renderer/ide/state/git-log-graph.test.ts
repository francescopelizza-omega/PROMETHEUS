/**
 * git-log-graph.test.ts — the PURE branch-graph lane-assignment model (APP-036).
 *
 * Fixture: a branch+merge history, oldest→newest: A(root)→B→C, then C forks into
 * D (main) and E (feature), then M merges D+E. newest-first input (git log order):
 * M, D, E, C, B, A.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type GraphCommit, assignLanes } from "./git-log-graph.js";

test("assignLanes: linear history stays in lane 0 throughout", () => {
  const commits: GraphCommit[] = [
    { hash: "C", parents: ["B"] },
    { hash: "B", parents: ["A"] },
    { hash: "A", parents: [] },
  ];
  const rows = assignLanes(commits);
  assert.deepEqual(
    rows.map((r) => r.lane),
    [0, 0, 0],
  );
  assert.deepEqual(
    rows.map((r) => r.laneCount),
    [1, 1, 1],
  );
  assert.deepEqual(rows[2]?.parentLanes, []); // the root commit has no parents
});

test("assignLanes: a branch+merge fixture produces the expected lane/edge sets", () => {
  const commits: GraphCommit[] = [
    { hash: "M", parents: ["D", "E"] },
    { hash: "D", parents: ["C"] },
    { hash: "E", parents: ["C"] },
    { hash: "C", parents: ["B"] },
    { hash: "B", parents: ["A"] },
    { hash: "A", parents: [] },
  ];
  const rows = assignLanes(commits);
  const byHash = new Map(rows.map((r) => [r.hash, r]));

  // M is a merge: forks into lane 0 (first parent D, same lane) and lane 1 (second
  // parent E, a NEW lane) — both edges recorded, in parent order.
  const m = byHash.get("M")!;
  assert.equal(m.lane, 0);
  assert.deepEqual(m.parentLanes, [0, 1]);
  assert.deepEqual(m.edges, [
    { fromLane: 0, toLane: 0 },
    { fromLane: 0, toLane: 1 },
  ]);

  // D continues straight in lane 0; the feature lane (1, waiting for E) passes
  // through untouched.
  const d = byHash.get("D")!;
  assert.equal(d.lane, 0);
  assert.deepEqual(d.parentLanes, [0]);
  assert.deepEqual(d.edges, [
    { fromLane: 1, toLane: 1 },
    { fromLane: 0, toLane: 0 },
  ]);

  // E is in lane 1; its parent C is ALREADY tracked in lane 0 (D's branch point) —
  // this converges E's lane into lane 0 rather than tracking C twice.
  const e = byHash.get("E")!;
  assert.equal(e.lane, 1);
  assert.deepEqual(e.parentLanes, [0]);
  assert.deepEqual(e.edges, [
    { fromLane: 0, toLane: 0 },
    { fromLane: 1, toLane: 0 },
  ]);

  // C is the fork point — back to a single lane from here down to the root.
  const c = byHash.get("C")!;
  assert.equal(c.lane, 0);
  assert.deepEqual(c.parentLanes, [0]);

  const a = byHash.get("A")!;
  assert.deepEqual(a.parentLanes, []); // root commit closes its lane
});

test("assignLanes: an empty log returns an empty graph", () => {
  assert.deepEqual(assignLanes([]), []);
});

test("assignLanes: a single root commit is lane 0 with no edges", () => {
  const rows = assignLanes([{ hash: "only", parents: [] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.lane, 0);
  assert.deepEqual(rows[0]?.edges, []);
  assert.deepEqual(rows[0]?.parentLanes, []);
});

test("assignLanes: an octopus merge (3 parents) opens a lane for each extra parent", () => {
  const commits: GraphCommit[] = [
    { hash: "oct", parents: ["p1", "p2", "p3"] },
    { hash: "p1", parents: [] },
    { hash: "p2", parents: [] },
    { hash: "p3", parents: [] },
  ];
  const rows = assignLanes(commits);
  const oct = rows[0]!;
  assert.equal(oct.lane, 0);
  assert.deepEqual(oct.parentLanes, [0, 1, 2]); // p1 stays in lane 0, p2/p3 fork new lanes
  assert.equal(oct.laneCount, 3);
});
