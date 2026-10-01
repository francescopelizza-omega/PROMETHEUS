// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/inline-values.ts — PURE inline-value decoration math (APP-031).
 *
 * At every debugger stop the active line of the selected frame gets an
 * after-content decoration listing that frame's local variable values (the
 * PyCharm/VS Code "inline values" affordance). This module builds the plain
 * decoration DESCRIPTORS — structurally what Monaco's
 * `createDecorationsCollection` consumes (`options.after` InjectedText) — with
 * NO monaco import, so it is node:test-able and the EditorPane stays the only
 * module touching the editor.
 *
 * Color comes from the `.prom-inline-value` class (a theme-token rule in
 * styles/global.css) — raw hex here would be build-blocked by check-no-raw-hex.
 */

/** One `name = value` pair rendered after the line. */
export interface InlineValuePair {
  name: string;
  value: string;
}

/** The theme-token CSS class the injected text renders with (global.css). */
export const INLINE_VALUE_CLASS = "prom-inline-value";

/** Render caps: the affordance is a glance, not a data dump. */
export const MAX_INLINE_PAIRS = 6;
export const MAX_INLINE_VALUE_LEN = 48;

/** A structural subset of monaco.editor.IModelDeltaDecoration. */
export interface InlineValueDecoration {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  options: {
    description: string;
    after: { content: string; inlineClassName: string };
  };
}

/** `  name = value, other = value` — capped pairs, per-value truncation with …. */
export function formatInlinePairs(pairs: readonly InlineValuePair[]): string {
  const shown = pairs.slice(0, MAX_INLINE_PAIRS).map((p) => {
    const oneLine = p.value.replace(/\s*\n\s*/g, " ");
    const v =
      oneLine.length > MAX_INLINE_VALUE_LEN
        ? `${oneLine.slice(0, MAX_INLINE_VALUE_LEN - 1)}…`
        : oneLine;
    return `${p.name} = ${v}`;
  });
  const more = pairs.length > MAX_INLINE_PAIRS ? `, +${pairs.length - MAX_INLINE_PAIRS} more` : "";
  return shown.length > 0 ? `  ${shown.join(", ")}${more}` : "";
}

/**
 * The decoration set for one stopped line: a single zero-width range at the
 * line's end column with the pairs as after-content. Empty pairs / an invalid
 * line produce [] (the collection clears).
 */
export function buildInlineValueDecorations(
  line: number,
  endColumn: number,
  pairs: readonly InlineValuePair[],
): InlineValueDecoration[] {
  const content = formatInlinePairs(pairs);
  if (line < 1 || endColumn < 1 || content === "") return [];
  return [
    {
      range: {
        startLineNumber: line,
        startColumn: endColumn,
        endLineNumber: line,
        endColumn,
      },
      options: {
        description: "prom-inline-values",
        after: { content, inlineClassName: INLINE_VALUE_CLASS },
      },
    },
  ];
}
