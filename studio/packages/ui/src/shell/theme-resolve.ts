/**
 * shell/theme-resolve.ts — the §6 theming RESOLUTION model (file 08 §6).
 *
 * The ThemeProvider (desktop) must: follow OS `prefers-color-scheme` by default,
 * honor a persisted user override, and flip `<html data-theme>` / `data-density`
 * with NO reload + NO flicker. This module owns the PURE decision logic (no
 * React, no DOM): given an OS scheme + a stored preference, what base + density
 * attributes should be written? theme.ts owns the actual DOM write (applyTheme /
 * applyDensity); this owns "which theme".
 *
 * Keeping it pure makes the "system sync + override" rule unit-testable from TS
 * source (no jsdom): the test feeds OS="dark", pref="light" and asserts the
 * resolved base — exactly the §6 "no reload, no flicker" contract's brain.
 */

import { BUILTIN_SCHEMES, DEFAULT_SCHEME_ID, type DensityMode } from "../tokens.js";

/** The three shipping themes (08 §6). data-theme ∈ these. */
export type ThemeBaseMode = "dark" | "light" | "high-contrast";

/** The user's theme PREFERENCE — "system" follows the OS (08 §6 default). */
export type ThemePreference = "system" | ThemeBaseMode;

/** The OS color scheme as read from `prefers-color-scheme` (light/dark only). */
export type OsScheme = "light" | "dark";

/** The persisted shell appearance settings (localStorage / settings store). */
export interface AppearancePrefs {
  theme: ThemePreference;
  density: DensityMode;
  /** the active built-in color scheme id (08 §6 + 13 §3.1 — one of BUILTIN_SCHEMES). */
  scheme: string;
}

/** The shipped default appearance (08 §2.1 dark default · §2.4 compact default). */
export const DEFAULT_APPEARANCE: AppearancePrefs = {
  theme: "system",
  density: "compact",
  scheme: DEFAULT_SCHEME_ID,
};

const SCHEME_IDS: ReadonlySet<string> = new Set(BUILTIN_SCHEMES.map((s) => s.id));

const THEME_PREFS: readonly ThemePreference[] = ["system", "dark", "light", "high-contrast"];
const DENSITIES: readonly DensityMode[] = ["comfortable", "compact"];

/**
 * Resolve the concrete `data-theme` base to apply from a preference + the OS
 * scheme. "system" maps the OS light/dark; an explicit preference wins. Total:
 * a bad preference falls back to following the OS (08 §6 default behavior).
 */
export function resolveThemeBase(pref: ThemePreference, osScheme: OsScheme): ThemeBaseMode {
  switch (pref) {
    case "light":
    case "dark":
    case "high-contrast":
      return pref;
    default:
      // "system" (or anything unexpected): follow the OS scheme.
      return osScheme === "light" ? "light" : "dark";
  }
}

/**
 * Parse a persisted appearance blob (e.g. from localStorage JSON) into a valid
 * AppearancePrefs, falling back to the defaults for any missing/invalid field.
 * Fail-soft (08 §6/13 §3.7): a corrupt preference never crashes the shell, it
 * just reverts to system-dark/compact.
 */
export function parseAppearance(value: unknown): AppearancePrefs {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_APPEARANCE };
  const v = value as Record<string, unknown>;
  const theme =
    typeof v.theme === "string" && THEME_PREFS.includes(v.theme as ThemePreference)
      ? (v.theme as ThemePreference)
      : DEFAULT_APPEARANCE.theme;
  const density =
    typeof v.density === "string" && DENSITIES.includes(v.density as DensityMode)
      ? (v.density as DensityMode)
      : DEFAULT_APPEARANCE.density;
  const scheme =
    typeof v.scheme === "string" && SCHEME_IDS.has(v.scheme) ? v.scheme : DEFAULT_APPEARANCE.scheme;
  return { theme, density, scheme };
}

/**
 * The set of DOM attributes the ThemeProvider writes onto `<html>` for a given
 * preference + OS scheme + density. The provider applies these via theme.ts's
 * applyTheme/applyDensity; this pure helper computes WHAT to write so it's
 * testable without a DOM. `color-scheme` lets the UA paint native widgets/
 * scrollbars to match (08 §6 "no flicker").
 */
export function appearanceAttributes(
  prefs: AppearancePrefs,
  osScheme: OsScheme,
): { "data-theme": ThemeBaseMode; "data-density": DensityMode; "color-scheme": "light" | "dark" } {
  const base = resolveThemeBase(prefs.theme, osScheme);
  return {
    "data-theme": base,
    "data-density": prefs.density,
    // high-contrast paints on a dark canvas → report "dark" to the UA.
    "color-scheme": base === "light" ? "light" : "dark",
  };
}
