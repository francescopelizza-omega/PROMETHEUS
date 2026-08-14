/**
 * tokens.ts — Prometheus Studio design tokens (per 08-design-system-ux.md §2).
 *
 * Two-layer system, exactly as the spec mandates:
 *   1. PRIMITIVE RAMPS   raw sRGB hex scales (the §2.1 values, 50→950).
 *   2. SEMANTIC TOKENS   role-named, theme-swappable; apps reference ONLY these.
 *
 * The verdict ROLE tokens (ok/warn/danger/info) map to the C3 verdict tiers
 * (allow/warn/block/error) and to severities — see VERDICT_ROLE / SEVERITY_ROLE
 * below. `clean` is a SEVERITY, never a verdict (C3); we surface the friendly
 * "Clean" label for the `allow` tier but the token is the same role (`ok`).
 *
 * Single source of truth for the verdict MODEL stays in
 * engine-bridge/src/security/verdict.ts (C3). This file only owns how those
 * tiers/severities LOOK. The string-literal unions here are a structural mirror
 * of that contract (kept import-free so @prometheus/ui has no runtime deps).
 *
 * No raw hex is allowed anywhere in app code (08 §6) — it lives here only.
 */

// The 20 famous community schemes + the operator's "Pelly" scheme (pure data; the
// module type-imports our shapes, so this adds no runtime cycle / no React dep).
import { FAMOUS_SCHEMES } from "./tokens/famous-schemes.js";

/* ────────────────────────────────────────────────────────────────────────────
 * Verdict / severity model mirror (structural copy of C3; do not drift).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The decision axis — mirrors nemesis exit tiers 0/10/20/2 (C3). */
export type VerdictTier = "allow" | "warn" | "block" | "error";

/** How severe a finding is. `clean` means "no finding" — a SEVERITY (C3). */
export type Severity = "clean" | "low" | "medium" | "high" | "critical";

/** Lifecycle of a catalog/package/component entry (08 §2.2, grep `cmd_status`). */
export type ComponentState = "enabled" | "installed" | "disabled" | "muted" | "absent" | "missing";

/** Finding class — icon-tinted, never the sole signal (08 §2.2). */
export type FindingKlass = "malware" | "secret" | "vuln" | "sca";

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Primitive ramps (08 §2.1 — dark-theme reference hex, 50→950).
 * ──────────────────────────────────────────────────────────────────────────── */

export type Ramp = {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
  950: string;
};

/** neutral — surfaces, text, borders (slightly cool gray). */
export const neutral: Ramp = {
  50: "#f7f8fa",
  100: "#e9ecf1",
  200: "#cfd5de",
  300: "#aab2c0",
  400: "#9aa4b2",
  500: "#727d8e",
  600: "#5b6675",
  700: "#313844",
  800: "#232932",
  900: "#121519",
  950: "#0b0d10",
};

/** violet — brand (Prometheus mark, primary CTAs, focus). */
export const violet: Ramp = {
  50: "#f3e8ff",
  100: "#e6d2ff",
  200: "#d4b3ff",
  300: "#c08cff",
  400: "#b266ff",
  500: "#a855f7",
  600: "#8b3ad6",
  700: "#6d2bab",
  800: "#4f2080",
  900: "#371759",
  950: "#2a1247",
};

/** cyan — accent (links, selection, info, "AI is here"). */
export const cyan: Ramp = {
  50: "#e0fbff",
  100: "#c2f6ff",
  200: "#8fecff",
  300: "#5cdff5",
  400: "#22d3ee",
  500: "#06b6d4",
  600: "#0894ad",
  700: "#0a7184",
  800: "#0a525f",
  900: "#083e48",
  950: "#06323b",
};

/** green — ok / clean verdict. */
export const green: Ramp = {
  50: "#e9fbef",
  100: "#cdf5d9",
  200: "#9aeab6",
  300: "#5fd98c",
  400: "#34c46a",
  500: "#22c55e",
  600: "#179c4a",
  700: "#147a3d",
  800: "#125f32",
  900: "#0d4526",
  950: "#06301a",
};

/** amber — warn verdict. */
export const amber: Ramp = {
  50: "#fff6e5",
  100: "#ffe9bf",
  200: "#ffd585",
  300: "#fbbf4a",
  400: "#f8a61f",
  500: "#f59e0b",
  600: "#cf7c06",
  700: "#a35c08",
  800: "#76430b",
  900: "#523008",
  950: "#3a2606",
};

