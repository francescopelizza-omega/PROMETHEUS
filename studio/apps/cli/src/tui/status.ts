/**
 * tui/status.ts — the status lines painted BELOW the composer box (Claude-Code chrome).
 *
 * Three pieces, all responsive to the terminal width:
 *   1. a justified status bar — LEFT chips ([PROM:<MODE>] · tools · gate) and RIGHT
 *      chips (model · /profile · cwd), each color-coded by role;
 *   2. the permission-mode INDICATOR line ("⏵⏵ bypass permissions on", "⏸ plan mode
 *      on", …) — shown only when a non-default mode is active, tinted by its tone;
 *   3. the composer key hint (⏎ send · / commands · ⇧⇥ mode · ⌃C cancel · …).
 *
 * PURE: takes a plain `StatusModel` + width + color caps; the host feeds live tuning.
 */
import { agent } from "@prometheus/core";
import {
  TRAIT_INLINE_MAX,
  type TraitCell,
  modelTraits as coreTraits,
  traitGrid,
  traitRail,
} from "@prometheus/core/ai-effort";

import { type FleetBarModel, fleetBarLine } from "./fleet-bar.js";
import { type ColorCaps, type Role, painter } from "./palette.js";
import { clipToWidth, stringWidth } from "./width.js";

type PermissionModeId = agent.PermissionModeId;
const { permissionModeMeta, authLevelMeta } = agent;

/** A justified segment: text + the palette role to tint it. */
export interface Segment {
  text: string;
  role: Role;
}

/** The live state the status bar reflects (the host maps tuning → this). */
export interface StatusModel {
  permMode: PermissionModeId;
  /** the 0–7 --authorisation autonomy level; shown as a chip to the LEFT of the model. */
  authLevel: number;
  model: string;
  /** where the model runs — drives the open(green)/paid(amber)/none color. */
  modelSource: "local" | "cloud" | "none";
  tools: boolean;
  /** "enforce" | "warn" | "off". */
  gate: string;
  dryRun: boolean;
  profile: string;
  /** already shortened (e.g. ~/proj). */
  cwd: string;
  /** subagent fan-out count (omitted/1 → not shown). */
  agents?: number;
  /**
   * Live context-usage meter (CLI-052): `used` tokens vs the model `window` (undefined ⇒ unknown
   * model ⇒ no percent). `estimated` ⇒ the chars/4 heuristic (suffix `~`); only exact provider
   * counts drop the marker. Fed by the host from the SAME session accounting the meter shows.
   */
  ctxUsage?: { used: number; window?: number; estimated: boolean };
  /**
   * Live per-session cost ticker (CLI-089): estimated tokens + USD, refreshed after every turn.
   * OMITTED (undefined) when no turns have run yet OR the active model has no pricing entry —
   * never a misleading `$0.00`. Fed from the SAME `sessionUsage`/`costOf` the `/stats` pull uses.
   */
  cost?: { estTokens: number; estUsd: number };
  /** the focused pane (CLI-060). Shown as a chip only when NOT the default "transcript" pane, so
   *  Ctrl+G (CLI-067) has a visible effect without cluttering the single-pane home. */
  activePane?: string;
  /**
   * Reasoning-effort state for the ACTIVE model. Rendered inlaid in the composer's bottom
   * border, NOT as a status chip down here — the bar is already dense, and this is exactly
   * the fact a user needs at the moment they switch models.
   *
   * `available:false` ⇒ the model has no usable reasoning control, for whichever of the three
   * distinct reasons `detail` explains (no capability / always-on / this runtime ignores it).
   */
  effort?: {
    tier: string;
    available: boolean;
    /** true when the tier was clamped or emulated rather than applied verbatim. */
    degraded: boolean;
    /** one-sentence explanation, shown on the `/effort` line (too long for the border). */
    detail?: string;
  };
  /**
   * What the ACTIVE model can actually do, as the runner itself reports it —
   * `["completion","vision","audio","tools","thinking"]` from Ollama's `/api/show`.
   *
   * Shown beside the effort tier because they are the same KIND of fact and are read at the
   * same moment: the turn right after switching models, when the user needs to know what this
   * one is capable of before they ask it for anything. `thinking` in particular is the
   * precondition for the effort tier next to it meaning anything at all — seeing them apart,
   * on different chrome, made a genuinely causal pair look like two unrelated chips.
   *
   * Order is the runner's own, not sorted: it is stable per model, and re-sorting would make
   * the strip flicker between models for no gain.
   *
   * `undefined` ⇒ never probed (a cloud endpoint, or the probe has not landed). Empty ⇒ probed
   * and the runner reported nothing.
   */
  capabilities?: readonly string[];
  /**
   * The other Prometheus windows on this machine, and what the machine costs right now.
   *
   * Absent, or present with a peer total of 1, ⇒ NO fleet line is painted. A user running a
   * single session must not spend a permanent row of terminal height on the word `prom 1`, and
   * the probe that fills this in does not even run until a second instance exists.
   */
  fleet?: FleetBarModel;
}

