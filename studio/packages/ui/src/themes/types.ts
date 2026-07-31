import type { SyntaxStyle } from "../theme.js";
/**
 * themes/types.ts — file 13's theming models (§3.6), built ON TOP of 08's engine.
 *
 * 08 owns the tokens (`tokens.ts`), the theme@1 doc + resolution (`theme.ts`), and the
 * Monaco/xterm theme-gen. This layer adds the AUTHORING surface: the on-disk
 * `CustomThemeFile` a user (or a .promext) ships, plus the contrast-report shapes the
 * §3.4 save-gate produces. It REUSES 08's `ColorScheme`/`SemanticColors`/`SyntaxStyle`
 * (imported, never re-declared) — a CustomThemeFile is just a named override map over
 * the same semantic layer, with a syntax layer + an optional ANSI layer.
 *
 * Re-exported from `@prometheus/ui` under the `themes` NAMESPACE so its `CustomThemeFile`
 * / `ContrastReport` never collide with the flat `ThemeTokens`/`ColorScheme` exports.
 */
import type { SchemeBase, SemanticColors } from "../tokens.js";

export type { SchemeBase, SemanticColors } from "../tokens.js";

/** The UI-token override layer — 08 semantic roles, hex values (§3.6). */
export type UiTokenOverrides = Partial<Record<keyof SemanticColors, string>>;

/** The syntax/TextMate override layer — Monaco scopes (§3.6). */
export type SyntaxTokenOverrides = Record<string, SyntaxStyle>;

/** The xterm ANSI-16 slot names a scheme may override (§3.6). */
export type AnsiSlot =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

export type AnsiOverrides = Partial<Record<AnsiSlot, string>>;

/** The last contrast-checker verdict, recorded on save (§3.4/§3.6). */
export type ContrastBadge = "AAA" | "AA" | "fail";

/** A custom theme on disk — `~/.prometheus-studio/themes/<name>.json` (§3.6). */
export interface CustomThemeFile {
  $schema: "prometheus-studio/theme@1";
  meta: {
    id: string;
    name: string;
    base: SchemeBase;
    author?: string;
    version: string;
    /** which builtin it was forked from (provenance). */
    baseScheme?: string;
    createdAt: string;
    /** last checker result, recorded on save. */
    contrast?: ContrastBadge;
  };
  uiTokens: UiTokenOverrides;
  syntaxTokens: SyntaxTokenOverrides;
  ansi?: AnsiOverrides;
}

/* ── contrast report (§3.4) ────────────────────────────────────────────────── */

/** What a contrast pair guards — only `verdict` failures HARD-BLOCK a save. */
export type ContrastPairKind = "body" | "role" | "verdict";

/** One measured WCAG pair in the contrast report (§3.4). */
export interface ContrastPair {
  /** human label, e.g. "text-primary on bg-surface" or "danger on its 14% tint". */
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  /** the AA minimum this pair must meet (4.5 body / 3 role+verdict). */
  required: number;
  pass: boolean;
  kind: ContrastPairKind;
  /** the semantic role this pair measures (for the auto-fix target). */
  role?: keyof SemanticColors;
}

/** The whole-scheme contrast report the §3.4 badge + save-gate read. */
export interface ContrastReport {
  badge: ContrastBadge;
  pairs: ContrastPair[];
  /** the verdict-token failures that BLOCK a save (fail-closed; §3.4). */
  verdictFailures: ContrastPair[];
  /** every failure (verdict + body + role) for the editor warnings list. */
  failures: ContrastPair[];
  passCount: number;
  total: number;
}

/** The result of a save attempt through the §3.4 gate. */
export type SaveOutcome =
  | { ok: true; file: CustomThemeFile; report: ContrastReport }
  | { ok: false; reason: string; report: ContrastReport };

/** The result of parsing a user theme file (fail-soft — never throws; §3.7). */
export type ParseOutcome = { ok: true; file: CustomThemeFile } | { ok: false; reason: string };
