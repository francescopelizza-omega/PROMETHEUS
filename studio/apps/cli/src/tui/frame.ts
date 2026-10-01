// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import { agent } from "@prometheus/core";

import { renderDropdown } from "./autocomplete.js";
/**
 * tui/frame.ts — compose the whole bottom chrome into ONE frame (pure).
 *
 * renderFrame(state,size) → { lines, cursorRow, cursorCol } stacks, top→bottom:
 *   [autocomplete dropdown rows]   (only when open — anchored ABOVE the box)
 *   [bordered composer box]        (resizes; red border in bypass mode)
 *   [status bar · mode indicator · hint]
 *
 * WIDTH RULE (load-bearing, from the spec): every line is built at `cols-1` columns so
 * no physical line ever touches the last terminal column — that defeats the deferred-
 * wrap / magic-margin bug and keeps `lines.length === physical rows` for the redraw
 * math. On a very narrow terminal the box collapses to a single `›` prompt line. PURE
 * → the app snapshots this for golden-frame tests; no IO here.
 */
import { fleetBarRows } from "./fleet-bar.js";
import { layoutComposer, reverseSearchLine } from "./input-box.js";
import { renderInvokeOverlay } from "./invoke-overlay.js";
import { renderListOverlay } from "./list-overlay.js";
import { type ColorCaps, paint, painter } from "./palette.js";
import { isPathOpen, toAcView } from "./path-mentions.js";
import type { TuiState } from "./reducer.js";
import {
  type StatusModel,
  type TraitSpan,
  effortBadge,
  statusLines,
  traitCells,
  traitFocusHint,
  traitRailLine,
  traitRailSpans,
} from "./status.js";
import { clipToWidth, graphemeSlice, splitGraphemes, stringWidth, wrapLine } from "./width.js";

export interface FrameInput {
  state: TuiState;
  status: StatusModel;
  caps: ColorCaps;
  cols: number;
  rows: number;
  /** ghost text shown when the buffer is empty. */
  placeholder?: string;
}

export interface Frame {
  lines: string[];
  /** caret target, 0-indexed from the first frame line. */
  cursorRow: number;
  cursorCol: number;
  /** the composer text area's screen geometry (CLI-069 click-to-position); absent in the narrow
   *  collapse. `firstBodyRow` = frame line of the first text row; `textLeft` = 0-based display
   *  column where text starts; `textWidth` = wrap width used for the text. */
  box?: { firstBodyRow: number; textLeft: number; textWidth: number };
  /**
   * The trait rail's screen geometry, so a click can be mapped back to a cell (the mouse twin of
   * ⌃T). `row` is the frame line the rail is painted on; `spans` are its cells' display-column
   * ranges measured from `textLeft`. Absent whenever no rail is rendered.
   */
  rail?: { row: number; textLeft: number; spans: TraitSpan[] };
}

const DEFAULT_PLACEHOLDER = 'Try "scan ./"  ·  type / for commands  ·  ⇧⇥ to change mode';

