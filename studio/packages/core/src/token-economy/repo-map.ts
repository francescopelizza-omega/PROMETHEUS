// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * token-economy/repo-map.ts — a token-budgeted repo map (file tree + exported symbols)
 * injected into the CLI agent's context so it can answer "where is X defined" WITHOUT a grep
 * tool call (CLI-053). Closes the grounding gap flagged in the audit.
 *
 * PURE core: takes an INJECTED fs adapter (readdir/readFile/stat) — the real `node:fs` binding
 * lives in apps/cli only, so core stays IO-free and the walk is fully testable against a fake fs.
 *
 * Regex symbol extraction, NOT tree-sitter: the tree-sitter repo-map remains a documented
 * deferred seam — this build is deterministic heuristics with no new deps. `estimateTokens` is
 * the identical `chars/4` heuristic session-bridge uses so the map trims to the same budget the
 * CLI-052 context meter reports (otherwise the two numbers disagree).
 */

/** The injected filesystem seam — core stays IO-free; apps/cli binds `node:fs`. All paths POSIX. */
export interface RepoFs {
  /** directory children (names only + a dir flag); order is filesystem-dependent → we sort it. */
  readdir(dir: string): RepoDirent[];
  /** file contents as UTF-8 text (only ever called after a size-gate). */
  readFile(path: string): string;
  /** byte size — used to size-gate BEFORE reading contents. */
  statSize(path: string): number;
}

export interface RepoDirent {
  name: string;
  isDirectory: boolean;
  /**
   * Whether this dirent is itself a symlink (regardless of what it points to). A walk that
   * dereferences a symlink can hang forever reading a special file (a FIFO, `/dev/zero`) or
   * disclose content from outside the walk root — so the walker never follows one; adapters
   * MUST report this from the dirent's own type (e.g. `Dirent.isSymbolicLink()`), never from a
   * `stat` of the target. Defaults to `false` for adapters that predate this field (accepted only
   * from fakes/tests — every real binding must set it).
   */
  isSymlink?: boolean;
}

export interface WalkOptions {
  /** max files RECORDED before `truncated` is set (default 2000). */
  fileCap?: number;
  /** files larger than this are listed by name only, never read/parsed (default 256 KiB). */
  maxReadBytes?: number;
  /** extra ignore dir names layered on the built-in defaults. */
  ignoreDirs?: readonly string[];
  /**
   * Max directories DESCENDED INTO before the walk stops early (`truncated=true`), regardless of
   * how many files have been recorded (default 20000). `fileCap` alone never bounds a file-sparse,
   * directory-heavy tree (e.g. tens of thousands of empty subfolders) — this is the same early
   * exit, keyed on directories visited instead of files recorded.
   */
  dirCap?: number;
}

export interface RepoEntry {
  /** repo-relative POSIX path. */
  path: string;
  /** exported/top-level symbols (empty for unknown extensions or oversized/binary files). */
  symbols: string[];
}

export interface RepoMap {
  /** recorded files, sorted by path (deterministic across filesystems). */
  entries: RepoEntry[];
  /** how many files were recorded (== entries.length; kept explicit for the header). */
  fileCount: number;
  /** true when the walk hit `fileCap` — `entries` is a prefix, not the whole repo. */
  truncated: boolean;
}

/** Built-in ignore dirs — the noise that dominates a walk and never grounds an agent. */
export const DEFAULT_IGNORE_DIRS: readonly string[] = Object.freeze([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "venv",
  ".venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  "coverage",
]);

/** Extensions never worth reading — a single vendored blob otherwise dominates walk time. */
const BINARY_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "svg",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "tar",
  "wasm",
  "node",
  "exe",
  "dll",
  "so",
  "dylib",
  "o",
  "a",
  "class",
  "jar",
  "bin",
  "dat",
  "db",
  "sqlite",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "webm",
  "lock",
  "map",
  "min",
]);

