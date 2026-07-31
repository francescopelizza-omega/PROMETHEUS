/**
 * ide/state/code-index.ts — the PURE codebase-index model (plan file 39 · the platform
 * layer under Search Everywhere / go-to-symbol / offline navigation).
 *
 * Three indexes, all pure + serialisable-ish so they can be node:test-ed and later
 * driven by a live builder (fs walk + LSP documentSymbol, or a tree-sitter sidecar):
 *   · a SYMBOL index (fuzzy-queried by name/container) — an LSP-free fallback for
 *     workspace-symbol + a fast local Search Everywhere;
 *   · a WORD/identifier index (word → files) — grep-free "which files mention X";
 *   · a dumb-mode STATUS machine (empty → indexing → ready) so the UI can honestly show
 *     "still indexing" instead of pretending an empty index is complete.
 *
 * Ranking reuses the same PURE fuzzy matcher the command palette uses (no drift).
 */

import { fuzzyRank } from "./fuzzy.js";

export interface IndexedSymbol {
  name: string;
  /** LSP SymbolKind number (5=Class, 12=Function, …) — opaque here. */
  kind: number;
  uri: string;
  line: number; // 0-based (LSP)
  container: string;
  /** repo-map PageRank importance in [0,1] (APP-053); absent for LSP-sourced symbols. */
  rank?: number;
}

export interface CodeIndex {
  symbols: IndexedSymbol[];
  files: string[];
}

/** Build a symbol index from per-file symbol lists (already flattened by the caller). */
export function buildIndex(
  entries: readonly { uri: string; symbols: IndexedSymbol[] }[],
): CodeIndex {
  const symbols: IndexedSymbol[] = [];
  const files: string[] = [];
  for (const e of entries) {
    files.push(e.uri);
    for (const s of e.symbols) symbols.push(s);
  }
  return { symbols, files };
}

/**
 * Fuzzy-search the symbol index by "container name" (empty query → the first `limit`
 * symbols in index order). Ranking is the shared fuzzy matcher, so results match the
 * palette's behaviour.
 */
export function searchSymbols(index: CodeIndex, query: string, limit = 50): IndexedSymbol[] {
  const q = query.trim();
  if (!q) return index.symbols.slice(0, limit);
  return fuzzyRank(q, index.symbols, (s) => (s.container ? `${s.container} ${s.name}` : s.name))
    .slice(0, limit)
    .map((m) => m.item);
}

/* ── repo-map merge + rank-aware search (APP-053) ───────────────────────────── */

/** The plain repo-map shape the repomap.py sidecar returns (mirrors ipc-contract). */
export interface RepoMapPayload {
  files: { path: string; symbols: { name: string; kind: string; line: number; rank: number }[] }[];
}

/** Map a repomap.py kind string → the LSP SymbolKind number searchSymbols carries. */
function lspKindOf(kind: string): number {
  switch (kind) {
    case "class":
      return 5;
    case "method":
      return 6;
    case "interface":
      return 11;
    case "enum":
      return 10;
    case "type":
      return 26; // TypeParameter-ish; opaque here
    default:
      return 12; // function
  }
}

/**
 * Merge a repo-map into a CodeIndex (APP-053). For each file the map covers, its symbols
 * REPLACE any prior repo-map/LSP symbols for that file uri (so an incremental `refresh`
 * of a few files updates only those). `toUri` maps a repo-relative path → a file:// uri.
 */
export function mergeRepoMap(
  index: CodeIndex,
  map: RepoMapPayload,
  toUri: (relPath: string) => string,
): CodeIndex {
  const touchedUris = new Set(map.files.map((f) => toUri(f.path)));
  // drop the touched files' existing symbols (fresh repo-map wins), keep the rest.
  const kept = index.symbols.filter((s) => !touchedUris.has(s.uri));
  const added: IndexedSymbol[] = [];
  for (const f of map.files) {
    const uri = toUri(f.path);
    for (const s of f.symbols) {
      added.push({
        name: s.name,
        kind: lspKindOf(s.kind),
        uri,
        line: Math.max(0, s.line - 1), // repomap lines are 1-based; index is 0-based (LSP)
        container: f.path,
        rank: s.rank,
      });
    }
  }
  const files = [...new Set([...index.files.filter((u) => !touchedUris.has(u)), ...touchedUris])];
  return { symbols: [...kept, ...added], files };
}

