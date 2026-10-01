// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/effort/traits.ts — the model's facts, in the order a person reads them.
 *
 * Both surfaces show the same strip beside the composer: what the active model can DO
 * (`completion`, `vision`, `audio`, `tools`, `thinking` — the runner's own words, from Ollama's
 * `/api/show`) and then the one setting the user can move (the effort tier).
 *
 * Putting them together is the point. `thinking` in that list is the PRECONDITION for the tier
 * next to it meaning anything at all — a model without it gets its tier by prompt emulation,
 * not by a request parameter — and while the two lived on different chrome, a genuinely causal
 * pair read as two unrelated chips.
 *
 * The ordering and the two-row grid live HERE, not in either renderer, because the CLI and the
 * Electron pane must not drift into showing the same facts in different orders. What each
 * renderer still owns is presentation: the terminal pads columns with spaces, the pane uses a
 * CSS grid, and neither concern belongs in the other.
 *
 * PURE. No IO, no DOM, no ANSI.
 */

/**
 * Above this many traits the single-line strip stops fitting and the two-row grid takes over.
 *
 * Four is measured, not chosen: `completion · vision · tools · thinking · effort: not available`
 * is already 58 columns, and in the terminal that strip is inlaid into a border which also has
 * to hold two corner pads. A fifth trait pushes a standard 80-column composer past the point
 * where the inlay gives up and silently drops the whole thing. The Electron rail is ~330px and
 * hits the same wall at the same count.
 */
export const TRAIT_INLINE_MAX = 4;

/**
 * The model's traits in display order: capabilities first, the one CONTROL last.
 *
 * The effort cell is deliberately final. It is the only entry that is a control rather than a
 * property, and putting the properties to its left is what makes the strip read as "here is the
 * model, and here is your dial" rather than as an undifferentiated chip soup.
 *
 * `capabilities` keeps the runner's own order — it is stable per model, and re-sorting would
 * make the strip reshuffle between models for no gain. Blanks and repeats are dropped: a runner
 * is free to repeat itself, and a doubled chip reads as a rendering bug.
 */
export function modelTraits(
  capabilities: readonly string[] | undefined,
  effortCell: string | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of capabilities ?? []) {
    const t = c.trim();
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  if (effortCell) out.push(effortCell);
  return out;
}

/** A two-row grid: `cols` columns, `cells` in row-major order (length is always `cols * 2`). */
export interface TraitGrid {
  cols: number;
  /** row-major; `""` marks a deliberately empty cell. */
  cells: string[];
}

/**
 * Lay the traits out as EXACTLY two rows.
 *
 * Two, not "as many as needed": the point is to stay a glanceable strip attached to the
 * composer, and a panel that grew with the model would start competing with the transcript for
 * the screen.
 *
 * Padding goes BEFORE the last trait, never after, so the effort cell always lands
 * bottom-right. A control that wanders with the capability count is harder to find than one
 * that is always in the same corner — and the count changes every time the user switches model,
 * which is precisely when they are looking for it.
 *
 * Returns null at or below `TRAIT_INLINE_MAX`, where the single-line strip is the better
 * rendering and the caller should use it instead.
 */
export function traitGrid(traits: readonly string[]): TraitGrid | null {
  if (traits.length <= TRAIT_INLINE_MAX) return null;
  const cols = Math.ceil(traits.length / 2);
  const pad = cols * 2 - traits.length;
  return {
    cols,
    cells: [
      ...traits.slice(0, -1),
      ...Array<string>(pad).fill(""),
      traits[traits.length - 1] as string,
    ],
  };
}

/* ── the trait RAIL (the interactive strip) ───────────────────────────────────
 *
 * The grid above lays the traits out as a table; the rail below is the other rendering, and
 * the one the surfaces actually paint: a FIXED row of slots in a FIXED order, where a slot the
 * model lacks stays in place, dimmed, instead of vanishing.
 *
 * Fixed-and-dimmed rather than present-only for two reasons. Absence is information — "this
 * model cannot see" is as worth knowing as "this one can" — and the old strip could not say it
 * at all. And a rail whose cells never move is one the eye and the ←/→ keys can both learn:
 * the same capability is in the same place on every model, so switching models does not
 * reshuffle the row out from under a user who is mid-keystroke.
 */

/** The capability slots, in rail order. `capability` is the runner's own word for the slot. */
export const TRAIT_SLOTS: readonly { id: TraitCellId; label: string; capability: string }[] = [
  { id: "completion", label: "txt", capability: "completion" },
  { id: "vision", label: "vis", capability: "vision" },
  { id: "audio", label: "aud", capability: "audio" },
  { id: "tools", label: "tool", capability: "tools" },
  { id: "thinking", label: "think", capability: "thinking" },
];

/** A rail cell: the five capability slots, then the one CONTROL. */
export type TraitCellId = "completion" | "vision" | "audio" | "tools" | "thinking" | "effort";

/**
 * `on` — the model has it and it is live this turn.
 * `off` — the model has it and the USER switched it off (the only state ↑ can undo).
 * `unsupported` — the model does not have it at all; no switch exists to throw.
 */
export type TraitCellState = "on" | "off" | "unsupported";