/** red — error / block verdict. */
export const red: Ramp = {
  50: "#ffe9e9",
  100: "#ffcccc",
  200: "#ff9d9d",
  300: "#fa6b6b",
  400: "#f24343",
  500: "#ef4444",
  600: "#cf2727",
  700: "#a51d1d",
  800: "#771818",
  900: "#511212",
  950: "#3a0d0d",
};

/** slate — panel chrome, muted. */
export const slate: Ramp = {
  50: "#eef2f7",
  100: "#dde4ee",
  200: "#bcc8d8",
  300: "#94a3b8",
  400: "#697587",
  500: "#4a5568",
  600: "#384151",
  700: "#2a313d",
  800: "#1d222b",
  900: "#171b21",
  950: "#11161d",
};

/** The whole primitive layer, addressable by name (CLI/Monaco theme-gen read this). */
export const ramps = { neutral, violet, cyan, green, amber, red, slate } as const;
export type RampName = keyof typeof ramps;

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Semantic tokens (08 §2.1 dark default). Apps reference ONLY these.
 *    Each is keyed by its CSS-variable name so theme.ts can emit `--<key>`.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SemanticColors {
  "bg-app": string;
  /** the warm upper-left node of the app-root radial wash (08 §2 / handoff §2). */
  "bg-app-glow": string;
  "bg-surface": string;
  "bg-surface-2": string;
  "bg-inset": string;
  /** chip / pill fill in the chrome (TopBar pills, composer chips). */
  "bg-chip": string;
  /** the "this row/icon is active-or-hovered" tint (rail, tabs, list rows). */
  "bg-active": string;
  /** secondary-button fill (Details / Run doctor / This session). */
  "bg-elevated": string;
  "border-subtle": string;
  /** list-row separator — one step quieter than border-subtle (handoff §1). */
  "border-row": string;
  /** panel-header separator — between border-row and border-subtle (handoff §1). */
  "border-header": string;
  /** chip / pill outline in the chrome. */
  "border-chip": string;
  "border-strong": string;
  /** the hover outline for an interactive island/chip (handoff §1). */
  "border-hover": string;
  "text-primary": string;
  /** the loudest text — greeting/hero only. */
  "text-strong": string;
  /** card + island titles (handoff §1 `text-title`). */
  "text-title": string;
  /** body copy tint inside cards (handoff §1 `text-body`). */
  "text-body": string;
  "text-secondary": string;
  /** faint metadata — timestamps, sublabels (handoff §1 `text-muted`). */
  "text-muted": string;
  "text-disabled": string;
  brand: string;
  /** the second stop of the primary-CTA gradient (handoff §1 `brand-2`). */
  "brand-2": string;
  /** the light brand tint used in the wordmark gradient + legend swatches. */
  "brand-3": string;
  "brand-fg": string;
  accent: string;
  "focus-ring": string;
  /** verdict/severity ROLE tokens (contrast-gated) */
  ok: string;
  warn: string;
  danger: string;
  /** danger TEXT on dark — a lighter tint than `danger` so copy stays legible. */
  "danger-fg": string;
  info: string;
  selection: string;
}

/** Dark theme — the default (08 §2.1, restyled to the handoff §1 navy ground).
 *  This IS "Prometheus Dark" (scheme #1). Raw hex is legal here ONLY (§6). */
export const darkSemantic: SemanticColors = {
  "bg-app": "#070d18", //          navy ground; the root gets the radial wash (§2)
  "bg-app-glow": "#0d1930", //     the wash's upper-right node
  "bg-surface": "#0c1728", //      island fill
  "bg-surface-2": "#0f1e35", //    raised: hover, popovers, ask-bar top
  "bg-inset": "#0a1322", //        editor / terminal ground
  "bg-chip": "#0e1a2e", //         TopBar + composer pill fill
  "bg-active": "#13253f", //       active rail icon / active tab / row hover
  "bg-elevated": "#152a47", //     secondary button fill
  "border-subtle": "#172a47", //   island borders
  "border-row": "#101d31", //      row separators
  "border-header": "#142438", //   header separators
  "border-chip": "#1a2c48", //     chip / pill outline
  "border-strong": "#244168",
  "border-hover": "#2a4570",
  "text-primary": "#e8f2ff",
  "text-strong": "#eef5ff", //     greeting / hero
  "text-title": "#c9dcf4", //      card titles
  "text-body": "#b7cbe6", //       body copy in cards
  "text-secondary": "#9db4d4",
  "text-muted": "#7d97bd", //      faint metadata
  "text-disabled": "#5f7899",
  brand: violet[500], //           #a855f7 (kept — the Prometheus violet)
  "brand-2": "#e879f9", //         CTA gradient end
  "brand-3": "#c084fc", //         wordmark gradient start / legend swatch
  "brand-fg": "#ffffff", //        text on the brand gradient
  accent: "#35c7ee",
  "focus-ring": "#35c7ee",
  ok: "#8be04a",
  warn: "#f5c944",
  danger: "#ff5566",
  "danger-fg": "#ff8093",
  info: "#35c7ee",
  selection: "#16325a",
};