/**
 * This surface's view of the model's traits. The ORDER and the grid shape live in core
 * (`ai/effort/traits.ts`) so the terminal and the Electron pane cannot drift into presenting
 * the same facts differently; what stays here is the terminal's own wording and padding.
 */
export function modelTraits(m: StatusModel): string[] {
  return coreTraits(m.capabilities, effortCell(m));
}

/** The effort cell on its own: `effort: high`, or `effort: not available`. */
function effortCell(m: StatusModel): string | undefined {
  const e = m.effort;
  if (!e) return undefined;
  return e.available ? `effort: ${e.tier}` : "effort: not available";
}

export { TRAIT_INLINE_MAX };

/**
 * The composer's bottom-border badge — the model's traits on ONE line:
 * `tools · thinking · effort: high`. Returns undefined when there is nothing worth saying, or
 * when there are too many traits to fit (the caller renders `capabilityPanel` instead).
 *
 * The `not available` wording is deliberate. Showing a tier the model will ignore is the bug
 * this whole feature exists to remove, so an unusable knob must read as unusable — not as a
 * setting that merely happens to be inert.
 *
 * The badge shows the tier that was APPLIED and carries no degradation marker: `~` already
 * means "estimated" on this same chrome (`~12.3k` context, `~$0.12` cost), so a second
 * meaning would be ambiguous. A clamped or emulated tier is signalled by the warn tint, and
 * spelled out in full by `/effort` and `/status`.
 */
export function effortBadge(m: StatusModel, opts: { traits?: boolean } = {}): string | undefined {
  // `traits:false` is the LAST-RESORT rendering, for a terminal too short to afford the panel
  // and too narrow for the full strip. The effort cell alone, because of the whole set it is
  // the only one the user can act on.
  if (opts.traits === false) return effortCell(m);
  const traits = modelTraits(m);
  if (traits.length === 0) return undefined;
  // Past the threshold the caller renders `capabilityPanel` instead — returning a long strip
  // here would just be dropped whole by `inlayBadge`, which is worse than either option.
  if (traits.length > TRAIT_INLINE_MAX) return undefined;
  return traits.join(" · ");
}

/**
 * The two-row, tab-aligned trait panel — what the border badge becomes once a model has more
 * traits than one border can hold.
 *
 * A GRID rather than a wrapped sentence, because these are parallel facts and the eye reads a
 * column of them far faster than a run-on `a · b · c · d · e · f`. Exactly two rows: the point
 * is to stay a glanceable strip attached to the composer, and a panel that grows with the model
 * would start competing with the transcript for the screen.
 *
 * The effort cell always lands BOTTOM-RIGHT: padding is inserted before it, never after, so the
 * one control in the set sits in the same place for every model instead of wandering with the
 * capability count.
 *
 * Returns null when `inner` cannot hold a legible grid — the caller then falls back to the
 * inline badge (which may itself drop). Never returns a clipped cell: a half-rendered
 * `thinki` reads as a bug, not as information.
 */
export function capabilityPanel(m: StatusModel, inner: number): string[] | null {
  const grid = traitGrid(modelTraits(m));
  if (!grid) return null;
  const { cols, cells: padded } = grid;
  const widest = padded.reduce((n, t) => Math.max(n, stringWidth(t)), 0);
  const colW = Math.floor(inner / cols);
  // one space of breathing room between columns, and the widest cell must fit whole.
  if (colW < widest + 1) return null;
  const row = (i: number): string =>
    padded
      .slice(i * cols, i * cols + cols)
      .map((t) => t + " ".repeat(Math.max(0, colW - stringWidth(t))))
      .join("")
      .trimEnd();
  return [row(0), row(1)];
}

