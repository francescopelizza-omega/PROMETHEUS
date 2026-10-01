// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/editor-vision.ts — PURE reading-aid helpers + toggle model (APP-074).
 *
 * Folding-range mapping (LSP → Monaco line numbers), an indentation-folding fallback, code-vision
 * lens labels, and the 3 persisted feature toggles (LSP folding regions / inlay hints / code-vision).
 * DOM- + monaco-free so it is node:test-able; EditorPane converts the plain `kind` string to a
 * `monaco.languages.FoldingRangeKind` at the boundary.
 */

/* ── feature toggles (persisted; mirrors the ghost-text opt-in pattern) ───────── */

export interface VisionToggles {
  /** use LSP `textDocument/foldingRange` regions (off → indentation folding). */
  folding: boolean;
  /** inlay parameter/type hints (wraps the existing inlay provider). */
  inlayHints: boolean;
  /** code-vision reference counts above symbols (off by default — one LSP req/symbol). */
  codeVision: boolean;
}

export const VISION_KEY = "prometheus.editor.vision.v1";

/** Defaults: folding + inlay ON (cheap, per-request); code-vision OFF (spams `references`). */
export function defaultVisionToggles(): VisionToggles {
  return { folding: true, inlayHints: true, codeVision: false };
}

/** Parse a persisted blob → validated toggles (fail-soft to defaults for any missing/bad field). */
export function parseVisionToggles(raw: string | null): VisionToggles {
  const d = defaultVisionToggles();
  if (!raw) return d;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof VisionToggles, unknown>>;
    return {
      folding: typeof o.folding === "boolean" ? o.folding : d.folding,
      inlayHints: typeof o.inlayHints === "boolean" ? o.inlayHints : d.inlayHints,
      codeVision: typeof o.codeVision === "boolean" ? o.codeVision : d.codeVision,
    };
  } catch {
    return d;
  }
}

export function serializeVisionToggles(t: VisionToggles): string {
  return JSON.stringify(t);
}

/* ── folding-range mapping ────────────────────────────────────────────────────── */

/** One LSP folding range (0-based lines; optional kind). */
export interface LspFoldingRange {
  startLine: number;
  endLine: number;
  kind?: string;
}

/** A monaco-free folding range: 1-based lines + the normalized kind (undefined = plain). */
export interface FoldRange {
  start: number;
  end: number;
  kind?: "comment" | "imports" | "region";
}

/** Map LSP folding ranges → 1-based `FoldRange`s; drop malformed / zero-height ranges. */
export function lspFoldingToRanges(ranges: readonly LspFoldingRange[]): FoldRange[] {
  const out: FoldRange[] = [];
  for (const r of ranges) {
    if (typeof r?.startLine !== "number" || typeof r.endLine !== "number") continue;
    if (r.endLine <= r.startLine) continue; // a fold needs ≥2 lines
    const range: FoldRange = { start: r.startLine + 1, end: r.endLine + 1 };
    if (r.kind === "comment" || r.kind === "imports" || r.kind === "region") range.kind = r.kind;
    out.push(range);
  }
  return out;
}

/**
 * Indentation folding fallback (when LSP folding is OFF): a block is a line whose indent is
 * SHALLOWER than the following line(s); it folds down to the last line before the indent returns
 * to ≤ its own. Blank lines don't break a block. Pure + deterministic; 1-based `FoldRange`s.
 */
export function indentFoldingRanges(lines: readonly string[]): FoldRange[] {
  const indent = (s: string): number => {
    if (s.trim() === "") return -1; // blank → transparent
    const m = s.match(/^[ \t]*/);
    return m ? m[0].replace(/\t/g, "  ").length : 0;
  };
  const out: FoldRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const own = indent(lines[i] ?? "");
    if (own < 0) continue;
    // find the next non-blank line; if it's deeper, open a block.
    let j = i + 1;
    while (j < lines.length && indent(lines[j] ?? "") < 0) j++;
    if (j >= lines.length || indent(lines[j] ?? "") <= own) continue;
    // extend while indentation stays deeper than `own` (ignoring blanks).
    let end = j;
    for (let k = j; k < lines.length; k++) {
      const ind = indent(lines[k] ?? "");
      if (ind < 0) continue; // blank
      if (ind <= own) break;
      end = k;
    }
    if (end > i) out.push({ start: i + 1, end: end + 1 });
  }
  return out;
}

/* ── code-vision lens labels ──────────────────────────────────────────────────── */

/** "N ref(s)" — a `null`/undefined count (timed-out / not yet resolved) renders "—". */
export function refsLensTitle(n: number | null | undefined): string {
  if (typeof n !== "number") return "— refs";
  return n === 1 ? "1 ref" : `${n} refs`;
}

/** "N impl(s)" (only shown when the server advertises implementationProvider). */
export function implsLensTitle(n: number | null | undefined): string {
  if (typeof n !== "number") return "— impls";
  return n === 1 ? "1 impl" : `${n} impls`;
}

/** Cap the per-file symbol count so code-vision can't fire hundreds of `references` reqs. */
export const CODE_VISION_SYMBOL_CAP = 30;
export function capSymbols<T>(symbols: readonly T[], cap = CODE_VISION_SYMBOL_CAP): T[] {
  return symbols.slice(0, cap);
}
