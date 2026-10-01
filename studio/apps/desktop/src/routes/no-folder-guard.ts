// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/no-folder-guard.ts — the "no folder open" decisions for the editor route (APP-073).
 *
 * PURE (node:test-able). `workspaceRoot` is `null` until the user opens a real folder (no more
 * `"."` demo shim), so nothing in the sidebar ever fs-lists the Electron process CWD. These
 * helpers centralize the "is a folder open?" test + the terminal's home-fallback cwd.
 */

/** True when a real workspace folder is open (a non-empty, non-"." absolute path). */
export function hasFolderOpen(root: string | null): boolean {
  return typeof root === "string" && root !== "" && root !== ".";
}

/** Show the Open-Folder empty-state prompt exactly when no folder is open. */
export function shouldPromptOpenFolder(root: string | null): boolean {
  return !hasFolderOpen(root);
}

/**
 * The cwd to hand the terminal. An open folder → that folder; otherwise "" — the MAIN pty-host
 * resolves an empty cwd to `os.homedir()` (never the app-bundle process cwd). We never pass "."
 * or a tilde (node-pty won't expand `~`).
 */
export function terminalCwd(root: string | null): string {
  return hasFolderOpen(root) ? (root as string) : "";
}