/** Light theme — the same identity inverted (08 §2.1 light override). */
export const lightSemantic: SemanticColors = {
  "bg-app": neutral[50],
  "bg-app-glow": "#ffffff",
  "bg-surface": "#ffffff",
  "bg-surface-2": neutral[50],
  "bg-inset": neutral[100],
  "bg-chip": neutral[100],
  "bg-active": "#e4ecf7",
  "bg-elevated": neutral[100],
  "border-subtle": neutral[200],
  "border-row": neutral[100],
  "border-header": neutral[200],
  "border-chip": neutral[200],
  "border-strong": neutral[300],
  "border-hover": slate[300],
  "text-primary": neutral[950],
  "text-strong": "#0a0f18",
  "text-title": neutral[900],
  "text-body": slate[500],
  "text-secondary": neutral[600],
  "text-muted": slate[400],
  "text-disabled": neutral[400],
  brand: violet[600],
  "brand-2": "#c026d3",
  "brand-3": violet[500],
  "brand-fg": neutral[50],
  accent: cyan[600],
  "focus-ring": cyan[600],
  ok: green[600],
  // amber-700, not 600: warm yellow-orange on a white surface + its own 14% chip
  // tint only reaches ~2.8:1 at 600 — 700 clears the §7 ≥3:1 UI target (tokens.test).
  warn: amber[700],
  danger: red[600],
  "danger-fg": red[700],
  info: cyan[600],
  selection: cyan[100],
};

/** High-contrast theme — AAA targets, pure black/white + saturated cues (08 §7). */
export const highContrastSemantic: SemanticColors = {
  "bg-app": "#000000",
  "bg-app-glow": "#000000",
  "bg-surface": "#000000",
  "bg-surface-2": "#0a0a0a",
  "bg-inset": "#000000",
  "bg-chip": "#0a0a0a",
  "bg-active": "#1a1a1a",
  "bg-elevated": "#141414",
  "border-subtle": "#ffffff",
  "border-row": "#ffffff",
  "border-header": "#ffffff",
  "border-chip": "#ffffff",
  "border-strong": "#ffffff",
  "border-hover": "#ffffff",
  "text-primary": "#ffffff",
  "text-strong": "#ffffff",
  "text-title": "#ffffff",
  "text-body": "#f2f2f2",
  "text-secondary": "#e6e6e6",
  "text-muted": "#d4d4d4",
  "text-disabled": "#bdbdbd",
  brand: violet[300],
  "brand-2": violet[200],
  "brand-3": violet[200],
  "brand-fg": "#000000",
  accent: cyan[300],
  "focus-ring": cyan[300],
  ok: green[300],
  warn: amber[300],
  danger: red[300],
  "danger-fg": red[200],
  info: cyan[300],
  selection: cyan[800],
};

/* ────────────────────────────────────────────────────────────────────────────
 * 2.2 Verdict, severity, component-state & klass role maps (08 §2.2).
 *     These map engine output to a SEMANTIC token key (not a raw hex), so they
 *     survive theme swaps. Glyphs carry meaning without color (08 §2.5, §7).
 * ──────────────────────────────────────────────────────────────────────────── */

export type RoleToken =
  | "ok"
  | "warn"
  | "danger"
  | "info"
  | "accent"
  | "text-secondary"
  | "text-disabled";

/** Verdict tier → role token (08 §2.2). allow=ok · warn=warn · block/error=danger. */
export const VERDICT_ROLE: Record<VerdictTier, RoleToken> = {
  allow: "ok",
  warn: "warn",
  block: "danger",
  error: "danger",
};

