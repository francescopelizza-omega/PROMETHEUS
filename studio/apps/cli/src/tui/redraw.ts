// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tui/redraw.ts — the inline (no-alt-screen) repaint engine.
 *
 * The chrome lives at the BOTTOM of native scrollback; all cursor motion is RELATIVE.
 * After a paint the real cursor is PARKED AT THE CARET (mid-block, for IME/visibility),
 * NOT at the bottom of the block — so the next repaint must move up by exactly the
 * caret's row-within-block to reach the top, erase, and redraw. Getting that offset
 * wrong erases scrollback ABOVE the chrome. The cursor math is therefore isolated here
 * as PURE builders (`composePaint`/`moveToTop`) that are unit-tested; `Renderer` is the
 * thin stateful wrapper that tracks the parked caret row across frames.
 */
import type { Frame } from "./frame.js";

const ESC = "\x1b";

/**
 * Emitted once on enter: bracketed paste on · autowrap off (our region) · cursor hidden.
 *
 * SGR mouse tracking (`?1000h`/`?1006h`) is DELIBERATELY NOT enabled: it makes the emulator
 * capture the mouse for the app, which BLOCKS native click-drag text selection / copy of
 * Prometheus output — the one thing users need most in a terminal. The mouse only powered
 * click-to-position-caret + wheel dropdown scroll, both of which the keyboard already covers.
 * Native selection now works everywhere with no Shift/Option-drag workaround.
 */
export const ENTER_TUI = `${ESC}[?2004h${ESC}[?7l${ESC}[?25l`;

/** OSC 11 — force the terminal background to pure black (#000000) while prometheus runs, so the
 *  vivid Pelly output stays at maximum contrast. Restored to the terminal default on exit
 *  (`BG_RESET`, OSC 111). Emitted ONLY when color is on (NO_COLOR / piped leaves it alone). */
export const BG_BLACK = `${ESC}]11;#000000\x07`;
export const BG_RESET = `${ESC}]111\x07`;
/** The idempotent restore (wired to every exit/signal/crash path) — mouse OFF in reverse order so
 *  a killed TUI never leaves the parent shell emitting click garbage. */
export const RESTORE_TUI = `${ESC}[?1006l${ESC}[?1000l${ESC}[?2004l${ESC}[?7h${ESC}[?25h${ESC}[0m`;

/**
 * DECAWM (autowrap) OFF — set once in `ENTER_TUI`, and RE-ASSERTED on every repaint below.
 *
 * Once was not enough, and the whole redraw rests on it. The invariant is
 * `lines.length === physical rows`: a repaint moves the cursor up by exactly the parked caret
 * row to reach the block top. One chrome line that WRAPS makes the block a row taller than the
 * renderer believes, the cursor-up lands a row short of the top, `ESC[0J` erases from there
 * down, and the top border is stranded above — one orphan `╭────╮` per repaint, which is
 * exactly what the reported screenshot shows.
 *
 * Anything can turn autowrap back on mid-session: a child process that emits its own reset, a
 * pager or $EDITOR sharing the tty, a terminal restoring defaults, or model output streamed
 * verbatim into scrollback that happens to contain `ESC[?7h` — the agent writes into the same
 * terminal, and its text is not sanitised.
 *
 * Four bytes per paint buys the invariant back unconditionally. With autowrap off, a line that
 * is one column too wide — a glyph the width table measures as 1 and the font paints as 2 — is
 * one clipped cell, not an extra row, so the cursor math cannot drift.
 */
const WRAP_OFF = `${ESC}[?7l`;

/** CUU — cursor up `n` rows (0 is a no-op; many terminals treat `[0A` as `[1A`). */
export function cursorUp(n: number): string {
  return n > 0 ? `${ESC}[${n}A` : "";
}
/** CUF — cursor right `n` cols (0 is a no-op). */
export function cursorRight(n: number): string {
  return n > 0 ? `${ESC}[${n}C` : "";
}

/**
 * Move the cursor from its PARKED position (caret row `fromRow` within the block) to
 * the block's top-left and erase to end of screen — the start of every repaint.
 */
export function moveToTop(fromRow: number): string {
  return `${WRAP_OFF}${cursorUp(Math.max(0, fromRow))}\r${ESC}[0J`;
}

