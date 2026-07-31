/**
 * ide/state/usages.ts — the PURE Find-Usages fan-in math (JetBrains Alt+F7 · MDS parity
 * plan 06 · APP-023).
 *
 * The Find-Usages tool window fans LSP `textDocument/references` in FIRST and falls back to
 * a whole-word grep only when there is NO language server (an empty answer from a WORKING
 * server means the symbol is genuinely unused — grep would find the definition text and
 * mislabel it a usage, so we don't). This module owns the deterministic transforms:
 * canonicalizing URIs, converting LSP's 0-based positions to the 1-based tabs/reveal/nav
 * convention, merging + DEDUPING across sources (an LSP hit and a grep hit at the same
 * location collapse to one), grouping by file, and the pure scope-prefix filter.
 *
 * Framework-free — NO react / monaco / electron / window.prometheus — so the fan-in is
 * node:test-able; ALL IPC (the LSP request + grep + fs reads) lives in EditorPane (C5).
 */

/** Which source produced a usage row — the badge + the "verified vs textual" honesty line. */
export type UsageSource = "lsp" | "grep";

/** One usage occurrence. `line`/`column` are 1-BASED (tabs/reveal/nav convention). */
export interface Usage {
  /** canonical `file://…` uri (see `canonicalUri`). */
  uri: string;
  line: number;
  column: number;
  source: UsageSource;
  /** the source line text, attached lazily for the tree excerpt (undefined until read). */
  excerpt?: string;
}

/** The scope a filter narrows to (pure path-prefix over the canonical uri). */
export type UsageScope = "all" | "file" | "directory";

/**
 * Canonicalize a path OR uri to a single `file://…` form so an LSP `file:///a/b%20c.ts`
 * uri and a grep filesystem path `/a/b c.ts` key IDENTICALLY (else the same location won't
 * dedupe). Decodes percent-encoding, strips the scheme, collapses `//`, re-prefixes.
 */
export function canonicalUri(pathOrUri: string): string {
  let s = pathOrUri;
  try {
    s = decodeURIComponent(s);
  } catch {
    // a malformed %-sequence: keep the raw string (never throw on user data).
  }
  s = s.replace(/^file:\/\//, "");
  s = s.replace(/\/{2,}/g, "/"); // collapse accidental double slashes
  return `file://${s}`;
}

/** The directory prefix of a (canonical) uri — everything up to and including the last `/`. */
export function dirOf(uri: string): string {
  const c = canonicalUri(uri);
  const i = c.lastIndexOf("/");
  return i >= 0 ? c.slice(0, i + 1) : c;
}

/** A minimal normalized LSP location (what `lsp-convert.normalizeLocations` yields): a uri
 *  + a 0-based start position. Kept structural so usages.ts doesn't couple to lsp-convert. */
export interface LocInput {
  uri: string;
  range: { start: { line: number; character: number } };
}

/**
 * Convert normalized LSP locations (0-based line AND character) to 1-BASED `Usage`s tagged
 * `lsp`, canonicalizing the uri. The +1 conversion happens HERE, once, at the fan-in
 * boundary — so the dedupe key and the reveal target are always 1-based.
 */
export function usagesFromLocations(locs: readonly LocInput[]): Usage[] {
  return locs.map((l) => ({
    uri: canonicalUri(l.uri),
    line: l.range.start.line + 1,
    column: l.range.start.character + 1,
    source: "lsp" as const,
  }));
}

/** The dedupe identity of a usage: canonical uri + 1-based line + 1-based column. */
function usageKey(u: Usage): string {
  return `${canonicalUri(u.uri)}:${u.line}:${u.column}`;
}

/**
 * Merge usage groups into one deduped list, keyed on the CONVERTED (1-based, canonical)
 * `uri:line:col`. Earlier groups win a tie — so pass the LSP group FIRST to keep the
 * authoritative `lsp` tag when an LSP and a grep hit collide. An excerpt from a later
 * duplicate is grafted onto the kept row if the kept one lacks one. Stable order.
 */
export function mergeUsages(...groups: (readonly Usage[])[]): Usage[] {
  const byKey = new Map<string, Usage>();
  for (const group of groups) {
    for (const u of group) {
      const key = usageKey(u);
      const kept = byKey.get(key);
      if (!kept) {
        byKey.set(key, { ...u, uri: canonicalUri(u.uri) });
      } else if (kept.excerpt === undefined && u.excerpt !== undefined) {
        kept.excerpt = u.excerpt; // graft a missing excerpt from the duplicate
      }
    }
  }
  return [...byKey.values()];
}

/** One file's usages (the tree's per-file group), rows sorted by line then column. */
export interface FileUsages {
  uri: string;
  rows: Usage[];
}

/** Group usages by canonical file, files sorted by path, rows by (line, column). */
export function groupByFile(usages: readonly Usage[]): FileUsages[] {
  const byUri = new Map<string, Usage[]>();
  for (const u of usages) {
    const uri = canonicalUri(u.uri);
    const arr = byUri.get(uri);
    if (arr) arr.push(u);
    else byUri.set(uri, [u]);
  }
  return [...byUri.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([uri, rows]) => ({
      uri,
      rows: rows.slice().sort((a, b) => a.line - b.line || a.column - b.column),
    }));
}

/**
 * Filter usages by scope — PURE string-prefix over the canonical uri (no `path` dep, C5):
 *   all       → everything
 *   file      → only usages in `originUri`'s file
 *   directory → only usages under `originUri`'s directory (path-prefix)
 * Re-filters an already-fetched result set WITHOUT a re-query.
 */
export function filterScope(
  usages: readonly Usage[],
  scope: UsageScope,
  originUri: string,
): Usage[] {
  if (scope === "all") return usages.slice();
  const origin = canonicalUri(originUri);
  if (scope === "file") return usages.filter((u) => canonicalUri(u.uri) === origin);
  const dir = dirOf(origin);
  return usages.filter((u) => canonicalUri(u.uri).startsWith(dir));
}

/** Total usage count + distinct-file count (the tool-window header). */
export function countUsages(usages: readonly Usage[]): { usages: number; files: number } {
  const files = new Set(usages.map((u) => canonicalUri(u.uri)));
  return { usages: usages.length, files: files.size };
}