/** Severity → role token (08 §2.2). clean/low=ok · medium=warn · high/critical=danger. */
export const SEVERITY_ROLE: Record<Severity, RoleToken> = {
  clean: "ok",
  low: "ok",
  medium: "warn",
  high: "danger",
  critical: "danger",
};

/** Component lifecycle → role token (08 §2.2; mirrors cmd_status color map). */
export const STATE_ROLE: Record<ComponentState, RoleToken> = {
  enabled: "ok",
  installed: "ok",
  disabled: "warn",
  muted: "accent",
  absent: "text-disabled",
  missing: "warn",
};

/** Finding klass → role token (icon tint only, never sole signal — 08 §2.2). */
export const KLASS_ROLE: Record<FindingKlass, RoleToken> = {
  malware: "danger",
  secret: "warn",
  vuln: "warn",
  sca: "info",
};

/**
 * Verdict glyphs — carry meaning WITHOUT color for accessibility (08 §2.5/§7).
 * allow renders the friendly "Clean ✓"; error gets a distinct ⚠ + copy.
 */
export const VERDICT_GLYPH: Record<VerdictTier, string> = {
  allow: "✓",
  warn: "▲",
  block: "⛔",
  error: "⚠",
};

/** Friendly UPPERCASE labels per tier (08 §2.2/§5.2). allow → "CLEAN". */
export const VERDICT_LABEL: Record<VerdictTier, string> = {
  allow: "CLEAN",
  warn: "WARN",
  block: "BLOCK",
  error: "SCAN FAILED",
};

/** Presence dots, ported verbatim from the TUI (08 §2.5 — `DOT`). */
export const DOT = { present: "●", forgotten: "◐", absent: "○" } as const;

/** Severity glyphs (reuse the verdict family where they overlap). */
export const SEVERITY_GLYPH: Record<Severity, string> = {
  clean: "✓",
  low: "✓",
  medium: "▲",
  high: "▲",
  critical: "⛔",
};

/* ────────────────────────────────────────────────────────────────────────────
 * 2.3 Typography (08 §2.3).
 * ──────────────────────────────────────────────────────────────────────────── */

