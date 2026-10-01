// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/search-preview.ts — the PURE project search/replace-preview math (§6.3).
 *
 * `SearchPanel.tsx` shows ripgrep results and, for a replace-all, a PREVIEW TREE
 * (per-file → per-match toggles) BEFORE anything is written — the same accept/reject
 * discipline as AI edits (§7.4). This module owns the deterministic core: turning a
 * literal/regex query into per-line matches, computing the replaced line, and
 * applying ONLY the accepted matches back to the file text. The writes themselves
 * go through `window.prometheus.ide.fsWrite` in the MAIN process — this module never
 * touches the fs.
 *
 * Framework-free — NO react / monaco / electron / window.prometheus — so the replace
 * math is testable in isolation (file 07 build-notes: "search replace-preview math").
 * Node built-ins only.
 */

/** A search query (mirrors the SearchPanel toolbar: regex / case / whole-word). */
export interface SearchQuery {
  pattern: string;
  /** treat `pattern` as a JS regex (else a literal substring). */
  isRegex?: boolean;
  /** case-sensitive (default false). */
  matchCase?: boolean;
  /** only whole-word matches (\b…\b). */
  wholeWord?: boolean;
}

/** One match on one line (column range, the matched text, and the replacement). */
export interface LineMatch {
  /** stable id within the file: `<lineIndex>:<startCol>` — survives re-render. */
  id: string;
  /** 0-based line index in the file. */
  line: number;
  /** 0-based start column of the match. */
  start: number;
  /** 0-based end column (exclusive). */
  end: number;
  /** the exact matched substring. */
  matchText: string;
  /** what it becomes under the current replacement (with $1.. group expansion). */
  replacement: string;
}

/** All matches for one file (the SearchPanel tree's per-file node). */
export interface FileMatches {
  uri: string;
  /** the file's lines (kept so the preview can show context without a re-read). */
  lines: string[];
  matches: LineMatch[];
}

/** Build the regex (or literal-as-regex) for a query. Throws on a bad regex. */
export function buildMatcher(query: SearchQuery): RegExp {
  const flags = `g${query.matchCase ? "" : "i"}`;
  let source: string;
  if (query.isRegex) {
    source = query.pattern;
  } else {
    // escape the literal for use inside a RegExp.
    source = query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (query.wholeWord) source = `\\b(?:${source})\\b`;
  return new RegExp(source, flags);
}

/**
 * Expand `$1..$99`, `$0`/`$&` (whole match) and `$$` (literal `$`) in a replacement
 * against a regex match (APP-024). Two-digit refs use JS `.replace` semantics: `$12`
 * is group 12 when it exists, else group 1 followed by a literal `2`. Everything
 * else after `$` stays LITERAL — deliberately NOT the full JS set: `` $` ``/`$'`
 * would need whole-string context our per-line splices don't have, so they pass
 * through unchanged (pinned by test).
 */
export function expandReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (whole, g: string) => {
    if (g === "$") return "$";
    if (g === "&") return match[0] ?? "";
    if (g.length === 2) {
      const nn = Number(g);
      if (nn < match.length) return match[nn] ?? "";
      const n = Number(g[0]);
      if (n === 0) return (match[0] ?? "") + g[1]!;
      if (n < match.length) return (match[n] ?? "") + g[1]!;
      return whole; // neither $nn nor $n exists — stays literal (JS semantics)
    }
    const n = Number(g);
    if (n === 0) return match[0] ?? "";
    return n < match.length ? (match[n] ?? "") : whole;
  });
}

/**
 * Find every match of `query` in one file's text, computing the replacement for each
 * under `replaceWith` ($-group expansion). Returns null when the query is empty or
 * the regex is invalid (the caller shows "invalid pattern"). Deterministic; never
 * loops on a zero-width match.
 */
