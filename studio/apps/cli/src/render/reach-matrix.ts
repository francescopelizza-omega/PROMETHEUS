/**
 * render/reach-matrix.ts — P3 projector for the `matrix` envelope (file 02 §3.3).
 *
 * Renders a box-drawn reach/coverage grid: one row per plugin, one column per
 * agent, each cell a colored glyph for how the plugin reaches that agent:
 *
 *   ● native   (green)  — installs directly into the agent
 *   ◐ sync     (cyan)   — reached via a sync bridge
 *   ○ none     (dim)    — the plugin cannot reach the agent
 *
 * This is pure presentation over the engine's `matrix` envelope (C5): nothing
 * here re-decides reach — it only paints the `native`/`sync`/`unavailable` sets
 * the engine already produced. Color is opt-in and ANSI-safe; all column widths
 * are computed from VISIBLE length (via render.ts helpers) so the box stays
 * aligned even with embedded SGR codes.
 *
 * The `scope` code (compact "C" = claude-only, "U" = universal) is shown as a
 * trailing tag per plugin so callers see reach AND scope at a glance.
 */
import type { MatrixEnvelope, MatrixReach } from "@prometheus/engine-bridge";

import { c, heading, padEnd, padStart, sym, visibleLen } from "../render.js";

export interface ReachMatrixOptions {
  /** Override the agent column order/set (defaults to `matrix.agents`). */
  agents?: string[];
  /** Suppress the heading + legend chrome (just the grid). Default false. */
  bare?: boolean;
  /** Show the per-plugin scope tag column ("C"/"U"). Default true. */
  showScope?: boolean;
  /**
   * Pane width hint (cols). Used as a MINIMUM for the PLUGIN column so the grid
   * can fill a session pane; the box never shrinks content below its natural
   * width. Ignored when undefined (the default — auto-size to content).
   */
  width?: number;
}

/** How a single plugin reaches a single agent. */
type ReachKind = "native" | "sync" | "none";

/** Light box-drawing set (matches the quiet house chrome). */
const BOX = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  h: "─",
  v: "│",
  // tee / cross junctions for the header rule
  teeDown: "┬",
  teeUp: "┴",
  teeRight: "├",
  teeLeft: "┤",
  cross: "┼",
} as const;

/** Classify a plugin's reach to one agent from its native/sync/unavailable sets. */
function reachKind(reach: MatrixReach, agent: string): ReachKind {
  if (reach.native.includes(agent)) return "native";
  if (reach.sync.includes(agent)) return "sync";
  return "none";
}

/** The colored single-glyph cell for a reach kind. */
function reachGlyph(kind: ReachKind): string {
  switch (kind) {
    case "native":
      // a filled dot — full, native reach (reuse the shared ok symbol).
      return sym.ok();
    case "sync":
      // a half dot — reached only via the sync bridge.
      return c.cyan("◐");
    case "none":
      // hollow dot — out of reach (reuse the shared off symbol).
      return sym.off();
  }
}

/** Compact scope code colored: "U" universal (accent), "C" claude-only (dim). */
function scopeTag(scope: string): string {
  const s = scope.trim().toUpperCase() || "?";
  return s === "U" ? c.cyan(s) : c.dim(s);
}

/** A horizontal rule for the grid, given each column's visible width. */
function rule(left: string, mid: string, right: string, widths: number[]): string {
  const segs = widths.map((w) => BOX.h.repeat(w + 2)); // +2 for the cell padding
  return left + segs.join(mid) + right;
}

/** Wrap a row of pre-padded cells in the vertical box borders. */
function boxRow(cells: string[]): string {
  return `${BOX.v} ${cells.join(` ${BOX.v} `)} ${BOX.v}`;
}

/**
 * Render the reach/coverage matrix to a multi-line string (no trailing newline).
 *
 * Accepts the engine's `MatrixEnvelope` directly so callers can pass the raw
 * engine reply with no reshaping.
 */
export function renderReachMatrix(matrix: MatrixEnvelope, opts: ReachMatrixOptions = {}): string {
  const agents = opts.agents ?? matrix.agents ?? [];
  const showScope = opts.showScope ?? true;
  const reach = matrix.reach ?? [];

  // Empty guard: an honest one-liner beats an empty box.
  if (agents.length === 0 || reach.length === 0) {
    const msg = c.dim("No reach data.");
    return opts.bare ? msg : `${heading("Reach matrix")}\n${msg}`;
  }

  // Column 0 is the plugin name; then one column per agent; then optional scope.
  const pluginHeader = "PLUGIN";
  const headerCells = [pluginHeader, ...agents, ...(showScope ? ["SCOPE"] : [])];

  // Body rows: plugin name + a glyph per agent + scope tag.
  const bodyCells: string[][] = reach.map((r) => {
    const glyphs = agents.map((a) => reachGlyph(reachKind(r, a)));
    const scope = showScope ? [scopeTag(r.scope)] : [];
    return [r.plugin, ...glyphs, ...scope];
  });

  // Compute each column's width from the VISIBLE length of every cell (ANSI-safe).
  const colCount = headerCells.length;
  const widths: number[] = [];
  for (let i = 0; i < colCount; i++) {
    let w = visibleLen(headerCells[i] ?? "");
    for (const row of bodyCells) {
      const len = visibleLen(row[i] ?? "");
      if (len > w) w = len;
    }
    widths[i] = w;
  }

  // Optional pane-width hint: widen the PLUGIN column (col 0) so the grid fills
  // the pane. We budget the hint minus the agent/scope columns and box chrome;
  // never shrink below the natural plugin-name width.
  if (opts.width !== undefined && opts.width > 0) {
    // chrome ≈ 3 per column (" │ ") + 1 trailing border.
    const others = widths.slice(1).reduce((sum, w) => sum + w, 0);
    const chrome = colCount * 3 + 1;
    const budget = opts.width - others - chrome;
    if (budget > (widths[0] ?? 0)) widths[0] = budget;
  }

  // Pad cells: plugin name left-aligned, every other column centered-ish via
  // right-pad on the header / center on glyphs. Glyph columns are width-1 so a
  // simple left-pad keeps them under their header. Plugin column stays left.
  const padCell = (cell: string, col: number): string =>
    col === 0 ? padEnd(cell, widths[col] ?? 0) : padStart(cell, widths[col] ?? 0);

  const out: string[] = [];

  if (!opts.bare) {
    out.push(heading("Reach matrix"));
  }

  // Top border.
  out.push(rule(BOX.tl, BOX.teeDown, BOX.tr, widths));
  // Header row (bold).
  out.push(boxRow(headerCells.map((h, i) => padCell(c.bold(h), i))));
  // Header rule.
  out.push(rule(BOX.teeRight, BOX.cross, BOX.teeLeft, widths));
  // Body rows.
  for (const row of bodyCells) {
    out.push(boxRow(row.map((cell, i) => padCell(cell, i))));
  }
  // Bottom border.
  out.push(rule(BOX.bl, BOX.teeUp, BOX.br, widths));

  if (!opts.bare) {
    out.push("");
    out.push(
      c.dim(
        `legend: ${sym.ok()} native   ${c.cyan("◐")} sync   ${sym.off()} none${showScope ? "   ·   scope: U universal · C claude-only" : ""}`,
      ),
    );
  }

  return out.join("\n");
}