/** Compact-k format: 12300 → "12.3k" (1 decimal <100k, floored), 131072 → "131k", <1000 → "N". */
function formatK(n: number): string {
  if (n < 1000) return String(Math.floor(n));
  const k = n / 1000;
  return k >= 100 ? `${Math.floor(k)}k` : `${(Math.floor(k * 10) / 10).toFixed(1)}k`;
}

/**
 * The context-usage meter segment (CLI-052): `⎋ 12.3k/131k (9%)` — the `~` marker prefixes an
 * estimated count; an unknown window renders `⎋ ~12.3k used` (no percent, no divide). Percent is
 * integer-floored on used/window: >=95 danger, >=80 warn, else muted. Returns null when nothing is
 * used yet. PURE — all length math elsewhere uses stringWidth so `⎋`/`~` never break the justify.
 */
export function contextMeterSegment(m: StatusModel): Segment | null {
  const u = m.ctxUsage;
  if (!u || u.used <= 0) return null;
  const marker = u.estimated ? "~" : "";
  const used = formatK(u.used);
  if (!u.window || u.window <= 0) {
    return { text: `⎋ ${marker}${used} used`, role: "muted" };
  }
  const pct = Math.floor((u.used * 100) / u.window); // integer math, guarded window>0 above
  const role: Role = pct >= 95 ? "danger" : pct >= 80 ? "warn" : "muted";
  return { text: `⎋ ${marker}${used}/${formatK(u.window)} (${pct}%)`, role };
}

/**
 * The live cost ticker segment (CLI-089): `~$0.12 · 4.2k tok` for a priced model, or `4.2k tok`
 * alone for a local ($0) model — the `~` marks it an ESTIMATE (not a billing figure). Returns null
 * (chip OMITTED) when there's no cost data yet (no turns, or no pricing) so it never reads `$0.00`.
 * PURE; token count via the compact-k format, width measured elsewhere with stringWidth.
 */
export function costMeterSegment(m: StatusModel): Segment | null {
  const cost = m.cost;
  if (!cost || cost.estTokens <= 0) return null;
  const tok = `${formatK(cost.estTokens)} tok`;
  // Guard on the DISPLAYED (2-dp rounded) value, not the raw float: a sub-cent estimate
  // (0 < estUsd < 0.005) rounds to "0.00", so show tokens-only rather than a misleading `~$0.00`.
  const rounded = cost.estUsd.toFixed(2);
  const usd = Number(rounded) > 0 ? `~$${rounded} · ` : "";
  return { text: `${usd}${tok}`, role: "muted" };
}

const visLen = stringWidth;
const clip = clipToWidth;

/**
 * Justify left + right segment runs across `width`: left-aligned run, right-aligned
 * run, a single gap between. If they don't fit, the right run is dropped tail-first
 * until they do (the left chips — mode/gate — are the load-bearing ones).
 */
export function justify(left: Segment[], right: Segment[], width: number, caps: ColorCaps): string {
  const p = painter(caps);
  const join = (segs: Segment[]): { plain: string; colored: string } => {
    const plain = segs.map((s) => s.text).join("  ");
    const colored = segs.map((s) => p[s.role](s.text)).join("  ");
    return { plain, colored };
  };
  let rightSegs = [...right];
  const l = join(left);
  let r = join(rightSegs);
  while (rightSegs.length > 0 && visLen(l.plain) + visLen(r.plain) + 1 > width) {
    rightSegs = rightSegs.slice(0, -1);
    r = join(rightSegs);
  }
  // if even the left run overflows, clip it (rare; tiny terminal).
  if (visLen(l.plain) > width) {
    const clipped = clip(l.plain, width);
    return p.muted(clipped);
  }
  // right run fully dropped → no trailing gap (a `max(1,…)` gap would overflow width+1 when the
  // left run exactly fills the width — the CLI-052 width sweep caught this).
  if (rightSegs.length === 0) return l.colored;
  const gap = Math.max(1, width - visLen(l.plain) - visLen(r.plain));
  return `${l.colored}${" ".repeat(gap)}${r.colored}`;
}

/** The gate chip's role: enforce=info, warn=warn, off=danger. */
function gateRole(gate: string): Role {
  return gate === "off" ? "danger" : gate === "warn" ? "warn" : "info";
}

/** The authorisation chip's role: higher autonomy = louder (0–1 muted → 6–7 danger). */
function authRole(level: number): Role {
  if (level >= 6) return "danger";
  if (level >= 4) return "warn";
  if (level >= 2) return "accent";
  return "muted";
}

