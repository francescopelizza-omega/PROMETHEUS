/**
 * hooks/useTheme.ts — the reusable §6 theming hook (08 §6). React-only, no node.
 *
 * Standalone (no React context required): resolves a ThemePreference to a concrete
 * base (following the OS `prefers-color-scheme` for "system"), writes data-theme +
 * the CSS vars via applyTheme(), live-syncs on OS change, and publishes the active
 * SemanticColors so a Monaco/xterm theme-gen can stay in lock-step (08 §6 "never
 * desync"). The desktop ships a thin context Provider over this same brain.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ThemeBaseMode,
  type ThemePreference,
  resolveThemeBase,
} from "../shell/theme-resolve.js";
import { applyTheme, themeFromBase } from "../theme.js";
import { type SemanticColors, baseSemantic } from "../tokens.js";

function readOsScheme(): "light" | "dark" {
  const mm = typeof window !== "undefined" ? window.matchMedia : undefined;
  if (!mm) return "dark";
  return mm("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export interface UseThemeResult {
  preference: ThemePreference;
  resolvedBase: ThemeBaseMode;
  colors: SemanticColors;
  setPreference(pref: ThemePreference): void;
}

/** Resolve + apply a theme preference; returns the active base, colors, and setter. */
export function useTheme(initial: ThemePreference = "system"): UseThemeResult {
  const [preference, setPreference] = useState<ThemePreference>(initial);
  const [osScheme, setOsScheme] = useState<"light" | "dark">(readOsScheme);

  useEffect(() => {
    const mm = typeof window !== "undefined" ? window.matchMedia : undefined;
    if (!mm) return;
    const mql = mm("(prefers-color-scheme: light)");
    const onChange = (): void => setOsScheme(mql.matches ? "light" : "dark");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const resolvedBase = useMemo<ThemeBaseMode>(
    () => resolveThemeBase(preference, osScheme),
    [preference, osScheme],
  );

  const colors = useMemo<SemanticColors>(() => baseSemantic(resolvedBase), [resolvedBase]);

  useEffect(() => {
    const root = typeof document !== "undefined" ? document.documentElement : null;
    if (!root) return;
    applyTheme(themeFromBase(resolvedBase), root);
  }, [resolvedBase]);

  const set = useCallback((pref: ThemePreference): void => setPreference(pref), []);

  return { preference, resolvedBase, colors, setPreference: set };
}
