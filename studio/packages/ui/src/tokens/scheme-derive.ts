/**
 * tokens/scheme-derive.ts — one compact palette → one COMPLETE, LEGIBLE SemanticColors map.
 *
 * Why this file exists (measured, 2026-09-09). Every colour scheme in the registry was
 * authored as a handful of palette colours and the remaining ~18 §2 roles were either
 * derived by mixing or left to fall through to the Prometheus dark/light base. Auditing all
 * 41 built-ins against WCAG produced two systemic defects, not 28 individual ones:
 *
 *   1. THE TEXT RAMP WAS INVERTED IN EVERY DERIVED SCHEME. `text-muted` was derived as
 *      "the dim tone pushed 20% toward the BACKGROUND" while `text-disabled` was the dim
 *      tone itself — so `muted` (metadata, sublabels, timestamps: the copy that is already
 *      hardest to read) came out DIMMER than `disabled`. Monokai measured muted 4.06:1 vs
 *      disabled 5.53:1; Ayu Dark 2.21:1 vs 2.79:1; Palenight 2.05:1 vs 2.49:1. That is the
 *      "grey text on a dark background" report, and it was the derivation, not the palettes.
 *   2. THE DIM END WAS NOT FLOORED AT ALL. A faithful reproduction of a low-contrast
 *      community palette (Ayu, Palenight, Oceanic Next, Horizon, Solarized Dark) hands us a
 *      `textDim` that is already under AA, and nothing lifted it.
 *
 * So the ramp is no longer a set of independent mixes. It is a SEGMENT between two ends that
 * are each proven legible first — `strong` (the palette's own text tone, lifted if need be)
 * and `dim` (the palette's own dim tone, lifted toward `strong` until it clears AA) — with
 * the four middle steps interpolated along it. Interpolating between two legible endpoints is
 * what makes the ramp monotone BY CONSTRUCTION: primary ≥ title ≥ body ≥ secondary ≥ muted ≥
 * disabled, every step ≥ 4.5:1 against every ground the scheme paints (`bg-app`,
 * `bg-surface`, `bg-surface-2`, `bg-inset`). It cannot invert again.
 *
 * Every lift moves along the straight line toward one of the SCHEME'S OWN colours (its text
 * tone for text and borders, its ground for selection) rather than toward white — so Monokai
 * stays Monokai-warm and Nord stays Nord-cold. Only the legibility moves; the hue does not.
 * `#fff`/`#000` are the last-resort poles, reached only when the palette's own tone cannot
 * carry the ratio.
 *
 * Borders are floored on the same principle and for the reason the dark base already records:
 * a border under ~2:1 gives an island no perceivable edge, which is exactly why "text going
 * outside the element that contains it" was so hard to see. The floors mirror the audited
 * Prometheus Dark values (subtle 2.12, row 1.60, header 1.90, chip 2.22, strong 3.03,
 * hover 3.52) so every scheme gets the frame the default already has.
 *
 * Pure and dependency-free apart from the §7 contrast math. Raw hex is legal under `tokens/`.
 */
import type { SchemeBase, SemanticColors } from "../tokens.js";
import { blend, contrastRatio, onFill } from "./contrast.js";

/** A compact palette → a full SemanticColors map (the §2 roles). */
export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  inset: string;
  borderSubtle: string;
  borderStrong: string;
  text: string;
  textDim: string;
  brand: string;
  accent: string;
  ok: string;
  warn: string;
  danger: string;
  info: string;
  selection: string;
}

function chan(hex: string, i: number): number {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.slice(0, 6);
  return Number.parseInt(full.slice(i * 2, i * 2 + 2), 16);
}

/** Linear sRGB mix: `t` = how much of `a` survives (1 → a, 0 → b). */
export function mix(a: string, b: string, t: number): string {
  const c = (i: number): string =>
    Math.max(0, Math.min(255, Math.round(chan(a, i) * t + chan(b, i) * (1 - t))))
      .toString(16)
      .padStart(2, "0");
  return `#${c(0)}${c(1)}${c(2)}`;
}

/** WCAG AA: 4.5:1 for body text, 3:1 for non-text UI (role chips, icons, meaningful borders). */
const AA_TEXT = 4.5;
const AA_UI = 3;

/**
 * The floor for the DIM END of the text ramp — deliberately above AA.
 *
 * 4.5:1 is the legal minimum for body copy, and the copy that lands on the dim end is the
 * copy the report was about: timestamps, sublabels, counts, disabled labels. Prometheus Dark
 * puts its own dimmest step at 6.9:1 for exactly that reason ("disabled never means
 * invisible"), so a derived scheme that stopped at 4.5 would still read as the greyer one.
 * 5.5 keeps every derived scheme in the same legibility class as the default while leaving
 * the ramp enough range to still express hierarchy.
 */
