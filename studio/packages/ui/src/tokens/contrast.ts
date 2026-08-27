/**
 * contrast.ts — WCAG 2.1 relative-luminance + contrast-ratio math (file 08 §7).
 * Pure, dependency-free. The single place the design system proves its a11y target:
 * body text >= 4.5:1, large/UI >= 3:1. No color is the SOLE signal (glyphs back it).
 */

/**
 * Parse a CSS colour this module can reason about, or null.
 *
 * `#rgb`, `#rrggbb`, `#rrggbbaa` (alpha ignored — contrast is computed on the composited
 * colour, which is `blend`'s job) and `rgb()/rgba()`.
 */
export function parseColor(input: string): [number, number, number] | null {
  const s = input.trim();
  const fn = /^rgba?\(\s*([0-9.]+%?)[\s,]+([0-9.]+%?)[\s,]+([0-9.]+%?)/i.exec(s);
  if (fn) {
    const chan = (raw: string): number => {
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n)) return Number.NaN;
      return Math.max(0, Math.min(255, Math.round(raw.endsWith("%") ? (n * 255) / 100 : n)));
    };
    const rgb = [chan(fn[1] as string), chan(fn[2] as string), chan(fn[3] as string)];
    return rgb.every(Number.isFinite) ? (rgb as [number, number, number]) : null;
  }
  if (!s.startsWith("#")) return null;
  const h = s.slice(1).trim();
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  const v = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join("") : h;
  if (v.length !== 6 && v.length !== 8) return null;
  const n = Number.parseInt(v.slice(0, 6), 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * A colour's channels. THROWS on input this module cannot parse.
 *
 * It used to `parseInt` whatever it was handed and hand back `[0,0,0]` on NaN — so `rgb(255,
 * 255,255)`, `hsl(...)` and `var(--x)` were all read as pure BLACK. `contrastRatio` then
 * compared black to black and answered 1.0 for white-on-black: the design system's single
 * source of a11y truth, silently computing against a colour nobody wrote. Failing loudly here
 * (and fail-closed in `contrastRatio`) is the only version of this that cannot under-report.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const rgb = parseColor(hex);
  if (!rgb) {
    throw new Error(`contrast: unsupported color ${JSON.stringify(hex)} (use #rgb/#rrggbb/rgb())`);
  }
  return rgb;
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
  // FAIL-CLOSED on a colour we cannot parse: 0 is below every AA/AAA threshold, so an
  // unsupported token is REPORTED as a violation instead of quietly scoring whatever
  // `[0,0,0]` happened to produce. The thrown message names the offending value.
  let l1: number;
  let l2: number;
  try {
    l1 = relativeLuminance(fg);
    l2 = relativeLuminance(bg);
  } catch {
    return 0;
  }
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