export function matchFile(
  uri: string,
  text: string,
  query: SearchQuery,
  replaceWith: string,
): FileMatches | null {
  if (query.pattern === "") return null;
  let re: RegExp;
  try {
    re = buildMatcher(query);
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const matches: LineMatch[] = [];
  for (let li = 0; li < lines.length; li++) {
    const lineText = lines[li]!;
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(lineText);
    while (m !== null) {
      const start = m.index;
      const matchText = m[0];
      const end = start + matchText.length;
      matches.push({
        id: `${li}:${start}`,
        line: li,
        start,
        end,
        matchText,
        replacement: expandReplacement(replaceWith, m),
      });
      // guard against a zero-width match looping forever.
      re.lastIndex = matchText.length === 0 ? re.lastIndex + 1 : end;
      m = re.exec(lineText);
    }
  }
  return { uri, lines, matches };
}

/** The total match count across a result set (the panel header "N results in M files"). */
export function countMatches(files: readonly FileMatches[]): { matches: number; files: number } {
  let matches = 0;
  let nonEmpty = 0;
  for (const f of files) {
    if (f.matches.length > 0) nonEmpty++;
    matches += f.matches.length;
  }
  return { matches, files: nonEmpty };
}

/**
 * Apply ONLY the accepted matches of a file back to its text, returning the new text
 * (file 07 §6.3 / §7.4 accept-subset discipline). Matches are applied per-line,
 * RIGHT-TO-LEFT within each line so an earlier replacement never shifts a later
 * match's columns. Unaccepted matches are left untouched. Deterministic + immutable.
 */
export function applyReplacements(file: FileMatches, acceptedIds: readonly string[]): string {
  const accepted = new Set(acceptedIds);
  const chosen = file.matches.filter((m) => accepted.has(m.id));
  if (chosen.length === 0) return file.lines.join("\n");
  return spliceMatches(file.lines, chosen).join("\n");
}

/** Splice matches into lines, RIGHT-TO-LEFT within each line so an earlier
 *  replacement never shifts a later match's columns. Immutable. */
function spliceMatches(lines: readonly string[], chosen: readonly LineMatch[]): string[] {
  // group accepted matches by line, then splice each line right-to-left.
  const byLine = new Map<number, LineMatch[]>();
  for (const m of chosen) {
    const arr = byLine.get(m.line);
    if (arr) arr.push(m);
    else byLine.set(m.line, [m]);
  }

  const out = [...lines];
  for (const [li, ms] of byLine) {
    let lineText = out[li] ?? "";
    // right-to-left so a splice keeps earlier columns valid.
    const ordered = [...ms].sort((a, b) => b.start - a.start);
    for (const m of ordered) {
      lineText = lineText.slice(0, m.start) + m.replacement + lineText.slice(m.end);
    }
    out[li] = lineText;
  }
  return out;
}

/**
 * Apply accepted matches against FRESHLY-RE-READ file text (APP-024 stale guard).
 * Every accepted match's recorded span must still equal its previewed `matchText`
 * in `currentText` (a WINDOW compare — an edit elsewhere in the file doesn't block
 * an unrelated match, but any drift at a match's own span marks the file stale).
 * Stale → the whole file is SKIPPED (never a corrupting blind splice); fresh →
 * the splice runs on the CURRENT lines, so unrelated concurrent edits survive.
 */
export function applyToFreshText(
  file: FileMatches,
  acceptedIds: readonly string[],
  currentText: string,
): { ok: true; text: string; applied: number } | { ok: false; stale: number } {
  const accepted = new Set(acceptedIds);
  const chosen = file.matches.filter((m) => accepted.has(m.id));
  if (chosen.length === 0) return { ok: true, text: currentText, applied: 0 };
  const lines = currentText.split("\n");
  const stale = chosen.filter((m) => (lines[m.line] ?? "").slice(m.start, m.end) !== m.matchText);
  if (stale.length > 0) return { ok: false, stale: stale.length };
  return { ok: true, text: spliceMatches(lines, chosen).join("\n"), applied: chosen.length };
}

/**
 * Extract a substring GUARANTEED to appear in any match of a regex source, so the
 * MAIN grep backend can pre-filter candidate files for regex searches (APP-024).
 * Conservative: returns the longest run of ≥`minLength` literal chars that is
 * provably required, or null when unsure (alternation, lookarounds, named groups,
 * backreferences → null; optional/starred units drop their char and break the run;
 * a `+` keeps its char but breaks the run after it). Null = caller falls back to
 * a plain bounded file enumeration.
 */
export function requiredLiteral(source: string, minLength = 3): string | null {
  const runs: string[] = [];
  const groupMarks: number[] = []; // runs.length at each `(` — dropped if the group ends optional
  let run = "";
  let i = 0;
  const endRun = (): void => {
    if (run !== "") runs.push(run);
    run = "";
  };
  while (i < source.length) {
    const c = source[i]!;
    if (c === "|") return null; // an alternation makes nothing required
    if (c === "\\") {
      const next = source[i + 1];
      if (next === undefined) return null;
      if (/[1-9]/.test(next)) return null; // backreference
      if (/[dDwWsSbB]/.test(next)) {
        // class escapes consume a char (run breaks); \b/\B are zero-width no-ops.
        if (next !== "b" && next !== "B") {
          if (isOptionalQuantifier(source, i + 2)) i = skipQuantifier(source, i + 2) - 2;
          endRun();
        }
        i += 2;
        continue;
      }
      // control escapes: translate the SIMPLE ones to their real char (a needle
      // containing \t must be a real tab, not the letter 't' — soundness), and
      // bail on anything with trailing operands (\xNN, \uNNNN, \cX, \p{..}, \k<..>)
      // or an unknown letter escape rather than mis-read it.
      const CONTROL: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        f: "\f",
        v: "\v",
        0: "\0",
      };
      let lit: string;
      if (CONTROL[next] !== undefined) lit = CONTROL[next]!;
      else if (/[A-Za-z]/.test(next)) return null;
      else lit = next; // escaped punctuation (\. \$ \\ …) is itself
      // the escaped literal is subject to a following quantifier.
      if (isOptionalQuantifier(source, i + 2)) {
        endRun();
        i = skipQuantifier(source, i + 2);
        continue;
      }
      if (isQuantifier(source[i + 2])) {
        run += lit;
        endRun();
        i = skipQuantifier(source, i + 2);
        continue;
      }
      run += lit;
      i += 2;
      continue;
    }
    if (c === "[") {
      const close = classEnd(source, i);
      if (close === -1) return null;
      if (isOptionalQuantifier(source, close + 1)) i = skipQuantifier(source, close + 1);
      else {
        if (isQuantifier(source[close + 1])) i = skipQuantifier(source, close + 1);
        else i = close + 1;
      }
      endRun();
      continue;
    }
    if (c === "(") {
      if (source[i + 1] === "?") {
        if (source[i + 2] === ":") {
          groupMarks.push(runs.length);
          endRun();
          i += 3;
          continue;
        }
        return null; // lookaround / named group — bail conservatively
      }
      groupMarks.push(runs.length);
      endRun();
      i += 1;
      continue;
    }
    if (c === ")") {
      const mark = groupMarks.pop() ?? 0;
      endRun();
      if (isOptionalQuantifier(source, i + 1)) {
        runs.length = mark; // the whole group is optional — drop its runs
        i = skipQuantifier(source, i + 1);
        continue;
      }
      if (isQuantifier(source[i + 1])) {
        i = skipQuantifier(source, i + 1); // `+`/`{1,}` — content required once, runs stay
        continue;
      }
      i += 1;
      continue;
    }
    if (c === "^" || c === "$") {
      i += 1; // zero-width anchors don't break adjacency
      continue;
    }
    if (c === ".") {
      if (isOptionalQuantifier(source, i + 1) || isQuantifier(source[i + 1]))
        i = skipQuantifier(source, i + 1);
      else i += 1;
      endRun();
      continue;
    }
    if (isQuantifier(c)) {
      // quantifier on the PREVIOUS literal char of the current run.
      const optional = c === "*" || c === "?" || /^\{0/.test(source.slice(i));
      if (optional && run !== "") run = run.slice(0, -1);
      endRun();
      i = skipQuantifier(source, i);
      continue;
    }
    run += c;
    i += 1;
  }
  endRun();
  let best = "";
  for (const r of runs) if (r.length > best.length) best = r;
  return best.length >= minLength ? best : null;
}

function isQuantifier(c: string | undefined): boolean {
  return c === "*" || c === "+" || c === "?" || c === "{";
}

/** true when the quantifier starting at `at` allows ZERO occurrences (`*`, `?`, `{0…}`). */
function isOptionalQuantifier(source: string, at: number): boolean {
  const c = source[at];
  if (c === "*" || c === "?") return true;
  if (c === "{") return /^\{0(?:,\d*)?\}/.test(source.slice(at));
  return false;
}

/** Index just past a quantifier (`*`,`+`,`?`,`{m,n}`) + a possible lazy `?`. */
function skipQuantifier(source: string, at: number): number {
  let j = at;
  if (source[j] === "{") {
    const close = source.indexOf("}", j);
    j = close === -1 ? j + 1 : close + 1;
  } else if (isQuantifier(source[j])) {
    j += 1;
  }
  if (source[j] === "?") j += 1; // lazy modifier
  return j;
}

/** End index of a `[...]` character class opened at `at` (the `]`), or -1. */
function classEnd(source: string, at: number): number {
  let j = at + 1;
  if (source[j] === "^") j += 1;
  if (source[j] === "]") j += 1; // a leading `]` is literal
  while (j < source.length) {
    if (source[j] === "\\") j += 2;
    else if (source[j] === "]") return j;
    else j += 1;
  }
  return -1;
}

/** Every match id in a file (the file-level "accept all" selection). */
export function allMatchIds(file: FileMatches): string[] {
  return file.matches.map((m) => m.id);
}

/** Toggle one match id into/out of an accepted-id selection (immutable). */
export function toggleMatch(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id];
}

