/**
 * contrast.ts — WCAG 2.1 relative-luminance + contrast-ratio math (file 08 §7).
 * Pure, dependency-free. The single place the design system proves its a11y target:
 * body text >= 4.5:1, large/UI >= 3:1. No color is the SOLE signal (glyphs back it).
 */

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  const v =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = Number.parseInt(v.slice(0, 6), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function linearize(c8: number): number {
  const s = c8 / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0..1). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio (1..21). */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastKind = "text" | "large" | "ui";

/** WCAG AA: 4.5:1 for body text, 3:1 for large text + non-text UI (icons, borders, verdict chips). */
export function meetsAA(fg: string, bg: string, kind: ContrastKind = "text"): boolean {
  return contrastRatio(fg, bg) >= (kind === "text" ? 4.5 : 3);
}

/**
 * Composite `fg` over `bg` at `pct` opacity (0..1) and return the resulting hex.
 * This is what CSS `color-mix(in srgb, fg P%, transparent)` resolves to when the
 * tint sits on `bg` — the design system's verdict/severity/klass chips render their
 * text in the role color over a ~14% tint of THAT SAME color (VerdictBadge,
 * FindingRow), so the contrast that matters is text-vs-tinted-bg, not text-vs-surface.
 */
export function blend(fg: string, bg: string, pct: number): string {
  const [r1, g1, b1] = hexToRgb(fg);
  const [r2, g2, b2] = hexToRgb(bg);
  const p = Math.max(0, Math.min(1, pct));
  const mix = (a: number, b: number): number => Math.round(a * p + b * (1 - p));
  return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}
