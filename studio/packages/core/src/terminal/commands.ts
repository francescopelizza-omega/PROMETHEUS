// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * terminal/commands.ts — the terminal command-id catalog (file 13 §1.8).
 *
 * The bindable command ids the terminal launcher contributes. These COMPOSE the
 * product's one binding surface (07 §8): the Keymap UI (§2.2) binds them, the Command
 * Palette lists them, and `prometheus` ([[11]]) can mirror `runPrompt`/`runActiveFile`. They
 * are NOT engine subcommands — they never enter the frozen `COMMAND_SPECS` (commands.ts)
 * and never bypass the run-gate. Pure DATA: id + title + default keys + a `when` context
 * expr (evaluated by 07's `evaluateWhen`).
 */

/** A bindable IDE command (file 13 §1.8 / §2.2). */
export interface IdeCommand {
  id: string;
  title: string;
  category: string;
  /** the default key for the shipped presets (the keymap may override). */
  defaultKeys?: string;
  /** context-key expr (07 §8): only active/visible when it evaluates true. */
  when?: string;
  /** true ⇒ this flow can write into the user's interactive terminal (§1.6 safety note). */
  writesToTerminal?: boolean;
}

function cmd(
  id: string,
  title: string,
  defaultKeys?: string,
  over: Partial<IdeCommand> = {},
): IdeCommand {
  return { id, title, category: "Terminal", ...(defaultKeys ? { defaultKeys } : {}), ...over };
}

/** The §1.8 terminal commands (added to the one binding surface, 07 §8). */
export const TERMINAL_COMMANDS: readonly IdeCommand[] = Object.freeze([
  cmd("terminal.new", "New terminal", "ctrl+`"),
  cmd("terminal.split.right", "Split terminal right"),
  cmd("terminal.split.down", "Split terminal down"),
  cmd("terminal.kill", "Kill terminal"),
  cmd("terminal.maximize", "Maximize terminal panel"),
  cmd("terminal.float", "Float terminal (own window)"),
  cmd("terminal.rename", "Rename terminal"),
  cmd("terminal.clear", "Clear terminal", "ctrl+l"),
  cmd("terminal.broadcast.toggle", "Toggle broadcast to all"),
  cmd("terminal.selectProfile", "Select terminal profile…"),
  cmd("terminal.runAiPreset", "Run AI preset…"),
  cmd("terminal.next", "Next terminal"),
  cmd("terminal.prev", "Previous terminal"),
  cmd("terminal.focus", "Focus terminal"),
  // read-in-editor → run-in-terminal flows (§1.6). These write into the user's shell
  // ONLY for explicit user actions; the AI agent never types silently (§1.6 security note).
  cmd("terminal.sendSelection", "Send selection to terminal", undefined, {
    category: "Terminal",
    when: "editorTextFocus",
    writesToTerminal: true,
  }),
  cmd("terminal.runActiveFile", "Run active file", undefined, {
    when: "editorFocus",
    writesToTerminal: true,
  }),
  cmd("terminal.runLine", "Run line / cell", undefined, {
    when: "editorTextFocus",
    writesToTerminal: true,
  }),
  cmd("terminal.runPrompt", "Run prompt (AI)", "alt+enter", {
    when: "editorTextFocus",
    writesToTerminal: true,
  }),
  cmd("terminal.openHere", "Open terminal here", undefined, {
    when: "explorerFocus || editorFocus",
  }),
]);

/** Look up a terminal command by id. */
export function getTerminalCommand(id: string): IdeCommand | undefined {
  return TERMINAL_COMMANDS.find((c) => c.id === id);
}

/**
 * The §1.6 read→run flows, in order. Each is a registry id so `prometheus` + the keymap bind
 * them; the headline is `terminal.runPrompt` (selection → an AI-preset terminal).
 */
export const READ_TO_RUN_FLOWS: readonly string[] = Object.freeze([
  "terminal.sendSelection",
  "terminal.runActiveFile",
  "terminal.runLine",
  "terminal.runPrompt",
  "terminal.openHere",
]);
