// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * theme.ts — the theme@1 document type + load/apply for Prometheus Studio.
 *
 * ThemeTokens here is the *runtime mirror* of schemas/theme/v1.json (C12):
 *   { schema:"theme@1", meta, base, uiTokens, syntaxTokens }
 * 08 §6 owns the *resolution mechanism* — flipping `<html data-theme>` and
 * writing CSS variables, no reload. This module implements exactly that:
 *   - loadTheme(file)            parse + structurally validate a theme@1 JSON.
 *   - applyTheme(tokens, root)   write `--<token>` CSS vars + `data-theme`.
 *   - schemeToTheme(scheme)      adapt a tokens.ts ColorScheme → a theme@1 doc.
 *
 * Cosmetics fail SOFT (a malformed theme is rejected, never crashes the picker —
 * 13 §3.7); only the security verdict-contrast gate fails closed. This loader
 * does the soft half: it returns null on a bad document instead of throwing.
 */

import {
  BUILTIN_SCHEMES,
  type ColorScheme,
  DEFAULT_SCHEME_ID,
  type SchemeBase,
  type SemanticColors,
  baseSemantic,
  resolveScheme,
} from "./tokens.js";

/* ────────────────────────────────────────────────────────────────────────────
 * theme@1 document shape (mirrors schemas/theme/v1.json).
 * ──────────────────────────────────────────────────────────────────────────── */

export type ThemeBase = SchemeBase; // "dark" | "light" | "high-contrast"

export interface ThemeMeta {
  id: string;
  label: string;
  author?: string;
  version?: string;
  description?: string;
}

/** A syntax token style: a bare color string, or color + font styling. */
export type SyntaxStyle =
  | string
  | {
      color: string;
      background?: string;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
    };

/**
 * The theme@1 document. `uiTokens` carries the chrome (08 semantic) roles;
 * `syntaxTokens` carries the Monaco/TextMate editor scopes (08 §6 theme-gen).
 * Both are open maps (schema: additionalProperties) with the well-known keys
 * called out as optional, exactly like schemas/theme/v1.json.
 */
export interface ThemeTokens {
  schema: "theme@1";
  meta: ThemeMeta;
  base: ThemeBase;
  uiTokens: Partial<Record<keyof SemanticColors, string>> & Record<string, string>;
  syntaxTokens: Record<string, SyntaxStyle>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Validation (structural; matches the schema's required keys + shapes).
 * ──────────────────────────────────────────────────────────────────────────── */

const THEME_BASES: readonly ThemeBase[] = ["dark", "light", "high-contrast"];

/* These mirror schemas/theme/v1.json so the runtime loader and the JSON Schema
 * cannot drift (C12). A custom/user theme that the schema would reject is rejected
 * here too (fail-soft → null, never a crash — 13 §3.7). */
const COLOR_RE =
  /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgb|rgba|hsl|hsla)\([^)]*\))$/;
const META_ID_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

