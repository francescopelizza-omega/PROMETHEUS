/**
 * render.ts — tiny ANSI color + table helpers for the prometheus CLI.
 *
 * The 16-color SGR codes are NOT hand-declared here: they are sourced from the
 * design system's single ANSI artifact, `@prometheus/ui/tokens` (`ANSI_SGR` /
 * `sgrFor`, the §5.7 role→ANSI map). This is the §8.1 contract — "tokens, not
 * components, are shared; the CLI reads the same token data to pick its 16-color
 * ANSI mapping" — so a brand/accent/verdict color means the same thing in the GUI,
 * the CLI, and the TUI, with no drift.
 *
 * Color is opt-in and auto-disabled when stdout is not a TTY, when NO_COLOR is
 * set (https://no-color.org), or when --no-color / --json is passed. Everything
 * here is pure string formatting — it never decides anything about safety; it
 * only renders the verdicts/envelopes the engine-bridge already produced (C5).
 */

import { ANSI_SGR, type AnsiRole, sgrParamsFor, sgrParamsForName } from "@prometheus/ui/tokens";

// ---- color state ---------------------------------------------------------- //

let COLOR_ENABLED = true;
let UNICODE_ENABLED = true;

/** Toggle color globally (called once from bin.ts after arg parsing). */
export function setColorEnabled(on: boolean): void {
  COLOR_ENABLED = on;
}

/**
 * Toggle UNICODE glyphs globally (CLI-097): OFF ⇒ box/status glyphs degrade to ASCII so a dumb
 * terminal (or a non-UTF-8 locale) stays legible. Orthogonal to color — NO_COLOR on a UTF-8
 * terminal keeps the glyphs, only the color drops. Called once from bin.ts after arg parsing.
 */
export function setUnicodeEnabled(on: boolean): void {
  UNICODE_ENABLED = on;
}

/** The default unicode-glyph decision (CLI-097): a `TERM=dumb` terminal can't render the glyphs. */
export function defaultUnicodeEnabled(): boolean {
  return process.env.TERM !== "dumb";
}

/** Pick a glyph by the live UNICODE_ENABLED state: the unicode form, or its ASCII fallback (CLI-097). */
function glyph(unicode: string, ascii: string): string {
  return UNICODE_ENABLED ? unicode : ascii;
}

/**
 * Decide the default. Priority:
 *   1. FORCE_COLOR (1/2/3/true) → ON  — force color even when stdout isn't a detected
 *      TTY (the standard escape hatch when the session runs under a wrapper / pipe /
 *      multiplexer that hides isTTY). FORCE_COLOR=0 → OFF.
 *   2. NO_COLOR (any non-empty)  → OFF (https://no-color.org).
 *   3. TERM=dumb                 → OFF.
 *   4. else                      → ON only when stdout is a real TTY.
 */
export function defaultColorEnabled(): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false" && force !== "";
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.TERM === "dumb") return false;
  // process.stdout.isTTY is undefined when piped — treat as no-color.
  return process.stdout.isTTY === true;
}

// SGR control codes (reset/bold/dim) are intrinsic; the color codes resolve from
// the design-token ANSI source (@prometheus/ui/tokens ANSI_SGR) — never re-declared.
const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: ANSI_SGR.red,
  green: ANSI_SGR.green,
  yellow: ANSI_SGR.yellow,
  blue: ANSI_SGR.blue,
  magenta: ANSI_SGR.magenta,
  cyan: ANSI_SGR.cyan,
  gray: ANSI_SGR.gray,
} as const;

type ColorName = keyof typeof CODES;