const DIM_FLOOR = 5.5;

/** How finely a lift walks the line. 24 steps ≈ 4% per step — below one JND, so a lift that
 *  only just clears the bar is invisible next to the colour the palette author chose. */
const STEPS = 24;

/**
 * Walk `from` toward `anchor` in equal steps until `ok` holds, and return the FIRST colour
 * that satisfies it — the smallest change that buys legibility. Returns `anchor` if even that
 * fails, which is the honest answer: the palette has no legible colour on this line.
 */
function toward(from: string, anchor: string, ok: (c: string) => boolean): string {
  if (ok(from)) return from;
  for (let i = 1; i <= STEPS; i++) {
    const c = mix(anchor, from, i / STEPS);
    if (ok(c)) return c;
  }
  return anchor;
}

/**
 * The mirror of `toward`: walk `from` toward `ground` and return the LAST colour that still
 * satisfies `ok` — the quietest tone the floor permits.
 *
 * This is what stops the ramp from collapsing. Some palettes hand us a `textDim` that is
 * already far above the bar (Nord's #d8dee9 reads 9:1), and if the dim END of the ramp is
 * that bright then title/body/secondary/muted are all crushed into the two percent of range
 * between it and `text-primary` — legible, but with no hierarchy left to read. Backing the
 * dim end down to the floor gives every scheme the same usable range.
 */
function away(from: string, ground: string, ok: (c: string) => boolean): string {
  let best = from;
  for (let i = 1; i <= STEPS; i++) {
    const c = mix(ground, from, i / STEPS);
    if (!ok(c)) break;
    best = c;
  }
  return best;
}

/**
 * FULL AUTONOMY (A6/A7) from a scheme's accent — the accent, pushed further from the ground.
 *
 * Exported because it is needed in two places and must not be written twice: `derivePalette`
 * below computes it for a derived scheme, and `resolveScheme` recomputes it for a hand-authored
 * PARTIAL scheme that overrides `accent` without stating an `autonomy`. That second case is not
 * hypothetical — four built-ins (dracula, synthwave-84, shades-of-purple, pelly) set a bright
 * cyan accent and inherited the base theme's ice, landing within 1.05:1 of their own accent.
 * Same fall-through the `on-<role>` pass exists to stop.
 *
 * `pole`, never the scheme's text colour: 14 of the 41 built-ins ship an accent BRIGHTER than
 * their own text (synthwave-84's #36f9f6, shades-of-purple's #9effff), so mixing toward the text
 * pulled those back TOWARD the background — the opposite of the intent, and undetectable without
 * measuring, since the result stayed perfectly legible. An extreme guarantees the direction.
 *
 * 0.6 keeps the accent's hue in charge. On a scheme whose accent is already near-white the step
 * it buys is small, and that is a real limit rather than a bug to tune away: there is no room
 * left in that direction. `ramp-contrast.test.ts` asserts the direction and legibility for all
 * 41, and a substantial gap for the themes this product actually ships. Colour is never the sole
 * signal for this level — every surface that paints it also writes the level out.
 */
export function autonomyFrom(accent: string, grounds: readonly string[], base: SchemeBase): string {
  const pole = base === "light" ? "#000000" : "#ffffff";
  const ok = (c: string): boolean =>
    Math.min(...grounds.map((g) => contrastRatio(c, g))) >= AA_TEXT;
  return toward(mix(accent, pole, 0.6), pole, ok);
}

/**
 * The full §2 token map for a palette, with the legibility floors applied.
 *
 * `base` only selects the last-resort pole (white on a dark scheme, black on a light one);
 * every other decision is made from the palette's own colours.
 */
