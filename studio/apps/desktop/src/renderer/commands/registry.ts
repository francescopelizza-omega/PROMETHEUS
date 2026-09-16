/**
 * renderer/commands/registry.ts — the shell COMMAND REGISTRY (file 08 §4.3, leap #1).
 *
 * The single source of truth for what the ⌘K palette can RUN and what the global
 * keybindings DO. Before this, the palette could only navigate (App.onRunCommand
 * admitted "the shell can't execute it") and the chords were a hardcoded if/else;
 * commands were not addressable. This mirrors VS Code's CommandsRegistry pattern
 * (the pattern only — no VS Code source is copied; that source is MIT, this is our
 * own implementation): each command is a stable id → handler, optionally bound to a
 * KeyChord, and BOTH the palette item list and the keydown matcher are derived from
 * the same table so a shortcut can never drift from its command.
 *
 * PURE: no React, no DOM nodes — only a KeyboardEvent type at the matcher boundary.
 * The renderer (App.tsx) supplies a CommandContext of callbacks; editor-scoped
 * commands navigate to the editor and re-dispatch through the window event bus the
 * editor route already listens on (`ide:run-command`).
 */

import type { ActivityId } from "@prometheus/ui";

import { requestDocsTab } from "../../routes/docs-view.js";
import { type RouteTab, requestRouteTab } from "../../routes/route-tabs.js";
import type { BottomTab } from "../shell/BottomPanel.js";

/** Which OS modifier glyphs/keys to use (⌘ on macOS, Ctrl elsewhere). */
export type Platform = "mac" | "other";

/**
 * A keybinding chord. `mod` is the PRIMARY accelerator — ⌘ on macOS, Ctrl on
 * Windows/Linux. `ctrl` is a LITERAL Control key (⌃` is Control on every platform).
 * `key` is the lowercased `KeyboardEvent.key` ("k", "b", "`", ",", "f").
 */