const META_KEYS = new Set(["id", "label", "author", "version", "description"]);
const TOP_KEYS = new Set(["schema", "meta", "base", "uiTokens", "syntaxTokens"]);
const SYNTAX_KEYS = new Set(["color", "background", "bold", "italic", "underline"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isColor(v: unknown): v is string {
  return typeof v === "string" && COLOR_RE.test(v);
}

function isSyntaxStyle(v: unknown): v is SyntaxStyle {
  if (typeof v === "string") return isColor(v);
  if (!isRecord(v)) return false;
  if (!isColor(v.color)) return false;
  if (v.background !== undefined && !isColor(v.background)) return false;
  // additionalProperties:false — only the known style keys are allowed.
  for (const k of Object.keys(v)) if (!SYNTAX_KEYS.has(k)) return false;
  return true;
}

/**
 * Structurally validate a parsed object against theme@1. Returns the typed
 * document or null (fail-soft — caller surfaces a toast, never crashes; 13 §3.7).
 */
export function validateTheme(value: unknown): ThemeTokens | null {
  if (!isRecord(value)) return null;
  if (value.schema !== "theme@1") return null;
  // additionalProperties:false at the top level (schema v1.json).
  for (const k of Object.keys(value)) if (!TOP_KEYS.has(k)) return null;
  if (!isRecord(value.meta)) return null;
  const meta = value.meta as Record<string, unknown>;
  // additionalProperties:false on meta.
  for (const k of Object.keys(meta)) if (!META_KEYS.has(k)) return null;
  if (typeof meta.id !== "string" || !META_ID_RE.test(meta.id)) return null;
  if (typeof meta.label !== "string" || meta.label.length === 0) return null;
  if (
    meta.version !== undefined &&
    (typeof meta.version !== "string" || !VERSION_RE.test(meta.version))
  )
    return null;
  if (typeof value.base !== "string" || !THEME_BASES.includes(value.base as ThemeBase)) return null;
  if (!isRecord(value.uiTokens) || Object.keys(value.uiTokens).length === 0) return null;
  if (!isRecord(value.syntaxTokens) || Object.keys(value.syntaxTokens).length === 0) return null;

  // ui token values must all be valid colors (hex / rgb / hsl), not arbitrary strings.
  for (const v of Object.values(value.uiTokens)) {
    if (!isColor(v)) return null;
  }
  // syntax token values must each be a valid SyntaxStyle.
  for (const v of Object.values(value.syntaxTokens)) {
    if (!isSyntaxStyle(v)) return null;
  }

  return {
    schema: "theme@1",
    meta: {
      id: meta.id as string,
      label: meta.label as string,
      ...(typeof meta.author === "string" ? { author: meta.author } : {}),
      ...(typeof meta.version === "string" ? { version: meta.version } : {}),
      ...(typeof meta.description === "string" ? { description: meta.description } : {}),
    },
    base: value.base as ThemeBase,
    uiTokens: value.uiTokens as ThemeTokens["uiTokens"],
    syntaxTokens: value.syntaxTokens as ThemeTokens["syntaxTokens"],
  };
}

/**
 * Serialize a theme@1 document to a shareable, DETERMINISTIC JSON string (APP-094).
 * Keys are emitted in a stable order (top-level → meta → tokens sorted) so a round-trip
 * `validateTheme(loadTheme(exportTheme(t)))` deep-equals the NORMALIZED (post-validate)
 * document regardless of the input's key order. Pure/stdlib (no DOM/Electron — theme.ts
 * also feeds the CLI ANSI token source, so it must stay dependency-free).
 */
export function exportTheme(theme: ThemeTokens): string {
  const meta: Record<string, unknown> = { id: theme.meta.id, label: theme.meta.label };
  if (theme.meta.author !== undefined) meta.author = theme.meta.author;
  if (theme.meta.version !== undefined) meta.version = theme.meta.version;
  if (theme.meta.description !== undefined) meta.description = theme.meta.description;
  const sortedUi: Record<string, string> = {};
  for (const k of Object.keys(theme.uiTokens).sort()) sortedUi[k] = theme.uiTokens[k]!;
  const sortedSyntax: Record<string, SyntaxStyle> = {};
  for (const k of Object.keys(theme.syntaxTokens).sort()) sortedSyntax[k] = theme.syntaxTokens[k]!;
  const obj = {
    schema: "theme@1" as const,
    meta,
    base: theme.base,
    uiTokens: sortedUi,
    syntaxTokens: sortedSyntax,
  };
  return JSON.stringify(obj, null, 2);
}

/**
 * Parse + validate a theme@1 document from a JSON string (the contents of a
 * theme file). Returns null on a JSON-parse error or a schema mismatch — the
 * picker stays alive (13 §3.7). The actual file READ is the host's job (the
 * engine-bridge / main process); this stays runtime-pure and dependency-free.
 */
export function loadTheme(fileContents: string): ThemeTokens | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents);
  } catch {
    return null;
  }
  return validateTheme(parsed);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Apply — write CSS variables (08 §6 resolution: no reload, no flicker).
 * ──────────────────────────────────────────────────────────────────────────── */

