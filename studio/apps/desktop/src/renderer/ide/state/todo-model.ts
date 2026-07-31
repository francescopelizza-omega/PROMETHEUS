/**
 * ide/state/todo-model.ts — the PURE, react-free/DOM-free heart of the TODO tool window
 * (APP-096). Everything testable about configurable markers lives here so it runs under
 * plain node:test with no Electron/DOM: pattern compilation (fail-soft), search-needle
 * derivation for the `ide.search` prefilter, per-line scanning, and scope/marker filtering.
 *
 * User patterns are UNTRUSTED input. JS `RegExp` has no timeout, so a crafted pattern
 * (`(a+)+$`) against a long minified line hangs the renderer thread forever. Two defenses
 * (documented as defense, NOT a guarantee): (1) `compilePatterns` rejects nested unbounded
 * quantifiers at compile time; (2) `scanLines` skips lines longer than `MAX_LINE_LEN`.
 *
 * Persistence note: a `RegExp` is not JSON-serializable, so patterns persist as their source
 * STRING + a `caseSensitive` flag; `compilePatterns` recompiles on load (`caseSensitive:false`
 * ⇒ the `i` flag). This module never touches `window`/`document` — the view feeds it the
 * active-doc path for scoping and reads back plain data.
 */

/** A user-configurable TODO marker. `regex` is a RegExp SOURCE string (JSON-safe);
 *  `caseSensitive:false` compiles with the `i` flag (default is case-sensitive, matching the
 *  historical `\bTODO\b` builtins). `name` is the group label shown in the panel header. */
export interface TodoPattern {
  name: string;
  regex: string;
  caseSensitive?: boolean;
}

/** A pattern that survived compilation: a non-global RegExp + the literal stems used to
 *  prefilter files via `ide.search` (at least one — a stemless pattern is rejected). */
export interface CompiledPattern {
  name: string;
  re: RegExp;
  stems: string[];
}

/** A pattern dropped during compilation, with the reason (drives the editor's inline hint). */
export interface SkippedPattern {
  pattern: TodoPattern;
  reason: "empty" | "no-stem" | "unsafe" | "invalid" | "too-many";
}

/** One scanned marker occurrence. `line` is 0-based (matches the historical TodoView). */
export interface TodoScanItem {
  uri: string;
  line: number;
  marker: string;
  text: string;
}

/** Scope narrowing for `filterItems`: whole project, a containing-dir prefix, or one file.
 *  The view derives `uri`/`prefix` from the tabs-store active doc — the model only compares
 *  strings, so it stays DOM-free and unit-testable. */
export type TodoScope =
  | { kind: "project" }
  | { kind: "dir"; prefix: string }
  | { kind: "file"; uri: string };

/** The shipped default markers — FOUR SEPARATE patterns (not one `\b(TODO|…)\b` alternation)
 *  so `searchNeedlesFor` yields every stem and a file containing ONLY `HACK`/`XXX` is
 *  prefiltered in (the historical latent miss this file fixes). */
export const DEFAULT_TODO_PATTERNS: TodoPattern[] = [
  { name: "TODO", regex: "\\bTODO\\b" },
  { name: "FIXME", regex: "\\bFIXME\\b" },
  { name: "HACK", regex: "\\bHACK\\b" },
  { name: "XXX", regex: "\\bXXX\\b" },
];

/** Ceiling on scanned items (was `MAX_ITEMS` inline in TodoView). */
export const MAX_TODO_ITEMS = 800;
/** Max user-pattern count — extras are dropped as `too-many` (bounds the scan cost). */
export const MAX_TODO_PATTERNS = 16;
/** Lines longer than this are skipped unscanned — ReDoS defense against minified blobs. */
export const MAX_LINE_LEN = 2000;

/** Leading `:`, whitespace and `-` after a marker (historical `[:\s-]*`), stripped from text. */
const SEP_RE = /^[:\s-]*/;