// `code` may be a single SGR integer (16-color) OR a full SGR param string such as
// "1;38;2;22;179;245" (the bold-truecolor accent) — both render the same way.
function wrap(s: string, code: number | string): string {
  if (!COLOR_ENABLED) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

export const c = {
  bold: (s: string) => wrap(s, CODES.bold),
  dim: (s: string) => wrap(s, CODES.dim),
  red: (s: string) => wrap(s, CODES.red),
  green: (s: string) => wrap(s, CODES.green),
  yellow: (s: string) => wrap(s, CODES.yellow),
  blue: (s: string) => wrap(s, CODES.blue),
  magenta: (s: string) => wrap(s, CODES.magenta),
  // "light blue" output is pinned to the operator accent (bold #16b3f5, 24-bit) — the
  // resolver returns the 16-color cyan code on terminals without truecolor.
  cyan: (s: string) => wrap(s, sgrParamsForName("cyan")),
  gray: (s: string) => wrap(s, CODES.gray),
  color: (s: string, name: ColorName) =>
    wrap(s, name === "cyan" ? sgrParamsForName("cyan") : CODES[name]),
  /** Tint by SEMANTIC role (08 §5.7): brand/accent/ok/warn/danger/info/secondary. */
  role: (s: string, role: AnsiRole) => wrap(s, sgrParamsFor(role)),
};

// ---- visible-length aware helpers ----------------------------------------- //

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width of a string, ignoring ANSI escapes. */
export function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/** Right-pad a string to `width` based on its VISIBLE length (ANSI-safe). */
export function padEnd(s: string, width: number): string {
  const gap = width - visibleLen(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/** Left-pad a string to `width` based on its VISIBLE length (ANSI-safe). */
export function padStart(s: string, width: number): string {
  const gap = width - visibleLen(s);
  return gap > 0 ? " ".repeat(gap) + s : s;
}

// ---- symbols -------------------------------------------------------------- //

export const sym = {
  ok: () => c.green(glyph("●", "+")),
  off: () => c.gray(glyph("○", "-")),
  warn: () => c.yellow(glyph("▲", "!")),
  bad: () => c.red(glyph("✖", "x")),
  bullet: () => c.dim(glyph("•", "*")),
} as const;

// ---- table ---------------------------------------------------------------- //

export interface TableColumn {
  header: string;
  /** "left" (default) or "right" alignment. */
  align?: "left" | "right";
}

/**
 * Render a simple left/right aligned table. Cells may already contain ANSI
 * color — column widths are computed from VISIBLE length so alignment holds.
 * Returns the full multi-line string (no trailing newline).
 */
export function table(columns: TableColumn[], rows: string[][]): string {
  const widths = columns.map((col, i) => {
    let w = visibleLen(col.header);
    for (const row of rows) {
      const cell = row[i] ?? "";
      const len = visibleLen(cell);
      if (len > w) w = len;
    }
    return w;
  });

  const fmtRow = (cells: string[]): string =>
    columns
      .map((col, i) => {
        const cell = cells[i] ?? "";
        const w = widths[i] ?? 0;
        return col.align === "right" ? padStart(cell, w) : padEnd(cell, w);
      })
      .join("  ")
      .replace(/\s+$/, "");

  const headerLine = fmtRow(columns.map((col) => c.bold(col.header)));
  const out: string[] = [headerLine];
  for (const row of rows) out.push(fmtRow(row));
  return out.join("\n");
}

// ---- box (rounded ANSI panel, visible-length aware) ----------------------- //

export interface BoxOpts {
  /** inside horizontal padding (default 1). */
  pad?: number;
  /** force a minimum inner width (visible cols); content can exceed it. */
  minWidth?: number;
  /** tint the border by a semantic role (default: dim gray). */
  border?: AnsiRole;
  /** per-line horizontal alignment (default "left"). */
  align?: "left" | "center";
}

/**
 * Draw a rounded box around `lines` (Claude-Code-style chrome). Width is computed
 * from the VISIBLE length of each line (ANSI-safe), so colored content aligns. The
 * border uses ╭─╮│╰╯; content is padded to a common inner width.
 */
export function box(lines: string[], opts: BoxOpts = {}): string {
  const pad = opts.pad ?? 1;
  const content = lines.length > 0 ? lines : [""];
  const inner = Math.max(opts.minWidth ?? 0, ...content.map(visibleLen));
  // CLI-097: ASCII box on a dumb terminal (─│╭╮╰╯ → -|+); unchanged on a unicode terminal.
  const bar = glyph("─", "-").repeat(inner + pad * 2);
  const vert = glyph("│", "|");
  const [tl, tr, bl, br] = UNICODE_ENABLED ? ["╭", "╮", "╰", "╯"] : ["+", "+", "+", "+"];
  const tint = (s: string): string => (opts.border ? c.role(s, opts.border) : c.dim(s));
  const sp = " ".repeat(pad);
  const body = content.map((line) => {
    const filled =
      opts.align === "center" ? padEnd(padStartCenter(line, inner), inner) : padEnd(line, inner);
    return `${tint(vert)}${sp}${filled}${sp}${tint(vert)}`;
  });
  return [tint(`${tl}${bar}${tr}`), ...body, tint(`${bl}${bar}${br}`)].join("\n");
}

/**
 * A full-width BACKGROUND-colored banner line (the verdict-card header, CLI-039). The bg color
 * comes from the design-token SGR codes (never raw hex): ok=green, warn=yellow, danger=red, with
 * a contrasting bold fg. Width follows `process.stdout.columns` (80 when piped/undefined, never
 * NaN). Degrades to PLAIN label text when color is disabled (NO_COLOR / non-TTY / --no-color) —
 * the label is always present as readable text.
 */
export function bgBanner(label: string, tone: "ok" | "warn" | "danger"): string {
  if (!COLOR_ENABLED) return label;
  const cols = process.stdout.columns;
  const width = typeof cols === "number" && cols > 0 ? cols : 80;
  const padded = padEnd(` ${label}`, width);
  // black fg on yellow, bright-white on green/red — SGR ints (30/97), not hex.
  const fg = tone === "warn" ? 30 : 97;
  const bg = (tone === "ok" ? CODES.green : tone === "warn" ? CODES.yellow : CODES.red) + 10;
  return `\x1b[1;${fg};${bg}m${padded}\x1b[0m`;
}

/** A faint horizontal rule (dim ─ run), optional centered dim label (Claude-Code turn divider). */
export function rule(width = 56, label?: string): string {
  const dash = glyph("─", "-"); // CLI-097: ASCII rule on a dumb terminal
  if (!label) return c.dim(dash.repeat(width));
  const tag = ` ${label} `;
  const side = Math.max(2, Math.floor((width - visibleLen(tag)) / 2));
  return c.dim(`${dash.repeat(side)}${tag}${dash.repeat(side)}`);
}

/** Center a string within `width` by visible length (left-bias on odd remainder). */
function padStartCenter(s: string, width: number): string {
  const gap = width - visibleLen(s);
  if (gap <= 0) return s;
  const left = Math.floor(gap / 2);
  return `${" ".repeat(left)}${s}`;
}

// ---- misc ----------------------------------------------------------------- //

/** A heading line ("== Title =="-ish, but quiet). */
export function heading(title: string): string {
  return c.bold(title);
}

/** Print a key: value line with a dim key. */
export function kv(key: string, value: string): string {
  return `${c.dim(`${key}:`)} ${value}`;
}

/** Human-readable bytes (binary, GiB-ish). Falls back to "—" for null. */
export function humanBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[u]}`;
}

/** Emit one machine JSON object (the --json global flag path). */
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
