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
  PELLY_SPAN_BG,
  PELLY_SYNTAX,
  type Ramp,
  type RampName,
  ramps,
} from "@prometheus/ui/tokens";

import { stringWidth } from "./width.js";

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
  // the model's trait rail: a capability that is LIVE this turn vs one the user switched off.
  // Green/amber and not the generic info/warn pair, because these two are read as a matched
  // set — "is this on or off" — and a shared vocabulary for a binary is what makes the rail
  // scannable without a legend.
  | "traitOn"
  | "traitOff"
  // the fleet bar's three-way resource split. These are the ONLY roles whose hue is fixed by
  // what the bar means rather than by a generic severity: light blue is Prometheus everywhere
  // in this product, yellow is "someone else's work", green is headroom. They are separate
  // roles rather than reused accent/warn/traitOn so that re-tuning a severity colour can never
  // silently re-tune the legend the user learned.
  | "fleetOurs"
  | "fleetOther"
  | "fleetFree"
  // syntax-highlight token roles (WRAPPER Subsystem 2). The exact hues come from the Pelly
  // scheme (tokens/pelly-syntax) on truecolor/256; the ramp/ANSI-16 maps below are the fallback.
  | "synKeyword"
  | "synString"
  | "synDoc"
  | "synNumber"
  | "synComment"
  | "synFunc"
  | "synClass"
  | "synType"
  | "synBuiltin"
  | "synSelf"
  | "synOperator"
  | "synParen"
  | "synBracket"
  | "synBrace"
  | "synComma"
  | "synDot"
  | "synDecorator"
  | "synConstant"
  | "synKwarg"
  | "synPunct"
  | "synProperty"
  | "synRegex"
  // non-code OUTPUT roles (Pelly-aligned): reasoning prose, status phases, markdown, tool lines.
  | "reasoning"
  | "thinkMark"
  | "mdHeading"
  | "mdBold"
  | "mdBullet"
  | "mdNumber"
  | "mdCode"
  | "mdQuote"
  | "toolAction"
  | "stSend"
  | "stResp"
  | "stWait"
  | "stRound"
  | "stErr"
  // surgical edit card (diff)
  | "diffAdd"
  | "diffDel"
  | "diffGutter"
  | "diffLoc";

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
  traitOn: ["green", 400],
  traitOff: ["amber", 400],
  fleetOurs: ["cyan", 400], //  light blue — pinned to the operator accent by ACCENT_ROLES
  fleetOther: ["amber", 300], // yellow
  fleetFree: ["green", 400], //  green
  synKeyword: ["violet", 400],
  synString: ["green", 400],
  synDoc: ["green", 300],
  synNumber: ["amber", 400],
  synComment: ["neutral", 500],
  synFunc: ["cyan", 400],
  synClass: ["violet", 400],
  synType: ["cyan", 300],
  synBuiltin: ["violet", 300],
  synSelf: ["violet", 300],
  synOperator: ["slate", 300],
  synParen: ["amber", 400],
  synBracket: ["green", 400],
  synBrace: ["cyan", 300],
  synComma: ["amber", 400],
  synDot: ["amber", 300],
  synDecorator: ["amber", 300],
  synConstant: ["violet", 300],
  synKwarg: ["amber", 300],
  synPunct: ["neutral", 400],
  synProperty: ["green", 300],
  synRegex: ["amber", 300],
  reasoning: ["violet", 300],
  thinkMark: ["violet", 400],
  mdHeading: ["violet", 400],
  mdBold: ["amber", 400],
  mdBullet: ["green", 400],
  mdNumber: ["cyan", 300],
  mdCode: ["cyan", 400],
  mdQuote: ["cyan", 400],
  toolAction: ["violet", 400],
  stSend: ["cyan", 400],
  stResp: ["green", 400],
  stWait: ["amber", 400],
  stRound: ["violet", 300],
  stErr: ["red", 400],
  diffAdd: ["green", 400],
  diffDel: ["red", 400],
  diffGutter: ["neutral", 500],
  diffLoc: ["cyan", 300],
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
  traitOn: "green",
  traitOff: "yellow",
  fleetOurs: "brightCyan",
  fleetOther: "brightYellow",
  fleetFree: "green",
  synKeyword: "brightYellow",
  synString: "brightBlue",
  synDoc: "brightGreen",
  synNumber: "brightGreen",
  synComment: "blue",
  synFunc: "brightMagenta",
  synClass: "brightMagenta",
  synType: "green",
  synBuiltin: "brightRed",
  synSelf: "magenta",
  synOperator: "green",
  synParen: "brightYellow",
  synBracket: "brightGreen",
  synBrace: "brightBlue",
  synComma: "brightYellow",
  synDot: "yellow",
  synDecorator: "yellow",
  synConstant: "brightMagenta",
  synKwarg: "red",
  synPunct: "brightYellow",
  synProperty: "brightBlue",
  synRegex: "yellow",
  reasoning: "brightMagenta",
  thinkMark: "brightMagenta",
  mdHeading: "brightMagenta",
  mdBold: "brightYellow",
  mdBullet: "brightGreen",
  mdNumber: "brightCyan",
  mdCode: "brightBlue",
  mdQuote: "blue",
  toolAction: "brightMagenta",
  stSend: "brightCyan",
  stResp: "brightGreen",
  stWait: "yellow",
  stRound: "brightMagenta",
  stErr: "brightRed",
  diffAdd: "brightGreen",
  diffDel: "brightRed",
  diffGutter: "brightBlack",
  diffLoc: "brightCyan",
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
const ACCENT_ROLES = new Set<Role>(["accent", "info", "question", "fleetOurs"]);