/** Classic nested-unbounded-quantifier ReDoS shapes: a group whose body carries an unbounded
 *  quantifier (`+`/`*`) and that is itself unbounded-quantified — `(a+)+`, `(a*)*`, `(\w+\s?)*`.
 *  Conservative heuristic (documented as defense, not a guarantee). */
const NESTED_UNBOUNDED = /\([^)]*[+*][^)]*\)\s*(?:[*+]|\{\d*,\d*\})/;

/** Extract the longest guaranteed literal alnum run from a regex-source fragment (no top-level
 *  `|`). Backslash escapes (`\b`, `\w`, `\.`) break the run; a char made optional by a
 *  following `?`/`*` is excluded (so `TODOS?` ⇒ `TODO`, not `TODOS`). Runs shorter than 2 chars
 *  are too weak a needle (would force a near-full-repo read) and yield "". */
function longestStem(fragment: string): string {
  let best = "";
  let cur = "";
  const flush = (): void => {
    if (cur.length > best.length) best = cur;
    cur = "";
  };
  for (let i = 0; i < fragment.length; i++) {
    const c = fragment[i] as string;
    if (c === "\\") {
      flush();
      i++; // skip the escaped char — never part of an alnum stem
      continue;
    }
    if (c === "{") {
      // a `{n,m}` quantifier not attached to an alnum atom (e.g. after a group) — skip its
      // interior wholesale, else the digits inside read as a bogus literal stem.
      flush();
      const close = fragment.indexOf("}", i);
      i = close < 0 ? fragment.length : close;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(c)) {
      const nxt = fragment[i + 1];
      if (nxt === "?" || nxt === "*") {
        // optional char: it can't be part of a GUARANTEED literal stem.
        flush();
        i++; // consume the quantifier too
        continue;
      }
      if (nxt === "{") {
        // a `{min,max}` on this char: min===0 (or omitted) ⇒ optional ⇒ drop it; min≥1 ⇒
        // guaranteed ⇒ keep it. Either way skip the quantifier so its digits never leak in.
        const close = fragment.indexOf("}", i + 1);
        const body = close < 0 ? "" : fragment.slice(i + 2, close);
        const min = /^\d*/.exec(body)?.[0] ?? "";
        if (min === "" || Number(min) === 0) flush();
        else cur += c;
        i = close < 0 ? fragment.length : close;
        continue;
      }
      cur += c;
    } else {
      flush();
    }
  }
  flush();
  return best.length >= 2 ? best : "";
}

/** Split a regex source on every alternation `|` (unescaped, outside a char class — so a
 *  grouped `\b(TODO|FIXME|HACK|XXX)\b` yields all four) and return each branch's literal stem.
 *  Splitting on ALL `|` (not just top-level) is deliberate: an over-inclusive needle set only
 *  broadens the `ide.search` prefilter (still safe — the scan regex is the real filter),
 *  whereas an under-inclusive set would miss files. */
