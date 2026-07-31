/**
 * primitives/filter.ts — the PURE subsequence filter the Combobox + Command palette
 * rank with (file 08 §3.1 / §4.3 "⌘K palette"). Framework-free + dependency-free so
 * it is unit-testable in isolation (the brief's "command-palette fuzzy" logic target).
 *
 * This is a small, deterministic subsequence scorer in the spirit of the editor's
 * `apps/desktop/src/renderer/ide/state/fuzzy.ts` — but @prometheus/ui may NOT import
 * from apps/desktop (C5 sandbox + no project ref), so the palette PRIMITIVE carries
 * its own copy. The renderer's ⌘K still ranks engine commands via the core/editor
 * command-registry; this is the in-package fallback the generic Combobox/Command use.
 */

/** Whether `query` is a case-insensitive subsequence of `text`, with a score. */
export function subsequenceScore(query: string, text: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      // reward contiguous runs and word-boundary starts (after / . _ - space :).
      if (i === prevMatch + 1) score += 6;
      const prev = i > 0 ? t[i - 1]! : "";
      if (i === 0 || "/\\._- :".includes(prev)) score += 4;
      if (i === 0 && qi === 0) score += 8;
      score += 1;
      prevMatch = i;
      qi++;
    }
  }
  if (qi < q.length) return null; // not a full subsequence
  // tighter (shorter) candidates rank slightly higher.
  return score + Math.max(0, 10 - (text.length - query.length) * 0.1);
}

/** A scored, filtered, best-first ranking of items by `keyOf` against the query. */
export function filterItems<T>(
  query: string,
  items: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const trimmed = query.trim();
  if (trimmed === "") return [...items];
  const scored: { item: T; score: number; i: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const s = subsequenceScore(trimmed, keyOf(item));
    if (s !== null) scored.push({ item, score: s, i });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}