// ── APP-021: fused "Search Everywhere" ranking + tab model (pure) ────────────
// The tabbed palette's ranking + tab math live here (framework-free) so they are
// node:test-able; ALL IPC / fetching stays in CommandPalette.tsx (C5 sandbox).

/** The six tabs of the fused Search Everywhere popup. "all" fuses the other five. */
export type SearchTab = "all" | "actions" | "files" | "symbols" | "text" | "git";

/** The tab order (also the Tab / Shift-Tab cycle order). */
export const SEARCH_TABS: readonly SearchTab[] = [
  "all",
  "actions",
  "files",
  "symbols",
  "text",
  "git",
];

/** A concrete (non-"all") source a row can come from — the badge + per-source cap key. */
export type SearchSource = Exclude<SearchTab, "all">;

/**
 * Map a legacy single-source mode string (the pre-APP-021 keybindings still pass these)
 * onto the equivalent tab, so existing openers keep working: commands→actions,
 * files→files, symbols/structure→symbols, text→text, git→git; anything else → all.
 */
export function tabForMode(mode: string): SearchTab {
  switch (mode) {
    case "commands":
    case "actions":
      return "actions";
    case "files":
      return "files";
    case "symbols":
    case "structure":
      return "symbols";
    case "text":
      return "text";
    case "git":
      return "git";
    case "all":
      return "all";
    default:
      return "all";
  }
}