const DEFAULT_FILE_CAP = 2000;
const DEFAULT_DIR_CAP = 20_000;
const DEFAULT_MAX_READ = 256 * 1024;
/** per-file symbol cap so one generated barrel can't flood the map. */
const MAX_SYMBOLS_PER_FILE = 48;

/* ------------------------------ .gitignore ------------------------------ */

interface GitignoreRule {
  /** the literal/basename/anchored pattern with `/` markers stripped. */
  pattern: string;
  /** `!` negation — re-includes a path an earlier rule excluded. */
  negate: boolean;
  /** trailing `/` — matches directories only. */
  dirOnly: boolean;
  /** a `/` anywhere but a single trailing one — anchored to the repo root (match the full rel
   *  path, not a basename). */
  anchored: boolean;
}

/**
 * Parse the ROOT `.gitignore` — TOP-LEVEL patterns only (deterministic). Honors `#` comments,
 * blank lines, leading `!` negation, trailing-slash dir-only, anchoring, and a simple `*.ext`
 * suffix glob. A full gitignore matcher is out of scope; NESTED `.gitignore` files are
 * deliberately NOT honored so the map is byte-stable across machines.
 *
 * ANCHORING follows git's own rule, not just "has a leading slash": a pattern anchors to the
 * .gitignore's own directory when it contains a `/` ANYWHERE but a single trailing one — a
 * pattern with a slash only in the MIDDLE, like `apps/vscode-extension/.vscode-test/`, is just
 * as anchored as `/apps/vscode-extension/.vscode-test/`. Treating "anchored" as "has a leading
 * slash" specifically was the bug: that pattern would fall through to basename-only matching
 * against a bare `.vscode-test`, which can never match a multi-segment relative path — so an
 * ignored, potentially huge (VS Code test binaries) directory would be walked anyway.
 */
export function parseGitignore(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let pat = line;
    const negate = pat.startsWith("!");
    if (negate) pat = pat.slice(1);
    const dirOnly = pat.endsWith("/");
    if (dirOnly) pat = pat.slice(0, -1);
    const anchored = pat.includes("/");
    if (anchored && pat.startsWith("/")) pat = pat.slice(1);
    if (!pat) continue;
    rules.push({ pattern: pat, negate, dirOnly, anchored });
  }
  return rules;
}

function ruleMatches(rule: GitignoreRule, relPath: string, name: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  const target = rule.anchored ? relPath : name;
  // simple `*.ext` suffix glob (the common case); otherwise exact match.
  if (rule.pattern.startsWith("*.")) return name.endsWith(rule.pattern.slice(1));
  if (rule.anchored) return relPath === rule.pattern || relPath.startsWith(`${rule.pattern}/`);
  return target === rule.pattern;
}

/** Is `relPath` git-ignored? Later negations win (a `!re-included` path survives an earlier rule). */
export function isGitIgnored(
  rules: readonly GitignoreRule[],
  relPath: string,
  name: string,
  isDir: boolean,
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, relPath, name, isDir)) ignored = !rule.negate;
  }
  return ignored;
}

/* -------------------------------- walk -------------------------------- */

const joinPosix = (a: string, b: string): string => (a ? `${a}/${b}` : b);
const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/**
 * Walk `root` via the injected fs adapter, recording every non-ignored file with its extracted
 * symbols. Deterministic: dir entries are SORTED before descent so the map is byte-stable across
 * APFS/ext4. Honors DEFAULT_IGNORE_DIRS (+ opts.ignoreDirs) and the root `.gitignore`. Size-gates
 * every read (>maxReadBytes ⇒ name only) and stops at `fileCap` with `truncated=true`.
 */
