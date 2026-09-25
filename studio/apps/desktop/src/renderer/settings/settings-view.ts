/**
 * settings-view.ts — PURE renderer-side display helpers for the Settings UI (file 13).
 *
 * The authoritative settings tree + keymap logic lives in @prometheus/core (tested
 * there) and reaches the renderer over `window.prometheus` (C5 sandbox: the renderer
 * imports neither core nor electron). This module owns only the renderer's DISPLAY
 * concerns — pretty key glyphs, a substring tree filter — so they're unit-testable
 * under node:test without a DOM (matching health-derive.test.ts). It imports ONE pure core
 * function — `normalizeKeys` from the `@prometheus/core/keymap` subpath — so conflict-highlight
 * normalization can't drift from the normalizer the conflict set is built with (both pure, no
 * node/electron; the C5 sandbox permits pure core subpaths, as keymap-capture.ts already does).
 */

import { normalizeKeys } from "@prometheus/core/keymap";

/** A settings-tree row as the renderer receives it (mirrors main's SettingsRowView —
 *  itself a mirror of core's SettingsNode + resolved (value, layer) provenance). */
export interface SettingsNodeView {
  id: string;
  title: string;
  category: string;
  ownerFile: string;
  /** the control kind this leaf renders as (page/toggle/select/number/text/color/…). */
  control?: string;
  /** the persisted key (schema path) this leaf's value lives at; absent for group nodes. */
  schemaKey?: string;
  scope?: string;
  /** the resolved effective value, when this node has a `schemaKey`. */
  value?: unknown;
  /** which layer produced `value` (§7.1: default/global/profile/workspace/unset). */
  layer?: "default" | "global" | "profile" | "workspace" | "unset";
  /** APP-058: the raw (pre-merge) value at each editable scope that SETS the key; a scope
   *  absent = "not set at this scope" (never the merged effective value). */
  rawByScope?: Partial<Record<SettingsUiScope, unknown>>;
  /** APP-058: every layer that sets the key, in precedence order (the "overrides …" chain). */
  definedIn?: ("default" | "global" | "profile" | "workspace" | "unset")[];
  searchTerms?: string[];
  /** the closed set of valid values, for a `select`. Carried from `SettingsNode.options`. */
  options?: readonly { value: string; label: string }[];
  children?: SettingsNodeView[];
}

/** The editable UI scope tabs (APP-058): default (read-only) ← user (global) ← project. */
export type SettingsUiScope = "default" | "user" | "project";

/** Flatten a node tree depth-first (parents before children). */
export function flattenNodes(nodes: readonly SettingsNodeView[]): SettingsNodeView[] {
  const out: SettingsNodeView[] = [];
  const visit = (n: SettingsNodeView) => {
    out.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** Filter the tree by a query (title/category/id/searchTerms substring), title-first. */
export function filterNodes(nodes: readonly SettingsNodeView[], query: string): SettingsNodeView[] {
  const q = query.trim().toLowerCase();
  if (!q) return flattenNodes(nodes);
  const hay = (n: SettingsNodeView) =>
    [n.title, n.category, n.id, ...(n.searchTerms ?? [])].join(" ").toLowerCase();
  return flattenNodes(nodes)
    .filter((n) => hay(n).includes(q))
    .sort((a, b) => {
      const at = a.title.toLowerCase().includes(q) ? 0 : 1;
      const bt = b.title.toLowerCase().includes(q) ? 0 : 1;
      return at - bt || a.title.localeCompare(b.title);
    });
}

/* ── key glyph rendering (the Keymap table) ────────────────────────────────── */

const GLYPH: Record<string, string> = {
  cmd: "⌘",
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  meta: "⌘",
  enter: "⏎",
  escape: "⎋",
  esc: "⎋",
  tab: "⇥",
  space: "␣",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  backspace: "⌫",
};

/** Pretty-print one chord segment with platform glyphs (⌘⇧⌥…). */
function prettySegment(seg: string): string {
  return seg
    .split("+")
    .map((p) => GLYPH[p.toLowerCase()] ?? p.toUpperCase())
    .join("");
}

/** Render a key string (incl. chords) with glyphs, e.g. "cmd+shift+p" → "⌘⇧P". */
export function formatKeys(keys: string): string {
  return keys.trim().split(/\s+/).map(prettySegment).join(" ");
}

/** A keybinding row as the renderer receives it (mirrors core KeyBinding). */
export interface KeyBindingView {
  /** the human title shown in the Action column. */
  command: string;
  keys: string;
  when?: string;
  source: "preset" | "user" | "extension";
  /** the stable command id (APP-057) — the rebind/reset key; absent for display-only rows. */
  id?: string;
  /** whether this row can be rebound live (APP-057). Read-only rows (e.g. editor-route
   *  chords not in the shell registry) set false so the UI never pretends a rebind applies. */
  rebindable?: boolean;
}

/** Whether a binding is in a given conflict set (normalized-keys match). */
export function bindingHasConflict(
  binding: KeyBindingView,
  conflictKeys: ReadonlySet<string>,
): boolean {
  return conflictKeys.has(normalizeForDisplay(binding.keys));
}

/* ── settings-tree editing (APP-017) ───────────────────────────────────────── */

const EDITABLE_CONTROLS = new Set(["toggle", "number", "text", "select", "color"]);

/**
 * Whether a node's control kind is safe to render a generic scalar editor for.
 * `keymap`/`custom`/`page` nodes (and any node whose resolved value is an object/array,
 * even under a nominally-scalar control) render read-only here — corrupting a structured
 * value through a plain text/number/toggle input is worse than not editing it at all.
 */
export function isEditableControl(control: string | undefined, value: unknown): boolean {
  if (!control || !EDITABLE_CONTROLS.has(control)) return false;
  return value === undefined || value === null || typeof value !== "object";
}

/** Canonical key form for conflict highlighting. MUST match the normalizer the conflict SET is
 *  built with (core `detectConflicts` → `normalizeKeys`), else the ⚠ never fires: the old local
 *  impl sorted the KEY in with the modifiers (`cmd+k` → `k+mod`) while core sorts modifiers by
 *  MOD_ORDER and appends the key last (`mod+k`) — the two never matched. Delegating to the same
 *  pure core function guarantees parity. */
export function normalizeForDisplay(keys: string): string {
  return normalizeKeys(keys, true);
}
