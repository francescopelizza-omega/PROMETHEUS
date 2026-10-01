// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/structsearch-map.ts — map structsearch sidecar matches → the SearchPanel preview
 * (APP-076). PURE (node:test-able): the panel reuses its per-file → per-match accept/reject +
 * fsWrite apply path, so structural results just need to become `LineMatch`es.
 */

import type { IdeStructMatch } from "../../../shared/ipc-contract.js";
import type { LineMatch } from "./search-preview.js";

/** Substitute captured `$X` bindings into a rewrite template as text (unbound → left literal). */
export function substituteBindings(template: string, bindings: Record<string, string>): string {
  return template.replace(/\$([A-Za-z_]\w*)/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(bindings, name) ? bindings[name]! : m,
  );
}

/**
 * One structural match → a `LineMatch` (0-based line/col; the sidecar reports 1-based). The end
 * column is the snippet length on the START line (structural matches are highlighted at their
 * head; a multi-line match's replacement still applies via the whole snippet text).
 */
export function structMatchToLineMatch(m: IdeStructMatch, replaceWith: string): LineMatch {
  const line = Math.max(0, m.line - 1);
  const start = Math.max(0, m.col - 1);
  const firstLineSnippet = m.snippet.split("\n")[0] ?? m.snippet;
  return {
    id: `${line}:${start}`,
    line,
    start,
    end: start + firstLineSnippet.length,
    matchText: m.snippet,
    replacement: substituteBindings(replaceWith, m.bindings),
  };
}

/** Group + map a file's structural matches → sorted `LineMatch`es (by line, then column). */
export function structMatchesToLineMatches(
  matches: readonly IdeStructMatch[],
  replaceWith: string,
): LineMatch[] {
  return matches
    .map((m) => structMatchToLineMatch(m, replaceWith))
    .sort((a, b) => (a.line === b.line ? a.start - b.start : a.line - b.line));
}