export const typography = {
  fontUi: `"Inter var", -apple-system, "Segoe UI", Roboto, sans-serif`,
  fontMono: `"JetBrains Mono", "SF Mono", "Cascadia Code", ui-monospace, monospace`,
  // the brand face (handoff §1): bundled Space Grotesk at weight 700 — the wordmark,
  // the greeting, and every island/card title read in it.
  fontBrand: `"Space Grotesk", "Inter var", -apple-system, "Segoe UI", Roboto, sans-serif`,
  brandLetterSpacing: "-0.01em",
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  /** The brand wordmark weight (handoff §1: 700, not the old 600). */
  brandWeight: 700,
  /**
   * rem size / unitless line-height (08 §2.3, re-based by the handoff §1 density
   * decision): the root is a plain 16px (the 112.5% scale is GONE), and dense UI text
   * is authored at 13px / 12.5px — ONE scale, applied everywhere.
   */
  scale: {
    display: { size: "1.5rem", line: "1.25" }, //   24px — the Home greeting
    h1: { size: "1.125rem", line: "1.35" }, //      18px
    h2: { size: "0.9375rem", line: "1.4" }, //      15px — island titles
    body: { size: "0.8125rem", line: "1.5" }, //    13px — the density decision
    small: { size: "0.78125rem", line: "1.45" }, // 12.5px — dense rows / chat
    code: { size: "0.75rem", line: "1.6" }, //      12px mono
  },
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * 2.4 Spacing, radius, density, elevation (08 §2.4).
 * ──────────────────────────────────────────────────────────────────────────── */

/** 4px-base space scale (08 §2.4). */
export const space = {
  0: "0px",
  1: "2px",
  2: "4px",
  3: "6px",
  4: "8px",
  6: "12px",
  8: "16px",
  10: "20px",
  12: "24px",
  16: "32px",
  20: "40px",
  24: "48px",
  32: "64px",
} as const;

/** Corner radii (08 §2.4 + the handoff §2 island scale). */
export const radius = {
  sm: "4px",
  md: "6px", // default control
  lg: "10px", // cards
  island: "12px", // workbench islands (editor / tree / terminal / chat rail)
  xl: "14px", // modals + the Home islands & ask bar
  full: "9999px", // pills, badges
} as const;

/** Elevation tokens (08 §2.4) — we lean on borders, not shadows. */
export const elevation = {
  e0: "none",
  e1: "0 0 0 1px var(--border-subtle)",
  e2: "0 0 0 1px var(--border-subtle), 0 8px 24px rgba(0, 0, 0, 0.35)",
  e3: "0 0 0 1px var(--border-strong), 0 16px 48px rgba(0, 0, 0, 0.5)",
} as const;

/** Density modes (08 §2.4) — flip a single `data-density` attribute. */
export const density = {
  comfortable: { "row-h": "36px", "pad-y": "8px" },
  compact: { "row-h": "28px", "pad-y": "4px" },
} as const;
export type DensityMode = keyof typeof density;

/** Motion durations (08 §2.5). Honor prefers-reduced-motion → 0ms (handled in theme.ts). */
export const motion = {
  hover: "120ms",
  panel: "180ms",
  route: "220ms",
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Built-in color-scheme registry (13 §3.1 — the 20 schemes).
 *    Each is a SemanticColors override map (a token set named). At least 6 are
 *    fully filled; the rest are named placeholders that fall back to their base
 *    so the picker is complete from day one (08 ships dark/light/hc on day one).
 * ──────────────────────────────────────────────────────────────────────────── */

export type SchemeBase = "dark" | "light" | "high-contrast";

export interface ColorScheme {
  id: string;
  name: string;
  base: SchemeBase;
  builtin: boolean;
  /** Partial override over the base SemanticColors; missing keys inherit the base. */
  tokens: Partial<SemanticColors>;
  /** Whether `tokens` is a full hand-authored palette (true) or a named stub (false). */
  filled: boolean;
}

/** Resolve a scheme's base semantic map. */
export function baseSemantic(base: SchemeBase): SemanticColors {
  switch (base) {
    case "light":
      return lightSemantic;
    case "high-contrast":
      return highContrastSemantic;
    default:
      return darkSemantic;
  }
}

/** Flatten a scheme to a complete SemanticColors map (base ◀ override). */
export function resolveScheme(scheme: ColorScheme): SemanticColors {
  return { ...baseSemantic(scheme.base), ...scheme.tokens };
}

// ── #1 Prometheus Dark ★ (the default — IS the 08 dark map, named) ───────────
const prometheusDark: ColorScheme = {
  id: "prometheus-dark",
  name: "Prometheus Dark",
  base: "dark",
  builtin: true,
  filled: true,
  tokens: {}, // identity over the dark base
};

// ── #2 Prometheus Light (08 light override, named) ───────────────────────────
const prometheusLight: ColorScheme = {
  id: "prometheus-light",
  name: "Prometheus Light",
  base: "light",
  builtin: true,
  filled: true,
  tokens: {}, // identity over the light base
};

// ── #3 Ember — warm charcoal + ember-orange (fully filled) ───────────────────
const ember: ColorScheme = {
  id: "ember",
  name: "Ember",
  base: "dark",
  builtin: true,
  filled: true,
  tokens: {
    "bg-app": "#14110d",
    "bg-surface": "#1b1712",
    "bg-surface-2": "#221c16",
    "bg-inset": "#0e0b08",
    "border-subtle": "#2c2419",
    "border-strong": "#3d3322",
    "text-primary": "#f3e8d8",
    "text-secondary": "#b39a82",
    "text-disabled": "#6b5d4f",
    brand: "#d2691e",
    "brand-fg": "#14110d",
    accent: "#e0a96d",
    "focus-ring": "#e0a96d",
    ok: green[400],
    warn: amber[400],
    danger: red[400],
    info: "#e0a96d",
    selection: "#3d3322",
  },
};

// ── #4 Nord Frost — arctic blue-grays (fully filled) ─────────────────────────
const nordFrost: ColorScheme = {
  id: "nord-frost",
  name: "Nord Frost",
  base: "dark",
  builtin: true,
  filled: true,
  tokens: {
    "bg-app": "#2e3440",
    "bg-surface": "#3b4252",
    "bg-surface-2": "#434c5e",
    "bg-inset": "#272c36",
    "border-subtle": "#434c5e",
    "border-strong": "#4c566a",
    "text-primary": "#eceff4",
    "text-secondary": "#d8dee9",
    "text-disabled": "#7b88a1",
    brand: "#b48ead",
    "brand-fg": "#2e3440",
    accent: "#88c0d0",
    "focus-ring": "#88c0d0",
    ok: "#a3be8c",
    warn: "#ebcb8b",
    danger: "#bf616a",
    info: "#81a1c1",
    selection: "#434c5e",
  },
};

// ── #5 Solarized Dark — Schoonover's low-contrast classic (fully filled) ─────
const solarizedDark: ColorScheme = {
  id: "solarized-dark",
  name: "Solarized Dark",
  base: "dark",
  builtin: true,
  filled: true,
  tokens: {
    "bg-app": "#002b36",
    "bg-surface": "#073642",
    "bg-surface-2": "#0a4250",
    "bg-inset": "#00212b",
    "border-subtle": "#0a4250",
    "border-strong": "#586e75",
    "text-primary": "#fdf6e3",
    "text-secondary": "#93a1a1",
    "text-disabled": "#586e75",
    brand: "#d33682",
    "brand-fg": "#002b36",
    accent: "#2aa198",
    "focus-ring": "#2aa198",
    ok: "#859900",
    warn: "#b58900",
    danger: "#dc322f",
    info: "#268bd2",
    selection: "#0a4250",
  },
};

// ── #6 Solarized Light — sepia base (fully filled) ───────────────────────────
const solarizedLight: ColorScheme = {
  id: "solarized-light",
  name: "Solarized Light",
  base: "light",
  builtin: true,
  filled: true,
  tokens: {
    "bg-app": "#fdf6e3",
    "bg-surface": "#eee8d5",
    "bg-surface-2": "#e6dfc8",
    "bg-inset": "#f5eeda",
    "border-subtle": "#e6dfc8",
    "border-strong": "#93a1a1",
    "text-primary": "#073642",
    "text-secondary": "#586e75",
    "text-disabled": "#93a1a1",
    brand: "#d33682",
    "brand-fg": "#fdf6e3",
    accent: "#2aa198",
    "focus-ring": "#2aa198",
    ok: "#859900",
    warn: "#b58900",
    danger: "#dc322f",
    info: "#268bd2",
    selection: "#e6dfc8",
  },
};

// ── #7–#20 — named placeholders (inherit their base until hand-authored) ──────
function stub(
  id: string,
  name: string,
  base: SchemeBase,
  tokens: Partial<SemanticColors> = {},
): ColorScheme {
  return { id, name, base, builtin: true, filled: false, tokens };
}

const dracula = stub("dracula", "Dracula", "dark", {
  "bg-app": "#282a36",
  "bg-surface": "#21222c",
  brand: "#bd93f9",
  accent: "#8be9fd",
  ok: "#50fa7b",
  warn: "#f1fa8c",
  danger: "#ff5555",
  info: "#8be9fd",
});
const gruvbox = stub("gruvbox", "Gruvbox", "dark", {
  "bg-app": "#282828",
  "bg-surface": "#32302f",
  brand: "#d3869b",
  accent: "#83a598",
  ok: "#b8bb26",
  warn: "#fabd2f",
  danger: "#fb4934",
});
const oneDark = stub("one-dark", "One Dark", "dark", {
  "bg-app": "#282c34",
  "bg-surface": "#21252b",
  brand: "#c678dd",
  accent: "#56b6c2",
  ok: "#98c379",
  warn: "#e5c07b",
  danger: "#e06c75",
});
const monokaiPro = stub("monokai-pro", "Monokai Pro", "dark", {
  "bg-app": "#2d2a2e",
  brand: "#ab9df2",
  accent: "#78dce8",
  ok: "#a9dc76",
  warn: "#ffd866",
  danger: "#ff6188",
});
const githubDark = stub("github-dark", "GitHub Dark", "dark", {
  "bg-app": "#0d1117",
  "bg-surface": "#161b22",
  accent: "#58a6ff",
  ok: "#3fb950",
  warn: "#d29922",
  danger: "#f85149",
});
const githubLight = stub("github-light", "GitHub Light", "light", {
  "bg-app": "#ffffff",
  accent: "#0969da",
  ok: "#1a7f37",
  warn: "#9a6700",
  danger: "#cf222e",
});
const tokyoNight = stub("tokyo-night", "Tokyo Night", "dark", {
  "bg-app": "#1a1b26",
  "bg-surface": "#24283b",
  brand: "#bb9af7",
  accent: "#7dcfff",
  ok: "#9ece6a",
  warn: "#e0af68",
  danger: "#f7768e",
});
const catppuccinMocha = stub("catppuccin-mocha", "Catppuccin Mocha", "dark", {
  "bg-app": "#1e1e2e",
  "bg-surface": "#181825",
  brand: "#cba6f7",
  accent: "#89dceb",
  ok: "#a6e3a1",
  warn: "#f9e2af",
  danger: "#f38ba8",
});
const catppuccinLatte = stub("catppuccin-latte", "Catppuccin Latte", "light", {
  "bg-app": "#eff1f5",
  brand: "#8839ef",
  accent: "#04a5e5",
  ok: "#40a02b",
  warn: "#df8e1d",
  danger: "#d20f39",
});
const highContrast = stub("high-contrast", "High Contrast", "high-contrast");
const cursorMist = stub("cursor-mist", "Cursor Mist", "dark", {
  "bg-app": "#16181d",
  "bg-surface": "#1b1e24",
  accent: cyan[400],
});
const lmStudioSlate = stub("lm-studio-slate", "LM Studio Slate", "dark", {
  "bg-app": slate[950],
  "bg-surface": slate[900],
  brand: violet[400],
});
const odysseusWorkspace = stub("odysseus-workspace", "Odysseus Workspace", "dark", {
  "bg-app": "#0c1417",
  "bg-surface": "#11201f",
  accent: "#2dd4bf",
  brand: "#5eead4",
});
const synthwave84 = stub("synthwave-84", "Synthwave '84", "dark", {
  "bg-app": "#241b2f",
  "bg-surface": "#2a2139",
  brand: "#ff7edb",
  accent: "#36f9f6",
  ok: "#72f1b8",
  warn: "#fede5d",
  danger: "#fe4450",
});

/** The built-in color schemes (13 §3.1), in catalog order. #1 is the default. The
 *  first 20 are the first-party set; FAMOUS_SCHEMES appends 20 world-famous editor
 *  themes + the operator's own "Pelly" scheme (tokens/famous-schemes.ts). */
export const BUILTIN_SCHEMES: readonly ColorScheme[] = [
  prometheusDark, // 1 ★
  prometheusLight, // 2
  ember, // 3   (filled)
  nordFrost, // 4   (filled)
  solarizedDark, // 5   (filled)
  solarizedLight, // 6   (filled)
  dracula, // 7
  gruvbox, // 8
  oneDark, // 9
  monokaiPro, // 10
  githubDark, // 11
  githubLight, // 12
  tokyoNight, // 13
  catppuccinMocha, // 14
  catppuccinLatte, // 15
  highContrast, // 16
  cursorMist, // 17
  lmStudioSlate, // 18
  odysseusWorkspace, // 19
  synthwave84, // 20
  ...FAMOUS_SCHEMES, // 21–41: famous community schemes + Pelly (custom)
];

/** The id of the default scheme (★ Prometheus Dark). */
export const DEFAULT_SCHEME_ID = "prometheus-dark";

/** Look up a built-in scheme by id; returns the default scheme if unknown. */
export function getScheme(id: string): ColorScheme {
  return (
    BUILTIN_SCHEMES.find((s) => s.id === id) ??
    BUILTIN_SCHEMES.find((s) => s.id === DEFAULT_SCHEME_ID)!
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ANSI-16 resolver re-export (08 §5.7 / §8.1).
 *   Surfaced here so the `prometheus` CLI + TUI can reach the §5.7 role→ANSI mapping
 *   AND the verdict label/glyph/role maps from the SAME react-free entry
 *   ("@prometheus/ui/tokens" = this file). The CLI must not pull the React barrel.
 * ──────────────────────────────────────────────────────────────────────────── */
export {
  ANSI_NAME,
  ANSI_SGR,
  sgrFor,
  ansiNameFor,
  // operator accent (bold #16b3f5) — the light-blue pin + its SGR-param resolvers.
  ACCENT_HEX,
  ACCENT_RGB,
  ACCENT_SGR,
  ANSI_TRUECOLOR,
  sgrParamsFor,
  sgrParamsForName,
  type AnsiRole,
  type AnsiColorName,
} from "./tokens/ansi.js";

// the user's "Pelly Colors" syntax scheme (raw hex lives under tokens/, §6-exempt).
export { PELLY_SYNTAX, PELLY_SPAN_BG, type PellySynStyle } from "./tokens/pelly-syntax.js";