export function walkRepo(fs: RepoFs, root: string, opts: WalkOptions = {}): RepoMap {
  const fileCap = opts.fileCap ?? DEFAULT_FILE_CAP;
  const dirCap = opts.dirCap ?? DEFAULT_DIR_CAP;
  const maxRead = opts.maxReadBytes ?? DEFAULT_MAX_READ;
  const ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...(opts.ignoreDirs ?? [])]);

  let gitignore: GitignoreRule[] = [];
  try {
    gitignore = parseGitignore(fs.readFile(joinPosix(root, ".gitignore")));
  } catch {
    // no root .gitignore → default ignores only.
  }

  const entries: RepoEntry[] = [];
  let truncated = false;
  let dirsVisited = 0;

  const descend = (absDir: string, relDir: string): void => {
    if (truncated) return;
    dirsVisited++;
    if (dirsVisited > dirCap) {
      // A file-sparse, directory-heavy tree (many empty subfolders) never trips `fileCap` — this
      // is the same early exit, keyed on directories visited instead of files recorded, so the
      // walk can't run unbounded on a repo shaped to have few files and many directories.
      truncated = true;
      return;
    }
    let dirents: RepoDirent[];
    try {
      dirents = [...fs.readdir(absDir)];
    } catch {
      return; // unreadable dir → skip, never throw the whole walk.
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (truncated) return;
      const rel = joinPosix(relDir, d.name);
      if (d.isDirectory) {
        if (ignoreDirs.has(d.name)) continue;
        if (isGitIgnored(gitignore, rel, d.name, true)) continue;
        // Never follow a symlinked directory: it can point outside `root` (disclosing an
        // unrelated tree) or cycle back into an ancestor (infinite recursion) — neither of
        // which `ignoreDirs`/`.gitignore` guards against.
        if (d.isSymlink) continue;
        descend(joinPosix(absDir, d.name), rel);
        continue;
      }
      if (isGitIgnored(gitignore, rel, d.name, false)) continue;
      if (entries.length >= fileCap) {
        truncated = true;
        return;
      }
      entries.push({
        path: rel,
        // Never dereference a symlinked FILE's target: it may point at a special file (a FIFO,
        // `/dev/zero`) whose read never returns — the exact DoS this guard exists to prevent —
        // or at a real file outside `root`, disclosing content that isn't part of this repo.
        // List it by name only, exactly like an oversized file already is.
        symbols: d.isSymlink
          ? []
          : extractFileSymbols(fs, joinPosix(absDir, d.name), d.name, maxRead),
      });
    }
  };

  descend(root, "");
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, fileCount: entries.length, truncated };
}

/** Size-gate then extract symbols for one file; binary ext or oversize ⇒ [] (name only). */
function extractFileSymbols(fs: RepoFs, abs: string, name: string, maxRead: number): string[] {
  const ext = extOf(name);
  if (BINARY_EXT.has(ext)) return [];
  let size: number;
  try {
    size = fs.statSize(abs);
  } catch {
    return [];
  }
  if (size > maxRead) return []; // skip the read AND the regex — no catastrophic backtrack on a 1-line MB file.
  let content: string;
  try {
    content = fs.readFile(abs);
  } catch {
    return [];
  }
  return extractSymbols(name, content);
}

/* ----------------------------- symbol regex ----------------------------- */

// TS/JS: named exports, default exports, and barrel re-exports — exactly what an agent greps for.
const TS_DECL =
  /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const TS_DEFAULT =
  /^\s*export\s+default\s+(?:(?:async\s+)?function|class)?\s*([A-Za-z_$][\w$]*)?/gm;
const TS_REEXPORT_NAMED = /^\s*export\s*\{([^}]*)\}/gm;
const TS_REEXPORT_STAR = /^\s*export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from/gm;
// Python: TOP-LEVEL def/class only (column 0) so nested/method defs don't flood the map.
const PY_DECL = /^(?:def|class)\s+([A-Za-z_][\w]*)/gm;
// Markdown: ATX headings.
const MD_HEAD = /^#{1,6}\s+(.+?)\s*#*$/gm;

const TS_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);