export interface KeyChord {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/** The callbacks the shell (App.tsx) provides so a command can act on the workbench. */
export interface CommandContext {
  navigate(id: ActivityId): void;
  togglePalette(): void;
  toggleSidebar(): void;
  toggleRightRail(): void;
  toggleBottomPanel(): void;
  openBottomPanel(tab: BottomTab): void;
  openSettings(): void;
  /** run an editor-scoped command id — navigate to the editor + re-dispatch to it. */
  runEditorCommand(id: string): void;
  /** APP-100: cycle keyboard focus forward/back across the shell landmark regions (F6/⇧F6).
   *  Optional so a lightweight ctx (tests, the AgentPane's shell-less path) needn't implement it. */
  focusNext?(): void;
  focusPrev?(): void;
}

/** One registered command (id mirrors the file-07 EDITOR_COMMANDS where they overlap). */
export interface Command {
  id: string;
  title: string;
  category: string;
  keybinding?: KeyChord;
  run(ctx: CommandContext): void;
}

/**
 * The shell command surface. Navigation ("Go to …") is generated from ACTIVITIES in
 * the palette and handled by onNavigate, so it is NOT duplicated here — this table is
 * the ACTIONS. The first group executes in the shell directly; the editor group
 * routes through runEditorCommand.
 */
export const SHELL_COMMANDS: readonly Command[] = [
  // ── shell-runnable (these used to silently no-op) ───────────────────────────
  {
    id: "view.commandPalette",
    title: "Command Palette",
    category: "View",
    keybinding: { key: "k", mod: true },
    run: (c) => c.togglePalette(),
  },
  {
    // Toggles the ACTIVE activity's contextual sidebar (per-route persisted map,
    // APP-002/003). On an activity with NO registered body this is a deliberate
    // NO-OP (toggleSidebarMap returns the map unchanged): there is nothing to
    // show, and flipping invisible state would desync the rail indicator. The
    // ⌥⌘B sibling below is the RIGHT rail — exact-modifier matching keeps them
    // distinct (pinned in registry.test.ts).
    id: "view.toggleSidebar",
    title: "Toggle Sidebar",
    category: "View",
    keybinding: { key: "b", mod: true },
    run: (c) => c.toggleSidebar(),
  },
  {
    id: "view.toggleRightRail",
    title: "Toggle AI Panel",
    category: "View",
    keybinding: { key: "b", mod: true, alt: true },
    run: (c) => c.toggleRightRail(),
  },
  {
    id: "view.toggleBottomPanel",
    title: "Toggle Bottom Panel",
    category: "View",
    keybinding: { key: "`", ctrl: true },
    run: (c) => c.toggleBottomPanel(),
  },
  {
    id: "workbench.openSettings",
    title: "Open Settings",
    category: "View",
    keybinding: { key: ",", mod: true },
    run: (c) => c.openSettings(),
  },
  {
    id: "panel.health",
    title: "Health: Open Panel",
    category: "View",
    run: (c) => c.openBottomPanel("health"),
  },
  {
    id: "panel.security",
    title: "Security: Open Panel",
    category: "Security",
    run: (c) => c.openBottomPanel("security"),
  },
  {
    id: "panel.metadata",
    title: "Metadata: Open Panel",
    category: "Privacy",
    run: (c) => c.openBottomPanel("metadata"),
  },
  {
    id: "panel.tokens",
    title: "Save Tokens: Open Toolkit",
    category: "View",
    run: (c) => c.openBottomPanel("tokens"),
  },
  {
    id: "ai.openAgent",
    title: "AI: Open Agent Pane",
    category: "AI",
    run: (c) => c.toggleRightRail(),
  },

  // ── editor-scoped (navigate to the editor, then re-dispatch to its runCommand) ─
  {
    id: "editor.action.formatDocument",
    title: "Format Document",
    category: "Edit",
    keybinding: { key: "f", shift: true, alt: true },
    run: (c) => c.runEditorCommand("editor.action.formatDocument"),
  },
  {
    id: "ai.inlineEdit",
    title: "AI: Inline Edit",
    category: "AI",
    run: (c) => c.runEditorCommand("ai.inlineEdit"),
  },
  {
    id: "search.findInFiles",
    title: "Search: Find in Files",
    category: "Edit",
    keybinding: { key: "f", mod: true, shift: true },
    run: (c) => c.runEditorCommand("search.findInFiles"),
  },
  {
    // APP-097: File Structure popup (⌘F12). No keybinding here — the chord is bound directly
    // on the focused Monaco editor (EditorPane) so it can't double-fire with this shell
    // handler; this entry exists only for palette discoverability.
    id: "structure.filePopup",
    title: "Go to Symbol in File (Structure)",
    category: "Go",
    run: (c) => c.runEditorCommand("structure.filePopup"),
  },
  // APP-100 — cycle focus across the shell landmark regions (sidebar → editor → bottom → rail).
  // F6 is free in every keymap preset; remappable like any chord. Optional ctx method (no-ops
  // where a shell isn't mounted).
  {
    id: "focus.next",
    title: "Focus Next Panel",
    category: "View",
    keybinding: { key: "f6" },
    run: (c) => c.focusNext?.(),
  },
  {
    id: "focus.prev",
    title: "Focus Previous Panel",
    category: "View",
    keybinding: { key: "f6", shift: true },
    run: (c) => c.focusPrev?.(),
  },
  // APP-099 — in-app help browser. Both land on the Docs route; the cheat-sheet one requests
  // its tab through the pure docs-tab latch (DocsRoute reads it on mount + live-subscribes).
  {
    id: "help.docs",
    title: "Help: Open Docs",
    category: "Help",
    run: (c) => {
      requestRouteTab("workspace", "docs");
      requestDocsTab("engine");
      c.navigate("workspace");
    },
  },
  {
    id: "help.cheatSheet",
    title: "Help: Keyboard Cheat-Sheet",
    category: "Help",
    run: (c) => {
      requestRouteTab("workspace", "docs");
      requestDocsTab("cheatsheet");
      c.navigate("workspace");
    },
  },
  // APP-098 — documentation surfaces. Quick Doc's ⌘J chord is bound on the focused editor
  // (EditorPane); these entries drive the palette + route to the editor host events.
  {
    id: "docs.quickDoc",
    title: "Quick Documentation",
    category: "View",
    run: (c) => c.runEditorCommand("docs.quickDoc"),
  },
  {
    id: "docs.generateStub",
    title: "Generate Docstring Stub",
    category: "Edit",
    run: (c) => c.runEditorCommand("docs.generateStub"),
  },
  {
    id: "docs.readerMode",
    title: "Toggle Reader Mode (doc comments)",
    category: "View",
    run: (c) => c.runEditorCommand("docs.readerMode"),
  },
  {
    // APP-061: open the Bookmarks tool window. Toggle a bookmark = ⌘/Ctrl-F3 (editor
    // action); set/jump numbered mnemonics = ⌘/Ctrl-(Shift-)<digit> (editor-route chords).
    id: "bookmarks.show",
    title: "Bookmarks: Show",
    category: "View",
    run: (c) => c.runEditorCommand("bookmarks.show"),
  },
  {
    // APP-063: open the Local History window for the active file (timeline + revert/recover).
    id: "history.show",
    title: "Local History: Show",
    category: "View",
    run: (c) => c.runEditorCommand("history.show"),
  },
  // reading aids (APP-074) — three live, persisted toggles honored by the Monaco providers.
  {
    id: "editor.vision.toggleFolding",
    title: "Toggle Folding Regions (LSP)",
    category: "View",
    run: (c) => c.runEditorCommand("editor.vision.toggleFolding"),
  },
  {
    id: "editor.vision.toggleInlayHints",
    title: "Toggle Inlay Hints",
    category: "View",
    run: (c) => c.runEditorCommand("editor.vision.toggleInlayHints"),
  },
  {
    id: "editor.vision.toggleCodeVision",
    title: "Toggle Code Vision (Reference Counts)",
    category: "View",
    run: (c) => c.runEditorCommand("editor.vision.toggleCodeVision"),
  },
  // APP-083: inline blame (current-line author/date/short-sha) — persisted opt-in.
  {
    id: "git.toggleInlineBlame",
    title: "Git: Toggle Inline Blame",
    category: "Git",
    run: (c) => c.runEditorCommand("git.toggleInlineBlame"),
  },
  {
    id: "git.commit",
    title: "Git: Commit",
    category: "Git",
    run: (c) => c.runEditorCommand("git.commit"),
  },
  {
    // Task #5 (desktop parity): create/list/switch/remove git worktrees for parallel
    // sessions — the SAME `@prometheus/core/git-worktree` functions the CLI's `/worktree`
    // slash calls (CLI-054). Opens the Git activity's Worktrees section.
    id: "git.worktrees",
    title: "Git: Worktrees",
    category: "Git",
    run: (c) => c.runEditorCommand("git.worktrees"),
  },
  {
    id: "debug.start",
    title: "Run: Start Debugging",
    category: "Run",
    run: (c) => c.runEditorCommand("debug.start"),
  },
  // Refactor Preview (APP-027) — surfaced in the shell ⌘K palette; each routes to
  // the editor, which opens the gated preview on the focused caret/selection.
  {
    id: "refactor.rename",
    title: "Refactor: Rename Symbol (Python)",
    category: "Refactor",
    run: (c) => c.runEditorCommand("refactor.rename"),
  },
  {
    id: "refactor.extract",
    title: "Refactor: Extract Method/Variable (Python)",
    category: "Refactor",
    run: (c) => c.runEditorCommand("refactor.extract"),
  },
  {
    id: "refactor.inline",
    title: "Refactor: Inline Symbol (Python)",
    category: "Refactor",
    run: (c) => c.runEditorCommand("refactor.inline"),
  },
  {
    id: "refactor.move",
    title: "Refactor: Move to Module (Python)",
    category: "Refactor",
    run: (c) => c.runEditorCommand("refactor.move"),
  },
  {
    id: "refactor.changeSignature",
    title: "Refactor: Change Signature (Python)",
    category: "Refactor",
    run: (c) => c.runEditorCommand("refactor.changeSignature"),
  },
  {
    id: "refactor.safeDelete",
    title: "Refactor: Safe Delete (Python)",
    category: "Refactor",
    run: (c) => c.runEditorCommand("refactor.safeDelete"),
  },
  // Generate menu (APP-028) — AST-derived members + core templates through the same
  // gated preview; each routes to the editor like the refactors above.
  {
    id: "generate.init",
    title: "Generate: __init__ (Python)",
    category: "Generate",
    run: (c) => c.runEditorCommand("generate.init"),
  },
  {
    id: "generate.repr",
    title: "Generate: __repr__ (Python)",
    category: "Generate",
    run: (c) => c.runEditorCommand("generate.repr"),
  },
  {
    id: "generate.eq",
    title: "Generate: __eq__ (Python)",
    category: "Generate",
    run: (c) => c.runEditorCommand("generate.eq"),
  },
  {
    id: "generate.dataclass",
    title: "Generate: Convert to @dataclass (Python)",
    category: "Generate",
    run: (c) => c.runEditorCommand("generate.dataclass"),
  },
  {
    id: "generate.property",
    title: "Generate: Property + Setter (Python)",
    category: "Generate",
    run: (c) => c.runEditorCommand("generate.property"),
  },
  {
    id: "generate.override",
    title: "Generate: Override Method (Python)",
    category: "Generate",
    run: (c) => c.runEditorCommand("generate.override"),
  },
  {
    id: "generate.delegate",
    title: "Generate: Delegate Method (Python)",
    category: "Generate",
    run: (c) => c.runEditorCommand("generate.delegate"),
  },
  {
    id: "generate.docstring",
    title: "Generate: Docstring Stub (Python)",
    category: "Generate",
    run: (c) => c.runEditorCommand("generate.docstring"),
  },
  {
    id: "generate.newFile",
    title: "Generate: New File from Template",
    category: "Generate",
    run: (c) => c.runEditorCommand("generate.newFile"),
  },
  {
    id: "generate.copyright",
    title: "Generate: Insert Copyright Header",
    category: "Generate",
    run: (c) => c.runEditorCommand("generate.copyright"),
  },
  // Run toolbar + Run-Anything picker (APP-034). ⌘⇧R deliberately — ⌘⇧B stays
  // with the Run-Build-Task default (tasks-config.ts).
  //
  // The TopBar used to call `debug.start` for BOTH Run and Debug — a handler that only opens the
  // debug panel — and `debug.stop`, which was never registered at all, so Stop returned false and
  // did nothing, silently. App.tsx dispatches these three ids instead. They have always lived
  // HERE: a second copy added higher up in this array shipped every one of them twice, which is
  // two palette rows and a duplicate React key per id (CommandPalette keys by `item.id`).
  {
    id: "run.config",
    title: "Run: Selected Configuration",
    category: "Run",
    run: (c) => c.runEditorCommand("run.config"),
  },
  {
    id: "run.debug",
    title: "Run: Debug Selected Configuration",
    category: "Run",
    run: (c) => c.runEditorCommand("run.debug"),
  },
  {
    id: "run.stop",
    title: "Run: Stop",
    category: "Run",
    run: (c) => c.runEditorCommand("run.stop"),
  },
  {
    id: "run.anything",
    title: "Run: Anything…",
    category: "Run",
    keybinding: { key: "r", mod: true, shift: true },
    run: (c) => c.runEditorCommand("run.anything"),
  },
];

/** Detect the platform once (defaults to mac when navigator is unavailable, e.g. tests). */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "mac";
  const p = (navigator.platform || navigator.userAgent || "").toLowerCase();
  return p.includes("mac") ? "mac" : "other";
}

