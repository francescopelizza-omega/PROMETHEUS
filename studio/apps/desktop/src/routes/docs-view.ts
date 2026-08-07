/**
 * routes/docs-view.ts — PURE view-model for the Docs route (node:test-able, no DOM).
 *
 * Turns the canonical engine registry (COMMAND_SPECS) into searchable, grouped doc
 * rows for the GUI Docs view + its live search box. The same id/title/group/args/
 * description the CLI `--docs` and the prometheus `/docs` render — one source of truth.
 */
import type { CommandSpec } from "@prometheus/core/commands";

import type { Command, KeyChord, Platform } from "../renderer/commands/registry.js";
import type { Tutorial } from "./docs-tutorials.js";

export interface CommandDocRow {
  id: string;
  title: string;
  group: string;
  description: string;
  /** human arg signature, e.g. "<target> [--full]" */
  signature: string;
}

export interface DocGroup {
  group: string;
  rows: CommandDocRow[];
}

/** Format a spec's positionals + flags into a one-line signature. */
export function commandSignature(spec: CommandSpec): string {
  const pos = (spec.argsSchema?.positionals ?? []).map((a) =>
    a.required ? `<${a.name}>` : `[${a.name}]`,
  );
  const flags = (spec.argsSchema?.flags ?? []).map((a) => `--${a.name}`);
  return [...pos, ...flags].join(" ");
}

export function commandDocRow(spec: CommandSpec): CommandDocRow {
  return {
    id: spec.id,
    title: spec.title,
    group: String(spec.group),
    description: spec.description,
    signature: commandSignature(spec),
  };
}

export function commandDocRows(specs: readonly CommandSpec[]): CommandDocRow[] {
  return specs.map(commandDocRow);
}

/**
 * Live filter: every whitespace-token must appear (case-insensitive) somewhere in
 * id / title / group / description / signature. Blank query → all rows.
 */
export function filterCommandDocs(rows: readonly CommandDocRow[], query: string): CommandDocRow[] {
  const toks = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return [...rows];
  return rows.filter((r) => {
    const hay = `${r.id} ${r.title} ${r.group} ${r.description} ${r.signature}`.toLowerCase();
    return toks.every((t) => hay.includes(t));
  });
}

/** Group rows by category, preserving first-seen order. */
export function groupDocRows(rows: readonly CommandDocRow[]): DocGroup[] {
  const order: string[] = [];
  const by = new Map<string, CommandDocRow[]>();
  for (const r of rows) {
    if (!by.has(r.group)) {
      by.set(r.group, []);
      order.push(r.group);
    }
    by.get(r.group)!.push(r);
  }
  return order.map((g) => ({ group: g, rows: by.get(g)! }));
}

/** One-shot: rows for a query, grouped (what the Docs view renders). */
export function searchCommandDocs(
  specs: readonly CommandSpec[],
  query: string,
): { groups: DocGroup[]; count: number } {
  const filtered = filterCommandDocs(commandDocRows(specs), query);
  return { groups: groupDocRows(filtered), count: filtered.length };
}

/* ── cheat-sheet: SHELL_COMMANDS + live key labels (APP-099) ─────────────────── */

/** Token-AND case-insensitive match (the shared matcher for all three help surfaces). */
function matchesTokens(hay: string, toks: readonly string[]): boolean {
  const h = hay.toLowerCase();
  return toks.every((t) => h.includes(t));
}
function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Special key names → glyphs (mac) / words (other). Platform-parameterized so docs-view stays
 *  pure/node-testable — never read navigator here. */
const KEY_MAC: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "⏎",
  escape: "⎋",
  esc: "⎋",
  tab: "⇥",
  " ": "Space",
  backspace: "⌫",
};
const KEY_OTHER: Record<string, string> = {
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  enter: "Enter",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  " ": "Space",
  backspace: "Backspace",
};

function keyLabel(key: string, mac: boolean): string {
  const special = (mac ? KEY_MAC : KEY_OTHER)[key.toLowerCase()];
  return special ?? key.toUpperCase();
}