/**
 * Extract the symbols worth mapping from one file's content, by extension:
 *   TS/JS → `export function|const|class|interface|type|enum NAME`, `export default …`,
 *           `export { A, B as C }` (captures the re-exported names), `export * [as ns] from`;
 *   Python → top-level `def|class NAME` (column 0 only);
 *   Markdown → ATX headings;
 *   unknown → [] (filename only).
 * Deduped, order-preserved, capped at MAX_SYMBOLS_PER_FILE.
 */
export function extractSymbols(name: string, content: string): string[] {
  const ext = extOf(name);
  const out: string[] = [];
  const push = (s: string | undefined): void => {
    const v = s?.trim();
    if (v && !out.includes(v)) out.push(v);
  };

  if (TS_EXT.has(ext)) {
    for (const m of content.matchAll(TS_DECL)) push(m[1]);
    for (const m of content.matchAll(TS_DEFAULT)) push(m[1] ? m[1] : "default");
    for (const m of content.matchAll(TS_REEXPORT_STAR)) push(m[1] ? m[1] : "*");
    for (const m of content.matchAll(TS_REEXPORT_NAMED)) {
      for (const part of (m[1] ?? "").split(",")) {
        const as = part.split(/\s+as\s+/);
        push((as[1] ?? as[0])?.replace(/[^\w$]/g, ""));
      }
    }
  } else if (ext === "py") {
    for (const m of content.matchAll(PY_DECL)) push(m[1]);
  } else if (ext === "md" || ext === "markdown") {
    for (const m of content.matchAll(MD_HEAD)) push(m[1]);
  }

  return out.slice(0, MAX_SYMBOLS_PER_FILE);
}

/* ------------------------------- render ------------------------------- */

/** IDENTICAL to session-bridge's `estTokens` (`Math.ceil(chars/4)`) so the map trims to the
 *  same budget the CLI-052 context meter reports. Do not "improve" this in isolation. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** rough header token reserve so `header + body` stays under the budget (header is small+bounded). */
const HEADER_RESERVE_TOKENS = 32;

type Detail = "symbols" | "paths" | "trimmed";

function renderBody(entries: readonly RepoEntry[], withSymbols: boolean): string {
  return entries
    .map((e) =>
      withSymbols && e.symbols.length > 0 ? `${e.path}: ${e.symbols.join(", ")}` : e.path,
    )
    .join("\n");
}

const depthOf = (p: string): number => {
  let n = 0;
  for (const ch of p) if (ch === "/") n++;
  return n;
};

/**
 * Render a deterministic, token-budgeted map string. Trims in order: full (path + symbols) →
 * paths only → drop DEEPEST paths until it fits. ALWAYS emits a budget-used header line, even
 * when nothing was trimmed. `tokenBudget` default 2048.
 */
export function renderRepoMap(map: RepoMap, tokenBudget = 2048): string {
  const budget = Math.max(1, tokenBudget);
  const bodyBudget = Math.max(1, budget - HEADER_RESERVE_TOKENS);

  let body = renderBody(map.entries, true);
  let detail: Detail = "symbols";
  let shown = map.entries.length;

  if (estimateTokens(body) > bodyBudget) {
    body = renderBody(map.entries, false);
    detail = "paths";
  }
  if (estimateTokens(body) > bodyBudget) {
    detail = "trimmed";
    // drop the DEEPEST paths first (shallow files ground the agent most); deterministic sort.
    const shallowFirst = [...map.entries].sort((a, b) => {
      const d = depthOf(a.path) - depthOf(b.path);
      return d !== 0 ? d : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    let keep = shallowFirst.length;
    while (keep > 0) {
      const subset = shallowFirst
        .slice(0, keep)
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      body = renderBody(subset, false);
      if (estimateTokens(body) <= bodyBudget) break;
      keep--;
    }
    shown = keep;
  }

  const used = estimateTokens(body);
  const parts = [`${shown}/${map.fileCount} files`, `~${used}/${budget} tok`, `detail:${detail}`];
  if (map.truncated) parts.push("truncated");
  const header = `# repo map (${parts.join(" · ")})`;
  return shown === 0 ? header : `${header}\n${body}`;
}
