/**
 * themes/registry.ts — the scheme registry (file 13 §3.7).
 *
 * builtin: the 20 schemes are 08's `BUILTIN_SCHEMES` (the SINGLE source — we do NOT
 * re-author 20 JSON files; that would drift). user: validated `CustomThemeFile`s
 * adapted to `ColorScheme`. active(scope): a global id + optional per-window overrides
 * (§3.5). Immutable: every mutator returns a NEW registry.
 */
import {
  BUILTIN_SCHEMES,
  type ColorScheme,
  DEFAULT_SCHEME_ID,
  type SchemeBase,
  getScheme,
} from "../tokens.js";
import type { CustomThemeFile } from "./types.js";

/** The active-scheme selection: a global default + per-window overrides (§3.5). */
export interface ActiveSelection {
  global: string;
  /** window id → scheme id (a floating terminal / 2nd window can pin its own; §3.5). */
  windows: Record<string, string>;
}

/** The theme registry (§3.7). */
export interface ThemeRegistry {
  builtin: readonly ColorScheme[];
  user: readonly ColorScheme[];
  active: ActiveSelection;
}

/** Adapt a CustomThemeFile → a ColorScheme (the in-memory override map). */
export function customFileToScheme(file: CustomThemeFile): ColorScheme {
  return {
    id: file.meta.id,
    name: file.meta.name,
    base: file.meta.base,
    builtin: false,
    tokens: { ...file.uiTokens },
    filled: true,
  };
}

/** Serialize a ColorScheme back to a CustomThemeFile for export (§3.3). */
export function schemeToCustomFile(
  scheme: ColorScheme,
  opts: { createdAt: string; author?: string; version?: string; baseScheme?: string },
): CustomThemeFile {
  return {
    $schema: "prometheus-studio/theme@1",
    meta: {
      id: scheme.id,
      name: scheme.name,
      base: scheme.base,
      version: opts.version ?? "1.0.0",
      createdAt: opts.createdAt,
      ...(opts.author ? { author: opts.author } : {}),
      ...(opts.baseScheme ? { baseScheme: opts.baseScheme } : {}),
    },
    uiTokens: { ...scheme.tokens },
    syntaxTokens: {},
  };
}

/** Build a registry from validated user theme files (builtin is always 08's set). */
export function createThemeRegistry(userFiles: readonly CustomThemeFile[] = []): ThemeRegistry {
  return {
    builtin: BUILTIN_SCHEMES,
    user: userFiles.map(customFileToScheme),
    active: { global: DEFAULT_SCHEME_ID, windows: {} },
  };
}

/** All schemes (builtin first, then user), the picker order. */
export function listSchemes(reg: ThemeRegistry): ColorScheme[] {
  return [...reg.builtin, ...reg.user];
}

/** Look up a scheme by id (user overrides shadow a builtin of the same id). */
export function getSchemeById(reg: ThemeRegistry, id: string): ColorScheme | undefined {
  return reg.user.find((s) => s.id === id) ?? reg.builtin.find((s) => s.id === id);
}

/** Add (or replace) a user scheme — returns a NEW registry. */
export function addUserScheme(reg: ThemeRegistry, scheme: ColorScheme): ThemeRegistry {
  const user = [...reg.user.filter((s) => s.id !== scheme.id), scheme];
  return { ...reg, user };
}

/** Remove a user scheme — returns a NEW registry (builtins are immutable). */
export function removeUserScheme(reg: ThemeRegistry, id: string): ThemeRegistry {
  return { ...reg, user: reg.user.filter((s) => s.id !== id) };
}

/** Set the active scheme globally, or for one window (§3.5) — returns a NEW registry. */
export function setActive(reg: ThemeRegistry, id: string, windowId?: string): ThemeRegistry {
  if (windowId) {
    return {
      ...reg,
      active: { ...reg.active, windows: { ...reg.active.windows, [windowId]: id } },
    };
  }
  return { ...reg, active: { ...reg.active, global: id } };
}

/** Clear a window's per-window override (it falls back to the global scheme; §3.5). */
export function clearWindowOverride(reg: ThemeRegistry, windowId: string): ThemeRegistry {
  const windows = { ...reg.active.windows };
  delete windows[windowId];
  return { ...reg, active: { ...reg.active, windows } };
}

/** The active scheme id for a window (per-window override else global; §3.5). */
export function activeSchemeId(reg: ThemeRegistry, windowId?: string): string {
  if (windowId && reg.active.windows[windowId]) return reg.active.windows[windowId];
  return reg.active.global;
}

/** Resolve the active ColorScheme for a window (falls back to the 08 default). */
export function activeScheme(reg: ThemeRegistry, windowId?: string): ColorScheme {
  return getSchemeById(reg, activeSchemeId(reg, windowId)) ?? getScheme(DEFAULT_SCHEME_ID);
}

/** Map a SchemeBase to the Monaco base id (for theme-gen). */
export function monacoBaseFor(base: SchemeBase): "vs" | "vs-dark" | "hc-black" {
  return base === "light" ? "vs" : base === "high-contrast" ? "hc-black" : "vs-dark";
}
