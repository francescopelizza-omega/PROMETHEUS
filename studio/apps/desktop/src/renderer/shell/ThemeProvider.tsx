// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/ThemeProvider.tsx — the §6 theming wiring (file 08 §6).
 *
 * Flips `<html data-theme>` (dark default · light · high-contrast) and
 * `<html data-density>` (comfortable · compact) with NO reload + NO flicker:
 *   - follows the OS `prefers-color-scheme` by default ("system"),
 *   - honors a persisted user override (localStorage), live-syncing on OS change,
 *   - re-resolves CSS vars via @prometheus/ui's applyTheme (theme-map → CSS vars).
 *
 * The DECISION logic (which base + which attributes) is the PURE shell brain in
 * @prometheus/ui (resolveThemeBase / appearanceAttributes / parseAppearance,
 * unit-tested without a DOM); this component is the thin React+DOM binding.
 *
 * It also publishes the active SemanticColors so the Monaco/xterm theme-gen
 * (monacoThemeFromSemantic / xtermThemeFromSemantic) feeds the editor + terminal
 * from the same tokens as the chrome (08 §6 "never desync").
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui only. No node/electron/bridge.
 */

import {
  type AppearancePrefs,
  type ColorScheme,
  type DensityMode,
  type SemanticColors,
  type ThemeBaseMode,
  type ThemePreference,
  appearanceAttributes,
  applyDensity,
  applyTheme,
  baseSemantic,
  getScheme,
  parseAppearance,
  resolveScheme,
  themeFromBase,
  themes,
} from "@prometheus/ui";
import {
  type ReactElement,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const STORAGE_KEY = "prometheus.appearance";
const SCHEME_KEY = "prometheus.scheme";
// APP-094: imported / user-authored custom schemes persist HERE (through the ThemeProvider,
// the single owner of scheme persistence) so a custom scheme id survives reload + resolves —
// NOT a parallel key owned by AppearancePage.
const CUSTOM_SCHEMES_KEY = "prometheus.customSchemes";

/** What `useTheme()` exposes to the shell (settings UI + editor theme-gen). */
export interface ThemeContextValue {
  /** the user's theme PREFERENCE ("system" follows the OS). */
  preference: ThemePreference;
  /** the density mode (comfortable · compact). */
  density: DensityMode;
  /** the RESOLVED base actually painted (system → the OS scheme). */
  resolvedBase: ThemeBaseMode;
  /** the active semantic color map (feeds the Monaco + xterm theme-gen). */
  colors: SemanticColors;
  /** the active color-scheme id, or null when following the plain base palette. */
  activeSchemeId: string | null;
  /** APP-094: the persisted custom (imported / user-authored) schemes — shown in the picker. */
  customSchemes: ColorScheme[];
  setPreference(pref: ThemePreference): void;
  setDensity(mode: DensityMode): void;
  /** select a color scheme (Settings ▸ Appearance) — persisted + re-applied on reload. */
  setScheme(id: string | null): void;
  /** APP-094: install (or replace by id) a custom scheme; persisted so it survives reload. */
  registerCustomScheme(scheme: ColorScheme): void;
  /** APP-094: remove a custom scheme by id (builtins are immutable, never removed). */
  removeCustomScheme(id: string): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Read the OS scheme via matchMedia, defaulting to dark when unavailable. */
function readOsScheme(): "light" | "dark" {
  const mm = typeof window !== "undefined" ? window.matchMedia : undefined;
  if (!mm) return "dark";
  return mm("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Load the persisted appearance (fail-soft → defaults). */
function loadAppearance(): AppearancePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return parseAppearance(raw ? JSON.parse(raw) : null);
  } catch {
    return parseAppearance(null);
  }
}

/** Persist the appearance (best-effort; a storage failure is non-fatal). */
function saveAppearance(prefs: AppearancePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — appearance just won't persist this session. */
  }
}

/** Load the persisted color-scheme id (null ⇒ follow the plain base palette). */
function loadSchemeId(): string | null {
  try {
    return window.localStorage.getItem(SCHEME_KEY);
  } catch {
    return null;
  }
}

/** Persist (or clear) the selected scheme id (best-effort). */
function saveSchemeId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(SCHEME_KEY, id);
    else window.localStorage.removeItem(SCHEME_KEY);
  } catch {
    /* fail-soft: theming must never break on a storage error. */
  }
}

/** A loose runtime check that a persisted value is a usable ColorScheme (fail-soft load). */
function isColorScheme(v: unknown): v is ColorScheme {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.base === "string" &&
    typeof o.tokens === "object" &&
    o.tokens !== null
  );
}

/** Load persisted custom schemes (fail-soft → []). */
function loadCustomSchemes(): ColorScheme[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SCHEMES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isColorScheme) : [];
  } catch {
    return [];
  }
}

