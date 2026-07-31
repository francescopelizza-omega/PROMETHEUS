/**
 * ide/state/structure-filter.ts — PURE symbol filtering for the File Structure popup (⌘F12)
 * and the membership check the Method Hierarchy view uses (APP-097). React-free/DOM-free so
 * it unit-tests under plain node:test; it only consumes the `NormalizedSymbol` tree that
 * `state/lsp-convert.ts` already produces from `textDocument/documentSymbol` (both the
 * hierarchical DocumentSymbol and the flat SymbolInformation shapes normalize to it).
 */

import type { LspRange, NormalizedSymbol } from "./lsp-convert.js";

/** One flattened row for the popup list: the symbol + its nesting depth (for indent). */
export interface StructureRow {
  symbol: NormalizedSymbol;
  depth: number;
}

/**
 * Case-insensitive SUBSEQUENCE match (IntelliJ/VS Code "type to filter"): every query char
 * appears in `name` in order, not necessarily contiguous — `fb` matches `fooBar`. An empty
 * query matches everything.
 */
export function subsequenceMatch(name: string, query: string): boolean {
  if (!query) return true;
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (let j = 0; j < n.length && i < q.length; j++) {
    if (n[j] === q[i]) i++;
  }
  return i === q.length;
}

/** Collect the included rows of a subtree in DFS order. A symbol is included iff it OR any
 *  descendant matches — so the full ancestor chain of a matched leaf is retained, while
 *  non-matching branches are pruned. Returns whether anything in `list` was included. */
function collect(
  list: readonly NormalizedSymbol[],
  depth: number,
  query: string,
  out: StructureRow[],
): boolean {
  let matchedAny = false;
  for (const s of list) {
    const selfMatch = subsequenceMatch(s.name, query);
    const childRows: StructureRow[] = [];
    const childMatched = collect(s.children, depth + 1, query, childRows);
    if (selfMatch || childMatched) {
      out.push({ symbol: s, depth });
      for (const r of childRows) out.push(r);
      matchedAny = true;
    }
  }
  return matchedAny;
}

/**
 * Flatten `symbols` to depth-tagged rows keeping only matched subtrees (empty query = the
 * whole tree). A matched nested member is returned together with its ancestors at the correct
 * depth; a matching parent with no matching child is returned alone.
 */
export function filterSymbols(symbols: readonly NormalizedSymbol[], query: string): StructureRow[] {
  const out: StructureRow[] = [];
  collect(symbols, 0, query.trim(), out);
  return out;
}

/**
 * Find a member named `name` anywhere in a type's symbol tree (exact, case-sensitive — method
 * names are). Returns the matched symbol (so the caller can reveal its `selectionRange`) or
 * null. This is the NAME heuristic behind the Method Hierarchy defines/overrides badges: it
 * cannot tell an override from a same-name/different-signature overload, so callers must label
 * it name-based, not signature-resolved.
 */
export function memberMatch(
  name: string,
  symbols: readonly NormalizedSymbol[],
): NormalizedSymbol | null {
  for (const s of symbols) {
    if (s.name === name) return s;
    const nested = memberMatch(name, s.children);
    if (nested) return nested;
  }
  return null;
}

/** Is the 0-based (line, character) inside `r` (inclusive of both ends)? */
function rangeContains(r: LspRange, line: number, character: number): boolean {
  if (line < r.start.line || line > r.end.line) return false;
  if (line === r.start.line && character < r.start.character) return false;
  if (line === r.end.line && character > r.end.character) return false;
  return true;
}

/**
 * The DEEPEST symbol whose `range` contains the 0-based (line, character) — used by the Method
 * Hierarchy view to resolve the member + enclosing type under the caret. Returns null when the
 * position is outside every symbol.
 */
export function symbolAtPosition(
  symbols: readonly NormalizedSymbol[],
  line: number,
  character: number,
): NormalizedSymbol | null {
  for (const s of symbols) {
    if (rangeContains(s.range, line, character)) {
      return symbolAtPosition(s.children, line, character) ?? s;
    }
  }
  return null;
}