/** Cycle to the next (dir=1, Tab) / previous (dir=-1, Shift-Tab) tab, wrapping around. */
export function cycleTab(cur: SearchTab, dir: 1 | -1): SearchTab {
  const i = SEARCH_TABS.indexOf(cur);
  const base = i < 0 ? 0 : i;
  return SEARCH_TABS[(base + dir + SEARCH_TABS.length) % SEARCH_TABS.length] as SearchTab;
}

/** The minimal shape `fuseResults` needs; the component's row type extends it. */
export interface Ranked {
  /** stable identity for React keys + cross-source dedup. */
  key: string;
  /** which source produced it (the badge + the per-source cap key). */
  source: SearchSource;
  /** the source's OWN scorer output — magnitudes differ across sources, so `fuseResults`
   *  min-max-normalizes per source before interleaving. Higher = better. */
  score: number;
}

/** Per-source caps so one high-volume source can't flood the fused "All" tab. */
export const DEFAULT_SOURCE_CAPS: Readonly<Record<SearchSource, number>> = {
  actions: 8,
  files: 8,
  symbols: 8,
  text: 5,
  git: 5,
};

/**
 * Fuse per-source ranked lists into ONE interleaved list for the All tab. Each source's
 * scores are min-max-normalized to [0,1] (so an LSP score and a fuzzy-file score become
 * comparable), sorted desc, and CAPPED (`caps[source]`, so no source floods). Then a
 * round-robin draft takes one head per non-empty source each round — ordered within the
 * round by normalized score — so sources interleave fairly rather than one clustering at
 * the top. Duplicate keys (a file hit by both `files` and `text`) keep their FIRST-drafted
 * occurrence. Pure + deterministic; `query` is accepted for symmetry/future tie-breaks.
 */