/**
 * Rank-aware symbol search (APP-053): an empty query returns the highest-RANK symbols
 * first (repo-map importance); a query fuzzy-matches then tiebreaks by rank so a widely-
 * referenced symbol wins over a same-name local. Symbols without a rank sort as 0.
 */
export function searchSymbolsRanked(index: CodeIndex, query: string, limit = 50): IndexedSymbol[] {
  const q = query.trim();
  if (!q) {
    return [...index.symbols].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, limit);
  }
  const ranked = fuzzyRank(q, index.symbols, (s) =>
    s.container ? `${s.container} ${s.name}` : s.name,
  );
  // fuzzyRank is score-ordered; apply rank as a stable tiebreak within equal scores.
  return ranked
    .map((m, i) => ({ item: m.item, order: i, rank: m.item.rank ?? 0 }))
    .sort((a, b) => (a.order === b.order ? b.rank - a.rank : a.order - b.order))
    .slice(0, limit)
    .map((m) => m.item);
}

// --- word / identifier index --------------------------------------------------

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Extract unique identifiers (first-seen order, original case, length ≥ 2) from text. */
export function extractIdentifiers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(IDENT_RE)) {
    const w = m[0];
    if (w.length < 2) continue;
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/** word (lower-cased) → sorted unique list of file uris that contain it. */
export type WordIndex = Map<string, string[]>;

export function buildWordIndex(entries: readonly { uri: string; text: string }[]): WordIndex {
  const acc = new Map<string, Set<string>>();
  for (const e of entries) {
    for (const ident of extractIdentifiers(e.text)) {
      const key = ident.toLowerCase();
      let set = acc.get(key);
      if (!set) {
        set = new Set<string>();
        acc.set(key, set);
      }
      set.add(e.uri);
    }
  }
  const out: WordIndex = new Map();
  for (const [word, uris] of acc) out.set(word, [...uris].sort());
  return out;
}

/** Files containing `word` (case-insensitive); [] if unknown. */
export function wordFiles(index: WordIndex, word: string): string[] {
  return index.get(word.trim().toLowerCase()) ?? [];
}

/**
 * Content-based file shortlist (APP-065, deliverable 5): the agent's context/grep tool and
 * fuzzy search call this to narrow the whole repo down to the files whose CONTENT mentions
 * the query — so an UNOPENED file that defines `parseArgs` surfaces for `@parseArgs`, not just
 * files whose NAME matches. Splits the query into identifier tokens, ranks each candidate file
 * by how many DISTINCT query tokens it contains (desc), tie-break by uri (stable, node-free).
 */
export function shortlistFiles(index: WordIndex, query: string, limit = 20): string[] {
  const tokens = extractIdentifiers(query).map((t) => t.toLowerCase());
  if (tokens.length === 0) return [];
  const hits = new Map<string, number>();
  for (const t of new Set(tokens)) {
    for (const uri of wordFiles(index, t)) hits.set(uri, (hits.get(uri) ?? 0) + 1);
  }
  return [...hits.entries()]
    .sort((a, b) => (b[1] === a[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
    .slice(0, limit)
    .map(([uri]) => uri);
}

/* ── ignore rules + incremental updates (full-repo walk, APP-065) ───────────── */

/** What a full-repo walk skips: heavy dirs, binary extensions, and a byte cap. */
export interface IgnoreRules {
  /** directory BASENAMES pruned before descent (the perf win — never walk node_modules). */
  dirs: ReadonlySet<string>;
  /** file EXTENSIONS (lower-case, with the dot) skipped as binary/uninteresting. */
  binaryExts: ReadonlySet<string>;
  /** files larger than this are skipped (mirrors fs-watch LARGE_FILE_BYTES). */
  maxBytes: number;
}

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "target",
  "coverage",
  ".turbo",
]);

const DEFAULT_BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".so",
  ".dylib",
  ".dll",
  ".node",
  ".wasm",
  ".class",
  ".pyc",
  ".lock",
]);

