/**
 * tui/fleet-bar.ts — the one-line fleet bar: who else is running, and what it costs.
 *
 * ```
 * prom 7  working 3  idle 2  needs-you 1  dead 1    cpu ██▒░░░ 41%  ram █▒░░░░ 34%  gpu 68%
 * ```
 *
 * ## Nothing here has to be decoded
 *
 * An earlier draft of this bar used glyphs for the peer states (`▶3 ◐2 ⏸1 ✖1`) and it failed
 * the only test that matters for chrome: a user could not tell what it said. So every number on
 * this line is preceded by a word and followed by its unit, and colour is redundant with the
 * word rather than the carrier of it — the bar reads identically under NO_COLOR.
 *
 * The three bar glyphs are the one thing that must be learned, they are learned once, and the
 * first-run legend + `/fleet` both spell them out:
 *
 *   `█` Prometheus (light blue) · `▒` other processes (yellow) · `░` free (green)
 *
 * ## `needs-you`
 *
 * The state that justifies the whole line. With seven windows open, the question you actually
 * have is not "what is the CPU at", it is "which window is sitting on a confirm prompt waiting
 * for me". It was called `waiting` and that was the vaguest chip on the bar.
 *
 * ## Zero counts are hidden
 *
 * `dead 0` is noise, and noise on a status line is how a status line stops being read. A healthy
 * fleet collapses to `prom 3  working 1  idle 2`; a broken one grows the chip that says so.
 *
 * PURE — takes a model, a width and the colour caps. No fs, no timers, no probing.
 */
import { type ColorCaps, type Role, painter } from "./palette.js";
import { clipToWidth, stringWidth } from "./width.js";

/** Prometheus / other / free. Kept as named constants so the legend cannot drift from the bar. */
export const CELL_OURS = "█";
export const CELL_OTHER = "▒";
export const CELL_FREE = "░";

/** One resource. `pct: null` ⇒ present but not measurable here; `oursPct` absent ⇒ no bar. */
export interface BarMeter {
  pct: number | null;
  oursPct?: number;
}

/** What the bar renders. Structurally satisfied by `fleet/meters.ts` + `fleet/heartbeat.ts`. */
export interface FleetBarModel {
  peers: { working: number; idle: number; needsYou: number; dead: number; total: number };
  cpu: BarMeter;
  ram: BarMeter;
  gpu?: BarMeter;
  /** presence-only badges (`ane`, `npu`, `tpu`) — first thing dropped when width is tight. */
  accelerators?: readonly string[];
}

/** How many cells a bar is split into, widest first. `0` ⇒ no bar, number only. */
export const CELL_TIERS = [6, 4, 3, 0] as const;

/**
 * Split `n` cells into ours / other / free.
 *
 * The load-bearing rule is the minimum: **a non-zero share always claims at least one cell.**
 * 6 GB of 64 is 9%, which is under a sixth of a six-cell bar, so plain rounding gives it zero
 * cells — and the fleet vanishes from the bar whose entire job is showing the fleet. Both used
 * segments floor-then-raise-to-1, `free` absorbs the remainder, and the three always sum to
 * exactly `n`.
 */