export interface TraitCell {
  id: TraitCellId;
  label: string;
  state: TraitCellState;
  /** ↑/↓ change this cell. False for a pure indicator or an unsupported capability. */
  actionable: boolean;
  /** why ↑/↓ do nothing here — shown instead of silently ignoring the keypress. */
  reason?: string;
}

export interface TraitRailInput {
  /** the runner's `/api/show` capabilities; undefined ⇒ never probed. */
  capabilities: readonly string[] | undefined;
  /** `/tools` — whether tools are sent to the model this session. */
  toolsEnabled: boolean;
  /**
   * Does THIS surface have a tools switch at all? Default true (the terminal's `/tools` + ⌃T).
   *
   * The Electron pane has none — it always sends the tool set — so there the cell is an
   * indicator, and saying so is the point: a rail cell that looks like a switch and silently
   * refuses is the exact failure this mode was built to remove.
   */
  toolsSwitchable?: boolean;
  /** the resolved effort state, exactly as the badge reports it. */
  effort?: { tier: string; available: boolean };
}

/**
 * Build the rail.
 *
 * `completion`, `vision` and `audio` are INDICATORS, not controls: Prometheus has no seam that
 * would make switching them off mean anything (there is no image or audio attachment path to
 * suppress), and a switch that silently does nothing is worse than no switch. They carry the
 * reason so the surface can say it out loud rather than swallow the keypress.
 *
 * `tools` and `thinking` are real: the first decides whether tool definitions are sent at all,
 * the second is the precondition for the effort tier beside it, so switching it off IS setting
 * the tier to `off`. Both are only actionable when the model reports the capability — turning
 * "on" something the runner says does not exist would be a lie the next turn exposes.
 */
export function traitRail(input: TraitRailInput): TraitCell[] {
  const has = new Set((input.capabilities ?? []).map((c) => c.trim()).filter((c) => c !== ""));
  const probed = input.capabilities !== undefined;
  const cells: TraitCell[] = [];
  for (const slot of TRAIT_SLOTS) {
    if (!probed) continue; // nothing was measured — an all-dim rail would be a false report
    const supported = has.has(slot.capability);
    if (slot.id === "tools") {
      const switchable = supported && input.toolsSwitchable !== false;
      cells.push({
        id: slot.id,
        label: slot.label,
        state: !supported ? "unsupported" : input.toolsEnabled ? "on" : "off",
        actionable: switchable,
        ...(switchable
          ? {}
          : {
              reason: supported
                ? "no switch here — this surface always sends tools"
                : "this model has no tool calling",
            }),
      });
      continue;
    }
    if (slot.id === "thinking") {
      const thinking = supported && input.effort?.tier !== "off";
      cells.push({
        id: slot.id,
        label: slot.label,
        state: !supported ? "unsupported" : thinking ? "on" : "off",
        actionable: supported,
        ...(supported ? {} : { reason: "this model has no reasoning control" }),
      });
      continue;
    }
    cells.push({
      id: slot.id,
      label: slot.label,
      state: supported ? "on" : "unsupported",
      actionable: false,
      // Kept short on purpose: this is rendered as a one-line hint under a rail that already
      // has to fit an 80-column terminal, and a clipped explanation explains nothing.
      reason: supported
        ? "no switch — this is what the model reports"
        : `this model has no ${slot.capability}`,
    });
  }
  if (input.effort) {
    const { tier, available } = input.effort;
    cells.push({
      id: "effort",
      /**
       * The gear carries U+FE0E (VARIATION SELECTOR-15) — "paint the previous code point as
       * TEXT, one cell" — and it is load-bearing, not decoration.
       *
       * `⚙` U+2699 is `Emoji=Yes, Emoji_Presentation=No`, so its width is a property of the
       * terminal font rather than of Unicode: measured on macOS, Menlo carries a text glyph and
       * paints it in one cell, Monaco does not and CoreText falls back to Apple Color Emoji,
       * which takes two. This label is the last cell of the composer's trait rail, a line padded
       * to EXACTLY the terminal's `cols-1` budget, so one unexpected column puts the row on the
       * last terminal cell — the one the width rule exists to keep empty — and the block becomes
       * a physical row taller than the renderer counted. VS15 asks for the one-cell glyph
       * explicitly, which is what every width table here already assumes; it measures zero, so
       * no column budget moves, and it is a no-op where the text glyph was being used anyway.
       *
       * The Electron pane reads the same label, where VS15 means the same thing.
       */
      label: `⚙︎ ${available ? tier : "n/a"}`,
      state: !available ? "unsupported" : tier === "off" ? "off" : "on",
      actionable: available,
      ...(available ? {} : { reason: "this model has no reasoning control" }),
    });
  }
  return cells;
}

/** Index of the first cell ↑/↓ can actually change, or -1 when the rail is inert. */
export function firstActionable(cells: readonly TraitCell[]): number {
  return cells.findIndex((c) => c.actionable);
}

/**
 * Move the focus by ±1 over ALL cells (not just the actionable ones).
 *
 * Every cell is reachable on purpose: an indicator's whole value is that you can land on it and
 * be told WHY it has no switch. Skipping them would leave the user pressing → at a cell that
 * silently refuses to be selected, which is the same "does nothing" complaint one level down.
 */
export function moveTraitFocus(cells: readonly TraitCell[], index: number, delta: number): number {
  if (cells.length === 0) return 0;
  const n = cells.length;
  return (((index + delta) % n) + n) % n;
}