export function defaultIgnoreRules(): IgnoreRules {
  return { dirs: DEFAULT_IGNORE_DIRS, binaryExts: DEFAULT_BINARY_EXTS, maxBytes: 5 * 1024 * 1024 };
}

/** Prune this directory basename before descending? (the load-bearing perf gate.) */
export function isIgnoredDir(basename: string, rules: IgnoreRules = defaultIgnoreRules()): boolean {
  return rules.dirs.has(basename);
}

/** Skip this file by EXTENSION (the NUL-sniff + size cap are the caller's fs job). */
export function isIgnoredFile(path: string, rules: IgnoreRules = defaultIgnoreRules()): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return rules.binaryExts.has(path.slice(dot).toLowerCase());
}

/** Replace one file's symbols in the index (immutable — returns a NEW CodeIndex so a zustand
 *  selector re-renders). Adds the uri to `files` if new. */
export function updateIndexEntry(
  index: CodeIndex,
  uri: string,
  symbols: readonly IndexedSymbol[],
): CodeIndex {
  const kept = index.symbols.filter((s) => s.uri !== uri);
  const files = index.files.includes(uri) ? index.files : [...index.files, uri];
  return { symbols: [...kept, ...symbols.map((s) => ({ ...s, uri }))], files };
}

/** Drop one file from the symbol index (immutable — new CodeIndex). */
export function removeIndexEntry(index: CodeIndex, uri: string): CodeIndex {
  const symbols = index.symbols.filter((s) => s.uri !== uri);
  const files = index.files.filter((u) => u !== uri);
  if (symbols.length === index.symbols.length && files.length === index.files.length) return index;
  return { symbols, files };
}

/** Drop one file's contribution from the word index (immutable — NEW Map; empties pruned). */
export function removeWordEntry(index: WordIndex, uri: string): WordIndex {
  const out: WordIndex = new Map();
  for (const [word, uris] of index) {
    if (!uris.includes(uri)) {
      out.set(word, uris);
      continue;
    }
    const rest = uris.filter((u) => u !== uri);
    if (rest.length > 0) out.set(word, rest);
  }
  return out;
}

/** Re-index one file in the word index (immutable — NEW Map): drop its old words, add the
 *  new identifiers from `text`. One file change never rebuilds the world. */
export function updateWordEntry(index: WordIndex, uri: string, text: string): WordIndex {
  const cleared = removeWordEntry(index, uri);
  for (const ident of extractIdentifiers(text)) {
    const key = ident.toLowerCase();
    const uris = cleared.get(key);
    if (!uris) cleared.set(key, [uri]);
    else if (!uris.includes(uri)) cleared.set(key, [...uris, uri].sort());
  }
  return cleared;
}

// --- dumb-mode status machine -------------------------------------------------

export interface IndexStatus {
  state: "empty" | "indexing" | "ready";
  indexed: number;
  total: number;
}

export function initialStatus(): IndexStatus {
  return { state: "empty", indexed: 0, total: 0 };
}

/** Begin an indexing pass over `total` files (total 0 ⇒ immediately ready). */
export function startIndexing(total: number): IndexStatus {
  const t = Math.max(0, Math.floor(total));
  return t === 0
    ? { state: "ready", indexed: 0, total: 0 }
    : { state: "indexing", indexed: 0, total: t };
}

/** Advance the pass by `by` files; flips to "ready" once every file is indexed. */
export function advance(status: IndexStatus, by = 1): IndexStatus {
  if (status.state !== "indexing") return status;
  const indexed = Math.min(status.total, status.indexed + Math.max(0, by));
  return { state: indexed >= status.total ? "ready" : "indexing", indexed, total: status.total };
}
