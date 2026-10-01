// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/editor-commands.ts — PyCharm-signature editor-core actions surfaced in the
 * command palette (plan file 01 · JetBrains "editor actions" parity).
 *
 * Each entry's `id` is a stock Monaco editor-action id. The palette dispatches the id
 * via the `ide:editor-action` event, which EditorPane runs on the focused editor
 * (`editor.getAction(id).run()`). Keeping this list PURE (no react/monaco) lets it be
 * spread into PALETTE_COMMANDS and node:test-ed independently. Monaco already binds the
 * default keys for these (e.g. Shift+Alt+→ expand); the palette adds discoverability +
 * JetBrains-labelled names.
 */

export interface EditorActionCommand {
  /** a stock Monaco editor-action id (or an allowlisted core-command id below). */
  id: string;
  title: string;
  category: string;
}

/** Monaco CORE-command ids (not "editor.action."-prefixed actions) we surface — these
 *  have no IEditorAction wrapper, so EditorPane runs them via editor.trigger(). */
export const MONACO_CORE_COMMAND_IDS: ReadonlySet<string> = new Set([
  "cursorUndo", // multi-caret parity (APP-018): "undo last caret" (⌘U in VS Code)
  "cursorColumnSelectUp",
  "cursorColumnSelectDown",
  "cursorColumnSelectLeft",
  "cursorColumnSelectRight",
]);

/** Monaco FOLD actions (APP-074) — run via `editor.getAction()` like `editor.action.*`, but
 *  their ids lack the `editor.action.` prefix, so they're allowlisted explicitly. */
export const EDITOR_FOLD_ACTION_IDS: ReadonlySet<string> = new Set([
  "editor.foldAll",
  "editor.unfoldAll",
  "editor.foldRecursively",
  "editor.unfoldRecursively",
]);

/** Does this id route to the focused Monaco editor via `ide:editor-action`?
 *  (a stock editor-action id, a fold action, or an allowlisted trigger-only core command). */
export function isEditorActionId(id: string): boolean {
  return (
    id.startsWith("editor.action.") ||
    EDITOR_FOLD_ACTION_IDS.has(id) ||
    MONACO_CORE_COMMAND_IDS.has(id)
  );
}

/**
 * The curated PyCharm-parity editor actions. Every id is a real Monaco built-in
 * (unknown ids would simply no-op via getAction → null, never crash), but this list is
 * pinned + tested so the palette surface stays intentional.
 */
export const EDITOR_ACTION_COMMANDS: readonly EditorActionCommand[] = [
  { id: "editor.action.smartSelect.expand", title: "Extend Selection", category: "Edit" },
  { id: "editor.action.smartSelect.shrink", title: "Shrink Selection", category: "Edit" },
  { id: "editor.action.joinLines", title: "Join Lines", category: "Edit" },
  {
    id: "editor.action.copyLinesDownAction",
    title: "Duplicate Line or Selection",
    category: "Edit",
  },
  { id: "editor.action.deleteLines", title: "Delete Line", category: "Edit" },
  { id: "editor.action.moveLinesUpAction", title: "Move Line Up", category: "Edit" },
  { id: "editor.action.moveLinesDownAction", title: "Move Line Down", category: "Edit" },
  { id: "editor.action.indentLines", title: "Indent Line", category: "Edit" },
  { id: "editor.action.outdentLines", title: "Unindent Line", category: "Edit" },
  { id: "editor.action.commentLine", title: "Toggle Line Comment", category: "Edit" },
  { id: "editor.action.blockComment", title: "Toggle Block Comment", category: "Edit" },
  { id: "editor.action.sortLinesAscending", title: "Sort Lines Ascending", category: "Edit" },
  { id: "editor.action.transformToUppercase", title: "To Uppercase", category: "Edit" },
  { id: "editor.action.transformToLowercase", title: "To Lowercase", category: "Edit" },
  {
    id: "editor.action.addSelectionToNextFindMatch",
    title: "Add Caret to Next Occurrence",
    category: "Edit",
  },
  // multi-caret + column selection (APP-018 · plan file 01). All Monaco built-ins:
  // the ⌥⌘↑/↓, ⌘D, ⇧⌥⌘-arrows and ⌥⇧-drag default chords come with them for free.
  { id: "editor.action.insertCursorAbove", title: "Add Caret Above", category: "Edit" },
  { id: "editor.action.insertCursorBelow", title: "Add Caret Below", category: "Edit" },
  { id: "editor.action.selectHighlights", title: "Select All Occurrences", category: "Edit" },
  { id: "cursorUndo", title: "Undo Last Caret", category: "Edit" },
  // folding (APP-074) — Monaco built-in fold actions (⌘K ⌘0 fold-all · ⌘K ⌘J unfold-all).
  { id: "editor.foldAll", title: "Fold All", category: "Fold" },
  { id: "editor.unfoldAll", title: "Unfold All", category: "Fold" },
  { id: "editor.foldRecursively", title: "Fold Recursively", category: "Fold" },
];