export function derivePalette(p: Palette, base: SchemeBase): SemanticColors {
  const pole = base === "light" ? "#000000" : "#ffffff";
  /** Every ground the scheme paints text on. A text token must clear AA on the WORST of them. */
  const grounds = [p.bg, p.surface, p.surface2, p.inset];
  const worstText = (c: string): number => Math.min(...grounds.map((g) => contrastRatio(c, g)));
  const textOk = (c: string): boolean => worstText(c) >= AA_TEXT;

  // ── the two ends of the text ramp, each proven legible before anything interpolates ──
  const strong = toward(p.text, pole, textOk);
  const dimOk = (c: string): boolean => worstText(c) >= DIM_FLOOR;
  // lift it if the palette's dim tone is under the floor, then back it down to the floor if
  // it was over — either way the dim end lands just above DIM_FLOOR, so the ramp has both a
  // guaranteed legibility and a guaranteed range. One of the two calls is always a no-op.
  const dim = away(toward(p.textDim, strong, dimOk), p.bg, dimOk);
  /** A step along the strong→dim segment. `t` = how much of `strong` survives. */
  const step = (t: number): string => mix(strong, dim, t);

  // ── role tokens: legible as a chip AND as a FILL that carries a label ──
  //
  // The `p.bg` leg carries AA_TEXT, not AA_UI, and that difference is load-bearing. A role
  // colour is used two ways: as a glyph/border/tint (non-text, 3:1) and as a SOLID FILL with
  // a label drawn on it in `bg-app` — the Git `tag:` pill, the search Aa/.*\/ab toggles, the
  // MCP enable switch, every primary CTA, Badge(solid). That label is text, so it needs 4.5:1
  // against the fill, and `bg-app` is the only foreground those call sites have.
  //
  // At 3:1 the guarantee was too weak to rely on: 19 of the 41 built-ins landed between 3.19
  // and 4.49 on at least one fill (measured — see tokens/ramp-contrast.test.ts, which pins
  // this). Those labels were legible in the audited default and quietly sub-AA everywhere
  // else, which is precisely the class of defect the ramp rework already removed from text.
  const roleOk = (c: string): boolean =>
    contrastRatio(c, p.surface) >= AA_UI &&
    contrastRatio(c, p.bg) >= AA_TEXT &&
    contrastRatio(c, blend(c, p.surface, 0.14)) >= AA_UI;
  const role = (c: string): string => toward(c, pole, roleOk);

  const ok = role(p.ok);
  const warn = role(p.warn);
  const danger = role(p.danger);
  const info = role(p.info);
  const brand = role(p.brand);
  const accent = role(p.accent);

  // ── borders: the floors the audited Prometheus Dark frame already meets ──
  const border = (c: string, target: number): string =>
    toward(c, p.text, (x) => contrastRatio(x, p.surface) >= target);
  const borderSubtle = border(p.borderSubtle, 2.0);
  const borderStrong = border(p.borderStrong, 3.0);

  // text on the brand fill: the ground if it reads, else whichever pole reads better.
  const brandFg =
    contrastRatio(p.bg, brand) >= AA_TEXT
      ? p.bg
      : contrastRatio("#ffffff", brand) >= contrastRatio("#000000", brand)
        ? "#ffffff"
        : "#000000";

  return {
    "bg-app": p.bg,
    "bg-app-glow": mix(p.surface2, p.bg, 0.6),
    "bg-surface": p.surface,
    "bg-surface-2": p.surface2,
    "bg-inset": p.inset,
    "bg-chip": mix(p.surface, p.bg, 0.5),
    "bg-active": mix(p.surface2, accent, 0.88),
    "bg-elevated": mix(p.surface2, borderStrong, 0.65),
    "border-subtle": borderSubtle,
    "border-row": border(mix(borderSubtle, p.bg, 0.5), 1.5),
    "border-header": border(mix(borderSubtle, p.bg, 0.75), 1.8),
    "border-chip": border(borderSubtle, 2.2),
    "border-strong": borderStrong,
    "border-hover": border(mix(borderStrong, accent, 0.75), 3.4),
    "text-primary": strong,
    "text-strong": strong,
    "text-title": step(0.8),
    "text-body": step(0.6),
    "text-secondary": step(0.4),
    "text-muted": step(0.2),
    "text-disabled": dim,
    brand,
    "brand-2": role(mix(brand, accent, 0.65)),
    "brand-3": role(mix(brand, strong, 0.65)),
    "brand-fg": brandFg,
    accent,
    "focus-ring": accent,
    ok,
    warn,
    danger,
    // danger reads as TEXT here (error copy), so it carries the 4.5 bar, not the 3:1 one.
    "danger-fg": toward(mix(danger, strong, 0.6), strong, textOk),
    info,
    // FULL AUTONOMY (A6/A7) — see `autonomyFrom` above for the whole argument. Derived from the
    // ROLE-floored `accent`, not `p.accent`, so it starts from the colour that will be painted.
    autonomy: autonomyFrom(accent, grounds, base),
    // a selection band must not swallow the text drawn on it: push it toward the ground
    // (never toward the text) until primary text clears AA on top of it.
    selection: toward(p.selection, p.bg, (c) => contrastRatio(strong, c) >= AA_TEXT),
    // the LABEL colour for each role painted as a solid fill. `roleOk` above already floors
    // every role at 4.5:1 against `p.bg`, so `onFill` returns the ground here every time and
    // a derived chip keeps the scheme's own colour under its label; the pole branch exists
    // for the hand-authored schemes that do not go through this function.
    "on-brand": onFill(brand, p.bg),
    "on-accent": onFill(accent, p.bg),
    "on-ok": onFill(ok, p.bg),
    "on-warn": onFill(warn, p.bg),
    "on-danger": onFill(danger, p.bg),
    "on-info": onFill(info, p.bg),
  };
}
