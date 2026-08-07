/**
 * ide/state/palette-commands.ts — the PURE editor-palette command surface (APP-004).
 *
 * Split out of CommandPalette.tsx (JSX-free, node:test-able — the settings-view.ts
 * convention) so the exhaustiveness test can pin that EVERY id surfaced here is
 * actually handled by EditorRoute.runCommand — no entry may fall into its default.
 *
 * Ids mirror @prometheus/core's editor-command-registry EDITOR_COMMANDS (the single
 * source shared with `prometheus`) by convention. NOTE `ai.openAgent` is deliberately NOT
 * surfaced here (APP-004): in the editor route the agent pane is always mounted, so
 * the entry was a documented no-op. The id itself still exists in core EDITOR_COMMANDS
 * and the shell registry (where it toggles the right rail) — only this surfacing died.
 */

import { EDITOR_ACTION_COMMANDS } from "./editor-commands.js";

/** A palette command (id/title mirror @prometheus/core EDITOR_COMMANDS, §8). */
export interface PaletteCommand {
  id: string;
  title: string;
  category: string;
}

export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { id: "ai.inlineEdit", title: "AI: Inline Edit (Cmd-K)", category: "AI" },
  { id: "gate.runWorkspaceScan", title: "Security: Gate Workspace", category: "Security" },
  { id: "gate.showLog", title: "Security: Show Gate Log", category: "Security" },
  { id: "python.selectInterpreter", title: "Python: Select Interpreter", category: "Run" },
  { id: "models.selectEndpoint", title: "AI: Select Model Endpoint", category: "AI" },
  { id: "git.commit", title: "Git: Commit", category: "Git" },
  { id: "debug.start", title: "Run: Start Debugging", category: "Run" },
  { id: "search.findInFiles", title: "Search: Find in Files", category: "Edit" },
  { id: "editor.newScratchFile", title: "New Scratch File", category: "File" },
  { id: "editor.action.formatDocument", title: "Format Document", category: "Edit" },
  { id: "prometheus.scan", title: "Prometheus: Scan Agents", category: "Security" },
  { id: "prometheus.audit", title: "Prometheus: Audit Plugin", category: "Security" },
  // navigation history (plan 05) — dispatched by EditorRoute.runCommand.
  { id: "nav.back", title: "Navigate Back", category: "Go" },
  { id: "nav.forward", title: "Navigate Forward", category: "Go" },
  { id: "nav.lastEdit", title: "Last Edit Location", category: "Go" },
  { id: "nav.recent", title: "Recent Locations", category: "Go" },
  { id: "index.rebuild", title: "Rebuild Symbol Index", category: "Go" },
  // APP-075 — the Go-to family (plan 05).
  { id: "nav.goToLine", title: "Go to Line/Column (Cmd-G)", category: "Go" },
  { id: "nav.goToSuper", title: "Go to Super (Base Declaration)", category: "Go" },
  { id: "nav.relatedSymbol", title: "Related Symbol…", category: "Go" },
  // smart keys + column mode + paste-history (APP-018 · plan file 01) — dispatched by
  // EditorRoute.runCommand (window events the focused EditorPane group handles).
  { id: "editor.completeStatement", title: "Complete Current Statement", category: "Edit" },
  { id: "editor.smartEnter", title: "Smart Enter (new indented line)", category: "Edit" },
  { id: "editor.toggleColumnSelection", title: "Toggle Column Selection Mode", category: "Edit" },
  { id: "editor.pasteFromHistory", title: "Paste from History", category: "Edit" },
  { id: "editor.organizeImports", title: "Optimize Imports", category: "Edit" },
  // live/postfix/surround templates (APP-020) — Surround With wraps the selection via the
  // focused EditorPane group (window event); the editor also binds ⌘⌥T directly.
  { id: "editor.surroundWith", title: "Surround With…", category: "Edit" },
  // Find Usages (APP-023) — fan LSP references + grep fallback on the caret symbol into the
  // usages tool window (SearchPanel usages mode); the editor also binds ⌥F7 directly.
  { id: "usages.findUsages", title: "Find Usages", category: "Go" },
  // Refactor Preview (APP-027) — one action per APP-026 rope transform; each opens the
  // GATED preview dialog (file→edit tree, per-file include, Apply/Cancel) on the
  // focused editor's caret/selection. Dispatched via the `ide:refactor` window bus.
  { id: "refactor.rename", title: "Refactor: Rename Symbol (Python)", category: "Refactor" },
  {
    id: "refactor.extract",
    title: "Refactor: Extract Method/Variable (Python)",
    category: "Refactor",
  },
  { id: "refactor.inline", title: "Refactor: Inline Symbol (Python)", category: "Refactor" },
  { id: "refactor.move", title: "Refactor: Move to Module (Python)", category: "Refactor" },
  {
    id: "refactor.changeSignature",
    title: "Refactor: Change Signature (Python)",
    category: "Refactor",
  },
  { id: "refactor.safeDelete", title: "Refactor: Safe Delete (Python)", category: "Refactor" },
  // Generate menu (APP-028) — AST-derived member generators + core templates; every
  // action opens the SAME gated preview (transform table in state/generate-actions.ts,
  // dispatched over the `ide:refactor` window bus like the refactors above).
  { id: "generate.init", title: "Generate: __init__ (Python)", category: "Generate" },
  { id: "generate.repr", title: "Generate: __repr__ (Python)", category: "Generate" },
  { id: "generate.eq", title: "Generate: __eq__ (Python)", category: "Generate" },
  {
    id: "generate.dataclass",
    title: "Generate: Convert to @dataclass (Python)",
    category: "Generate",
  },
  { id: "generate.property", title: "Generate: Property + Setter (Python)", category: "Generate" },
  { id: "generate.override", title: "Generate: Override Method (Python)", category: "Generate" },
  { id: "generate.delegate", title: "Generate: Delegate Method (Python)", category: "Generate" },
  { id: "generate.docstring", title: "Generate: Docstring Stub (Python)", category: "Generate" },
  { id: "generate.newFile", title: "Generate: New File from Template", category: "Generate" },
  { id: "generate.copyright", title: "Generate: Insert Copyright Header", category: "Generate" },
  // Run toolbar + Run-Anything picker (APP-034) — ids namespaced run.* (the prometheus
  // CLI reserves plain `run`); dispatched by EditorRoute.runCommand.
  { id: "run.config", title: "Run: Selected Configuration", category: "Run" },
  { id: "run.debug", title: "Run: Debug Selected Configuration", category: "Run" },
  { id: "run.stop", title: "Run: Stop", category: "Run" },
  { id: "run.anything", title: "Run: Anything… (⌘⇧R)", category: "Run" },
  // bottom-panel openers — handled LOCALLY by EditorRoute.runCommand via the
  // onOpenShellPanel prop seam (APP-004); the shell registry handles them for ⌘K.
  { id: "panel.tokens", title: "Save tokens: Open toolkit", category: "View" },
  { id: "panel.health", title: "Health: Open panel", category: "View" },
  { id: "panel.metadata", title: "Metadata: Open panel", category: "View" },
  // PyCharm-signature editor-core actions (plan 01) — routed to the focused Monaco editor
  // via `ide:editor-action`. Pure + tested list in state/editor-commands.ts.
  ...EDITOR_ACTION_COMMANDS,
];

