/**
 * worker/tasks.ts — the PURE-NODE task implementations the worker process runs
 * (file 01 §5, the offloaded worker layer).
 *
 * These functions are the actual CPU/IO work the MAIN process offloads to the
 * Electron utilityProcess so the UI thread never stalls. They are written as
 * plain, synchronous-where-possible Node functions with ZERO electron import and
 * ZERO third-party deps so node:test exercises them directly RIGHT NOW. The
 * worker entry (worker/index.ts) is a thin transport that maps request messages
 * onto these and posts the result back; ALL the logic lives here.
 *
 * Two real tasks (per the brief):
 *   1. LOG AGGREGATION — parse the engine's free-form / JSON-lines stderr
 *      progress into structured, counted events the UI can render as a timeline.
 *   2. FILE SEARCH/INDEX — walk a directory tree and return matching files
 *      (glob-ish suffix + substring + content grep), bounded and deterministic.
 *
 * Determinism + bounds are deliberate: a worker task must never hang the host or
 * fan out unboundedly, so every walk is depth/-count capped and sorted.
 *
 * Node built-ins only: node:fs, node:path.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

/* ════════════════════════════════════════════════════════════════════════════
 * TASK 1 — log-line aggregation
 * Parse engine stderr progress (which is partly free-form human text and partly
 * JSON-lines) into a structured, ordered, counted event model. Mirrors the phase
 * vocabulary of engine-bridge/stream.ts but stays SELF-CONTAINED (the worker must
 * not import the bridge package — it runs in a separate process realm).
 * ══════════════════════════════════════════════════════════════════════════ */

/** The progress phases the aggregator recognises (superset of stream.ts). */
export type LogPhase =
  | "scan"
  | "verdict"
  | "dry-run"
  | "install"
  | "uninstall"
  | "enable"
  | "disable"
  | "step"
  | "warn"
  | "error"
  | "info";

/** A single structured progress event parsed from one stderr line. */
export interface LogEvent {
  /** 0-based index of the source line among the NON-BLANK lines. */
  index: number;
  phase: LogPhase;
  /** the verdict tier when the line is a nemesis verdict, else undefined. */
  verdict?: "allow" | "warn" | "block" | "error";
  /** human-readable message (trimmed). */
  message: string;
  /** structured fields when the line was a JSON object, else undefined. */
  fields?: Record<string, unknown>;
  /** the raw line, untouched (minus a trailing CR). */
  raw: string;
}

/** The aggregate the UI renders: ordered events + per-phase counts + summary. */
export interface LogAggregate {
  events: LogEvent[];
  /** count of events per phase (only present phases are keyed). */
  counts: Partial<Record<LogPhase, number>>;
  total: number;
  errors: number;
  warnings: number;
  /** the worst verdict seen across all lines (block > warn > allow), if any. */
  worstVerdict?: "allow" | "warn" | "block" | "error";
}

const VERDICT_WORD_RE = /\b(allow|warn|block|error|safe|dangerous|blocked|clean)\b/i;

/** Rank verdict tiers so the aggregate can pick the WORST (most-blocking) one. */
const VERDICT_RANK: Record<NonNullable<LogEvent["verdict"]>, number> = {
  allow: 0,
  warn: 1,
  error: 2,
  block: 3,
};