/** Resolve a chord to the EXACT modifier booleans a KeyboardEvent must have. */
function chordModifiers(
  ch: KeyChord,
  plat: Platform,
): {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
} {
  const mod = ch.mod ?? false;
  const literalCtrl = ch.ctrl ?? false;
  return {
    // macOS: `mod` → ⌘ (meta); other: `mod` → Ctrl (folds into ctrl below).
    meta: plat === "mac" ? mod : false,
    ctrl: literalCtrl || (plat === "mac" ? false : mod),
    shift: ch.shift ?? false,
    alt: ch.alt ?? false,
  };
}

/** Does a KeyboardEvent EXACTLY match a chord (no extra/missing modifiers)? */
/** The physical `KeyboardEvent.code` a single letter/digit chord key maps to (else null). */
function expectedCode(key: string): string | null {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return null;
}

export function matchChord(
  e: {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  ch: KeyChord,
  plat: Platform = detectPlatform(),
): boolean {
  // macOS composes Option+<letter> into a diacritic in `e.key` (⇧⌥F reports "Ï", not "f"), so an
  // alt accelerator without a Cmd modifier could never match on key alone. Fall back to the
  // physical `e.code` for alt chords when the mangled key doesn't compare equal.
  const keyMatch =
    e.key.toLowerCase() === ch.key ||
    (ch.alt === true && !!e.code && e.code === expectedCode(ch.key));
  if (!keyMatch) return false;
  const m = chordModifiers(ch, plat);
  return (
    e.metaKey === m.meta && e.ctrlKey === m.ctrl && e.shiftKey === m.shift && e.altKey === m.alt
  );
}

/** Human-readable label for a key segment ("`" / "," stay literal; letters uppercase). */
function keyLabel(key: string): string {
  if (key.length === 1 && /[a-z]/.test(key)) return key.toUpperCase();
  return key;
}

/** Render a chord as a display string ("⌘K", "⇧⌥F", "Ctrl+Shift+F"). */
export function chordLabel(ch: KeyChord | undefined, plat: Platform = detectPlatform()): string {
  if (!ch) return "";
  if (plat === "mac") {
    const parts: string[] = [];
    if (ch.ctrl) parts.push("⌃");
    if (ch.alt) parts.push("⌥");
    if (ch.shift) parts.push("⇧");
    if (ch.mod) parts.push("⌘");
    parts.push(keyLabel(ch.key));
    return parts.join("");
  }
  const parts: string[] = [];
  if (ch.mod || ch.ctrl) parts.push("Ctrl");
  if (ch.shift) parts.push("Shift");
  if (ch.alt) parts.push("Alt");
  parts.push(keyLabel(ch.key));
  return parts.join("+");
}

/** Render a chord as a RAW `mod+shift+k`-style key string (for the Keymap page's
 *  formatKeys glyph renderer — distinct from chordLabel which already emits glyphs). */
export function chordToKeysString(ch: KeyChord): string {
  const parts: string[] = [];
  if (ch.ctrl) parts.push("ctrl");
  if (ch.alt) parts.push("alt");
  if (ch.shift) parts.push("shift");
  if (ch.mod) parts.push("mod");
  parts.push(ch.key);
  return parts.join("+");
}

/**
 * Parse a `mod+shift+k`-style keys string into a KeyChord (APP-057, the inverse of
 * chordToKeysString). Returns null for a multi-segment chord (`g d` — the registry KeyChord
 * is single-segment and can't dispatch it) or a modifier-only string (no key). Folds
 * cmd/command/meta → the primary `mod`; a literal `ctrl` stays ctrl.
 */
export function parseChordString(keys: string): KeyChord | null {
  const trimmed = keys.trim();
  if (!trimmed || /\s/.test(trimmed)) return null; // chords (space-separated) aren't dispatchable here
  const ch: KeyChord = { key: "" };
  let key = "";
  for (const raw of trimmed.toLowerCase().split("+")) {
    const p = raw.trim();
    if (!p) continue;
    if (p === "mod" || p === "cmd" || p === "command" || p === "meta") ch.mod = true;
    else if (p === "ctrl" || p === "control") ch.ctrl = true;
    else if (p === "shift") ch.shift = true;
    else if (p === "alt" || p === "opt" || p === "option") ch.alt = true;
    else key = p;
  }
  if (!key) return null; // modifier-only → not a runnable chord
  ch.key = key;
  return ch;
}

/**
 * The chord a command dispatches under, honoring the user OVERRIDE layer (APP-057). An
 * override of `""` explicitly UNBINDS the command; an unparseable override falls back to the
 * registry default (a rebind is never allowed to leave a command dead). No override → the
 * built-in keybinding.
 */
export function effectiveKeybinding(
  cmd: Command,
  overrides?: Record<string, string>,
): KeyChord | undefined {
  const ov = overrides?.[cmd.id];
  if (ov === undefined) return cmd.keybinding;
  if (ov === "") return undefined; // explicit unbind
  return parseChordString(ov) ?? cmd.keybinding;
}

/** Run a command by id against a context. Returns false for an unknown id. */
export function executeCommandId(id: string, ctx: CommandContext): boolean {
  const cmd = SHELL_COMMANDS.find((c) => c.id === id);
  if (!cmd) return false;
  cmd.run(ctx);
  return true;
}

/**
 * Match a global keydown against the registry's keybindings and run the first hit.
 * Returns true (and preventDefaults) when a command fired. The shell replaces its
 * hardcoded chord if/else with this so shortcuts and palette share one source.
 *
 * `overrides` (APP-057) is the user rebind layer (command id → keys string): the LIVE
 * matcher reads the merged chord (override wins), so a rebind takes effect immediately
 * without touching the frozen SHELL_COMMANDS table.
 */
export function handleChord(
  e: KeyboardEvent,
  ctx: CommandContext,
  plat: Platform = detectPlatform(),
  overrides?: Record<string, string>,
): boolean {
  for (const cmd of SHELL_COMMANDS) {
    const kb = effectiveKeybinding(cmd, overrides);
    if (kb && matchChord(e, kb, plat)) {
      e.preventDefault();
      cmd.run(ctx);
      return true;
    }
  }
  return false;
}

/** A palette-ready projection of the command table (id/title/category + key hint). */
export interface CommandPaletteRow {
  id: string;
  title: string;
  category: string;
  keybind: string;
}

/**
 * Build the palette rows from the registry (keybindings included for display).
 *
 * `overrides` is the APP-057 user rebind layer (command id → keys). The hint must come from
 * `effectiveKeybinding`, the same merge the live matcher uses — otherwise a rebound or
 * unbound command keeps advertising its frozen default in every palette.
 */
export function commandPaletteRows(
  plat: Platform = detectPlatform(),
  overrides?: Record<string, string>,
): CommandPaletteRow[] {
  return SHELL_COMMANDS.map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    keybind: chordLabel(effectiveKeybinding(c, overrides), plat),
  }));
}