/**
 * Extra rows to climb past when the terminal has just been made NARROWER.
 *
 * `onResize` used to repaint straight through `paint()`, on the stated assumption that the old
 * block "is wiped cleanly at the new width — no reset(), no debris" because autowrap was off so
 * nothing had reflowed. That assumption does not hold on the two emulators this is used from:
 * Terminal.app and iTerm2 both REWRAP the buffer when the window narrows, whatever DECAWM said
 * when the text was written. A chrome line built at the old `cols-1` no longer fits, so it
 * becomes two physical rows, every row above the caret shifts, and the cursor-up lands short of
 * the block top. `ESC[0J` then erases from below the top border and leaves it stranded — one
 * orphan per resize. That is what the reported screenshot is: a single 359-column logical line
 * holding FOUR `╭` runs of 133, 105, 2 and 119 columns, the last being the live border and the
 * first two the `cols-1` budgets for widths the window had passed through (134 and 106).
 *
 * Takes the DISPLAY WIDTHS of the rows above the caret, not a count and a nominal width: a line
 * of `w` columns occupies `ceil(w / cols)` rows after the rewrap, and rows that still fit are
 * untouched. Measuring each one matters because the block is not uniform — the key-hint row and
 * a short dropdown entry are well under the box's full width, and charging them for a rewrap
 * they did not have would climb past the block and erase live transcript above it.
 *
 * Zero whenever nothing was too wide, which is every widening and every shrink small enough to
 * leave the block intact.
 */
export function reflowSlack(rowWidths: readonly number[], cols: number): number {
  if (cols <= 0) return 0;
  let extra = 0;
  for (const w of rowWidths) if (w > cols) extra += Math.ceil(w / cols) - 1;
  return extra;
}

/**
 * Build the full repaint string. `parkedRow` is where the cursor currently sits (the
 * caret row of the PREVIOUS frame, 0 before the first paint). Hides the cursor, moves
 * to the block top, erases, writes the block, then parks + shows the caret at its new
 * row/col. Every line must already be styled + ≤ cols-1 columns.
 */
export function composePaint(parkedRow: number, frame: Frame): string {
  const rows = frame.lines.length;
  const body = frame.lines.join("\r\n");
  const caretRow = Math.max(0, Math.min(frame.cursorRow, rows - 1));
  // after writing, the cursor sits at the END of the LAST line (row rows-1).
  const upToCaret = rows - 1 - caretRow;
  const place = `${cursorUp(upToCaret)}\r${cursorRight(Math.max(0, frame.cursorCol))}`;
  return `${ESC}[?25l${moveToTop(parkedRow)}${body}${place}${ESC}[?25h`;
}

/** Strip the embedded carriage returns from a "print above" line so it can't desync rows. */
function oneLine(s: string): string {
  return s.replace(/\r/g, "");
}

/** The thin stateful writer: tracks where the caret was parked for the next repaint. */
export class Renderer {
  /** the caret row of the last painted frame (0 = no block / cursor at block top). */
  private parkedRow = 0;
  private readonly write: (s: string) => void;

  constructor(write: (s: string) => void) {
    this.write = write;
  }

  /**
   * Repaint the chrome in place.
   *
   * `slack` is extra rows to climb before erasing, for the one case where the parked row is a
   * count the terminal no longer agrees with: a narrowing resize that rewrapped the block under
   * us (see `reflowSlack`). It defaults to 0, so every ordinary repaint is unchanged.
   */
  paint(frame: Frame, slack = 0): void {
    this.write(composePaint(this.parkedRow + Math.max(0, slack), frame));
    this.parkedRow = Math.max(0, Math.min(frame.cursorRow, frame.lines.length - 1));
  }

  /**
   * Print line(s) ABOVE the chrome (agent output / notices): move to the block top,
   * erase it, write the text into scrollback, and reset so the next paint() redraws
   * below it.
   */
  printAbove(text: string): void {
    const lines = text.split("\n").map(oneLine);
    this.write(`${moveToTop(this.parkedRow)}${lines.join("\r\n")}\r\n`);
    this.parkedRow = 0;
  }

  /**
   * Paint a single transient line IN PLACE at the parked position (the live "working…"
   * spinner). Erases from the parked row to end of screen, writes the one line, and keeps
   * the parked row at 0 so the next transient/printAbove overwrites it — no scrollback growth.
   */
  transient(line: string): void {
    this.write(`${ESC}[?25l${moveToTop(this.parkedRow)}${oneLine(line)}${ESC}[?25h`);
    this.parkedRow = 0;
  }

  /** Erase the chrome entirely (on exit, before the final restore). */
  clear(): void {
    this.write(moveToTop(this.parkedRow));
    this.parkedRow = 0;
  }

  /** Reset the tracked position (after an external write the renderer didn't make). */
  reset(): void {
    this.parkedRow = 0;
  }
}
