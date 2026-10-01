// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import { type ThemeTokens, applyTheme, schemeToTheme, themeToCssVars } from "../theme.js";
/**
 * themes/loader.ts — load/apply/save schemes (file 13 §3.7), wiring 08's engine.
 *
 * - `parseCustomThemeFile` — fail-soft parse+validate of a user `~/.prometheus-studio/
 *   themes/<name>.json` (malformed → a reason, never a throw; the picker stays alive,
 *   §3.7);
 * - `schemeAssets` — resolve a scheme to its CSS vars + Monaco theme + xterm 16-color
 *   map via 08's `schemeToTheme`/`themeToCssVars`/`monacoThemeFromTheme`/
 *   `xtermThemeFromSemantic` (one token source, all surfaces in lockstep, §3.1);
 * - `applySchemeToRoot` — flip a window's CSS vars + data-theme (08 §6, no reload);
 * - `prepareSave` — run the §3.4 contrast gate; BLOCK on a verdict-token failure
 *   (fail-closed) and stamp the badge into the file's meta.
 */
import type { ColorScheme } from "../tokens.js";
import { resolveScheme } from "../tokens.js";

/** The CSS-var apply target (08's applyTheme root) — structural, not exported by theme.ts. */
type CssVarTarget = Parameters<typeof applyTheme>[1];
import { type MonacoThemeData, monacoThemeFromTheme } from "../tokens/monaco-theme.js";
import { type XtermTheme, xtermThemeFromSemantic } from "../tokens/monaco-theme.js";
import { blockReason, canSave, checkContrast } from "./contrast.js";
import { customFileToScheme, monacoBaseFor } from "./registry.js";
import type { CustomThemeFile, ParseOutcome, SaveOutcome, SchemeBase } from "./types.js";

const COLOR_RE =
  /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgb|rgba|hsl|hsla)\([^)]*\))$/;
const BASES: readonly SchemeBase[] = ["dark", "light", "high-contrast"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a parsed object as a CustomThemeFile (fail-soft → reason; §3.7). */
function validateCustomFile(v: unknown): ParseOutcome {
  if (!isRecord(v)) return { ok: false, reason: "not an object" };
  if (v.$schema !== "prometheus-studio/theme@1")
    return { ok: false, reason: "missing/wrong $schema" };
  if (!isRecord(v.meta)) return { ok: false, reason: "missing meta" };
  const meta = v.meta;
  if (typeof meta.id !== "string" || typeof meta.name !== "string")
    return { ok: false, reason: "meta needs id + name" };
  if (typeof meta.base !== "string" || !BASES.includes(meta.base as SchemeBase)) {
    return { ok: false, reason: "meta.base must be dark|light|high-contrast" };
  }
  if (typeof meta.version !== "string") return { ok: false, reason: "meta.version required" };
  if (!isRecord(v.uiTokens)) return { ok: false, reason: "uiTokens must be an object" };
  // every uiToken value must be a valid color (reject over-reaching files; §3.7)
  for (const [k, val] of Object.entries(v.uiTokens)) {
    if (typeof val !== "string" || !COLOR_RE.test(val))
      return { ok: false, reason: `uiTokens.${k} is not a color` };
  }
  if (v.syntaxTokens !== undefined && !isRecord(v.syntaxTokens)) {
    return { ok: false, reason: "syntaxTokens must be an object" };
  }
  const file: CustomThemeFile = {
    $schema: "prometheus-studio/theme@1",
    meta: {
      id: meta.id,
      name: meta.name,
      base: meta.base as SchemeBase,
      version: meta.version,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
      ...(typeof meta.author === "string" ? { author: meta.author } : {}),
      ...(typeof meta.baseScheme === "string" ? { baseScheme: meta.baseScheme } : {}),
    },
    uiTokens: { ...(v.uiTokens as Record<string, string>) },
    syntaxTokens: isRecord(v.syntaxTokens)
      ? (v.syntaxTokens as CustomThemeFile["syntaxTokens"])
      : {},
    ...(isRecord(v.ansi) ? { ansi: v.ansi as CustomThemeFile["ansi"] } : {}),
  };
  return { ok: true, file };
}

/** Parse a user theme file's JSON text — fail-soft (never throws; §3.7). */
export function parseCustomThemeFile(json: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  return validateCustomFile(parsed);
}

/** The resolved render assets for a scheme — chrome + editor + terminal in lockstep. */
export interface SchemeAssets {
  theme: ThemeTokens;
  cssVars: Record<string, string>;
  monaco: MonacoThemeData;
  xterm: XtermTheme;
}

/** Resolve a scheme to all three surface palettes via 08's theme-gen (§3.1). */
export function schemeAssets(scheme: ColorScheme): SchemeAssets {
  const theme = schemeToTheme(scheme);
  return {
    theme,
    cssVars: themeToCssVars(theme),
    monaco: monacoThemeFromTheme(theme, monacoBaseFor(scheme.base)),
    xterm: xtermThemeFromSemantic(resolveScheme(scheme)),
  };
}

/** Apply a scheme to a window root (its CSS vars + data-theme; 08 §6, no reload). */
export function applySchemeToRoot(
  scheme: ColorScheme,
  root: CssVarTarget | null,
): Record<string, string> {
  return applyTheme(schemeToTheme(scheme), root);
}

/**
 * The §3.4 save-gate: BLOCK on a verdict-token contrast failure (fail-closed); on pass,
 * return the file with its contrast badge stamped into meta (§3.6).
 */
export function prepareSave(file: CustomThemeFile): SaveOutcome {
  const report = checkContrast(customFileToScheme(file));
  if (!canSave(report)) {
    return { ok: false, reason: blockReason(report), report };
  }
  return {
    ok: true,
    file: { ...file, meta: { ...file.meta, contrast: report.badge } },
    report,
  };
}
