/**
 * tui/palette.ts — the high-contrast TUI color palette + gradient engine.
 *
 * The §5.7 design tokens publish a 16-color role map; the live TUI wants MORE
 * separation than 16 colors give, so this layer renders in 24-bit truecolor when the
 * terminal supports it and DEGRADES cleanly to xterm-256 → ANSI-16 → no-color. Every
 * color is still SOURCED FROM THE TOKENS (`@prometheus/ui` `ramps`) — we read a ramp
 * shade's hex and emit the matching SGR; nothing here invents a new brand color, so
 * the CLI/TUI/GUI never drift. PURE: capability is detected from env (injectable) and
 * every paint takes the resolved caps, so it is fully unit-testable.
 */
import {
  ACCENT_RGB,
  ANSI_SGR,
  type AnsiColorName,
  type Ramp,
  type RampName,
  ramps,
} from "@prometheus/ui/tokens";

/** What the terminal can render. `none` = monochrome (NO_COLOR / dumb / piped). */
export type ColorCaps = "truecolor" | "ansi256" | "ansi16" | "none";

/** An RGB triple (0–255). */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The output ROLES the TUI tints (the user-visible "every type of text" palette). */
export type Role =
  | "question" // a prompt / question to the user
  | "plain" // ordinary assistant text
  | "command" // an executed shell/verb command
  | "codeAdd" // an added code line (+)
  | "codeDel" // a removed code line (-)
  | "modelOpen" // open-source / local model output
  | "modelPaid" // paid / cloud model output
  | "info"
  | "warn"
  | "danger"
  | "brand"
  | "accent"
  | "muted"
  | "heading"
  // syntax-highlight token roles (WRAPPER Subsystem 2) — sourced from the SAME ramps, no new hex.
  | "synKeyword"
  | "synString"
  | "synNumber"
  | "synComment"
  | "synFunc"
  | "synType"
  | "synBuiltin"
  | "synOperator"
  | "synPunct"
  | "synProperty"
  | "synRegex";

/** role → (ramp, shade): the truecolor source. High shades = bright = high contrast on dark. */
const ROLE_RAMP: Record<Role, [RampName, keyof Ramp]> = {
  question: ["cyan", 300],
  plain: ["neutral", 100],
  command: ["violet", 300],
  codeAdd: ["green", 300],
  codeDel: ["red", 300],
  modelOpen: ["green", 400],
  modelPaid: ["amber", 400],
  info: ["cyan", 400],
  warn: ["amber", 400],
  danger: ["red", 400],
  brand: ["violet", 400],
  accent: ["cyan", 400],
  muted: ["neutral", 500],
  heading: ["violet", 200],
  synKeyword: ["violet", 400],
  synString: ["green", 400],
  synNumber: ["amber", 400],
  synComment: ["neutral", 500],
  synFunc: ["cyan", 400],
  synType: ["cyan", 300],
  synBuiltin: ["violet", 300],
  synOperator: ["slate", 300],
  synPunct: ["neutral", 400],
  synProperty: ["green", 300],
  synRegex: ["amber", 300],
};

/** role → ANSI-16 fallback name (used when the terminal can't do 256/truecolor). */
const ROLE_ANSI16: Record<Role, AnsiColorName> = {
  question: "brightCyan",
  plain: "white",
  command: "brightMagenta",
  codeAdd: "brightGreen",
  codeDel: "brightRed",
  modelOpen: "green",
  modelPaid: "yellow",
  info: "cyan",
  warn: "yellow",
  danger: "red",
  brand: "magenta",
  accent: "cyan",
  muted: "brightBlack",
  heading: "brightMagenta",
  synKeyword: "brightMagenta",
  synString: "green",
  synNumber: "yellow",
  synComment: "brightBlack",
  synFunc: "brightCyan",
  synType: "cyan",
  synBuiltin: "magenta",
  synOperator: "white",
  synPunct: "white",
  synProperty: "brightGreen",
  synRegex: "yellow",
};

const ESC = "\x1b";

/* ── capability detection ─────────────────────────────────────────────────── */

/**
 * Detect the terminal's color depth from env. `enabled=false` (the global --no-color
 * / NO_COLOR / non-TTY decision made in render.ts) short-circuits to `none` so the
 * palette honors the ONE color switch the CLI already owns.
 */
export function detectColorCaps(env: NodeJS.ProcessEnv = process.env, enabled = true): ColorCaps {
  if (!enabled) return "none";
  const force = env.FORCE_COLOR;
  if (force === "0" || force === "false") return "none";
  if (force === "3") return "truecolor";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.TERM === "dumb") return "none";
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct.includes("truecolor") || ct.includes("24bit")) return "truecolor";
  if (force === "2") return "ansi256";
  const term = env.TERM ?? "";
  if (term.includes("256")) return "ansi256";
  if (force === "1") return "ansi16";
  return term ? "ansi16" : "none";
}

/* ── hex / rgb helpers (token hex → rgb → SGR) ────────────────────────────── */

/** Parse a "#rrggbb" token hex into an Rgb. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

/** The token RGB for a (ramp, shade). */
export function rampRgb(ramp: RampName, shade: keyof Ramp): Rgb {
  return hexToRgb(ramps[ramp][shade]);
}