/** Tint text by a semantic role, honoring the resolved color depth. */
export function paint(
  text: string,
  role: Role,
  caps: ColorCaps,
  opts: { bold?: boolean } = {},
): string {
  if (caps === "none") return text;
  const isAccent = ACCENT_ROLES.has(role);
  // truecolor/256 syntax roles take their EXACT hue + bold/italic from the Pelly scheme;
  // ansi16 has no hex path, so it keeps the ROLE_ANSI16 nearest-name fallback below.
  const syn = caps !== "ansi16" ? PELLY_SYNTAX[role] : undefined;
  // accent (light-blue) output is always bold; other roles bold when asked or per the Pelly style.
  const bold = opts.bold || isAccent || syn?.bold ? "1;" : "";
  const italic = syn?.italic ? "3;" : "";
  if (caps === "ansi16") {
    return sgr(text, String(ANSI_SGR[ROLE_ANSI16[role]]), bold);
  }
  const rgb = syn ? hexToRgb(syn.fg) : isAccent ? { ...ACCENT_RGB } : rampRgb(...ROLE_RAMP[role]);
  return sgr(text, fgCode(rgb, caps), bold + italic);
}

/**
 * Paint a WORD-LEVEL changed span on a diff line: the role's fg colour PLUS a subtle add/del
 * background tint, so the exact tokens that changed stand out from the rest of the red/green line.
 * ansi16 has no truecolor bg → falls back to the fg colour only.
 */
export function spanHighlight(
  text: string,
  role: Role,
  which: "add" | "del",
  caps: ColorCaps,
): string {
  if (caps === "none") return text;
  const syn = caps !== "ansi16" ? PELLY_SYNTAX[role] : undefined;
  const bold = syn?.bold ? "1;" : "";
  if (caps === "ansi16") return sgr(text, String(ANSI_SGR[ROLE_ANSI16[role]]), bold);
  const fg = syn ? hexToRgb(syn.fg) : rampRgb(...ROLE_RAMP[role]);
  const bg = hexToRgb(PELLY_SPAN_BG[which]);
  return `${ESC}[${bold}${fgCode(fg, caps)};${bgCode(bg, caps)}m${text}${ESC}[0m`;
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
  // Display width, not `.length`: a CJK glyph is two columns and an astral code point is two
  // UTF-16 units, so `.length` over-pads one and under-pads the other — and this bar paints a
  // background, so a mis-padded row leaves a ragged edge or bleeds past the pane.
  const w0 = stringWidth(text);
  const padded = w0 >= width ? text : text + " ".repeat(width - w0);
  if (caps === "none") return `› ${text}`;
  if (caps === "ansi16") return `${ESC}[7m${padded}${ESC}[0m`; // reverse video
  const [a, b] = brandGradientEnds();
  const chars = [...padded];
  const stops = gradientStops(a, b, Math.max(chars.length, 2));
  // bright-white bold foreground over the moving gradient background = high contrast.
  const body = chars.map((ch, i) => `${ESC}[1;97;${bgCode(stops[i] ?? a, caps)}m${ch}`).join("");
  return `${body}${ESC}[0m`;
}

