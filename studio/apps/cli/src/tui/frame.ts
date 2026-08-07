import { renderDropdown } from "./autocomplete.js";
import { layoutComposer, reverseSearchLine } from "./input-box.js";
import { renderInvokeOverlay } from "./invoke-overlay.js";
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
import { type ColorCaps, paint, painter } from "./palette.js";
import type { TuiState } from "./reducer.js";
import { type StatusModel, effortBadge, statusLines } from "./status.js";
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
  // keep the whole block within `rows`: box≈3, status≈3 → cap the dropdown.
  const dropCap = Math.max(1, Math.min(8, rows - 7));
  const dropdown = renderDropdown(state.ac, width, caps, { maxRows: dropCap });
  lines.push(...dropdown);

  // ── /invoke overlay (CLI-059) — modal, above the box; clamps to the free rows ─── //
  if (state.invokeOverlay) {
    const ovRows = Math.max(4, rows - 5);
    lines.push(...renderInvokeOverlay(state.invokeOverlay, width, ovRows, caps));
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

  // ── composer box (red border in bypass / yolo mode) ──────────────────────── //
  const borderRole =
    state.permMode === "bypassPermissions" || state.permMode === "yolo" ? "danger" : "accent";
  const boxMaxRows = Math.max(1, Math.min(8, rows - dropdown.length - 4));
  // Reasoning-effort state rides in the composer's own bottom border rather than the status
  // bar: it changes when the MODEL changes, and the border of the box you are typing into is
  // the one piece of chrome that cannot be scrolled away or lost in a dense chip row.
  const badge = effortBadge(status);
  const composer = layoutComposer(state.input, state.cursor, width, {
    prompt: "›",
    placeholder: input.placeholder ?? DEFAULT_PLACEHOLDER,
    maxRows: boxMaxRows,
    ...(badge ? { badge } : {}),
    paint: {
      border: (s) => p[borderRole](s),
      prompt: (s) => p.brand(s),
      placeholder: (s) => p.muted(s),
      // an unavailable knob reads as muted (a fact), a degraded one as a warning (a caveat).
      badge: (s) =>
        status.effort && !status.effort.available
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