export function barCells(
  pct: number,
  oursPct: number,
  n: number,
): { ours: number; other: number; free: number } {
  if (n <= 0) return { ours: 0, other: 0, free: 0 };
  const total = Math.max(0, Math.min(100, pct));
  const ours = Math.max(0, Math.min(total, oursPct));
  const shares = [ours, total - ours, 100 - total];
  const exact = shares.map((s) => (s / 100) * n);
  const cells = exact.map((e) => Math.floor(e));
  // Largest remainder: hand the leftover cells to the segments the flooring shortchanged most.
  // Flooring all three and letting `free` keep the remainder is what a first draft does, and it
  // systematically shrinks both used segments in favour of headroom — a bar that always reads
  // emptier than the machine is.
  let left = n - cells.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((e, i) => ({ i, r: e - Math.floor(e) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k += 1, left -= 1) {
    const idx = (byRemainder[k % 3] as { i: number }).i;
    cells[idx] = (cells[idx] as number) + 1;
  }
  // A non-zero USED share always claims a cell. 6 GB of 64 is 9% — under a sixth of a six-cell
  // bar — so without this the fleet disappears from the bar whose entire job is showing the
  // fleet. The cell is taken from a segment that can spare one, so the three still sum to `n`.
  for (const i of [0, 1]) {
    if ((shares[i] as number) <= 0 || (cells[i] as number) > 0) continue;
    const donor = [2, 1, 0].find(
      (j) => j !== i && (cells[j] as number) > ((shares[j] as number) > 0 ? 1 : 0),
    );
    if (donor === undefined) continue;
    cells[donor] = (cells[donor] as number) - 1;
    cells[i] = (cells[i] as number) + 1;
  }
  return { ours: cells[0] as number, other: cells[1] as number, free: cells[2] as number };
}

interface Piece {
  plain: string;
  colored: string;
}

const join = (pieces: readonly Piece[], sep: string): Piece => ({
  plain: pieces.map((p) => p.plain).join(sep),
  colored: pieces.map((p) => p.colored).join(sep),
});

/** The load tint on a percentage: the same 80 / 95 thresholds the context meter already uses. */
function loadRole(pct: number | null): Role {
  if (pct === null) return "muted";
  if (pct >= 95) return "danger";
  if (pct >= 80) return "warn";
  return "muted";
}

/** `cpu ██▒░░░ 41%` / `cpu 41%` / `gpu —`. */
export function meterPiece(label: string, m: BarMeter, cells: number, caps: ColorCaps): Piece {
  const p = painter(caps);
  const value = m.pct === null ? "—" : `${Math.round(m.pct)}%`;
  const head = `${label} `;
  const drawBar = cells > 0 && m.pct !== null && m.oursPct !== undefined;
  if (!drawBar) {
    return {
      plain: `${head}${value}`,
      colored: `${p.muted(head)}${p[loadRole(m.pct)](value)}`,
    };
  }
  const c = barCells(m.pct as number, m.oursPct as number, cells);
  const bar = CELL_OURS.repeat(c.ours) + CELL_OTHER.repeat(c.other) + CELL_FREE.repeat(c.free);
  const barColored =
    p.fleetOurs(CELL_OURS.repeat(c.ours)) +
    p.fleetOther(CELL_OTHER.repeat(c.other)) +
    p.fleetFree(CELL_FREE.repeat(c.free));
  return {
    plain: `${head}${bar} ${value}`,
    colored: `${p.muted(head)}${barColored} ${p[loadRole(m.pct)](value)}`,
  };
}

/** The peer chips: `prom 7  working 3  idle 2  needs-you 1  dead 1`, zero counts omitted. */
export function peerPieces(m: FleetBarModel, caps: ColorCaps): Piece[] {
  const p = painter(caps);
  const chip = (text: string, role: Role): Piece => ({ plain: text, colored: p[role](text) });
  const out: Piece[] = [chip(`prom ${m.peers.total}`, "brand")];
  // Order is fixed and never re-sorted by count: a chip that moves position between refreshes
  // has to be re-found by eye every time, which is the opposite of what a status line is for.
  if (m.peers.working > 0) out.push(chip(`working ${m.peers.working}`, "fleetOurs"));
  if (m.peers.idle > 0) out.push(chip(`idle ${m.peers.idle}`, "muted"));
  if (m.peers.needsYou > 0) out.push(chip(`needs-you ${m.peers.needsYou}`, "warn"));
  if (m.peers.dead > 0) out.push(chip(`dead ${m.peers.dead}`, "danger"));
  return out;
}

/** Which meters a rung of the ladder keeps. */
type Variant = "accel" | "full" | "noGpu" | "cpuOnly";

/**
 * The width ladder, most-valuable-last-to-go.
 *
 * The presence badges go first — they are static facts that never change during a session, so
 * they cost width every frame to say the same thing, and `/fleet` carries them anyway. Then the
 * bars shrink 6 → 4 → 3 before being dropped entirely, because a number with no bar still
 * answers "how loaded", while a dropped meter answers nothing. Only then do whole meters go.
 */
const LADDER: readonly { variant: Variant; cells: number }[] = [
  { variant: "accel", cells: 6 },
  ...CELL_TIERS.map((cells) => ({ variant: "full" as Variant, cells })),
  ...CELL_TIERS.map((cells) => ({ variant: "noGpu" as Variant, cells })),
  { variant: "cpuOnly", cells: 0 },
];

function rightPieces(m: FleetBarModel, variant: Variant, cells: number, caps: ColorCaps): Piece[] {
  const p = painter(caps);
  const out: Piece[] = [meterPiece("cpu", m.cpu, cells, caps)];
  if (variant !== "cpuOnly") out.push(meterPiece("ram", m.ram, cells, caps));
  if (m.gpu && (variant === "accel" || variant === "full")) {
    out.push(meterPiece("gpu", m.gpu, cells, caps));
  }
  if (variant === "accel") {
    for (const a of m.accelerators ?? []) {
      out.push({ plain: `${a} present`, colored: p.muted(`${a} present`) });
    }
  }
  return out;
}

/**
 * Render the bar, or null when there is nothing to say.
 *
 * Null on a fleet of one is the contract the caller depends on: a user running a single session
 * does not spend a row of terminal height, forever, on the word `prom 1`.
 */
export function fleetBarLine(
  m: FleetBarModel,
  width: number,
  caps: ColorCaps,
  opts: { showAlone?: boolean } = {},
): string | null {
  if (fleetBarRows(m, width, opts) === 0) return null;
  const left = join(peerPieces(m, caps), "  ");
  for (const rung of LADDER) {
    const right = join(rightPieces(m, rung.variant, rung.cells, caps), "  ");
    const need = stringWidth(left.plain) + 2 + stringWidth(right.plain);
    if (need <= width) {
      const gap = width - stringWidth(left.plain) - stringWidth(right.plain);
      return `${left.colored}${" ".repeat(Math.max(2, gap))}${right.colored}`;
    }
  }
  // Narrower than even `prom N …  cpu 41%`: keep the peers, which are the reason the line
  // exists, and clip. Clipping the PLAIN text (not the coloured one) so a cut never lands
  // inside an escape sequence and paints the rest of the terminal light blue.
  const p = painter(caps);
  return p.muted(clipToWidth(left.plain, width));
}

/**
 * How many rows the bar will occupy — 1 or 0. THE predicate, used by both the renderer and the
 * frame's height budget.
 *
 * Two copies of "will there be a fleet line" is a frame that renders one row more than the
 * terminal has: the composer height is computed from a budget, and a budget that disagrees with
 * what is actually painted walks the prompt up the screen over the scrollback. `frame.ts` already
 * carries two scars from exactly that, both from a status row someone forgot to count.
 */
export function fleetBarRows(
  m: FleetBarModel | undefined,
  width: number,
  opts: { showAlone?: boolean } = {},
): 0 | 1 {
  if (!m) return 0;
  if (width <= 0) return 0;
  if (m.peers.total <= 1 && opts.showAlone !== true) return 0;
  return 1;
}

/* ── the legend ──────────────────────────────────────────────────────────────*/

/**
 * The one-time legend, printed above the bar the first time a user ever sees it.
 *
 * A bar this dense needs exactly one explanation and then never again, which is why this is a
 * first-run event rather than a permanent key: a legend you have already read is just three rows
 * of scrollback you did not want.
 */
export function fleetLegendLines(caps: ColorCaps): string[] {
  const p = painter(caps);
  const row = (k: string, v: string): string => `    ${p.accent(k.padEnd(11))}${p.muted(v)}`;
  return [
    p.muted("  fleet bar — the other Prometheus windows on this machine"),
    row("working", "running a turn right now"),
    row("idle", "sitting at the prompt"),
    row("needs you", "blocked on a confirm prompt — switch to that window"),
    row("dead", "heartbeat stopped (crashed or killed)"),
    `    ${p.fleetOurs(CELL_OURS)} ${p.muted("Prometheus")}   ${p.fleetOther(CELL_OTHER)} ${p.muted(
      "other processes",
    )}   ${p.fleetFree(CELL_FREE)} ${p.muted("free")}      ${p.muted(
      "(no bar = the split is not measurable here)",
    )}`,
    p.muted("  run /fleet for the per-window list and the exact GB"),
  ];
}
