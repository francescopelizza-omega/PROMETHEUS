/**
 * tokens/ansi.ts — the §5.7 / §8.1 ANSI-16 resolver (file 08).
 *
 * The CLI cannot take a hex value for the terminal's 16-color path, so the design
 * system also publishes the semantic-role → ANSI-color-NAME → SGR-code mapping that
 * both the `prometheus` CLI (apps/cli render.ts) and the prometheus TUI consume. This is the
 * ONE place the §5.7 row contract lives:
 *
 *   brand → magenta · accent → cyan · ok → green · warn → yellow ·
 *   danger → red · info → cyan · secondary → bright-black (SGR 90).
 *
 * GOLDEN RULE (C5/§6): this maps tokens to a RENDERING; it decides nothing about
 * safety. It is pure data + a lookup, no react/node deps, so the CLI can import it.
 */

/** A semantic role the CLI/TUI tints text with (the §5.7 left column). */
export type AnsiRole =
  | "brand"
  | "accent"
  | "ok"
  | "warn"
  | "danger"
  | "info"
  | "secondary"
  | "disabled";

/** The §5.7 role → ANSI color-NAME map (the single source for the CLI palette). */
export const ANSI_NAME: Record<AnsiRole, AnsiColorName> = {
  brand: "magenta",
  accent: "cyan",
  ok: "green",
  warn: "yellow",
  danger: "red",
  info: "cyan",
  secondary: "brightBlack",
  disabled: "gray",
} as const;

/** Every ANSI color name we can resolve → its SGR foreground integer. */
export type AnsiColorName =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

/** ANSI color name → SGR foreground code (gray === brightBlack === 90). */
export const ANSI_SGR: Record<AnsiColorName, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  brightBlack: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
} as const;

/**
 * Operator accent — the "light blue" pin. The 16-color cyan is only an approximation; the
 * operator wants this EXACT hex for every light-blue output, rendered BOLD. Falls back to the
 * 16-color cyan on terminals without 24-bit color. (#16b3f5 = rgb(22, 179, 245).)
 */
export const ACCENT_HEX = "#16b3f5";
export const ACCENT_RGB = { r: 22, g: 179, b: 245 } as const;

/** 24-bit BOLD SGR params for the accent (bold + truecolor foreground). */
export const ACCENT_SGR = `1;38;2;${ACCENT_RGB.r};${ACCENT_RGB.g};${ACCENT_RGB.b}`;

/** Color names that resolve to the operator accent (bold #16b3f5) instead of the 16-color code. */
export const ANSI_TRUECOLOR: Partial<Record<AnsiColorName, string>> = {
  cyan: ACCENT_SGR,
};

/** SGR params (string) for a color name — the accent override (cyan) or the 16-color code. */
export function sgrParamsForName(name: AnsiColorName): string {
  return ANSI_TRUECOLOR[name] ?? String(ANSI_SGR[name]);
}

/** SGR params (string) for a role — light-blue roles (accent/info) become bold #16b3f5. */
export function sgrParamsFor(role: AnsiRole): string {
  return sgrParamsForName(ANSI_NAME[role]);
}

/** Resolve a semantic role → its SGR foreground code (the CLI wrap() needs this). */
export function sgrFor(role: AnsiRole): number {
  return ANSI_SGR[ANSI_NAME[role]];
}

/** Resolve a semantic role → its ANSI color name (the TUI's COLOR map needs this). */
export function ansiNameFor(role: AnsiRole): AnsiColorName {
  return ANSI_NAME[role];
}
