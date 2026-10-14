// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tui/terminal-handover.ts — lend the real terminal to a child, then take it back, safely.
 *
 * Used around the privileged gate's sudo (which reads its password from the TTY itself) by
 * both the TUI and the readline host. One rule matters beyond the bookkeeping: if the session
 * ENDED while the terminal was lent out, taking it back must do nothing. Ctrl+C in cooked mode
 * is SIGINT to the whole foreground group — the app restores the terminal and finishes, and
 * only THEN does the killed child's close arrive and ask for the terminal back. Re-entering raw
 * mode and re-listening on stdin at that point kept a finished session alive forever, with a
 * raw, cursor-less terminal the user had to kill and `reset` from elsewhere.
 */
export interface HandoverTerminal {
  /** the session still owns this terminal (it has not finished or closed its input) */
  isLive(): boolean;
  /** leave raw mode, stop reading stdin, restore the terminal's own modes */
  giveAway(): void;
  /** raw mode, the input listener, the session's modes, a repaint */
  takeBack(): void;
}

export interface Handover {
  readonly suspended: boolean;
  suspend(): void;
  resume(): void;
}

export function createHandover(t: HandoverTerminal): Handover {
  let suspended = false;
  return {
    get suspended() {
      return suspended;
    },
    suspend() {
      if (suspended || !t.isLive()) return;
      suspended = true;
      t.giveAway();
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      if (!t.isLive()) return;
      t.takeBack();
    },
  };
}