/* ── the elapsed-turn clock ("⏱ 3h 7m 44s") ───────────────────────────────── */

/**
 * How long the turn took, as a COLOR BAND.
 *
 * The clock used to paint `muted` (neutral.500, no bold) — a dark grey on a dark terminal,
 * which is the one thing a wall-clock must not be: unreadable. It is also the only number in
 * the session that carries a verdict, so it now says how long WITHOUT being read: cool while
 * the turn is quick, warming as it drags, and unmistakable once it has run for hours.
 *
 * Bands are [lower, upper) — a turn at exactly 30m is `lt1h`, not `lt30m` — so every instant
 * belongs to exactly one band and the boundary is never ambiguous.
 */
export type DurationTier = "lt30m" | "lt1h" | "lt2h" | "lt3h" | "lt5h" | "lt7h" | "gte7h";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Upper bound (exclusive) → band. Ordered; the first bound the elapsed time is under wins. */
const DURATION_BANDS: readonly (readonly [number, DurationTier])[] = [
  [30 * MINUTE_MS, "lt30m"],
  [1 * HOUR_MS, "lt1h"],
  [2 * HOUR_MS, "lt2h"],
  [3 * HOUR_MS, "lt3h"],
  [5 * HOUR_MS, "lt5h"],
  [7 * HOUR_MS, "lt7h"],
];

/**
 * Which band an elapsed span falls in. PURE.
 *
 * A negative / NaN span floors to 0 for the same reason `formatDuration` does: a clock that
 * throws or blanks on a clock-skewed `Date.now()` difference loses the whole turn's timing.
 */
export function durationTier(ms: number): DurationTier {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  for (const [upper, tier] of DURATION_BANDS) {
    if (safe < upper) return tier;
  }
  return "gte7h";
}

/** Blend two token colors — how the two hues the ramps do not carry are DERIVED, not invented. */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

/**
 * band → truecolor hue.
 *
 * Five come straight off a token ramp. Orange and rubine have no ramp of their own, so they are
 * MIXED from two that do rather than hard-coded — the palette's rule is that no color here is
 * invented, and a blend of amber+red / red+violet keeps them moving with the tokens if a ramp is
 * ever re-tuned.
 */
const DURATION_RGB: Record<DurationTier, Rgb> = {
  lt30m: { ...ACCENT_RGB }, //                                    light blue  #16b3f5
  lt1h: rampRgb("green", 400), //                                 green       #34c46a
  lt2h: rampRgb("amber", 300), //                                 yellow      #fbbf4a
  lt3h: mix(rampRgb("amber", 400), rampRgb("red", 400), 0.5), //  orange
  lt5h: rampRgb("red", 400), //                                   bright red  #f24343
  lt7h: mix(rampRgb("red", 600), rampRgb("violet", 700), 0.35), // dark rubine
  gte7h: rampRgb("violet", 400), //                               purple      #b266ff
};

/**
 * band → ANSI-16 fallback.
 *
 * All seven bands get a DISTINCT code, but sixteen colors have no orange and no rubine, so the
 * two warm pairs separate only by brightness (brightYellow/yellow, brightRed/red) and may read
 * as one hue on a low-contrast theme. The SWEEP — cyan → green → yellow → red → magenta — is what
 * survives intact, and it is the part that carries the meaning.
 */
const DURATION_ANSI16: Record<DurationTier, AnsiColorName> = {
  lt30m: "brightCyan",
  lt1h: "brightGreen",
  lt2h: "brightYellow",
  lt3h: "yellow",
  lt5h: "brightRed",
  lt7h: "red",
  gte7h: "brightMagenta",
};

/**
 * Paint the turn clock: ALWAYS bold, hue from how long the turn ran.
 *
 * `caps='none'` returns the text untouched — NO_COLOR / a pipe gets an escape-free clock, the
 * same contract every other painter here honors.
 */
export function paintDuration(text: string, elapsedMs: number, caps: ColorCaps): string {
  if (caps === "none") return text;
  const tier = durationTier(elapsedMs);
  if (caps === "ansi16") return sgr(text, String(ANSI_SGR[DURATION_ANSI16[tier]]), "1;");
  return sgr(text, fgCode(DURATION_RGB[tier], caps), "1;");
}
