/**
 * monaco-theme.ts — generate the Monaco editor theme + the xterm terminal theme FROM
 * the active semantic token map (file 08 §6: editor + terminal never desync from
 * chrome). file 07's EditorPane / Terminal feed these to monaco.editor.defineTheme /
 * the xterm Terminal `theme` option.
 */
import type { SyntaxStyle, ThemeTokens } from "../theme.js";
import { type SemanticColors, darkSemantic } from "../tokens.js";
import { PELLY_EDITOR_COLORS, PELLY_MONACO_SYNTAX, type PellySynStyle } from "./pelly-syntax.js";

export interface MonacoTokenRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}
export interface MonacoThemeData {
  base: "vs" | "vs-dark" | "hc-black";
  inherit: boolean;
  rules: MonacoTokenRule[];
  colors: Record<string, string>;
}

const bare = (hex: string) => hex.replace("#", "");

export function monacoThemeFromSemantic(
  s: SemanticColors,
  base: MonacoThemeData["base"] = "vs-dark",
): MonacoThemeData {
  return {
    base,
    inherit: true,
    rules: [
      { token: "comment", foreground: bare(s["text-secondary"]), fontStyle: "italic" },
      { token: "keyword", foreground: bare(s.brand) },
      { token: "string", foreground: bare(s.ok) },
      { token: "number", foreground: bare(s.accent) },
      { token: "type", foreground: bare(s.info) },
      { token: "function", foreground: bare(s.brand) },
      { token: "variable", foreground: bare(s["text-primary"]) },
    ],
    colors: {
      "editor.background": s["bg-inset"],
      "editor.foreground": s["text-primary"],
      "editorLineNumber.foreground": s["text-disabled"],
      "editorLineNumber.activeForeground": s["text-secondary"],
      "editor.selectionBackground": s.selection,
      "editorCursor.foreground": s.accent,
      "editorError.foreground": s.danger,
      "editorWarning.foreground": s.warn,
      "editorInfo.foreground": s.info,
      "editor.lineHighlightBackground": s["bg-surface"],
      focusBorder: s["focus-ring"],
    },
  };
}

/**
 * The PELLY editor scheme (handoff §1 "Editor scheme") over a given chrome palette.
 *
 * The CHROME (background, selection, cursor, focus ring) still comes from the active
 * semantic tokens, so the editor island keeps matching the shell; only the SYNTAX rules
 * and the three gutter/current-line colors are Pelly's. That split is deliberate: the
 * operator's syntax palette is the constant, the chrome follows whichever scheme is
 * selected.
 *
 * NOTE for the caller: Monaco's bracket-pair colorization paints bracket CHARACTERS by
 * NESTING DEPTH and overrides the tokenizer, so it must be OFF for the per-character
 * brace/bracket colors below to appear (EditorPane disables it).
 */
export function pellyMonacoTheme(
  s: SemanticColors,
  base: MonacoThemeData["base"] = "vs-dark",
): MonacoThemeData {
  const rules: MonacoTokenRule[] = Object.entries(PELLY_MONACO_SYNTAX).map(([token, style]) => {
    const fontStyle = pellyFontStyle(style);
    return fontStyle === undefined
      ? { token, foreground: bare(style.fg) }
      : { token, foreground: bare(style.fg), fontStyle };
  });
  return {
    base,
    inherit: true,
    rules,
    colors: {
      // chrome: from the active scheme (tokens.test pins editor.background === bg-inset)
      "editor.background": s["bg-inset"],
      "editor.selectionBackground": s.selection,
      "editorCursor.foreground": s.accent,
      "editorError.foreground": s.danger,
      "editorWarning.foreground": s.warn,
      "editorInfo.foreground": s.info,
      focusBorder: s["focus-ring"],
      // syntax-adjacent: from Pelly
      "editor.foreground": PELLY_EDITOR_COLORS.foreground,
      "editorLineNumber.foreground": PELLY_EDITOR_COLORS.lineNumber,
      "editorLineNumber.activeForeground": PELLY_EDITOR_COLORS.lineNumberActive,
      "editor.lineHighlightBackground": PELLY_EDITOR_COLORS.currentLine,
      "editor.lineHighlightBorder": PELLY_EDITOR_COLORS.currentLineBorder,
    },
  };
}

/** Compose a Monaco fontStyle string from a Pelly style's bold/italic. */
function pellyFontStyle(style: PellySynStyle): string | undefined {
  const parts = [style.bold && "bold", style.italic && "italic"].filter(Boolean).join(" ");
  return parts.length > 0 ? parts : undefined;
}

/** Compose a Monaco fontStyle string from a SyntaxStyle's bold/italic/underline. */
function fontStyleOf(style: SyntaxStyle): string | undefined {
  if (typeof style === "string") return undefined;
  const parts = [style.bold && "bold", style.italic && "italic", style.underline && "underline"]
    .filter(Boolean)
    .join(" ");
  return parts.length > 0 ? parts : undefined;
}

/** A SyntaxStyle's color (bare string form, or the object's `color`). */
function colorOf(style: SyntaxStyle): string {
  return typeof style === "string" ? style : style.color;
}

/**
 * Generate a Monaco theme from a full theme@1 document (08 §6/§79): the
 * syntaxTokens carry bold/italic/underline (the schemeToTheme adapter sets comment
 * italic + keyword bold), so unlike monacoThemeFromSemantic this preserves font
 * intent. uiTokens map to the editor colors block, falling back to the dark base
 * for any well-known key a partial theme omits.
 */
export function monacoThemeFromTheme(
  theme: ThemeTokens,
  base: MonacoThemeData["base"] = "vs-dark",
): MonacoThemeData {
  const ui = (key: keyof SemanticColors): string =>
    (theme.uiTokens[key] as string | undefined) ?? darkSemantic[key];
  const rules: MonacoTokenRule[] = Object.entries(theme.syntaxTokens).map(([token, style]) => {
    const fontStyle = fontStyleOf(style);
    return fontStyle === undefined
      ? { token, foreground: bare(colorOf(style)) }
      : { token, foreground: bare(colorOf(style)), fontStyle };
  });
  return {
    base,
    inherit: true,
    rules,
    colors: {
      "editor.background": ui("bg-inset"),
      "editor.foreground": ui("text-primary"),
      "editorLineNumber.foreground": ui("text-disabled"),
      "editorLineNumber.activeForeground": ui("text-secondary"),
      "editor.selectionBackground": ui("selection"),
      "editorCursor.foreground": ui("accent"),
      "editorError.foreground": ui("danger"),
      "editorWarning.foreground": ui("warn"),
      "editorInfo.foreground": ui("info"),
      "editor.lineHighlightBackground": ui("bg-surface"),
      focusBorder: ui("focus-ring"),
    },
  };
}

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
}

/** The ANSI-16 mapping (file 08 §5.7): brand->magenta, accent->cyan, ok->green, warn->yellow, danger->red. */
export function xtermThemeFromSemantic(s: SemanticColors): XtermTheme {
  return {
    background: s["bg-inset"],
    foreground: s["text-primary"],
    cursor: s.accent,
    selectionBackground: s.selection,
    black: s["bg-app"],
    red: s.danger,
    green: s.ok,
    yellow: s.warn,
    blue: s.info,
    magenta: s.brand,
    cyan: s.accent,
    white: s["text-primary"],
    brightBlack: s["text-secondary"],
  };
}

export const monacoDarkTheme = monacoThemeFromSemantic(darkSemantic, "vs-dark");
export const xtermDarkTheme = xtermThemeFromSemantic(darkSemantic);