export function fuseResults<T extends Ranked>(
  perSource: readonly (readonly T[])[],
  _query: string,
  caps: Readonly<Record<string, number>> = DEFAULT_SOURCE_CAPS,
): T[] {
  const queues = perSource.map((items) => {
    if (items.length === 0) return [] as { item: T; n: number }[];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const it of items) {
      if (it.score < min) min = it.score;
      if (it.score > max) max = it.score;
    }
    const span = max - min;
    const cap = caps[items[0]!.source] ?? Number.POSITIVE_INFINITY;
    return items
      .map((item) => ({ item, n: span === 0 ? 1 : (item.score - min) / span }))
      .sort((a, b) => b.n - a.n)
      .slice(0, cap);
  });

  const idx = queues.map(() => 0);
  const out: T[] = [];
  const seen = new Set<string>();
  let remaining = queues.reduce((s, q) => s + q.length, 0);
  while (remaining > 0) {
    const heads: { s: number; n: number }[] = [];
    for (let s = 0; s < queues.length; s++) {
      const q = queues[s]!;
      if (idx[s]! < q.length) heads.push({ s, n: q[idx[s]!]!.n });
    }
    if (heads.length === 0) break;
    heads.sort((a, b) => b.n - a.n);
    for (const h of heads) {
      const entry = queues[h.s]![idx[h.s]!]!;
      idx[h.s]! += 1;
      remaining -= 1;
      if (seen.has(entry.item.key)) continue;
      seen.add(entry.item.key);
      out.push(entry.item);
    }
  }
  return out;
}

/**
 * Clip a long line to a window around a match for display, SHIFTING the match column
 * offsets to the clipped coordinate space (else a highlight on a clipped line lands on the
 * wrong characters — the grep-row-highlight gotcha). Returns the visible text plus the
 * match ranges relative to it, and whether each side was truncated (to render an ellipsis).
 */
export function clipLineForDisplay(
  line: string,
  matchStart: number,
  matchEnd: number,
  maxLen = 200,
): { text: string; start: number; end: number; clippedLeft: boolean; clippedRight: boolean } {
  if (line.length <= maxLen) {
    return {
      text: line,
      start: matchStart,
      end: matchEnd,
      clippedLeft: false,
      clippedRight: false,
    };
  }
  // center the window on the match, biased so the match start is ~1/4 in.
  const pad = Math.floor((maxLen - (matchEnd - matchStart)) / 4);
  let from = Math.max(0, matchStart - Math.max(pad, 0));
  const to = Math.min(line.length, from + maxLen);
  from = Math.max(0, to - maxLen);
  return {
    text: line.slice(from, to),
    start: Math.max(0, matchStart - from),
    end: Math.max(0, Math.min(to, matchEnd) - from),
    clippedLeft: from > 0,
    clippedRight: to < line.length,
  };
}