/**
 * Every non-Monaco id EditorRoute.runCommand handles with an explicit case — kept in
 * LOCKSTEP with the switch in routes/editor.tsx (same convention as PALETTE_COMMANDS
 * mirroring the core registry). palette-commands.test.ts asserts full coverage:
 * PALETTE_COMMANDS ⊆ isEditorActionId ∪ this set, so a new palette entry without a
 * dispatcher case fails the suite instead of dying in the default branch.
 */
export const EDITOR_DISPATCHED_IDS: ReadonlySet<string> = new Set([
  "search.findInFiles",
  "git.commit",
  "debug.start",
  "gate.runWorkspaceScan",
  "gate.showLog",
  "prometheus.scan",
  "prometheus.audit",
  "editor.newScratchFile",
  "ai.inlineEdit",
  "nav.back",
  "nav.forward",
  "nav.lastEdit",
  "nav.recent",
  "index.rebuild",
  "nav.goToLine", // APP-075 — Go-to family (dispatched in editor.tsx runCommand)
  "nav.goToSuper",
  "nav.relatedSymbol",
  "editor.completeStatement",
  "editor.smartEnter",
  "editor.toggleColumnSelection",
  "editor.pasteFromHistory",
  "editor.organizeImports",
  "editor.surroundWith",
  "usages.findUsages",
  "refactor.rename",
  "refactor.extract",
  "refactor.inline",
  "refactor.move",
  "refactor.changeSignature",
  "refactor.safeDelete",
  "generate.init",
  "generate.repr",
  "generate.eq",
  "generate.dataclass",
  "generate.property",
  "generate.override",
  "generate.delegate",
  "generate.docstring",
  "generate.newFile",
  "generate.copyright",
  "run.config",
  "run.debug",
  "run.stop",
  "run.anything",
  "panel.tokens",
  "panel.health",
  "panel.metadata",
  "python.selectInterpreter",
  "models.selectEndpoint",
]);
