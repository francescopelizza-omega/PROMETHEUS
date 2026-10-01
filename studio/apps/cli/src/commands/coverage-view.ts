// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/coverage-view.ts — PURE terminal coverage-bar renderer for `prometheus test coverage` (CLI-095).
 *
 * A fixed-width fill bar (`█████████▌░` via the left-eighth block set U+258F..U+2588) drawn from a
 * coverage percentage. GLYPH-ONLY (no ANSI): the caller tints it with the SAME threshold roles the
 * pct column uses, so there's no second color path and it passes check-no-raw-hex. Guarantees
 * `stringWidth(bar) === width` so it never corrupts the table; an ASCII fallback (`#`/`.`) covers
 * non-UTF-8 locales where block chars would mojibake.
 */

/** Partial left-eighth blocks, index 0..7 (0 = none, 7 = ▉ = 7/8 filled). U+258F..U+2589. */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const FULL = "█"; // █ (8/8)
const EMPTY = "░"; // ░ light shade — keeps the bar a fixed visible width

/**
 * Render a fixed-`width` coverage bar from `pct` (0..100). Unicode by default (sub-cell resolution
 * via an eighth-block partial); `ascii:true` degrades to `#`/`.` (non-UTF-8 terminals). The partial
 * eighth is FLOORED (not rounded) so a just-below-full value shows `▉`, never a full cell — 99.9%
 * is visibly not 100%. Always exactly `width` display columns.
 */
export function coverageBar(pct: number, width: number, opts: { ascii?: boolean } = {}): string {
  const w = Math.max(1, Math.floor(width));
  const frac = Math.min(1, Math.max(0, (Number.isFinite(pct) ? pct : 0) / 100));
  if (opts.ascii) {
    const full = Math.round(frac * w); // ascii has no sub-cell glyph → round to nearest cell
    return "#".repeat(full) + ".".repeat(w - full);
  }
  const cells = frac * w;
  const full = Math.floor(cells);
  const eighths = Math.floor((cells - full) * 8); // 0..7 — floor so <full never shows a full cell
  const partial = full < w ? EIGHTHS[eighths] : "";
  const filledWidth = full + (partial ? 1 : 0);
  return FULL.repeat(full) + partial + EMPTY.repeat(Math.max(0, w - filledWidth));
}

/**
 * Should the ASCII fallback be used? True when the locale is NOT UTF-8 (block glyphs render as
 * `?`/mojibake under `LC_ALL=C` etc). Pure over the passed env (defaults to process.env). Mirrors
 * the "check the locale, not just color" convention the refinement calls for.
 */
export function preferAscii(env: NodeJS.ProcessEnv = process.env): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (!locale) return true; // no locale info → play safe with ASCII
  return !/utf-?8/i.test(locale);
}
