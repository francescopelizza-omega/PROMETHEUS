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
import { FILL_ROLES, onFill } from "./tokens/contrast.js";
import { derivePalette } from "./tokens/scheme-derive.js";

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
  /* ── the LABEL colour for each role used as a SOLID FILL (`on-<role>`) ──────────
   *
   * A role colour is painted two ways and the two need different foregrounds:
   *   - as a glyph, border or 14% tint  → the role itself, 3:1 (already covered above);
   *   - as a SOLID FILL with a label on it → a verdict chip's solid variant, the Git
   *     `tag:` pill, the search Aa/.*\/ab toggles, the MCP enable switch, every primary
   *     CTA. That label is TEXT, so it carries 4.5:1 against the fill.
   *
   * There was no token for the second case, so call sites reached for whatever was
   * nearest — mostly `brand-fg`, which is WHITE on the dark scheme. White on `--accent`
   * (#35c7ee) measures 1.99:1, on `--ok` 1.63:1, on `--warn` 1.58:1. Swapping them all to
   * `bg-app` fixes the dark scheme and breaks the light one for the mirror-image reason:
   * there `bg-app` is near-white and the fills are saturated mid-tones (black on light
   * `--accent` reads 5.85:1, the near-white ground only 3.38:1). Neither ground nor pole
   * is right universally — it depends on the fill — which is exactly what a token is for.
   *
   * Computed, never hand-picked: `onFill` prefers the scheme's OWN `bg-app` (so a chip
   * still reads as part of the scheme) and falls back to whichever pole actually carries
   * the ratio. `resolveScheme` recomputes any of these that a scheme leaves to the base
   * while overriding the matching role, so a partial palette can never inherit a
   * foreground that was measured against a different fill. */
  "on-brand": string;
  "on-accent": string;
  "on-ok": string;
  "on-warn": string;
  "on-danger": string;
  "on-info": string;
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
  // BORDERS, re-based for legibility.
  //
  // Every one of these sat between 1.06:1 and 1.87:1 against `bg-surface`. WCAG asks 3:1 of a
  // non-text UI boundary, and these were not close — which is why "text going outside the
  // graphical element that contains it" was so hard to see: on a dark ground the element had
  // no perceivable edge to go outside OF. Lifted along the SAME hue (lightness only), so the
  // navy character is unchanged and only the visibility moves.
  "border-subtle": "#2a4d82", //   island borders        (1.25 → 2.12:1)
  "border-row": "#213b64", //      row separators        (1.06 → 1.60:1, deliberately the quietest)
  "border-header": "#28476f", //   header separators     (1.15 → 1.90:1)
  "border-chip": "#2f5082", //     chip / pill outline   (1.28 → 2.22:1)
  "border-strong": "#3865a1", //   dividers that carry MEANING — clears the 3:1 UI bar (1.74 → 3.03:1)
  "border-hover": "#436eb2", //    hover/focus edge      (1.87 → 3.52:1)
  // TEXT, lifted (2026-09-08). The whole text ramp below `text-primary` read as "gray on
  // dark": secondary (662 call sites) sat at #9db4d4 and muted at #7d97bd — WCAG-legal, but
  // visibly dim next to white chrome. Lifted along the same navy hue so hierarchy survives
  // (primary > title > body > secondary > muted > disabled) while every step stays bright.
  // Ratios on bg-surface (#0c1728): primary 16.9, title 14.7, body 13.0, secondary 12.0,
  // muted 9.2, disabled 6.9 — all comfortably above AA (4.5:1).
  "text-primary": "#f0f6ff",
  "text-strong": "#ffffff", //     greeting / hero
  "text-title": "#e4eefc", //      card titles
  "text-body": "#d6e3f5", //       body copy in cards
  "text-secondary": "#c3d4ea",
  "text-muted": "#a6bbd9", //      faint metadata — still legible, not faint
  "text-disabled": "#8ba1c0", //   dimmest step; 6.9:1 so "disabled" never means "invisible"
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
  selection: "#16325a",  /* label colours for the solid role fills — see `onFill`; pinned by tokens.test.ts. */
  "on-brand": "#070d18", // on #a855f7 = 4.92:1
  "on-accent": "#070d18", // on #35c7ee = 9.78:1
  "on-ok": "#070d18", // on #8be04a = 11.91:1
  "on-warn": "#070d18", // on #f5c944 = 12.34:1
  "on-danger": "#070d18", // on #ff5566 = 6.24:1
  "on-info": "#070d18", // on #35c7ee = 9.78:1
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
  // The bottom of the LIGHT ramp was measured against its own grounds (bg-app #f7f8fa,
  // bg-surface #fff, bg-inset #e9ecf1) and three of four steps failed AA on the inset:
  // secondary 4.92, muted 3.95, disabled 2.13. `neutral[400]` as "disabled" is the light
  // twin of the grey-on-dark report — legible on white, invisible on an inset panel. Re-based
  // along the same slate hue so the ladder survives and every step clears 4.5:1 on the WORST
  // light ground: secondary 5.47, muted 4.97, disabled 4.54. The band is narrower than dark's
  // because a light ground has less room below AA; that is the ground's limit, not a choice.
  "text-secondary": "#535f71",
  "text-muted": "#5a6578",
  "text-disabled": "#606b7e",
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
  selection: cyan[100],  /* label colours for the solid role fills — see `onFill`; pinned by tokens.test.ts. */
  "on-brand": "#f7f8fa", // on #8b3ad6 = 5.38:1
  "on-accent": "#000000", // on #0894ad = 5.85:1
  "on-ok": "#000000", // on #179c4a = 5.89:1
  "on-warn": "#f7f8fa", // on #a35c08 = 4.83:1
  "on-danger": "#f7f8fa", // on #cf2727 = 4.97:1
  "on-info": "#000000", // on #0894ad = 5.85:1
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
  selection: cyan[800],  /* label colours for the solid role fills — see `onFill`; pinned by tokens.test.ts. */
  "on-brand": "#000000", // on #c08cff = 8.44:1
  "on-accent": "#000000", // on #5cdff5 = 13.33:1
  "on-ok": "#000000", // on #5fd98c = 11.79:1
  "on-warn": "#000000", // on #fbbf4a = 12.65:1
  "on-danger": "#000000", // on #fa6b6b = 7.38:1
  "on-info": "#000000", // on #5cdff5 = 13.33:1
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
  /**
   * The small end of the scale was re-based for READABILITY.
   *
   * 13px body / 12.5px small is a scale drawn for someone who reads code all day on a
   * high-DPI display. Reported verbatim by the user: text is "quite difficult to be read in
   * most cases for people that are not expert developers". The large end was already fine and
   * is untouched — this only lifts the sizes that dense UI actually renders at.
   */
  scale: {
    display: { size: "1.5rem", line: "1.25" }, //   24px — the Home greeting
    h1: { size: "1.125rem", line: "1.35" }, //      18px
    h2: { size: "1rem", line: "1.4" }, //           16px — island titles   (was 15px)
    body: { size: "0.875rem", line: "1.55" }, //    14px — UI default      (was 13px)
    small: { size: "0.8125rem", line: "1.5" }, //   13px — dense rows/chat (was 12.5px)
    code: { size: "0.78125rem", line: "1.6" }, //   12.5px mono            (was 12px)
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

/**
 * Flatten a scheme to a complete SemanticColors map (base ◀ override).
 *
 * The `on-<role>` pass is what makes a PARTIAL palette safe. `tokens` is a
 * `Partial<SemanticColors>`, so a scheme that overrides `danger` but says nothing about
 * `on-danger` would inherit a label colour measured against the BASE scheme's red — the
 * exact fall-through that once gave Ember the base's navy separators and an inverted text
 * ramp. So whenever a scheme moves a fill without stating its label colour, the label is
 * recomputed from the fill that will actually be painted.
 *
 * An EXPLICIT `on-*` in `tokens` is left alone: a hand-authored or user-imported theme that
 * states one has said something deliberate, and the save-gate is where legibility is
 * enforced for those.
 */
export function resolveScheme(scheme: ColorScheme): SemanticColors {
  const merged = { ...baseSemantic(scheme.base), ...scheme.tokens };
  for (const role of FILL_ROLES) {
    const key = `on-${role}` as const;
    if (scheme.tokens[key] !== undefined) continue;
    if (scheme.tokens[role] === undefined && scheme.tokens["bg-app"] === undefined) continue;
    merged[key] = onFill(merged[role], merged["bg-app"]);
  }
  return merged;
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

// ── #3–#6 — the fully-authored first-party schemes ───────────────────────────
//
// These four used to be hand-written `Partial<SemanticColors>` maps that filled ~22 of the 33
// §2 roles and let the rest fall through to the Prometheus base. `filled: true` was therefore
// only half true, and the half that was missing was visible: Ember (warm charcoal) inherited
// the base's NAVY row separators, chips and `text-muted`; Nord and Solarized did the same.
// Worse, the inherited `text-muted` sat on a different ground than it was tuned for, which is
// how Ember ended up with muted (9.11:1) BRIGHTER than its own secondary (6.67:1) — the same
// inverted ramp the famous schemes had.
//
// They are authored as palettes now and run through the SAME `derivePalette` the famous
// schemes use, so every role is filled from the scheme's own colours and the text ramp is
// monotone and floored by construction. See tokens/scheme-derive.ts for the measurements.

/** Ember — warm charcoal + ember-orange. */
const ember: ColorScheme = {
  id: "ember",
  name: "Ember",
  base: "dark",
  builtin: true,
  filled: true,
  tokens: derivePalette(
    {
      bg: "#14110d",
      surface: "#1b1712",
      surface2: "#221c16",
      inset: "#0e0b08",
      borderSubtle: "#2c2419",
      borderStrong: "#3d3322",
      text: "#f3e8d8",
      textDim: "#b39a82",
      brand: "#d2691e",
      accent: "#e0a96d",
      ok: green[400],
      warn: amber[400],
      danger: red[400],
      info: "#e0a96d",
      selection: "#3d3322",
    },
    "dark",
  ),
};

/** Nord Frost — arctic blue-grays. */
const nordFrost: ColorScheme = {
  id: "nord-frost",
  name: "Nord Frost",
  base: "dark",
  builtin: true,
  filled: true,
  tokens: derivePalette(
    {
      bg: "#2e3440",
      surface: "#3b4252",
      surface2: "#434c5e",
      inset: "#272c36",
      borderSubtle: "#434c5e",
      borderStrong: "#4c566a",
      text: "#eceff4",
      textDim: "#d8dee9",
      brand: "#b48ead",
      accent: "#88c0d0",
      ok: "#a3be8c",
      warn: "#ebcb8b",
      danger: "#bf616a",
      info: "#81a1c1",
      selection: "#434c5e",
    },
    "dark",
  ),
};

/** Solarized Dark — Schoonover's low-contrast classic. */
const solarizedDark: ColorScheme = {
  id: "solarized-dark",
  name: "Solarized Dark",
  base: "dark",
  builtin: true,
  filled: true,
  tokens: derivePalette(
    {
      bg: "#002b36",
      surface: "#073642",
      surface2: "#0a4250",
      inset: "#00212b",
      borderSubtle: "#0a4250",
      borderStrong: "#586e75",
      text: "#fdf6e3",
      textDim: "#93a1a1",
      brand: "#d33682",
      accent: "#2aa198",
      ok: "#859900",
      warn: "#b58900",
      danger: "#dc322f",
      info: "#268bd2",
      selection: "#0a4250",
    },
    "dark",
  ),
};

/** Solarized Light — sepia base. */
const solarizedLight: ColorScheme = {
  id: "solarized-light",
  name: "Solarized Light",
  base: "light",
  builtin: true,
  filled: true,
  tokens: derivePalette(
    {
      bg: "#fdf6e3",
      surface: "#eee8d5",
      surface2: "#e6dfc8",
      inset: "#f5eeda",
      borderSubtle: "#e6dfc8",
      borderStrong: "#93a1a1",
      text: "#073642",
      textDim: "#586e75",
      brand: "#d33682",
      accent: "#2aa198",
      ok: "#859900",
      warn: "#b58900",
      danger: "#dc322f",
      info: "#268bd2",
      selection: "#e6dfc8",
    },
    "light",
  ),
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
// Latte's own green/peach/sky are drawn for syntax on a warm off-white, and as CHIP fills on
// the app's white surface they measured 2.62–2.88:1 against the surface and their own 14%
// tint — under the §7 3:1 bar for a non-text UI element, so a warn chip and an ok chip were
// telling the user apart by a colour they could barely see. Darkened along the same hue by
// the smallest step that clears 3:1 on both (ok 3.63/3.10, warn 3.69/3.15, accent 3.60/3.04).
// brand and danger already cleared it and are the authentic values, untouched.
const catppuccinLatte = stub("catppuccin-latte", "Catppuccin Latte", "light", {
  "bg-app": "#eff1f5",
  brand: "#8839ef",
  accent: "#0490c8",
  ok: "#3d9929",
  warn: "#ba7618",
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