/**
 * Format a KeyChord into a human label. macOS renders glyphs in the canonical ⌃⌥⇧⌘ order with
 * no separators (⇧⌘P); Windows/Linux renders Ctrl+Alt+Shift+Key with "+" joins. `mod` is the
 * primary accelerator (⌘ on mac, Ctrl elsewhere); `ctrl` is a literal Control (distinct from
 * `mod` on mac, the SAME physical key on other platforms — collapsed to one Ctrl there).
 */
export function formatChord(chord: KeyChord, platform: Platform): string {
  const mac = platform === "mac";
  if (mac) {
    let mods = "";
    if (chord.ctrl) mods += "⌃";
    if (chord.alt) mods += "⌥";
    if (chord.shift) mods += "⇧";
    if (chord.mod) mods += "⌘";
    return mods + keyLabel(chord.key, true);
  }
  const parts: string[] = [];
  if (chord.mod || chord.ctrl) parts.push("Ctrl"); // mod === Ctrl on non-mac; collapse a literal ctrl into it
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(keyLabel(chord.key, false));
  return parts.join("+");
}

/** One cheat-sheet row: a shell/editor command + its live key label ("" when unbound). */
export interface CheatSheetRow {
  id: string;
  title: string;
  category: string;
  keys: string;
}

/**
 * Build cheat-sheet rows from the registry. Key labels come from `Command.keybinding` (the
 * default-preset chord) — the source of truth for what a command is bound to when no user
 * rebind is in effect; the view passes the platform in (pure, no navigator).
 */
export function cheatSheetRows(commands: readonly Command[], platform: Platform): CheatSheetRow[] {
  return commands.map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    keys: c.keybinding ? formatChord(c.keybinding, platform) : "",
  }));
}

/** Live filter over cheat-sheet rows (id / title / category / keys). */
export function filterCheatSheet(rows: readonly CheatSheetRow[], query: string): CheatSheetRow[] {
  const toks = tokens(query);
  if (toks.length === 0) return [...rows];
  return rows.filter((r) => matchesTokens(`${r.id} ${r.title} ${r.category} ${r.keys}`, toks));
}

/** Live filter over tutorials (title / summary / every step's text). */
export function filterTutorials(tutorials: readonly Tutorial[], query: string): Tutorial[] {
  const toks = tokens(query);
  if (toks.length === 0) return [...tutorials];
  return tutorials.filter((t) =>
    matchesTokens(`${t.title} ${t.summary} ${t.steps.map((s) => s.text).join(" ")}`, toks),
  );
}

/**
 * One-shot unified help search: narrows engine commands, cheat-sheet rows, and tutorials with
 * the SAME query + matcher so the shared search box feels consistent across all three tabs.
 */
export function searchHelp(
  query: string,
  data: {
    specs: readonly CommandSpec[];
    commands: readonly Command[];
    tutorials: readonly Tutorial[];
    platform: Platform;
  },
): {
  engine: { groups: DocGroup[]; count: number };
  cheatSheet: CheatSheetRow[];
  tutorials: Tutorial[];
} {
  return {
    engine: searchCommandDocs(data.specs, query),
    cheatSheet: filterCheatSheet(cheatSheetRows(data.commands, data.platform), query),
    tutorials: filterTutorials(data.tutorials, query),
  };
}

/* ── docs-route tab navigation latch (APP-099) ──────────────────────────────── */

/** The three tabs of the Docs route. */
export type DocsTab = "engine" | "cheatsheet" | "tutorials";

let pendingDocsTab: DocsTab | null = null;
const docsTabListeners = new Set<(tab: DocsTab) => void>();

/** A `help.*` command requests a tab: it latches the value (for a DocsRoute that will MOUNT
 *  from another activity) AND notifies live listeners (for a DocsRoute already mounted). Pure
 *  pub-sub — no DOM — so registry.ts stays DOM-free and this stays node-testable. */
export function requestDocsTab(tab: DocsTab): void {
  pendingDocsTab = tab;
  for (const l of docsTabListeners) l(tab);
}
/** Read + clear the latched tab (the route's initial tab); null when none pending. */
export function takeDocsTab(): DocsTab | null {
  const t = pendingDocsTab;
  pendingDocsTab = null;
  return t;
}
/** Subscribe to tab requests while mounted; returns an unsubscribe. */
export function onDocsTab(listener: (tab: DocsTab) => void): () => void {
  docsTabListeners.add(listener);
  return () => docsTabListeners.delete(listener);
}
