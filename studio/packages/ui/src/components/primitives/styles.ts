/**
 * primitives/styles.ts — the shared inline-style atoms the vendored shadcn
 * primitives compose (file 08 §3).
 *
 * WHY INLINE-STYLE TOKEN VARS (not raw Tailwind classes at runtime): the design
 * system's rule is "no raw hex anywhere; everything reads a token CSS variable"
 * (08 §6). The Tailwind PRESET (tokens/tailwind-preset.ts) maps utilities like
 * `bg-bg-surface` → `var(--bg-surface)`; the `cva()`/`cn()` config on each
 * primitive expresses that class shape so a real Tailwind build (once postcss/
 * tailwind are installed by the orchestrator) compiles them. But this env has no
 * Tailwind/PostCSS runtime, so the primitives ALSO carry an inline-style fallback
 * built from the SAME token CSS vars — identical to every existing component in
 * this package (Button/Panel/StatusBar/FindingRow). The class names ride along on
 * `className` (for the future Tailwind build + test assertions); the inline styles
 * make them render correctly TODAY. One token source, two emit paths — never a hex.
 */

import type { CSSProperties } from "react";

/** A token CSS-var reference, e.g. v("bg-surface") → "var(--bg-surface)". */
export function v(token: string): string {
  return `var(--${token})`;
}

/** A space-scale var with a px fallback, e.g. sp(4) → "var(--space-4, 8px)". */
const SPACE_PX: Record<number, number> = {
  0: 0,
  1: 2,
  2: 4,
  3: 6,
  4: 8,
  6: 12,
  8: 16,
  10: 20,
  12: 24,
  16: 32,
  20: 40,
  24: 48,
  32: 64,
};
export function sp(step: keyof typeof SPACE_PX): string {
  return `var(--space-${String(step)}, ${SPACE_PX[step]}px)`;
}

/** A radius var with a px fallback. */
const RADIUS_PX: Record<string, number> = { sm: 4, md: 6, lg: 10, xl: 14, full: 9999 };
export function rad(name: keyof typeof RADIUS_PX): string {
  return `var(--radius-${name}, ${RADIUS_PX[name]}px)`;
}

/** Type-scale font-size var with a rem fallback. */
const FONT_SIZE: Record<string, string> = {
  display: "1.75rem",
  h1: "1.375rem",
  h2: "1.125rem",
  body: "0.9375rem",
  small: "0.8125rem",
  code: "0.875rem",
};
export function fs(scale: keyof typeof FONT_SIZE): string {
  return `var(--text-${scale}-size, ${FONT_SIZE[scale]})`;
}

/** The tokenized focus ring shadow (08 §7: 2px accent, 2px offset over bg-app). */
export const FOCUS_RING = "0 0 0 2px var(--bg-app), 0 0 0 4px var(--focus-ring)";

/** A standard control surface (input/select/button-shell): bordered inset field. */
export function controlSurface(): CSSProperties {
  return {
    background: v("bg-inset"),
    border: `1px solid ${v("border-strong")}`,
    borderRadius: rad("md"),
    color: v("text-primary"),
    fontFamily: v("font-ui"),
    fontSize: fs("body"),
  };
}

/** The motion transition tokens (08 §2.5); reduced-motion is handled in CSS globally. */
export const HOVER_TRANSITION =
  "background var(--motion-hover, 120ms) ease-out, border-color var(--motion-hover, 120ms) ease-out, box-shadow var(--motion-hover, 120ms) ease-out";

/** Attach a tokenized focus ring on focus, clear it on blur (shared by primitives). */
export function focusRingHandlers(): {
  onFocus: (e: { currentTarget: HTMLElement }) => void;
  onBlur: (e: { currentTarget: HTMLElement }) => void;
} {
  return {
    onFocus: (e) => {
      e.currentTarget.style.boxShadow = FOCUS_RING;
    },
    onBlur: (e) => {
      e.currentTarget.style.boxShadow = "none";
    },
  };
}
