// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/pending-line.ts — empty readline's half-typed line before a question it must not pre-fill.
 *
 * Keys typed without Return while a slash command ran sit in readline's line buffer, and
 * `rl.question` keeps that buffer: a stray "y", then the Return meant as "no", reads as yes. For
 * a question whose yes authorises installs ("update everything"), that buffer is emptied first.
 *
 * It is cleared by writing the fields directly rather than by sending ctrl-e/ctrl-u: under
 * TERM=dumb node's readline swaps in a key handler that ignores both, so the keypress route
 * silently does nothing there — while a note on screen says the keys were discarded.
 */

/** The slice of node:readline's `Interface` this touches: its public `line` and `cursor`. */
export interface LineBuffer {
  line?: unknown;
  cursor?: unknown;
}

/** What happened to the pending line: nothing was there, it is gone, or it could not be cleared. */
export type PendingLine = "none" | "discarded" | "stuck";

/**
 * Empty a readline's pending input. "stuck" means the buffer refused the write — the caller must
 * then not ask at all, because the answer would start with whatever is still in it.
 */
export function discardPendingLine(rl: LineBuffer): PendingLine {
  if (typeof rl.line !== "string" || rl.line === "") return "none";
  try {
    rl.line = "";
    rl.cursor = 0;
  } catch {
    /* a buffer that refuses the write — reported below */
  }
  return rl.line === "" ? "discarded" : "stuck";
}
