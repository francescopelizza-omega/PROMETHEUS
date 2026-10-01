// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/code-action-classify.ts — PURE LSP code-action → run classifier (APP-078).
 *
 * An edit-carrying action applies its WorkspaceEdit; a command-only action relays
 * `workspace/executeCommand`; an action with neither is skipped. DOM/monaco-free (node:test-ed).
 */

export type CodeActionRun =
  | { kind: "edit" }
  | { kind: "command"; command: string; arguments: unknown[] }
  | { kind: "skip" };

interface RawCodeAction {
  edit?: unknown;
  command?: { command?: unknown; arguments?: unknown } | unknown;
}

/**
 * Classify a code action:
 *   - has `.edit` → apply the WorkspaceEdit (existing path);
 *   - CodeAction with a `.command` object (or a bare `Command`) → `workspace/executeCommand`;
 *   - otherwise → skip (nothing runnable).
 */
export function classifyCodeAction(a: RawCodeAction | null | undefined): CodeActionRun {
  if (!a || typeof a !== "object") return { kind: "skip" };
  if (a.edit) return { kind: "edit" };
  const c = a.command as { command?: unknown; arguments?: unknown } | undefined;
  if (c && typeof c === "object" && typeof c.command === "string") {
    return {
      kind: "command",
      command: c.command,
      arguments: Array.isArray(c.arguments) ? c.arguments : [],
    };
  }
  return { kind: "skip" };
}