function classifyVerdictWord(line: string): LogEvent["verdict"] | undefined {
  const m = line.match(VERDICT_WORD_RE);
  if (!m) return undefined;
  switch (m[1]?.toLowerCase()) {
    case "allow":
    case "safe":
    case "clean":
      return "allow";
    case "warn":
      return "warn";
    case "block":
    case "blocked":
    case "dangerous":
      return "block";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

/**
 * Try to read a JSON object out of a line. The engine MIGHT one day emit
 * JSON-lines progress (C6); we tolerate it now. Returns the parsed object plus a
 * best-effort phase/message/verdict derived from its fields.
 */
function tryJsonLine(line: string): {
  fields: Record<string, unknown>;
  phase?: LogPhase;
  message?: string;
  verdict?: LogEvent["verdict"];
} | null {
  if (!line.startsWith("{") || !line.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const phaseRaw = typeof o.phase === "string" ? o.phase.toLowerCase() : undefined;
  const phase = isLogPhase(phaseRaw) ? phaseRaw : undefined;
  const message =
    typeof o.message === "string" ? o.message : typeof o.msg === "string" ? o.msg : undefined;
  const verdictRaw = typeof o.verdict === "string" ? o.verdict.toLowerCase() : undefined;
  const verdict =
    verdictRaw === "allow" ||
    verdictRaw === "warn" ||
    verdictRaw === "block" ||
    verdictRaw === "error"
      ? verdictRaw
      : undefined;
  return { fields: o, phase, message, verdict };
}

function isLogPhase(v: string | undefined): v is LogPhase {
  return (
    v === "scan" ||
    v === "verdict" ||
    v === "dry-run" ||
    v === "install" ||
    v === "uninstall" ||
    v === "enable" ||
    v === "disable" ||
    v === "step" ||
    v === "warn" ||
    v === "error" ||
    v === "info"
  );
}

/** Parse ONE raw stderr line into a phase/message/verdict (free-form heuristics). */
function classifyTextLine(line: string): {
  phase: LogPhase;
  message: string;
  verdict?: LogEvent["verdict"];
} {
  const lower = line.toLowerCase();

  if (/\[dry[- ]?run\]/i.test(line)) {
    return { phase: "dry-run", message: line };
  }
  if (/\bverdict\b/i.test(line) || /\bnemesis\b/i.test(line)) {
    return { phase: "verdict", message: line, verdict: classifyVerdictWord(line) };
  }
  if (/^(error|err|fatal|!|✗|×)\b/i.test(line) || lower.startsWith("error:")) {
    return { phase: "error", message: line };
  }
  if (/^(warn|warning|⚠)\b/i.test(line) || lower.startsWith("warning:")) {
    return { phase: "warn", message: line };
  }
  if (/\b(scanning|scanned|gating|gate|audit)\b/i.test(lower)) {
    return { phase: "scan", message: line, verdict: classifyVerdictWord(line) };
  }
  if (/\b(installing|installed|copying|writing|linking)\b/i.test(lower)) {
    return { phase: "install", message: line };
  }
  if (/\b(uninstalling|uninstalled|removing|removed)\b/i.test(lower)) {
    return { phase: "uninstall", message: line };
  }
  if (/\b(enabling|enabled|re-?arm)\b/i.test(lower)) {
    return { phase: "enable", message: line };
  }
  if (/\b(disabling|disabled)\b/i.test(lower)) {
    return { phase: "disable", message: line };
  }
  if (/^(\s*(\d+[).]|[-*•]|==>|\[\d+\/\d+\]))\s+/.test(line)) {
    return { phase: "step", message: line };
  }
  return { phase: "info", message: line };
}

/**
 * Aggregate a whole stderr blob (or array of lines) into structured progress.
 * Blank lines are dropped; JSON-lines are parsed into `fields`; everything else
 * is heuristically classified. The result is fully deterministic.
 */
export function aggregateLogLines(input: string | readonly string[]): LogAggregate {
  const lines = Array.isArray(input) ? (input as readonly string[]) : (input as string).split("\n");

  const events: LogEvent[] = [];
  const counts: Partial<Record<LogPhase, number>> = {};
  let worstRank = -1;
  let worstVerdict: LogEvent["verdict"] | undefined;

  let index = 0;
  for (const rawLine of lines) {
    const raw = rawLine.replace(/\r$/, "");
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const json = tryJsonLine(trimmed);
    let phase: LogPhase;
    let message: string;
    let verdict: LogEvent["verdict"];
    let fields: Record<string, unknown> | undefined;

    if (json) {
      fields = json.fields;
      const text = classifyTextLine(json.message ?? trimmed);
      phase = json.phase ?? text.phase;
      message = json.message ?? text.message;
      verdict = json.verdict ?? text.verdict;
    } else {
      const text = classifyTextLine(trimmed);
      phase = text.phase;
      message = text.message;
      verdict = text.verdict;
    }

    const event: LogEvent = { index, phase, message, raw };
    if (verdict) event.verdict = verdict;
    if (fields) event.fields = fields;
    events.push(event);

    counts[phase] = (counts[phase] ?? 0) + 1;
    if (verdict && VERDICT_RANK[verdict] > worstRank) {
      worstRank = VERDICT_RANK[verdict];
      worstVerdict = verdict;
    }
    index += 1;
  }

  const aggregate: LogAggregate = {
    events,
    counts,
    total: events.length,
    errors: counts.error ?? 0,
    warnings: counts.warn ?? 0,
  };
  if (worstVerdict) aggregate.worstVerdict = worstVerdict;
  return aggregate;
}

/* ════════════════════════════════════════════════════════════════════════════
 * TASK 2 — file search / index
 * Walk a directory tree returning matching files. Bounded by maxDepth, maxResults
 * and a directory ignore-list so the worker never fans out unboundedly or hangs.
 * Supports: suffix/extension filter, filename substring, and optional content
 * grep (bounded by maxBytes per file). Fully deterministic (sorted output).
 * ══════════════════════════════════════════════════════════════════════════ */

export interface FileSearchQuery {
  /** absolute root to walk. */
  root: string;
  /** keep files whose path contains this substring (case-insensitive). */
  contains?: string;
  /** keep files whose extension is one of these (with or without a dot). */
  extensions?: readonly string[];
  /** when set, only keep files whose CONTENT contains this substring. */
  grep?: string;
  /** case sensitivity for `contains`/`grep` (default false = insensitive). */
  caseSensitive?: boolean;
  /** how deep to recurse (root = depth 0). Default 8. */
  maxDepth?: number;
  /** stop after this many matches. Default 1000. */
  maxResults?: number;
  /** per-file content cap for the grep, in bytes. Default 1 MiB. */
  maxBytes?: number;
  /** directory names to skip entirely. Default node_modules/.git/dist/out. */
  ignoreDirs?: readonly string[];
  /** keep only files whose ROOT-RELATIVE path matches ≥1 of these globs (APP-024). */
  include?: readonly string[];
  /** drop files whose root-relative path matches any of these globs; `dir/**`
   *  patterns also PRUNE the walk before reading (APP-024). */
  exclude?: readonly string[];
}

export interface FileMatch {
  /** absolute path. */
  path: string;
  /** path relative to root (POSIX-normalised separators). */
  rel: string;
  /** size in bytes. */
  size: number;
  /** lowercased extension WITHOUT the dot (e.g. "ts"), or "" if none. */
  ext: string;
  /** 1-based line number of the first content match, when `grep` was set. */
  matchLine?: number;
}

export interface FileSearchResult {
  root: string;
  matches: FileMatch[];
  /** total files VISITED (after dir-ignore), regardless of match. */
  scanned: number;
  /** true when the walk hit maxResults and stopped early. */
  truncated: boolean;
  /** true when a cooperative cancel (shouldCancel) stopped the walk (APP-066). */
  cancelled?: boolean;
}

/**
 * Local (NOT structured-clone-transferred) hooks the caller supplies IN ITS OWN realm
 * (APP-066): the worker entry wires `onProgress` → post a progress message and
 * `shouldCancel` → poll a cancel set; the MAIN inline-fallback wires them to a local
 * broadcast + flag. Because they are supplied per-realm, `searchFiles` stays the ONE
 * shared pure fn — the host and the worker never fork the walk.
 */
export interface SearchHooks {
  /** called every ~PROGRESS_STRIDE visited files with the running scanned count. */
  onProgress?: (scanned: number) => void;
  /** polled every ~PROGRESS_STRIDE files; returning true stops the walk (cooperative). */
  shouldCancel?: () => boolean;
}

/** How many visited files between progress emits / cancel polls (bounds the overhead). */
const PROGRESS_STRIDE = 256;

const DEFAULT_IGNORE_DIRS = ["node_modules", ".git", "dist", "out", ".cache"];

/**
 * Compile ONE glob pattern to a RegExp over POSIX root-relative paths (APP-024).
 * Deliberately small (no npm dep — picomatch is only transitive here): `**` = any
 * depth incl. none, `*` = any run WITHOUT `/`, `?` = one non-`/` char, `{a,b}` =
 * alternation (non-nested), everything else literal. Anchored both ends.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          // `**/` — zero or more whole path segments.
          out += "(?:.*/)?";
          i += 1;
        } else {
          // trailing/infix `**` — anything, `/` included.
          out += ".*";
        }
        continue;
      }
      out += "[^/]*";
      i += 1;
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
        i += 1;
      } else {
        const alts = pattern
          .slice(i + 1, close)
          .split(",")
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[^/]*"));
        out += `(?:${alts.join("|")})`;
        i = close + 1;
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Does a POSIX root-relative path match a glob? A bare-name pattern with no `/`
 *  (e.g. `*.ts`) matches at ANY depth, mirroring gitignore/editorconfig intuition. */
export function matchesGlob(pattern: string, relPath: string): boolean {
  let re: RegExp;
  try {
    re = globToRegExp(pattern);
  } catch {
    return false; // an uncompilable pattern matches nothing (fail-closed for include).
  }
  if (re.test(relPath)) return true;
  // no-slash pattern → also try against the basename (any-depth semantics).
  if (!pattern.includes("/")) {
    const base = relPath.slice(relPath.lastIndexOf("/") + 1);
    return re.test(base);
  }
  return false;
}

/** Normalise an extension list to a Set of lowercase no-dot extensions. */
function normalizeExtensions(exts: readonly string[] | undefined): Set<string> | null {
  if (!exts || exts.length === 0) return null;
  const set = new Set<string>();
  for (const e of exts) {
    const clean = e.startsWith(".") ? e.slice(1) : e;
    if (clean) set.add(clean.toLowerCase());
  }
  return set.size ? set : null;
}

/**
 * Search a directory tree. Pure Node, bounded, deterministic (sorted by rel
 * path). Unreadable dirs/files are skipped, never thrown — a worker task must be
 * resilient to permission errors mid-walk.
 */
export function searchFiles(query: FileSearchQuery, hooks?: SearchHooks): FileSearchResult {
  const root = query.root;
  const maxDepth = query.maxDepth ?? 8;
  const maxResults = query.maxResults ?? 1000;
  const maxBytes = query.maxBytes ?? 1024 * 1024;
  const caseSensitive = query.caseSensitive ?? false;
  const ignore = new Set(query.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const extSet = normalizeExtensions(query.extensions);

  const needle = (s: string | undefined): string | undefined =>
    s === undefined ? undefined : caseSensitive ? s : s.toLowerCase();
  const contains = needle(query.contains);
  const grep = needle(query.grep);
  const include = query.include?.length ? query.include : null;
  const exclude = query.exclude?.length ? query.exclude : null;

  const matches: FileMatch[] = [];
  let scanned = 0;
  let truncated = false;
  let cancelled = false;

  // Pre-flight: a missing/non-dir root yields an empty (not thrown) result.
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    return { root, matches: [], scanned: 0, truncated: false };
  }
  if (!rootStat.isDirectory()) {
    return { root, matches: [], scanned: 0, truncated: false };
  }

  const walk = (dir: string, depth: number): void => {
    if (truncated || cancelled || depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory — skip, don't crash the walk.
    }
    entries.sort(); // determinism

    for (const name of entries) {
      if (truncated || cancelled) return;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue; // broken symlink / vanished file
      }

      const rel = relative(root, full).split(sep).join("/");

      if (st.isDirectory()) {
        if (ignore.has(name)) continue;
        // `dir/**`-shaped excludes PRUNE the subtree before any read (APP-024).
        if (
          exclude?.some(
            (p) => matchesGlob(p, rel) || (p.endsWith("/**") && matchesGlob(p.slice(0, -3), rel)),
          )
        )
          continue;
        walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;

      scanned += 1;
      // periodic progress emit + cooperative cancel poll (APP-066); STRIDE-bounded so
      // the hook overhead is negligible on a large tree.
      if (scanned % PROGRESS_STRIDE === 0) {
        hooks?.onProgress?.(scanned);
        if (hooks?.shouldCancel?.()) {
          cancelled = true;
          return;
        }
      }

      const ext = extname(name).slice(1).toLowerCase();
      if (extSet && !extSet.has(ext)) continue;

      // include/exclude scope BEFORE the content read — excluded paths are never opened.
      if (exclude?.some((p) => matchesGlob(p, rel))) continue;
      if (include && !include.some((p) => matchesGlob(p, rel))) continue;

      const haystackPath = caseSensitive ? full : full.toLowerCase();
      if (contains && !haystackPath.includes(contains)) continue;

      let matchLine: number | undefined;
      if (grep) {
        const found = grepFile(full, grep, caseSensitive, maxBytes);
        if (found === undefined) continue; // no content match → drop file
        matchLine = found;
      }

      const match: FileMatch = { path: full, rel, size: st.size, ext };
      if (matchLine !== undefined) match.matchLine = matchLine;
      matches.push(match);

      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }
    }
  };

  walk(root, 0);
  matches.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  // a final progress tick so a walk shorter than one STRIDE still reports its total.
  hooks?.onProgress?.(scanned);
  const out: FileSearchResult = { root, matches, scanned, truncated };
  if (cancelled) out.cancelled = true;
  return out;
}

/* ── indexing task (APP-066) — a filter-free walk returning the flat file list ──
 * The repo index needs the SAME bounded/sorted walk as search, minus the content
 * filters, so `indexFiles` delegates to `searchFiles` (the one shared walk) and maps
 * matches → absolute paths. Runs in the worker on workspace open. */

export interface FileIndexQuery {
  root: string;
  extensions?: readonly string[];
  maxDepth?: number;
  maxResults?: number;
  ignoreDirs?: readonly string[];
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface FileIndexResult {
  root: string;
  /** absolute paths, sorted (root-relative order). */
  files: string[];
  scanned: number;
  truncated: boolean;
  cancelled?: boolean;
}

export function indexFiles(query: FileIndexQuery, hooks?: SearchHooks): FileIndexResult {
  const r = searchFiles({ ...query }, hooks); // no contains/grep → pure enumeration
  const out: FileIndexResult = {
    root: r.root,
    files: r.matches.map((m) => m.path),
    scanned: r.scanned,
    truncated: r.truncated,
  };
  if (r.cancelled) out.cancelled = true;
  return out;
}

/**
 * Grep a single file for `needle` (already case-folded if !caseSensitive).
 * Returns the 1-based line number of the first hit, or undefined for no match /
 * unreadable / over-size file. Bounded by maxBytes.
 */
function grepFile(
  path: string,
  needle: string,
  caseSensitive: boolean,
  maxBytes: number,
): number | undefined {
  let text: string;
  try {
    const raw = readFileSync(path);
    text = (raw.length > maxBytes ? raw.subarray(0, maxBytes) : raw).toString("utf8");
  } catch {
    return undefined;
  }
  const hay = caseSensitive ? text : text.toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx === -1) return undefined;
  // Count newlines before the hit → 1-based line number.
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (hay.charCodeAt(i) === 10 /* \n */) line += 1;
  }
  return line;
}

/* ════════════════════════════════════════════════════════════════════════════
 * Task dispatch — the request/response protocol the worker entry speaks.
 * The MAIN process posts a TaskRequest; the worker runs the matching pure fn and
 * posts a TaskResponse. Defined here (pure) so the worker entry + worker-host +
 * tests all share ONE typed contract.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Every task request carries a correlation id so responses can be matched. */
export type TaskRequest =
  | { id: string; kind: "log.aggregate"; payload: { lines: string | string[] } }
  | { id: string; kind: "file.search"; payload: FileSearchQuery }
  | { id: string; kind: "file.index"; payload: FileIndexQuery };

export type TaskKind = TaskRequest["kind"];

/** A successful or failed task response, correlated by id. */
export type TaskResponse =
  | { id: string; kind: "log.aggregate"; ok: true; result: LogAggregate }
  | { id: string; kind: "file.search"; ok: true; result: FileSearchResult }
  | { id: string; kind: "file.index"; ok: true; result: FileIndexResult }
  | { id: string; kind: TaskKind; ok: false; error: string };

/**
 * A mid-task PROGRESS message (APP-066) — a SEPARATE message shape from TaskResponse
 * (no `ok`), correlated by the same id. The host routes it to the request's onProgress
 * and RESETS the idle timeout so a long walk isn't force-timed-out mid-work.
 */
export interface TaskProgress {
  id: string;
  kind: TaskKind;
  progress: { scanned: number };
}

/** A cancel control message the host posts to the worker; the worker polls its id. */
export interface CancelMessage {
  cancel: string;
}

/**
 * Run ONE task request synchronously and return its response. This is the single
 * switch the worker entry calls; keeping it here (pure) means the dispatch logic
 * itself is node:test-covered without spawning a process. `hooks` (progress/cancel)
 * are supplied by the caller's realm and threaded into the walk (APP-066).
 */
export function runTask(req: TaskRequest, hooks?: SearchHooks): TaskResponse {
  try {
    switch (req.kind) {
      case "log.aggregate":
        return {
          id: req.id,
          kind: "log.aggregate",
          ok: true,
          result: aggregateLogLines(req.payload.lines),
        };
      case "file.search":
        return {
          id: req.id,
          kind: "file.search",
          ok: true,
          result: searchFiles(req.payload, hooks),
        };
      case "file.index":
        return {
          id: req.id,
          kind: "file.index",
          ok: true,
          result: indexFiles(req.payload, hooks),
        };
      default: {
        // exhaustiveness: a new kind without a case is a compile error.
        const _never: never = req;
        return {
          id: (_never as { id: string }).id,
          kind: (_never as { kind: TaskKind }).kind,
          ok: false,
          error: "unknown task kind",
        };
      }
    }
  } catch (e) {
    return {
      id: req.id,
      kind: req.kind,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Narrow an arbitrary IPC message into a TaskRequest (worker-entry guard). */
export function isTaskRequest(msg: unknown): msg is TaskRequest {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== "string") return false;
  if (m.kind === "log.aggregate") {
    return !!m.payload && typeof m.payload === "object";
  }
  if (m.kind === "file.search" || m.kind === "file.index") {
    return (
      !!m.payload &&
      typeof m.payload === "object" &&
      typeof (m.payload as Record<string, unknown>).root === "string"
    );
  }
  return false;
}

/** Narrow a message into a mid-task progress event (host-side routing, APP-066). */
export function isTaskProgress(msg: unknown): msg is TaskProgress {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  const p = m.progress as Record<string, unknown> | undefined;
  return typeof m.id === "string" && !!p && typeof p.scanned === "number";
}

/** Narrow a message into a cancel control message (worker-side, APP-066). */
export function isCancelMessage(msg: unknown): msg is CancelMessage {
  return (
    !!msg && typeof msg === "object" && typeof (msg as Record<string, unknown>).cancel === "string"
  );
}

/** Stable basename helper exposed for callers building UI labels. */
export function fileLabel(path: string): string {
  return basename(path);
}
