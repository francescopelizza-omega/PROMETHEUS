/**
 * profile-view.ts — PURE flame-graph layout math (file 14 §3.28).
 *
 * The profiler is the profile.py sidecar (cProfile/py-spy → a speedscope/pstats tree, a
 * runtime seam). This owns the renderer's display math: fold raw stack samples into a
 * call tree, compute hit ratios for color intensity, and sort hot-first — node:test-tested.
 */

/** A raw profiler sample: a call stack (root→leaf) + a weight (time or count). */
export interface ProfileSample {
  stack: string[];
  value: number;
}

/** A node in the folded flame tree. */
export interface FlameNode {
  name: string;
  value: number; // total time/count under this node (self + children)
  children: FlameNode[];
}

/** Fold raw stack samples into a flame tree (root is a synthetic "all"). */
export function flameSamplesToTree(samples: readonly ProfileSample[], rootName = "all"): FlameNode {
  const root: FlameNode = { name: rootName, value: 0, children: [] };
  for (const s of samples) {
    root.value += s.value;
    let node = root;
    for (const frame of s.stack) {
      let child = node.children.find((c) => c.name === frame);
      if (!child) {
        child = { name: frame, value: 0, children: [] };
        node.children.push(child);
      }
      child.value += s.value;
      node = child;
    }
  }
  return root;
}

/** Sort every level hot-first (descending value), returning a NEW tree. */
export function sortHotFirst(node: FlameNode): FlameNode {
  return {
    ...node,
    children: [...node.children].sort((a, b) => b.value - a.value).map(sortHotFirst),
  };
}

/**
 * Sort every level by |value| descending (a NEW tree). Use for a DELTA/compare tree where
 * values are signed — `sortHotFirst` would sort improvements (negatives) as "coldest" and
 * bury the biggest regressions; magnitude-order surfaces the largest changes either way.
 */
export function sortByAbsValue(node: FlameNode): FlameNode {
  return {
    ...node,
    children: [...node.children]
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .map(sortByAbsValue),
  };
}

/**
 * Invert a top-down tree into a BOTTOM-UP (callee-rooted) tree: each function becomes a
 * top-level entry weighted by its SELF value, and its subtree shows who called it (root
 * = immediate caller, deeper = further up the stack). Built by reversing every node's
 * root→node path and re-folding with value = that node's self time — so `flattenFlame`/
 * `sortHotFirst` keep working on the result unchanged. The synthetic root name is preserved.
 */
export function invertBottomUp(root: FlameNode): FlameNode {
  const samples: ProfileSample[] = [];
  const visit = (n: FlameNode, path: string[]): void => {
    const here = [...path, n.name];
    const self = selfTime(n);
    // callee chain excludes the synthetic root; reversed = leaf(self)→…→outermost caller.
    if (self > 0 && here.length > 1) {
      samples.push({ stack: here.slice(1).reverse(), value: self });
    }
    for (const c of n.children) visit(c, here);
  };
  visit(root, []);
  return flameSamplesToTree(samples, root.name);
}

/**
 * Structurally align two trees by full call-path (function identity + parent chain) and
 * emit a signed DELTA tree: `value = b − a` at every node. A node present only in `b` is a
 * pure regression (a=0 → its full b value); only in `a` is an improvement (negative). The
 * root delta is `b.total − a.total`. Either side may be undefined (missing snapshot).
 */
export function diffTrees(
  a: FlameNode | undefined,
  b: FlameNode | undefined,
  rootName = "Δ",
): FlameNode {
  const build = (na: FlameNode | undefined, nb: FlameNode | undefined, name: string): FlameNode => {
    const names = new Set<string>();
    for (const c of na?.children ?? []) names.add(c.name);
    for (const c of nb?.children ?? []) names.add(c.name);
    const children: FlameNode[] = [];
    for (const cn of names) {
      children.push(
        build(
          na?.children.find((c) => c.name === cn),
          nb?.children.find((c) => c.name === cn),
          cn,
        ),
      );
    }
    return { name, value: (nb?.value ?? 0) - (na?.value ?? 0), children };
  };
  return build(a, b, rootName);
}

/**
 * Format a profile VALUE for its mode's unit (APP-089). "us" → µs/ms, "bytes" → B/KB/MB…,
 * "samples" → "N samples". Sign-preserving so a delta tree reads "+…"/"−…" correctly.
 */
