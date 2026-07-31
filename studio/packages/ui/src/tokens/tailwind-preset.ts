/**
 * tailwind-preset.ts — the Tailwind theme extension (file 08 §2/§6). It maps every
 * color to a CSS variable from tokens.css (NO raw hex — the §6 lint rule). New shadcn
 * components consume these utilities; existing components read the same CSS vars
 * directly. apps/desktop/tailwind.config.ts spreads this preset.
 */
import { radius, space, typography } from "../tokens.js";

const cssVarColor = (name: string) => `var(--${name})`;

export const tailwindPreset = {
  theme: {
    extend: {
      colors: {
        "bg-app": cssVarColor("bg-app"),
        "bg-surface": cssVarColor("bg-surface"),
        "bg-surface-2": cssVarColor("bg-surface-2"),
        "bg-inset": cssVarColor("bg-inset"),
        "border-subtle": cssVarColor("border-subtle"),
        "border-strong": cssVarColor("border-strong"),
        "text-primary": cssVarColor("text-primary"),
        "text-secondary": cssVarColor("text-secondary"),
        "text-disabled": cssVarColor("text-disabled"),
        brand: cssVarColor("brand"),
        "brand-fg": cssVarColor("brand-fg"),
        accent: cssVarColor("accent"),
        ok: cssVarColor("ok"),
        warn: cssVarColor("warn"),
        danger: cssVarColor("danger"),
        info: cssVarColor("info"),
      },
      borderRadius: { ...radius },
      spacing: { ...space },
      fontFamily: {
        ui: [typography.fontUi],
        mono: [typography.fontMono],
      },
      fontWeight: {
        regular: String(typography.weight.regular),
        medium: String(typography.weight.medium),
        semibold: String(typography.weight.semibold),
      },
      ringColor: { DEFAULT: cssVarColor("accent") },
      ringOffsetColor: { DEFAULT: cssVarColor("bg-app") },
    },
  },
} as const;

export default tailwindPreset;