/** Nearest xterm-256 index for an RGB (6×6×6 cube + the 24-step grayscale ramp). */
export function rgbTo256(c: Rgb): number {
  // clamp to 5: round((255-35)/40)=6 would overflow the 0–5 cube axis and land a bright non-gray
  // color in the grayscale ramp (232–255) instead of the color cube.
  const toCube = (v: number): number =>
    v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40));
  // grayscale shortcut when the channels are close (better than the coarse cube)
  if (Math.abs(c.r - c.g) < 8 && Math.abs(c.g - c.b) < 8) {
    if (c.r < 8) return 16;
    if (c.r > 248) return 231;
    return 232 + Math.round(((c.r - 8) / 247) * 24);
  }
  return 16 + 36 * toCube(c.r) + 6 * toCube(c.g) + toCube(c.b);
}

/** The SGR foreground introducer for an RGB at a given capability (no reset). */
function fgCode(c: Rgb, caps: ColorCaps): string {
  if (caps === "truecolor") return `38;2;${c.r};${c.g};${c.b}`;
  return `38;5;${rgbTo256(c)}`;
}
/** The SGR background introducer for an RGB at a given capability. */
function bgCode(c: Rgb, caps: ColorCaps): string {
  if (caps === "truecolor") return `48;2;${c.r};${c.g};${c.b}`;
  return `48;5;${rgbTo256(c)}`;
}

/** Wrap text in an SGR sequence (+reset). `extra` prepends e.g. "1;" for bold. */
function sgr(text: string, code: string, extra = ""): string {
  return `${ESC}[${extra}${code}m${text}${ESC}[0m`;
}

/* ── the public paint API ─────────────────────────────────────────────────── */

/**
 * Roles whose output is "light blue": pinned to the operator accent (#16b3f5) and ALWAYS
 * bold. `command` is violet (not light blue) so it is intentionally excluded.
 */
const ACCENT_ROLES = new Set<Role>(["accent", "info", "question"]);

/** Tint text by a semantic role, honoring the resolved color depth. */
export function paint(
  text: string,
  role: Role,
  caps: ColorCaps,
  opts: { bold?: boolean } = {},
): string {
  if (caps === "none") return text;
  const isAccent = ACCENT_ROLES.has(role);
  // accent (light-blue) output is always bold; other roles bold only when asked.
  const bold = opts.bold || isAccent ? "1;" : "";
  if (caps === "ansi16") {
    return sgr(text, String(ANSI_SGR[ROLE_ANSI16[role]]), bold);
  }
  const rgb = isAccent ? { ...ACCENT_RGB } : rampRgb(...ROLE_RAMP[role]);
  return sgr(text, fgCode(rgb, caps), bold);
}

/** Bind a caps value into a terse `p.role(text)` painter set (for the renderers). */
export function painter(caps: ColorCaps): Record<Role, (t: string) => string> & {
  bold: (t: string, role: Role) => string;
} {
  const out = {} as Record<Role, (t: string) => string>;
  for (const role of Object.keys(ROLE_RAMP) as Role[]) {
    out[role] = (t: string) => paint(t, role, caps);
  }
  return { ...out, bold: (t: string, role: Role) => paint(t, role, caps, { bold: true }) };
}

/* ── gradient ─────────────────────────────────────────────────────────────── */

/** Linear-interpolate `n` RGB stops from `a` to `b` (inclusive of both ends). */
export function gradientStops(a: Rgb, b: Rgb, n: number): Rgb[] {
  if (n <= 1) return [a];
  const out: Rgb[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push({
      r: Math.round(a.r + (b.r - a.r) * t),
      g: Math.round(a.g + (b.g - a.g) * t),
      b: Math.round(a.b + (b.b - a.b) * t),
    });
  }
  return out;
}

/** The brand gradient endpoints (violet → cyan), token-sourced. */
export function brandGradientEnds(): [Rgb, Rgb] {
  return [rampRgb("violet", 400), rampRgb("cyan", 400)];
}

/** Paint each visible character along a violet→cyan gradient (the brand sweep). */
export function gradientText(text: string, caps: ColorCaps, ends?: [Rgb, Rgb]): string {
  if (caps === "none") return text;
  const chars = [...text];
  const [a, b] = ends ?? brandGradientEnds();
  const stops = gradientStops(a, b, Math.max(chars.length, 2));
  return chars.map((ch, i) => sgr(ch, fgCode(stops[i] ?? a, caps))).join("");
}

/**
 * A high-contrast SELECTION bar (the highlighted /command row): a violet→cyan
 * background gradient with bold bright-white text, padded to `width`. Degrades to a
 * single reverse-video bar in ansi16 and to "› text" in no-color.
 */
export function selectionBar(text: string, width: number, caps: ColorCaps): string {
  const padded = text.length >= width ? text : text + " ".repeat(width - text.length);
  if (caps === "none") return `› ${text}`;
  if (caps === "ansi16") return `${ESC}[7m${padded}${ESC}[0m`; // reverse video
  const [a, b] = brandGradientEnds();
  const chars = [...padded];
  const stops = gradientStops(a, b, Math.max(chars.length, 2));
  // bright-white bold foreground over the moving gradient background = high contrast.
  const body = chars.map((ch, i) => `${ESC}[1;97;${bgCode(stops[i] ?? a, caps)}m${ch}`).join("");
  return `${body}${ESC}[0m`;
}
