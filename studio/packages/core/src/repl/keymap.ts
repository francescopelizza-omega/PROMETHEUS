// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * repl/keymap.ts — the §7 keybinding table as data (PURE).
 *
 * The Ink raw-mode handler reads this table to map a key (in a context) to an
 * action. Keeping it data lets it be unit-tested + shown in /help, and keeps the
 * view layer dumb.
 */
export type KeyContext = "input" | "pane" | "global" | "confirm";

export type KeyAction =
  | "send"
  | "newline"
  | "slash-palette"
  | "history-prev"
  | "history-next"
  | "autocomplete"
  | "back-to-transcript"
  | "cycle-panes"
  | "refresh-pane"
  | "clear-transcript"
  | "toggle-tools"
  | "quit"
  | "save"
  | "approve"
  | "decline"
  | "back-from-pane";

export interface KeyBinding {
  key: string;
  context: KeyContext;
  action: KeyAction;
}

/** The §7 keymap. */
export const KEYMAP: readonly KeyBinding[] = Object.freeze([
  { key: "Enter", context: "input", action: "send" },
  { key: "Shift+Enter", context: "input", action: "newline" },
  { key: "/", context: "input", action: "slash-palette" },
  { key: "ArrowUp", context: "input", action: "history-prev" },
  { key: "ArrowDown", context: "input", action: "history-next" },
  { key: "Tab", context: "input", action: "autocomplete" },
  { key: "Escape", context: "pane", action: "back-to-transcript" },
  { key: "Ctrl+G", context: "global", action: "cycle-panes" },
  { key: "Ctrl+R", context: "pane", action: "refresh-pane" },
  { key: "Ctrl+L", context: "global", action: "clear-transcript" },
  { key: "Ctrl+T", context: "global", action: "toggle-tools" },
  { key: "Ctrl+D", context: "global", action: "quit" },
  { key: "Ctrl+C", context: "global", action: "quit" },
  { key: "Ctrl+S", context: "input", action: "save" },
  { key: "y", context: "confirm", action: "approve" },
  { key: "n", context: "confirm", action: "decline" },
  { key: "q", context: "pane", action: "back-from-pane" },
]);

/** Resolve the action for a key in a context (undefined if unbound). */
export function actionFor(key: string, context: KeyContext): KeyAction | undefined {
  return KEYMAP.find((b) => b.key === key && b.context === context)?.action;
}