function stemsOf(source: string): string[] {
  const branches: string[] = [];
  let inClass = false;
  let cur = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      cur += c + (source[i + 1] ?? "");
      i++;
      continue;
    }
    if (inClass) {
      cur += c;
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      cur += c;
    } else if (c === "|") {
      branches.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  branches.push(cur);
  const out: string[] = [];
  for (const b of branches) {
    const s = longestStem(b);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Compile user patterns fail-soft: an invalid/unsafe/stemless pattern is DROPPED (recorded in
 * `skipped`), never thrown. Count is capped at `MAX_TODO_PATTERNS`; the compiled RegExp is
 * NON-global (so `.exec` reuse across lines carries no `lastIndex`) and case-sensitive unless
 * `caseSensitive === false`. `stems` are the prefilter needles for `searchNeedlesFor`.
 */
export function compilePatterns(
  patterns: readonly TodoPattern[],
  max = MAX_TODO_PATTERNS,
): { compiled: CompiledPattern[]; skipped: SkippedPattern[] } {
  const compiled: CompiledPattern[] = [];
  const skipped: SkippedPattern[] = [];
  patterns.forEach((p, idx) => {
    if (idx >= max) {
      skipped.push({ pattern: p, reason: "too-many" });
      return;
    }
    const source = typeof p.regex === "string" ? p.regex.trim() : "";
    if (!source) {
      skipped.push({ pattern: p, reason: "empty" });
      return;
    }
    if (NESTED_UNBOUNDED.test(source)) {
      skipped.push({ pattern: p, reason: "unsafe" });
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(source, p.caseSensitive === false ? "i" : "");
    } catch {
      skipped.push({ pattern: p, reason: "invalid" });
      return;
    }
    const stems = stemsOf(source);
    if (stems.length === 0) {
      // no literal stem ⇒ no usable `ide.search` prefilter ⇒ would force a full-repo read.
      skipped.push({ pattern: p, reason: "no-stem" });
      return;
    }
    compiled.push({ name: p.name || source, re, stems });
  });
  return { compiled, skipped };
}

/** Union of every compiled pattern's stems — the needle set for the `ide.search` content
 *  prefilter. De-duplicated, order-stable; the fix for the historical HACK/XXX miss. */
export function searchNeedlesFor(compiled: readonly CompiledPattern[]): string[] {
  const out: string[] = [];
  for (const c of compiled) {
    for (const s of c.stems) if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Leftmost-winning match of any compiled pattern on one line (mirrors the historical
 *  `(TODO|FIXME|…)` alternation which picks the earliest occurrence), plus the trailing text
 *  with leading separators stripped. `null` if no pattern matches. */
function matchLine(
  line: string,
  compiled: readonly CompiledPattern[],
): { marker: string; text: string } | null {
  let bestIdx = -1;
  let bestLen = 0;
  let bestName = "";
  for (const c of compiled) {
    const m = c.re.exec(line); // non-global ⇒ always starts at 0, no lastIndex carry
    if (m && (bestIdx === -1 || m.index < bestIdx)) {
      bestIdx = m.index;
      bestLen = m[0].length;
      bestName = c.name;
    }
  }
  if (bestIdx === -1) return null;
  const after = line.slice(bestIdx + bestLen).replace(SEP_RE, "");
  return { marker: bestName, text: (after || line).trim().slice(0, 140) };
}

/**
 * Scan a file's lines, appending hits to `items` (mutated in place so a caller can accumulate
 * across many files against one shared `max`). Lines over `MAX_LINE_LEN` are skipped (ReDoS
 * defense). Returns `true` once `items` reaches `max` — the signal for the caller to stop
 * reading further files.
 */
export function scanLines(
  uri: string,
  lines: readonly string[],
  compiled: readonly CompiledPattern[],
  items: TodoScanItem[],
  max = MAX_TODO_ITEMS,
): boolean {
  if (compiled.length === 0) return items.length >= max;
  for (let i = 0; i < lines.length; i++) {
    if (items.length >= max) return true;
    const line = lines[i] ?? "";
    if (line.length > MAX_LINE_LEN) continue;
    const hit = matchLine(line, compiled);
    if (hit) items.push({ uri, line: i, marker: hit.marker, text: hit.text });
  }
  return items.length >= max;
}

/** Narrow scanned items by scope (project / containing-dir / exact-file) and an optional
 *  marker allow-set (the per-pattern filter chips). A `null`/absent marker set means all
 *  markers pass. String-only comparisons keep this DOM-free. */
export function filterItems(
  items: readonly TodoScanItem[],
  opts: { scope: TodoScope; markers?: ReadonlySet<string> | null },
): TodoScanItem[] {
  const { scope, markers } = opts;
  return items.filter((it) => {
    if (markers && !markers.has(it.marker)) return false;
    switch (scope.kind) {
      case "file":
        return it.uri === scope.uri;
      case "dir":
        return it.uri.startsWith(scope.prefix);
      default:
        return true;
    }
  });
}
