/**
 * ide/state/git-log-graph.ts — the PURE branch-graph lane-assignment model (APP-036).
 *
 * Renderer-local (C5: the renderer never imports `@prometheus/core` at runtime) so
 * this stays node:test-able without Electron. Takes an ordered (newest-first) commit
 * log and assigns each commit a lane column + the edges connecting it to where its
 * parent(s) land, using the standard "active lanes" algorithm real git-graph UIs use:
 * a lane holds the hash it is waiting for; a commit consumes the lane(s) waiting for
 * its hash, then re-arms its own lane (and opens/merges lanes) for its parents.
 */

/** The minimal per-commit shape the graph needs (mirrors GitLogEntry/IdeGitLogEntry). */
export interface GraphCommit {
  hash: string;
  parents: string[];
}

/** One edge between THIS row and the next: draw a connector from `fromLane` (this
 *  row) to `toLane` (the lane state carried into the next row) — same lane = a
 *  straight vertical segment, different lanes = a merge/fork curve. */
export interface GraphEdge {
  fromLane: number;
  toLane: number;
}

/** One row of the rendered graph. */
export interface GraphRow {
  hash: string;
  /** this commit's column. */
  lane: number;
  /** total lane columns in play at this row (for the graph column's width). */
  laneCount: number;
  /** edges from this row down into the next (one per surviving/opened lane, in
   *  parent order for this commit's own contributions, PLUS any straight-through
   *  edges other lanes carry unrelated to this commit). */
  edges: GraphEdge[];
  /** this row's parent hashes → which lane each one lands in (parent order). */
  parentLanes: number[];
}

/**
 * Assign lanes + edges for an ordered (newest-first) commit list. Pure, deterministic,
 * single pass. A linear history (each commit's sole parent is the very next row)
 * stays in lane 0 throughout; a branch+merge opens/closes lanes as expected.
 */
export function assignLanes(commits: readonly GraphCommit[]): GraphRow[] {
  // lanes[i] = the hash lane i is waiting for, or null when the lane is free (reused
  // by the next commit that needs a fresh column).
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  const firstFreeOrNew = (): number => {
    const free = lanes.indexOf(null);
    if (free !== -1) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    // 1) find (or open) this commit's own lane, and collapse any OTHER lane that was
    //    also waiting for this same hash (a converging branch tip) into it.
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) lane = firstFreeOrNew();
    const edges: GraphEdge[] = [];
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && lanes[j] === commit.hash) {
        edges.push({ fromLane: j, toLane: lane });
        lanes[j] = null;
      }
    }

    // 2) carry forward every OTHER still-active lane as a straight pass-through edge
    //    (a line with no business at this row keeps running down the same column).
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && lanes[j] !== null) edges.push({ fromLane: j, toLane: j });
    }

    // 3) re-arm this commit's lane (and open/merge lanes) for its parents.
    const parentLanes: number[] = [];
    if (commit.parents.length === 0) {
      lanes[lane] = null; // root commit — this lane closes here.
    } else {
      commit.parents.forEach((parent, i) => {
        if (i === 0) {
          const already = lanes.findIndex((h, j) => j !== lane && h === parent);
          if (already !== -1) {
            // the first parent is already the tip of a tracked lane — converge and
            // close this row's lane rather than tracking the same hash twice.
            edges.push({ fromLane: lane, toLane: already });
            lanes[lane] = null;
            parentLanes.push(already);
          } else {
            lanes[lane] = parent;
            edges.push({ fromLane: lane, toLane: lane });
            parentLanes.push(lane);
          }
        } else {
          const already = lanes.findIndex((h, j) => j !== lane && h === parent);
          if (already !== -1) {
            edges.push({ fromLane: lane, toLane: already });
            parentLanes.push(already);
          } else {
            const newLane = firstFreeOrNew();
            lanes[newLane] = parent;
            edges.push({ fromLane: lane, toLane: newLane });
            parentLanes.push(newLane);
          }
        }
      });
    }

    rows.push({ hash: commit.hash, lane, laneCount: lanes.length, edges, parentLanes });
  }
  return rows;
}
