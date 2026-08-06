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
  const modeChip = `[PROM:${meta.label.toUpperCase().replace(/\s+/g, "-")}]`;

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