/** A minimal structural view of the bits of an Element we touch (keeps the */
/** package buildable without lib.dom in this source-only pass).             */
interface CssVarTarget {
  style: { setProperty(prop: string, value: string): void };
  setAttribute(name: string, value: string): void;
}

/** Resolve the document root, falling back gracefully when there is no DOM. */
function defaultRoot(): CssVarTarget | null {
  const g = globalThis as unknown as { document?: { documentElement?: CssVarTarget } };
  return g.document?.documentElement ?? null;
}

/**
 * Apply a theme@1 document to a root element by writing `--<token>` CSS vars and
 * the `data-theme` attribute. UI tokens become `--<key>` (e.g. `--bg-app`);
 * syntax tokens become `--syntax-<key>` (Monaco theme-gen reads these). Returns
 * the flat var map it wrote (handy for the CLI/Monaco adapters and for tests).
 */
export function applyTheme(
  theme: ThemeTokens,
  root: CssVarTarget | null = defaultRoot(),
): Record<string, string> {
  const vars = themeToCssVars(theme);
  if (root) {
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value);
    }
    root.setAttribute("data-theme", theme.base);
  }
  return vars;
}

/** Flatten a theme@1 doc to a `{ "--token": "value" }` map (no DOM needed). */
export function themeToCssVars(theme: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.uiTokens)) {
    vars[`--${key}`] = value;
  }
  for (const [scope, style] of Object.entries(theme.syntaxTokens)) {
    vars[`--syntax-${scope}`] = typeof style === "string" ? style : style.color;
  }
  return vars;
}

/** Toggle the density attribute (08 §2.4) on a root; a peer of data-theme. */
export function applyDensity(
  mode: "comfortable" | "compact",
  root: CssVarTarget | null = defaultRoot(),
): void {
  root?.setAttribute("data-density", mode);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Adapter — a tokens.ts ColorScheme → a theme@1 document.
 * Lets the 20 built-in schemes (which are SemanticColors override maps) flow
 * through the exact same loadTheme/applyTheme path as on-disk user themes.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Default syntax scopes derived from semantic roles, so every scheme is */
/** editor-ready without hand-authoring a full TextMate layer.            */
function defaultSyntax(sem: SemanticColors): Record<string, SyntaxStyle> {
  return {
    comment: { color: sem["text-disabled"], italic: true },
    keyword: { color: sem.brand, bold: true },
    string: sem.ok,
    number: sem.warn,
    function: sem.accent,
    variable: sem["text-primary"],
    type: sem.info,
    constant: sem.warn,
    operator: sem["text-secondary"],
    punctuation: sem["text-secondary"],
  };
}

/** Turn a built-in/user ColorScheme into a theme@1 document. */
export function schemeToTheme(scheme: ColorScheme): ThemeTokens {
  const sem = resolveScheme(scheme);
  return {
    schema: "theme@1",
    meta: { id: scheme.id, label: scheme.name },
    base: scheme.base,
    uiTokens: { ...sem },
    syntaxTokens: defaultSyntax(sem),
  };
}

/** The default theme@1 document (★ Prometheus Dark), ready to applyTheme(). */
export function defaultTheme(): ThemeTokens {
  const scheme = BUILTIN_SCHEMES.find((s) => s.id === DEFAULT_SCHEME_ID) ?? BUILTIN_SCHEMES[0]!;
  return schemeToTheme(scheme);
}

/** Build a theme@1 doc straight from a base mode (no scheme override). */
export function themeFromBase(base: ThemeBase): ThemeTokens {
  const sem = baseSemantic(base);
  return {
    schema: "theme@1",
    meta: { id: `prometheus-${base}`, label: `Prometheus ${base}` },
    base,
    uiTokens: { ...sem },
    syntaxTokens: defaultSyntax(sem),
  };
}