/** Compose the full bottom-chrome frame for the current state + terminal size. */
export function renderFrame(input: FrameInput): Frame {
  const { state, status, caps, cols, rows } = input;
  const p = painter(caps);
  // never write the last column (magic-margin guard).
  const width = Math.max(8, cols - 1);

  // ── narrow-terminal collapse: a single `› text` line, no box ─────────────── //
  if (cols < 24 || rows < 6) {
    const promptCols = 2; // "› "
    const avail = Math.max(1, width - promptCols); // columns left for the text
    const before = [...state.input].slice(0, state.cursor).join("");
    // clip to the available columns (wide-char aware) so the line never exceeds cols-1.
    const line = `${p.brand("›")} ${p.plain(clipToWidth(state.input, avail))}`;
    return {
      lines: [line],
      cursorRow: 0,
      cursorCol: promptCols + Math.min(stringWidth(before), avail),
    };
  }

  const lines: string[] = [];

  // ── dropdown (above the box) ─────────────────────────────────────────────── //
  // keep the whole block within `rows`: box≈3, status≈3 → cap the dropdown. The slash and
  // "@"-path dropdowns share this one slot — they're never both open (see reducer.ts's
  // `commit()`), so at most one of the two renders produces any rows.
  const dropCap = Math.max(1, Math.min(8, rows - 7));
  const slashDropdown = renderDropdown(state.ac, width, caps, { maxRows: dropCap });
  const pathDropdown = isPathOpen(state.pathAc)
    ? renderDropdown(toAcView(state.pathAc), width, caps, { maxRows: dropCap, sigil: "" })
    : [];
  const dropdown = slashDropdown.length > 0 ? slashDropdown : pathDropdown;
  lines.push(...dropdown);

  /**
   * How many rows the chrome below an overlay needs: 3 composer + 2 status, plus the
   * permission-mode indicator when there is one.
   *
   * Both overlays used a flat `rows - 5`, which counts only TWO status lines. `statusLines`
   * emits a THIRD — the mode indicator — in acceptEdits/plan/bypassPermissions/yolo. The
   * composer budget further down already subtracts `indicatorRows`, but it floors at one body
   * row (`Math.max(1, …)`), so the extra line was never absorbed and the frame came out at
   * rows + 1 — breaking the `lines.length === physical rows` invariant the redraw depends on,
   * the same invariant the rows=7 overrun broke before it.
   *
   * Computed ONCE here and reused by the budget below, so the two cannot disagree about how
   * tall the chrome is.
   */
  const indicatorRows = agent.permissionModeMeta(state.permMode).indicator ? 1 : 0;
  /**
   * The fleet line is a FOURTH status row, and every height budget below has to know about it
   * for the same reason the permission indicator does — see the two comments above, both written
   * after a status row that nothing counted overran the terminal by exactly its own height.
   * `fleetBarRows` is the SAME predicate the renderer uses, so the two cannot disagree.
   */
  const extraStatusRows = indicatorRows + fleetBarRows(status.fleet, width);
  const overlayRows = rows - 5 - extraStatusRows;
  /**
   * An overlay draws title + filter + at least one row + hint — four lines, minimum. Below that
   * there is genuinely no room for it beside the chrome, and the old `Math.max(4, …)` floor took
   * those four rows anyway, so the frame simply came out taller than the terminal. Dropping the
   * overlay keeps the `lines.length === physical rows` invariant the redraw depends on; the
   * overlay state is untouched, so it appears as soon as the terminal has room.
   */
  const showOverlay = overlayRows >= 4;

  // ── /invoke overlay (CLI-059) — modal, above the box; clamps to the free rows ─── //
  if (state.invokeOverlay && showOverlay) {
    lines.push(...renderInvokeOverlay(state.invokeOverlay, width, overlayRows, caps));
  }

  // ── generic list-overlay (CLI-1xx) — modal, above the box; clamps to the free rows ─── //
  if (state.listOverlay && showOverlay) {
    lines.push(...renderListOverlay(state.listOverlay, width, overlayRows, caps));
  }

  // ── reverse-i-search prompt line (CLI-019), only while active ─────────────── //
  if (state.search) {
    lines.push(
      clipToWidth(
        reverseSearchLine(state.search, state.history, {
          label: (s) => (state.search?.failing ? p.warn(s) : p.muted(s)),
          match: (s) => p.accent(s),
        }),
        width,
      ),
    );
  }

  /**
   * ── composer box (ICE border at full autonomy) ────────────────────────────
   *
   * Was `danger` (red). Full autonomy is a mode the operator CHOSE to finish work unprompted,
   * not a fault, and a red rectangle held for a whole session stops being information and
   * becomes pressure — the reported effect being that people leave the mode that was working.
   * `autonomy` keeps it in the light-blue family and turns the lightness up instead. See the
   * role's comment in `palette.ts` for the full argument and the contrast figures.
   *
   * Both bypass AND yolo, because the level is not visible here: this keys on `permMode`, and
   * `authLevelToMode` maps A7 → yolo and A6 → bypassPermissions. Recolouring A7 alone would
   * mean threading `authLevel` into `TuiState`, which carries no level today.
   */
  const borderRole =
    state.permMode === "bypassPermissions" || state.permMode === "yolo" ? "autonomy" : "accent";
  /**
   * The model's traits ride in the composer's own chrome rather than the status bar: they
   * change when the MODEL changes, and the box you are typing into is the one piece of chrome
   * that cannot be scrolled away or lost in a dense chip row.
   *
   * Three renderings, picked by what the terminal can actually afford:
   *   1. ≤4 traits            → one strip inlaid in the bottom border;
   *   2. >4 traits, room      → the two-row panel (3 extra lines: rule + 2 rows);
   *   3. >4 traits, no room   → the effort cell alone — of the set, the only one the user can act on.
   *
   * Panel width is `width - 4`: the box spends 1 column on each border and 1 pad on each side.
   */
  /**
   * Rows left for the composer.
   *
   * Counts everything ALREADY emitted — `lines` at this point holds the dropdown AND the
   * /invoke or list overlay AND the reverse-i-search prompt — not just the dropdown. The old
   * `rows - dropdown.length - 4` under-counted by the whole overlay, which was survivable
   * while the composer was three lines and is not now that the trait panel can add three more:
   * with an overlay open the frame overran `rows` by exactly the panel's height, breaking the
   * `lines.length === physical rows` invariant the redraw math depends on.
   */
  /**
   * The permission-mode INDICATOR is a third status line.
   *
   * `statusLines` emits [status bar, indicator?, key hint] — two lines by default and THREE
   * whenever a non-default mode is active. This budget subtracted a fixed 4, so in
   * acceptEdits / plan / bypassPermissions / yolo the frame came out one line taller than the
   * terminal at exactly the height where the composer is already down to its minimum: a
   * 7-row terminal rendered 8 lines, breaking the `lines.length === physical rows` invariant
   * the redraw math depends on — the same class of overrun the comment above describes for
   * overlays.
   */
  const room = rows - lines.length - 4 - extraStatusRows;
  /**
   * The rail's compartment: the `├──┤` rule + the rail itself, + the key-hint row while ⌃T
   * focus is open. The old two-row grid cost three lines and spread five short facts across a
   * ragged 3×2 table with a hole in it; one dense line says the same thing and leaves room for
   * the hint that makes the row operable.
   */
  const cells = traitCells(status);
  const hint = state.traitFocus ? traitFocusHint(cells, state.traitFocus) : "";
  const railLines = 1 + 1 + (hint ? 1 : 0); // rule + rail (+ hint)
  const rail =
    room - railLines >= 1
      ? traitRailLine(cells, state.traitFocus, Math.max(1, width - 4), caps)
      : null;
  const panel = rail ? [rail, ...(hint ? [p.muted(hint)] : [])] : null;
  const boxMaxRows = Math.max(1, Math.min(8, panel ? room - railLines : room));
  const badge = panel ? undefined : (effortBadge(status) ?? effortBadge(status, { traits: false }));
  const composer = layoutComposer(state.input, state.cursor, width, {
    prompt: "›",
    placeholder: input.placeholder ?? DEFAULT_PLACEHOLDER,
    maxRows: boxMaxRows,
    ...(badge ? { badge } : {}),
    ...(panel ? { panel } : {}),
    paint: {
      border: (s) => p[borderRole](s),
      prompt: (s) => p.brand(s),
      placeholder: (s) => p.muted(s),
      // an unavailable knob reads as muted (a fact), a degraded one as a warning (a caveat).
      // `pbadge` paints BOTH the inlaid badge and the panel rows. The rail arrives already
      // colored cell-by-cell (green on / amber off / dim unsupported), so wrapping it in one
      // more role would put a color code in front of a string whose first cell immediately
      // resets it — the outer tint would apply to the gaps and nothing else. Identity there;
      // the badge fallback keeps its own tinting.
      badge: (s) =>
        panel
          ? s
          : status.effort && !status.effort.available
            ? p.muted(s)
            : status.effort?.degraded
              ? p.warn(s)
              : p.muted(s),
      // CLI-063: paint live `[Pasted text #N, L lines]` chips in accent so they read as tokens,
      // not typed text (ANSI is zero-width → the caret math upstream is unaffected).
      text: (s) => {
        const ids = new Set(state.pastes.map((x) => x.id));
        if (ids.size === 0) return p.plain(s);
        return s
          .split(/(\[Pasted text #\d+, \d+ lines?\])/)
          .map((part) => {
            const m = part.match(/^\[Pasted text #(\d+), \d+ lines?\]$/);
            return m && ids.has(Number(m[1])) ? p.accent(part) : p.plain(part);
          })
          .join("");
      },
    },
  });
  const boxTop = lines.length;
  lines.push(...composer.lines);

  // ── status lines (below the box) — state.permMode is the single source of truth ── //
  lines.push(
    ...statusLines(
      { ...status, permMode: state.permMode, activePane: state.activePane },
      width,
      caps,
    ),
  );

  return {
    lines,
    cursorRow: boxTop + composer.cursorRow,
    cursorCol: composer.cursorCol,
    // text body starts after `│ ` + the 2-cell gutter → column 4 (0-based); wrap width = width-6.
    box: { firstBodyRow: boxTop + 1, textLeft: 4, textWidth: Math.max(1, width - 6) },
    // A panel row is laid out as `│ <content> │`, so its content starts at column 2 — two
    // columns left of the text body, which carries the extra 2-cell prompt gutter.
    ...(panel && composer.panelRow !== undefined
      ? {
          rail: {
            row: boxTop + composer.panelRow,
            textLeft: 2,
            spans: traitRailSpans(cells),
          },
        }
      : {}),
  };
}

/* ── in-TUI modal repaint (CLI-064) ──────────────────────────────────────────── */

/** A live confirm/ask modal's paint state (updated as the user types) — the resize repaint and
 *  the first paint share this ONE pure renderer so a SIGWINCH never loses the prompt. */
export interface ModalView {
  kind: "confirm" | "ask";
  /** the prompt text (no prefix/suffix). */
  prompt: string;
  /** the user's typed buffer (ask only; "" for confirm). */
  buffer: string;
  /** the caret as a GRAPHEME index into `buffer` (CLI-065); defaults to end. Confirm ignores it. */
  caret: number;
  /** an optional dim hint row below the prompt (CLI-066 Tab-completion candidates). */
  hint?: string;
}

/**
 * Apply an editing key to an ask modal's buffer + caret (CLI-065), grapheme- and caret-aware:
 * left/right move by one grapheme, home/end jump, backspace/delete remove the whole grapheme
 * (a CJK char or ZWJ emoji cluster is ONE unit), a char/paste splices at the caret. Non-editing
 * keys return the modal unchanged. PURE — the app repaints from the returned record.
 */
export function applyModalKey(modal: ModalView, key: { name: string; ch?: string }): ModalView {
  const g = splitGraphemes(modal.buffer);
  const caret = Math.max(0, Math.min(modal.caret, g.length));
  const splice = (ins: string): ModalView => {
    const insG = splitGraphemes(ins);
    return {
      ...modal,
      buffer: [...g.slice(0, caret), ...insG, ...g.slice(caret)].join(""),
      caret: caret + insG.length,
    };
  };
  switch (key.name) {
    case "left":
      return { ...modal, caret: Math.max(0, caret - 1) };
    case "right":
      return { ...modal, caret: Math.min(g.length, caret + 1) };
    case "home":
      return { ...modal, caret: 0 };
    case "end":
      return { ...modal, caret: g.length };
    case "backspace":
      return caret === 0
        ? modal
        : {
            ...modal,
            buffer: [...g.slice(0, caret - 1), ...g.slice(caret)].join(""),
            caret: caret - 1,
          };
    case "delete":
      return caret >= g.length
        ? modal
        : { ...modal, buffer: [...g.slice(0, caret), ...g.slice(caret + 1)].join(""), caret };
    case "char":
      return key.ch ? splice(key.ch) : modal;
    case "paste":
      return key.ch ? splice(key.ch.replace(/[\r\n]/g, " ")) : modal;
    default:
      return modal;
  }
}

/** The DISPLAY cursor column for a modal (CLI-065): prefix + prompt + a space + text-before-caret,
 *  measured in columns (a 2-cell CJK glyph advances 2). Confirm parks after `[y/N]`. */
export function modalCursorCol(modal: ModalView): number {
  const prefix = modal.kind === "confirm" ? "? " : "› ";
  if (modal.kind === "confirm") return stringWidth(`${prefix}${modal.prompt} [y/N]`);
  const before = graphemeSlice(modal.buffer, 0, modal.caret);
  return stringWidth(`${prefix}${modal.prompt} ${before}`);
}

/**
 * Render a modal to width-clamped, painted lines (CLI-064): `? <prompt> [y/N]` (confirm, warn) or
 * `› <prompt> <buffer>` (ask, question). Word-wrapped to `width-1` (dodges the last-column
 * autowrap) so the prompt is FULLY visible at any width and each line never exceeds the terminal.
 */
export function renderModal(modal: ModalView, width: number, caps: ColorCaps): string[] {
  const w = Math.max(8, width - 1);
  const prefix = modal.kind === "confirm" ? "? " : "› ";
  const suffix = modal.kind === "confirm" ? " [y/N]" : modal.buffer ? ` ${modal.buffer}` : "";
  const role = modal.kind === "confirm" ? "warn" : "question";
  const plain = `${prefix}${modal.prompt}${suffix}`;
  const wrapped = plain === "" ? [""] : wrapLine(plain, w);
  const lines = wrapped.map((l) => paint(l, role, caps));
  // CLI-066: a dim candidate hint row below the prompt (Tab-completion), width-clamped.
  if (modal.hint) lines.push(paint(clipToWidth(modal.hint, w), "muted", caps));
  return lines;
}