/** The permission-mode chip role, from its tone. */
function modeRole(mode: PermissionModeId): Role {
  const tone = permissionModeMeta(mode).tone;
  return tone === "danger"
    ? "danger"
    : tone === "warn"
      ? "warn"
      : tone === "accent"
        ? "accent"
        : "muted";
}

/**
 * Build the status lines (1–3). Line 1 is always present; line 2 only when a
 * non-default permission mode is active; the composer hint is appended last.
 */
export function statusLines(m: StatusModel, width: number, caps: ColorCaps): string[] {
  const meta = permissionModeMeta(m.permMode);
  const modeChip = `[PROMETHEUS:${meta.label.toUpperCase().replace(/\s+/g, "-")}]`;

  const left: Segment[] = [
    { text: modeChip, role: modeRole(m.permMode) },
    { text: `tools:${m.tools ? "on" : "off"}`, role: m.tools ? "accent" : "muted" },
    { text: `gate:${m.gate}`, role: gateRole(m.gate) },
  ];
  if (m.dryRun) left.push({ text: "dry-run", role: "warn" });
  if (m.agents && m.agents > 1) left.push({ text: `agents:${m.agents}`, role: "accent" });
  // pane focus chip (CLI-060) — only when a non-default pane is focused (Ctrl+G shows an effect).
  if (m.activePane && m.activePane !== "transcript") {
    left.push({ text: `⊞ ${m.activePane}`, role: "accent" });
  }

  const modelRole: Role =
    m.modelSource === "local" ? "modelOpen" : m.modelSource === "cloud" ? "modelPaid" : "muted";
  // the authorisation chip sits immediately LEFT of the model (first right segment → leftmost of
  // the right run) and, being at the head, is the LAST right chip justify() drops on a narrow
  // terminal — so the active autonomy level stays visible next to the model.
  const auth = authLevelMeta(m.authLevel);
  const right: Segment[] = [
    { text: `auth:${auth.level}·${auth.name}`, role: authRole(auth.level) },
    { text: m.model || "no model", role: modelRole },
    { text: `/${m.profile}`, role: "modelOpen" }, // profile in green (the "/rc"-style chip)
  ];
  // live cost ticker (CLI-089) — before cwd so cwd drops first on a narrow terminal (cost is the
  // more useful chip); omitted entirely when there's no cost data yet.
  const costSeg = costMeterSegment(m);
  if (costSeg) right.push(costSeg);
  right.push({ text: m.cwd, role: "muted" });
  // the context meter is the LAST right chip → justify's tail-first drop hides it (whole-segment,
  // never mid-token) before the load-bearing model/profile/cwd chips on narrow terminals (CLI-052).
  const meter = contextMeterSegment(m);
  if (meter) right.push(meter);

  const lines = [justify(left, right, width, caps)];

  // the fleet line, directly under the chips it extends. Null on a fleet of one (or none), so
  // the common case costs nothing.
  const fleet = m.fleet ? fleetBarLine(m.fleet, width, caps) : null;
  if (fleet) lines.push(fleet);

  // line 2: the permission indicator (only when non-default), clipped + painted.
  const p = painter(caps);
  if (meta.indicator) {
    const role = modeRole(m.permMode);
    lines.push(p[role](clip(meta.indicator, width)));
  }
  lines.push(composerHint(caps, width));
  return lines;
}

/** The full key hint, longest-first; drop trailing tokens to fit `width`, then paint. */
// Order matters: the composer hint drops tokens TAIL-FIRST to fit the width, so the load-bearing
// binds (send/mode/cancel/exit) come first and the secondary §7 keys (⌃G/⌃S) drop first (CLI-067).
const HINT_TOKENS = [
  "⏎ send",
  "/ commands",
  "⇧⏎ newline",
  "↑↓ history",
  "⇧⇥ mode",
  "⌃C cancel",
  "⌃D exit",
  "⌃T traits", // focus the model's trait rail (tools / thinking / effort)
  "⌃G panes", // cycle focused pane (CLI-067)
  "⌃S save", // save transcript (CLI-067)
];

/** The composer key hint (muted), responsive — drops tokens tail-first to fit `width`. */
export function composerHint(caps: ColorCaps, width = 80): string {
  const p = painter(caps);
  let tokens = [...HINT_TOKENS];
  while (tokens.length > 1 && visLen(tokens.join("  ·  ")) > width) tokens = tokens.slice(0, -1);
  return p.muted(clip(tokens.join("  ·  "), width));
}