export function formatProfileValue(value: number, unit: string): string {
  const sign = value < 0 ? "−" : "";
  const v = Math.abs(value);
  if (unit === "bytes") {
    if (v < 1024) return `${sign}${Math.round(v)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let n = v / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${sign}${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} ${units[i]}`;
  }
  // pin en-US so the profiler numbers are deterministic across host locales (and tests).
  if (unit === "samples") return `${sign}${v.toLocaleString("en-US")} samples`;
  // default: microseconds → ms once it gets large.
  if (v >= 1000)
    return `${sign}${(v / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })} ms`;
  return `${sign}${v.toLocaleString("en-US")} µs`;
}

/** Hit ratio of a node vs the tree total (0..1) — drives color intensity. */
export function hitRatio(node: FlameNode, total: number): number {
  return total <= 0 ? 0 : Math.max(0, Math.min(1, node.value / total));
}

/** Self time of a node (its value minus the sum of its children). */
export function selfTime(node: FlameNode): number {
  const childSum = node.children.reduce((s, c) => s + c.value, 0);
  return Math.max(0, node.value - childSum);
}

/** The hottest leaf path (root→…→hottest leaf) for "jump to hot path". */
export function hottestPath(root: FlameNode): string[] {
  const path: string[] = [];
  let node: FlameNode | undefined = root;
  while (node) {
    path.push(node.name);
    node = node.children.length
      ? [...node.children].sort((a, b) => b.value - a.value)[0]
      : undefined;
  }
  return path;
}

/** Flatten the tree to rows for a call-tree table (depth-first, hot-first). */
export interface FlameRow {
  name: string;
  value: number;
  self: number;
  depth: number;
  ratio: number;
}
export function flattenFlame(root: FlameNode): FlameRow[] {
  const total = root.value;
  const out: FlameRow[] = [];
  const visit = (n: FlameNode, depth: number) => {
    out.push({ name: n.name, value: n.value, self: selfTime(n), depth, ratio: hitRatio(n, total) });
    for (const c of [...n.children].sort((a, b) => b.value - a.value)) visit(c, depth + 1);
  };
  visit(root, 0);
  return out;
}

/** A flame row that also carries its zoom PATH (child names root→node, root itself = []). */
export interface FlameRowP extends FlameRow {
  path: string[];
}

/**
 * Like flattenFlame but each row carries the child-name `path` from `root` down to the
 * node (usable directly as `zoomTo(root, path)`), and `ratio` is vs the CURRENT root
 * total (so zoomed bars fill the width). `maxDepth` caps rendered rows (deep Python
 * recursion → very tall trees; default 60 keeps the offscreen render fast).
 */
export function flameRowsWithPath(root: FlameNode, maxDepth = 60): FlameRowP[] {
  const total = root.value;
  const out: FlameRowP[] = [];
  const visit = (n: FlameNode, depth: number, path: string[]) => {
    if (depth > maxDepth) return;
    out.push({
      name: n.name,
      value: n.value,
      self: selfTime(n),
      depth,
      ratio: hitRatio(n, total),
      path,
    });
    for (const c of [...n.children].sort((a, b) => b.value - a.value)) {
      visit(c, depth + 1, [...path, c.name]);
    }
  };
  visit(root, 0, []);
  return out;
}

/**
 * Re-root the flame at `path` (child names from `root` down). Returns the target node
 * with its children subtree UNCHANGED (structural identity — self/total math stays
 * correct); an empty or unresolvable path returns `root` itself (reset zoom).
 */
export function zoomTo(root: FlameNode, path: readonly string[]): FlameNode {
  let node = root;
  for (const name of path) {
    const child = node.children.find((c) => c.name === name);
    if (!child) return node; // path diverged (tree changed) — stop at the deepest match
    node = child;
  }
  return node;
}

/**
 * The set of node names to KEEP BRIGHT for a search: every node whose name matches
 * `query` (case-insensitive substring) PLUS all of its ancestors (so a match stays
 * visually reachable). An empty query returns an empty set → the caller dims nothing.
 */
export function matchesFlame(root: FlameNode, query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const keep = new Set<string>();
  if (!q) return keep;
  const visit = (n: FlameNode, ancestors: string[]): boolean => {
    const selfMatch = n.name.toLowerCase().includes(q);
    let childMatch = false;
    for (const c of n.children) {
      if (visit(c, [...ancestors, n.name])) childMatch = true;
    }
    if (selfMatch || childMatch) {
      keep.add(n.name);
      for (const a of ancestors) keep.add(a);
      return true;
    }
    return false;
  };
  visit(root, []);
  return keep;
}