/**
 * Where a palette command that the shell CANNOT execute should send the user instead.
 *
 * `executeCommandId` returns false for ids surfaced by other routes (the editor's own
 * palette contributes `python.*`, `models.*`, …). Rather than silently no-op, the shell
 * navigates to the surface where that command actually works.
 *
 * `tab` exists because handoff_3 §1 turned four rail nouns into SEGMENTS. Naming only the
 * activity is not enough any more: `python.selectInterpreter` lives in Workspace's
 * *Environments* segment, and a bare `setActivity("workspace")` lands the user on Repos —
 * the exact failure the §1 redirects were written to prevent, on a live code path.
 */
export interface CommandTarget {
  activity: ActivityId;
  /** the merged route's segment, when the command lives inside one. */
  tab?: RouteTab;
}

/** Route a palette command id to the surface where it works. null ⇒ handled inline. */
export function commandTarget(id: string): CommandTarget | null {
  if (id.startsWith("panel.")) return null;
  if (id.startsWith("models.")) return { activity: "models" };
  if (id.startsWith("prometheus.") || id.startsWith("gate.")) return { activity: "security" };
  if (id.startsWith("python.")) return { activity: "workspace", tab: "environments" };
  // ai.* / git.* / debug.* / search.* / editor.* all live in the Editor workbench.
  return { activity: "editor" };
}
