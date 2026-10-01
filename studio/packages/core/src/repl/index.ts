// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * repl/index.ts — the REPL brain barrel (file 11 §3/§7).
 *
 * Slash registry + parser, pane model + cycle, the tuning footer, the §7 keymap, and
 * the REPL state reducer. All PURE (no ink/react) — apps/cli's Ink view binds these.
 */
export type { SlashCommand, ParsedInput } from "./slash.js";
export { SLASH_COMMANDS, TUNING_SLASHES, parseSlash, knownSlash, getSlash } from "./slash.js";
export type { PaneId } from "./panes.js";
export { PANE_CYCLE, cyclePane } from "./panes.js";
export { modelLabel, footerLine } from "./footer.js";
export type { KeyContext, KeyAction, KeyBinding } from "./keymap.js";
export { KEYMAP, actionFor } from "./keymap.js";
export type { ReplMessage, ReplState, ReplEvent } from "./state.js";
export { initialReplState, reduce, tuneFromSlash } from "./state.js";
