/**
 * shell/palette.ts — the ⌘K Command Palette filter model (file 08 §4.2/§4.3).
 *
 * The palette is "what do I do": a single surface that searches COMMANDS and
 * engine ENTITIES (catalog items, models, venvs, files, settings) and runs
 * verdict-gated actions inline. This module owns the PURE filter/rank logic
 * (no React, no DOM) so it is unit-testable from TS source and reusable by the
 * `prometheus` TUI palette (file 08 §8: ⌘K commands are CLI subcommands).
 *
 * The matcher is a forgiving SUBSEQUENCE fuzzy match (Cursor/VS-Code style):
 * "srvq" matches "Serve qwen3", "nv" matches "New venv". Contiguous runs,
 * word-boundary hits, and a prefix bonus rank the strongest matches first; a
 * pinned verdict tier never changes the score (security rides along, §4.3).
 */

/** The §4.3 palette sections: commands first, then go-to entities. */
export type PaletteKind = "command" | "file" | "model" | "catalog" | "venv" | "setting";

/** A pinned inline verdict shown BEFORE a verdict-gated action runs (§4.3). */
export type PaletteVerdict = "allow" | "warn" | "block" | "error" | "scanning";

/** One palette row (a command or a go-to entity). */
export interface PaletteItem {
  /** stable id — a command id (file 07 registry) or an entity key. */
  id: string;
  /** the primary label shown + matched against. */
  title: string;
  kind: PaletteKind;
  /** optional secondary text (category, path, params) also matched, lower weight. */
  subtitle?: string;
  /** optional default keybind hint, e.g. "⌘K" (rendered right-aligned). */
  keybind?: string;
  /** a pinned inline verdict for a verdict-gated action (§4.3); cosmetic only (C5). */
  verdict?: PaletteVerdict;
}

/** A scored palette item — `score` higher = better; `ranges` are matched spans. */
export interface ScoredPaletteItem {
  item: PaletteItem;
  score: number;
  /** [start,end) index pairs into `title` for highlight rendering. */
  ranges: ReadonlyArray<readonly [number, number]>;
}

/* ── scoring weights (tuned so the obvious match wins) ───────────────────── */
const W_PREFIX = 16; // the query is a prefix of the title
const W_WORD_START = 8; // a matched char begins a word
const W_CONTIGUOUS = 4; // a matched char immediately follows the previous match
const W_BASE = 1; // any matched char
const W_SUBTITLE = 0.4; // a subtitle-only match is worth less than a title hit

function isWordBoundary(prev: string | undefined): boolean {
  if (prev === undefined) return true;
  return (
    prev === " " || prev === "-" || prev === "_" || prev === "." || prev === ":" || prev === "/"
  );
}

/**
 * Fuzzy subsequence score of `query` against `text`. Returns null when `query`
 * is NOT a subsequence of `text` (no match), else a positive score + the matched
 * index ranges (merged contiguous runs) for highlighting. Case-insensitive.
 * A blank query matches everything with score 0 (the palette shows all rows).
 */
export function fuzzyScore(
  query: string,
  text: string,
): { score: number; ranges: Array<[number, number]> } | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { score: 0, ranges: [] };
  const t = text.toLowerCase();

  let score = 0;
  let qi = 0;
  let prevMatch = -2; // index of the previous matched char (for contiguity)
  const matched: number[] = [];

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let charScore = W_BASE;
    if (isWordBoundary(ti === 0 ? undefined : text[ti - 1])) charScore += W_WORD_START;
    if (ti === prevMatch + 1) charScore += W_CONTIGUOUS;
    score += charScore;
    matched.push(ti);
    prevMatch = ti;
    qi++;
  }

  if (qi < q.length) return null; // not all query chars consumed → no match

  if (t.startsWith(q)) score += W_PREFIX;

  // Merge consecutive matched indices into [start,end) ranges.
  const ranges: Array<[number, number]> = [];
  for (const idx of matched) {
    const last = ranges[ranges.length - 1];
    if (last && idx === last[1]) last[1] = idx + 1;
    else ranges.push([idx, idx + 1]);
  }
  return { score, ranges };
}

/**
 * Filter + rank palette items against a query (file 08 §4.3). Matches `title`
 * (full weight) and, as a fallback, `subtitle` (reduced weight). Returns the
 * matching items, best score first; ties broken by original order (stable). A
 * blank query returns every item in original order (score 0).
 */
export function filterPalette(
  items: readonly PaletteItem[],
  query: string,
  limit = 50,
): ScoredPaletteItem[] {
  const q = query.trim();
  const scored: Array<ScoredPaletteItem & { ord: number }> = [];

  items.forEach((item, ord) => {
    const titleHit = fuzzyScore(q, item.title);
    if (titleHit) {
      scored.push({ item, score: titleHit.score, ranges: titleHit.ranges, ord });
      return;
    }
    if (item.subtitle) {
      const subHit = fuzzyScore(q, item.subtitle);
      if (subHit) {
        // subtitle-only match: scaled down, no title ranges to highlight.
        scored.push({ item, score: subHit.score * W_SUBTITLE, ranges: [], ord });
      }
    }
  });

  scored.sort((a, b) => (b.score === a.score ? a.ord - b.ord : b.score - a.score));
  return scored.slice(0, limit).map(({ item, score, ranges }) => ({ item, score, ranges }));
}

/* ── §4.3 go-to grammar (sigil scoping) ─────────────────────────────────────── */

/** A parsed palette query: a scope (from a leading sigil) + the bare needle. */
export interface ParsedQuery {
  scope: "all" | "symbol" | "line" | "catalog" | "model";
  needle: string;
}

/**
 * Parse the §4.3 go-to grammar from a raw query:
 *   ">model …" → models · ">cat …" → catalog · "@…" → symbols · ":…" → lines.
 * Anything else is an unscoped "all" search. PURE — the sigil only narrows which
 * KIND of rows are searched; the needle is matched by the same fuzzy scorer.
 */
export function parsePaletteQuery(raw: string): ParsedQuery {
  const s = raw.trimStart();
  if (s.startsWith(">model ")) return { scope: "model", needle: s.slice(7) };
  if (s.startsWith(">cat ")) return { scope: "catalog", needle: s.slice(5) };
  if (s.startsWith("@")) return { scope: "symbol", needle: s.slice(1) };
  if (s.startsWith(":")) return { scope: "line", needle: s.slice(1) };
  return { scope: "all", needle: raw };
}

/** Which PaletteKind a non-"all" scope restricts to (symbol/line ⇒ file rows). */
const SCOPE_KIND: Record<Exclude<ParsedQuery["scope"], "all">, PaletteKind> = {
  symbol: "file",
  line: "file",
  catalog: "catalog",
  model: "model",
};

/**
 * Filter + rank palette items honoring the §4.3 sigil grammar: a scoped query
 * (">model qwen", ">cat superpowers", "@sym", ":42") restricts the candidate pool
 * to the matching KIND before fuzzy-ranking the remaining needle. An unscoped
 * query falls straight through to filterPalette over every item.
 */
export function scopedFilterPalette(
  items: readonly PaletteItem[],
  raw: string,
  limit = 50,
): ScoredPaletteItem[] {
  const { scope, needle } = parsePaletteQuery(raw);
  const pool = scope === "all" ? items : items.filter((i) => i.kind === SCOPE_KIND[scope]);
  return filterPalette(pool, needle, limit);
}
