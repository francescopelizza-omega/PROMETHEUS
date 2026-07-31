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
 * Emitted once on enter: bracketed paste on · autowrap off (our region) · cursor hidden · SGR mouse
 * tracking on (CLI-069: `?1000h` button events THEN `?1006h` SGR extended coords — order matters;
 * `?1003h` any-motion is deliberately NOT enabled, it floods stdin). Best-effort — an emulator
 * without SGR mouse (macOS Terminal.app) silently ignores it, no garbage. Hold Shift for native
 * OS text-selection (the emulator bypasses tracking then — emulator behavior, not ours).
 */
export const ENTER_TUI = `${ESC}[?2004h${ESC}[?7l${ESC}[?25l${ESC}[?1000h${ESC}[?1006h`;
/** The idempotent restore (wired to every exit/signal/crash path) — mouse OFF in reverse order so
 *  a killed TUI never leaves the parent shell emitting click garbage. */
export const RESTORE_TUI = `${ESC}[?1006l${ESC}[?1000l${ESC}[?2004l${ESC}[?7h${ESC}[?25h${ESC}[0m`;

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
  return `${cursorUp(Math.max(0, fromRow))}\r${ESC}[0J`;
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

  /** Repaint the chrome in place. */
  paint(frame: Frame): void {
    this.write(composePaint(this.parkedRow, frame));
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