/** Persist the custom scheme list (best-effort). */
function saveCustomSchemes(schemes: readonly ColorScheme[]): void {
  try {
    window.localStorage.setItem(CUSTOM_SCHEMES_KEY, JSON.stringify(schemes));
  } catch {
    /* quota / private mode — the customs just won't persist this session. */
  }
}

/** Resolve a scheme id to a ColorScheme: a custom scheme wins, else a builtin (undefined
 *  for unknown ids / following the plain base palette). */
function schemeFor(id: string | null, customs: readonly ColorScheme[]): ColorScheme | undefined {
  if (!id) return undefined;
  const custom = customs.find((s) => s.id === id);
  if (custom) return custom;
  try {
    return getScheme(id);
  } catch {
    return undefined;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [prefs, setPrefs] = useState<AppearancePrefs>(loadAppearance);
  const [osScheme, setOsScheme] = useState<"light" | "dark">(readOsScheme);
  // an explicitly-picked color scheme overrides the base palette (persisted so it
  // survives reload — the old code only ever re-applied the base, clobbering it).
  const [schemeId, setSchemeId] = useState<string | null>(loadSchemeId);
  // APP-094: the persisted custom (imported / authored) schemes.
  const [customSchemes, setCustomSchemes] = useState<ColorScheme[]>(loadCustomSchemes);

  // Live-sync with the OS scheme (only matters while preference is "system").
  useEffect(() => {
    const mm = typeof window !== "undefined" ? window.matchMedia : undefined;
    if (!mm) return;
    const mql = mm("(prefers-color-scheme: light)");
    const onChange = (): void => setOsScheme(mql.matches ? "light" : "dark");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Resolve the concrete base + attributes (PURE shell brain) and APPLY them to
  // <html> — write data-theme + the CSS vars (no reload), then data-density.
  const resolvedBase = useMemo<ThemeBaseMode>(() => {
    return appearanceAttributes(prefs, osScheme)["data-theme"];
  }, [prefs, osScheme]);

  // a selected scheme wins (its own colors + base); otherwise follow the base palette.
  const activeScheme = useMemo<ColorScheme | undefined>(
    () => schemeFor(schemeId, customSchemes),
    [schemeId, customSchemes],
  );

  const colors = useMemo<SemanticColors>(
    () => (activeScheme ? resolveScheme(activeScheme) : baseSemantic(resolvedBase)),
    [activeScheme, resolvedBase],
  );

  useEffect(() => {
    const root = typeof document !== "undefined" ? document.documentElement : null;
    if (!root) return;
    // SINGLE owner of what's painted: apply the selected scheme's CSS vars when one
    // is active (re-applied on every reload/density/OS change so it never gets lost),
    // else apply the base palette. applyTheme/applySchemeToRoot both write data-theme.
    if (activeScheme) {
      themes.applySchemeToRoot(activeScheme, root);
    } else {
      applyTheme(themeFromBase(resolvedBase), root);
    }
    applyDensity(prefs.density, root);
    const attrs = appearanceAttributes(prefs, osScheme);
    root.style.setProperty("color-scheme", attrs["color-scheme"]);
  }, [activeScheme, resolvedBase, prefs, osScheme]);

  const setPreference = useCallback((preference: ThemePreference): void => {
    // choosing a base theme is an explicit "use the plain palette" → drop any scheme
    // override so the preference actually takes effect (else the scheme would mask it).
    setSchemeId(null);
    saveSchemeId(null);
    setPrefs((p) => {
      const next = { ...p, theme: preference };
      saveAppearance(next);
      return next;
    });
  }, []);

  const setDensity = useCallback((density: DensityMode): void => {
    setPrefs((p) => {
      const next = { ...p, density };
      saveAppearance(next);
      return next;
    });
  }, []);

  const setScheme = useCallback((id: string | null): void => {
    setSchemeId(id);
    saveSchemeId(id);
  }, []);

  const registerCustomScheme = useCallback((scheme: ColorScheme): void => {
    setCustomSchemes((cur) => {
      const next = [...cur.filter((s) => s.id !== scheme.id), scheme];
      saveCustomSchemes(next);
      return next;
    });
  }, []);

  const removeCustomScheme = useCallback((id: string): void => {
    setCustomSchemes((cur) => {
      const next = cur.filter((s) => s.id !== id);
      saveCustomSchemes(next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference: prefs.theme,
      density: prefs.density,
      resolvedBase,
      colors,
      activeSchemeId: schemeId,
      customSchemes,
      setPreference,
      setDensity,
      setScheme,
      registerCustomScheme,
      removeCustomScheme,
    }),
    [
      prefs.theme,
      prefs.density,
      resolvedBase,
      colors,
      schemeId,
      customSchemes,
      setPreference,
      setDensity,
      setScheme,
      registerCustomScheme,
      removeCustomScheme,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Read the active theme + appearance setters (08 §6). Throws outside the provider. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
