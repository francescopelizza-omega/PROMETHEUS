// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/docs-tutorials.ts — the in-app getting-started tutorials (APP-099). Pure static data
 * (no fetch, no remote markdown) so it stays node:test-able and can't leak. A step may deep-link
 * to a palette command via `commandId`; a shape test asserts every `commandId` resolves against
 * SHELL_COMMANDS, so a renamed command breaks CI instead of shipping a dead link.
 */

/** One tutorial step. `commandId`, when present, is a SHELL_COMMANDS id the "run" affordance
 *  dispatches through the same executor the palette uses. */
export interface TutorialStep {
  text: string;
  commandId?: string;
}

/** A short, ordered how-to. */
export interface Tutorial {
  id: string;
  title: string;
  summary: string;
  steps: TutorialStep[];
}

export const TUTORIALS: readonly Tutorial[] = [
  {
    id: "getting-started",
    title: "Getting started",
    summary: "Find your way around: the command palette is the fastest path to everything.",
    steps: [
      {
        text: "Open the command palette to search every action by name.",
        commandId: "view.commandPalette",
      },
      {
        text: "Toggle the side bar to show or hide the explorer/search/git panels.",
        commandId: "view.toggleSidebar",
      },
      {
        text: "Toggle the bottom panel for the terminal, problems, and database tabs.",
        commandId: "view.toggleBottomPanel",
      },
      {
        text: "Open Settings to pick a theme, keymap preset, and AI providers.",
        commandId: "workbench.openSettings",
      },
    ],
  },
  {
    id: "editor-basics",
    title: "Open a project + editor basics",
    summary:
      "Open a folder, jump around a file, and read documentation without leaving the editor.",
    steps: [
      { text: "Open a project folder from the Explorer to scope search, git, and runs to it." },
      {
        text: "Jump to any symbol in the current file with the File Structure popup (⌘F12).",
        commandId: "structure.filePopup",
      },
      { text: "Press ⌘J on a symbol for pinned Quick Documentation.", commandId: "docs.quickDoc" },
      { text: "Find text across the whole project.", commandId: "search.findInFiles" },
      { text: "Format the current document.", commandId: "editor.action.formatDocument" },
    ],
  },
  {
    id: "ai-chat",
    title: "AI chat + the agent gate",
    summary:
      "Use inline edits and the agent pane — every tool call passes the security gate first.",
    steps: [
      {
        text: "Select code and run an AI inline edit; the diff is one undoable step.",
        commandId: "ai.inlineEdit",
      },
      { text: "Attach the current selection as chat context, then ask the agent to change it." },
      {
        text: "Agent tool calls are gated by nemesis — you approve anything risky before it runs.",
      },
    ],
  },
  {
    id: "terminal-run",
    title: "Terminal + running things",
    summary: "Run tasks, configs, and one-off commands from the keyboard.",
    steps: [
      {
        text: "Open the bottom panel and switch to the Terminal tab.",
        commandId: "view.toggleBottomPanel",
      },
      {
        text: "Run Anything: fuzzy-launch a run configuration or a shell command.",
        commandId: "run.anything",
      },
      { text: "Start the active run/debug configuration.", commandId: "run.config" },
      { text: "Stop a running session.", commandId: "run.stop" },
    ],
  },
  {
    id: "security-scan",
    title: "Security scan",
    summary: "Scan the workspace and read the nemesis verdict before you trust anything.",
    steps: [
      {
        text: "Open the Security panel to review the latest scan verdict.",
        commandId: "panel.security",
      },
      {
        text: "Check the token-economy panel to see what a request would cost.",
        commandId: "panel.tokens",
      },
      {
        text: "Review workspace health (migrations, resilience, environment).",
        commandId: "panel.health",
      },
    ],
  },
  {
    id: "commit-history",
    title: "Commit + local history",
    summary: "Commit with an AI message and recover earlier versions of a file.",
    steps: [
      { text: "Stage and commit changes from the Source Control panel.", commandId: "git.commit" },
      {
        text: "Open Local History for the active file to recover an earlier version.",
        commandId: "history.show",
      },
      { text: "Bookmark a line to jump back to it later.", commandId: "bookmarks.show" },
    ],
  },
];