/* ── the trait rail ───────────────────────────────────────────────────────────── */

/**
 * This surface's view of the rail: the shared slot order + on/off/unsupported model from core,
 * with the terminal's own wording for the effort cell.
 */
export function traitCells(m: StatusModel): TraitCell[] {
  return traitRail({
    capabilities: m.capabilities,
    toolsEnabled: m.tools,
    ...(m.effort ? { effort: { tier: m.effort.tier, available: m.effort.available } } : {}),
  });
}

/** The `⌃T` focus state: which rail cell the arrow keys are pointed at. */
export interface TraitFocus {
  index: number;
}

/** A rail cell's display-column span, measured from the START of the rail string. */
export interface TraitSpan {
  start: number;
  /** exclusive. */
  end: number;
}

/**
 * Where each cell lands on the rendered rail, so a MOUSE click can be mapped back to a cell.
 *
 * Computed from the same `[label]` / ` label ` shapes `traitRailLine` paints, and both are
 * driven off the same `cells` array — the click target cannot drift from what is on screen
 * unless one of them stops using this function.
 */
export function traitRailSpans(cells: readonly TraitCell[]): TraitSpan[] {
  const spans: TraitSpan[] = [];
  let x = 0;
  for (const c of cells) {
    const w = stringWidth(c.label) + 2; // ` label ` and `[label]` are the same width
    spans.push({ start: x, end: x + w });
    x += w;
  }
  return spans;
}

/**
 * Paint the rail as ONE line: `txt vis aud tool think    ⚙ high`.
 *
 * Green = live this turn, amber = the user switched it off, dim = the model does not have it.
 * The focused cell (⌃T mode) is bracketed so the selection survives a terminal with no color
 * at all — a highlight that exists only as a hue is not a selection under NO_COLOR.
 *
 * Returns null when the rail is empty (nothing probed and no effort state) or cannot fit in
 * `width`, so the caller can fall back rather than paint a half-truncated row.
 */
/**
 * Does the rail actually FIT in `width`? — the same test `traitRailLine` applies before painting.
 *
 * Exported because ⌃T must not enter its modal trait-focus when nothing is on screen. That guard
 * only checked whether there were cells at all, while the rail is dropped whenever it does not
 * fit (a ~35-38 column rail on a narrow terminal). The result was a composer that looked
 * completely normal — no focus ring, no hint row, no rail — in which every printable key, Enter,
 * Backspace and ⌃D were silently swallowed by the modal reducer. The user reads that as a frozen
 * terminal.
 *
 * One predicate rather than two, so the key that ENTERS the mode and the code that PAINTS it can
 * never disagree about whether the rail is there.
 */
export function traitRailFits(
  cells: readonly TraitCell[],
  width: number,
  focus?: { index: number } | null,
): boolean {
  if (cells.length === 0) return false;
  const plain = cells
    .map((c, i) => (focus && focus.index === i ? `[${c.label}]` : ` ${c.label} `))
    .join("");
  return stringWidth(plain) <= width;
}

export function traitRailLine(
  cells: readonly TraitCell[],
  focus: TraitFocus | null,
  width: number,
  caps: ColorCaps,
): string | null {
  if (!traitRailFits(cells, width, focus)) return null;
  const p = painter(caps);
  const role = (c: TraitCell): Role =>
    c.state === "on" ? "traitOn" : c.state === "off" ? "traitOff" : "muted";
  return cells
    .map((c, i) => {
      const text = focus && focus.index === i ? `[${c.label}]` : ` ${c.label} `;
      return p[role(c)](text);
    })
    .join("");
}

/**
 * The one-line key hint shown under the rail while ⌃T focus is active — including, for a cell
 * that has no switch, the REASON, so a refused ↑ explains itself instead of looking broken.
 */
export function traitFocusHint(cells: readonly TraitCell[], focus: TraitFocus): string {
  const cell = cells[focus.index];
  if (!cell) return "";
  if (!cell.actionable) return `${cell.label}: ${cell.reason ?? "no switch here"} · esc done`;
  if (cell.id === "effort") return "↑/↓ raise/lower effort · ←/→ move · esc done";
  return "↑ on · ↓ off · ←/→ move · esc done";
}
