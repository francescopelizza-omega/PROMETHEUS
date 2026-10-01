// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * settings/keymap.ts — the keymap model + presets + conflict detection (file 13 §2.2).
 *
 * ONE binding surface for the whole product (07 §8): a `Keymap` binds command ids
 * (terminal.* from [[13]] §1.8, editor commands, engine subcommands) to keys, optionally
 * scoped by a `when` context expr (evaluated by 07's `evaluateWhen`). Ships 4 presets —
 * PyCharm, VS Code, Vim, macOS — plus user customs that extend a preset; APP-093 adds pure
 * export/import (shareable JSON round-trip). The conflict detector resolves `(keys, when)`
 * collisions; OS-modifier normalization (cmd↔ctrl) + chords (`g d`, `cmd+k cmd+k`) are
 * handled. Pure data + pure functions (09 layers/persists it).
 */
import { TERMINAL_COMMANDS } from "../terminal/commands.js";

/** Where a binding came from (user always wins; extensions lose; §2.2). */
export type BindingSource = "preset" | "user" | "extension";

/** One key→command binding (§2.2). */
export interface KeyBinding {
  command: string; // a registry id, e.g. 'terminal.runPrompt' | 'ai.inlineEdit'
  keys: string; // 'ctrl+shift+f10' | 'g d' (chord) | 'cmd+k cmd+k'
  when?: string; // context-key expr (07 §8): 'editorFocus && pythonFile'
  source: BindingSource;
}

/** A named keymap — a preset or a user/extension map that extends one (§2.2). */
export interface Keymap {
  id: string; // 'pycharm' | 'vscode' | 'vim' | user uuid
  base?: string; // a preset this derives from (customs extend a preset)
  label: string;
  bindings: KeyBinding[];
  builtin: boolean;
}

/* ── key normalization (cmd↔ctrl, chords, modifier order) ──────────────────── */

const MOD_ALIAS: Record<string, string> = {
  command: "cmd",
  cmd: "cmd",
  control: "ctrl",
  ctrl: "ctrl",
  option: "alt",
  opt: "alt",
  alt: "alt",
  shift: "shift",
  meta: "meta",
  super: "meta",
  win: "meta",
  // the renderer's platform-agnostic PRIMARY-accelerator token (chordToKeysString /
  // EDITOR_BINDINGS emit `mod`); treat it as a first-class modifier so a registry-derived
  // `mod+b` normalizes to `mod+b` (not to the bare key) and compares against folded cmd/ctrl.
  mod: "mod",
};
const MOD_ORDER = ["ctrl", "cmd", "alt", "shift", "meta", "mod"];

/** Normalize one chord segment: sorted modifiers + key, lower-cased. */
function normalizeSegment(segment: string, modAsEqual: boolean): string {
  const parts = segment
    .trim()
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    const alias = MOD_ALIAS[p];
    if (alias) {
      mods.push(modAsEqual && (alias === "cmd" || alias === "ctrl") ? "mod" : alias);
    } else {
      key = p;
    }
  }
  const ordered = [...new Set(mods)].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...ordered, key].filter(Boolean).join("+");
}

/**
 * Canonicalize a key string for comparison (§2.2). Sorts modifiers + lowercases each
 * chord segment. `modAsEqual` folds cmd/ctrl → `mod` so a cross-platform binding written
 * `cmd+k` matches `ctrl+k` (OS-modifier normalization).
 */
export function normalizeKeys(keys: string, modAsEqual = true): string {
  return keys
    .trim()
    .split(/\s+/)
    .map((seg) => normalizeSegment(seg, modAsEqual))
    .join(" ");
}

/** True when a binding is a chord (more than one segment). */
export function isChord(keys: string): boolean {
  return keys.trim().split(/\s+/).length > 1;
}

/* ── bindable command catalog (the Keymap UI lists these) ──────────────────── */

/** A bindable action shown in the Keymap UI (id + title + group). */
export interface BindableCommand {
  id: string;
  title: string;
  category: string;
}

/** View / Navigate / Tool-window commands this file owns (§2.3/§2.4/§2.6). */
const IDE_VIEW_COMMANDS: readonly BindableCommand[] = [
  { id: "view.zen", title: "Zen mode", category: "View" },
  { id: "view.distractionFree", title: "Distraction-free mode", category: "View" },
  { id: "view.presentation", title: "Presentation mode", category: "View" },
  { id: "search.everywhere", title: "Search Everywhere", category: "Navigate" },
  { id: "navigate.file", title: "Go to File", category: "Navigate" },
  { id: "navigate.symbol", title: "Go to Symbol", category: "Navigate" },
  { id: "navigate.action", title: "Go to Action", category: "Navigate" },
  { id: "navigate.line", title: "Go to Line", category: "Navigate" },
  { id: "refactor.this", title: "Refactor This…", category: "Refactor" },
  { id: "toolwindow.project", title: "Tool: Project", category: "Tool Windows" },
  { id: "toolwindow.structure", title: "Tool: Structure", category: "Tool Windows" },
  { id: "toolwindow.problems", title: "Tool: Problems", category: "Tool Windows" },
  { id: "toolwindow.terminal", title: "Tool: Terminal", category: "Tool Windows" },
  { id: "toolwindow.vcs", title: "Tool: Version Control", category: "Tool Windows" },
  { id: "toolwindow.services", title: "Tool: Services", category: "Tool Windows" },
];

/** Every bindable command the Keymap UI lists (terminal §1.8 + view/navigate/tools). */
export const BINDABLE_COMMANDS: readonly BindableCommand[] = Object.freeze([
  ...TERMINAL_COMMANDS.map((c) => ({ id: c.id, title: c.title, category: c.category })),
  ...IDE_VIEW_COMMANDS,
]);

/* ── shipped preset keymaps (§2.2) ─────────────────────────────────────────── */

function b(command: string, keys: string, when?: string): KeyBinding {
  return { command, keys, source: "preset", ...(when ? { when } : {}) };
}

/** PyCharm / IntelliJ preset. */
export const KEYMAP_PYCHARM: Keymap = {
  id: "pycharm",
  label: "PyCharm",
  builtin: true,
  bindings: [
    b("run.start", "ctrl+shift+f10"),
    b("debug.start", "ctrl+shift+f9"),
    b("search.everywhere", "shift shift"),
    b("navigate.file", "cmd+o"),
    b("navigate.action", "cmd+shift+a"),
    b("navigate.line", "cmd+l"),
    b("refactor.this", "ctrl+t", "editorFocus"),
    b("terminal.new", "alt+f12"),
    b("terminal.runPrompt", "alt+enter", "editorTextFocus"),
  ],
};

/** VS Code preset (matches 07's existing default). */
export const KEYMAP_VSCODE: Keymap = {
  id: "vscode",
  label: "VS Code",
  builtin: true,
  bindings: [
    b("run.start", "f5"),
    b("debug.start", "f5"),
    b("search.everywhere", "cmd+shift+p"),
    b("navigate.file", "cmd+p"),
    b("navigate.action", "cmd+shift+p"),
    b("navigate.line", "ctrl+g"),
    b("terminal.new", "ctrl+`"),
    b("terminal.runPrompt", "alt+enter", "editorTextFocus"),
  ],
};

/** Vim preset (modal layer; opt-in, coexists with a base for non-modal commands). */
export const KEYMAP_VIM: Keymap = {
  id: "vim",
  base: "vscode",
  label: "Vim",
  builtin: true,
  bindings: [
    b("navigate.symbol", "g d", "editorTextFocus"),
    b("editor.save", ": w", "editorTextFocus"),
    b("terminal.runPrompt", "alt+enter", "editorTextFocus"),
  ],
};

/** macOS-native preset (APP-093): ⌘ = `cmd`, ⌥ = `alt` (option), a literal ⌃ = `ctrl`
 *  (distinct from `cmd`). Uses the platform-idiomatic Cmd chords. */
export const KEYMAP_MACOS: Keymap = {
  id: "macos",
  label: "macOS",
  builtin: true,
  bindings: [
    b("run.start", "cmd+r"),
    b("debug.start", "cmd+shift+r"),
    b("search.everywhere", "cmd+shift+o"),
    b("navigate.file", "cmd+p"),
    b("navigate.action", "cmd+shift+a"),
    b("navigate.line", "cmd+l"),
    b("terminal.new", "ctrl+`"), // ⌃` — literal Control on mac, not ⌘
    b("terminal.runPrompt", "alt+enter", "editorTextFocus"), // ⌥⏎
  ],
};

export const BUILTIN_KEYMAPS: readonly Keymap[] = Object.freeze([
  KEYMAP_PYCHARM,
  KEYMAP_VSCODE,
  KEYMAP_VIM,
  KEYMAP_MACOS,
]);
export const DEFAULT_KEYMAP_ID = "vscode";

/** Look up a builtin keymap by id. */
export function getKeymap(id: string): Keymap | undefined {
  return BUILTIN_KEYMAPS.find((k) => k.id === id);
}

/**
 * Resolve a keymap's effective bindings: a custom map's bindings layered over its base
 * preset (a later binding for the same (keys, command) wins). User > extension > preset.
 */
export function resolveBindings(keymap: Keymap): KeyBinding[] {
  const base = keymap.base ? (getKeymap(keymap.base)?.bindings ?? []) : [];
  return [...base.map((x) => ({ ...x })), ...keymap.bindings.map((x) => ({ ...x }))];
}

/* ── conflict detection (§2.2) ─────────────────────────────────────────────── */

/** A keymap conflict — one (keys, when) bound to multiple commands (§2.2). */
export interface KeyConflict {
  keys: string; // normalized
  when?: string;
  commands: string[];
}

/** True when two `when` scopes overlap (no when = global = always overlaps). */
function whenOverlaps(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true; // a global binding overlaps any scope
  return a === b; // distinct scopes are treated as non-overlapping (conservative)
}

/** Detect (keys, when) collisions across a binding set (§2.2). */
export function detectConflicts(bindings: readonly KeyBinding[]): KeyConflict[] {
  const conflicts: KeyConflict[] = [];
  const byKeys = new Map<string, KeyBinding[]>();
  for (const binding of bindings) {
    const norm = normalizeKeys(binding.keys);
    const list = byKeys.get(norm) ?? [];
    list.push(binding);
    byKeys.set(norm, list);
  }
  for (const [norm, list] of byKeys) {
    // group by overlapping when, collect distinct commands
    for (let i = 0; i < list.length; i++) {
      const commands = new Set<string>();
      let when: string | undefined;
      for (let j = 0; j < list.length; j++) {
        const a = list[i] as KeyBinding;
        const c = list[j] as KeyBinding;
        if (whenOverlaps(a.when, c.when)) {
          commands.add(c.command);
          when = a.when;
        }
      }
      // De-dupe on (norm, COMMAND SET) — not (norm, when): a global (when=undef) and a scoped
      // binding sharing keys otherwise reported the SAME collision twice (once per outer index)
      // with two different `when` values. The first index (global) wins its command set.
      if (commands.size > 1) {
        const cmdKey = [...commands].sort().join("\x00");
        const dup = conflicts.some(
          (k) => k.keys === norm && [...k.commands].sort().join("\x00") === cmdKey,
        );
        if (!dup)
          conflicts.push({ keys: norm, ...(when ? { when } : {}), commands: [...commands] });
      }
    }
  }
  return conflicts;
}

/** How to resolve a conflict (§2.2). */
export type ConflictResolution =
  | { kind: "remove-other"; keep: string } // keep one command, drop the others on these keys
  | { kind: "keep-both"; scopeWith: string }; // keep both, scoping the loser by a `when`

/**
 * Apply a conflict resolution to a binding set (§2.2). `remove-other` drops the other
 * commands' bindings on these keys; `keep-both` leaves them (the UI adds the `when`).
 */
export function resolveConflict(
  bindings: readonly KeyBinding[],
  conflict: KeyConflict,
  resolution: ConflictResolution,
): KeyBinding[] {
  if (resolution.kind === "keep-both") return [...bindings];
  return bindings.filter((binding) => {
    const sameKeys = normalizeKeys(binding.keys) === conflict.keys;
    const inConflict = sameKeys && conflict.commands.includes(binding.command);
    return !inConflict || binding.command === resolution.keep;
  });
}

/** Add or replace a user binding (user source) — returns a NEW binding list. */
export function setBinding(bindings: readonly KeyBinding[], binding: KeyBinding): KeyBinding[] {
  const norm = normalizeKeys(binding.keys);
  const without = bindings.filter(
    (x) => !(x.command === binding.command && normalizeKeys(x.keys) === norm),
  );
  return [...without, { ...binding, source: "user" }];
}

/* ── user-override layer (APP-057 interactive rebinding) ────────────────────── */

/**
 * Add/replace a USER override for `binding.command` in the override layer (replace-BY-
 * COMMAND: the rebind editor edits at most one chord per row). If the new chord equals the
 * preset default for that command (same normalized keys + `when`), the override is DROPPED
 * — rebinding back to the default persists no redundant override. Returns a NEW override
 * list (source forced to "user"); never mutates the inputs.
 */
export function applyUserBinding(
  preset: readonly KeyBinding[],
  overrides: readonly KeyBinding[],
  binding: KeyBinding,
): KeyBinding[] {
  const without = overrides.filter((o) => o.command !== binding.command);
  const presetDefault = preset.find((p) => p.command === binding.command);
  if (
    presetDefault &&
    normalizeKeys(presetDefault.keys) === normalizeKeys(binding.keys) &&
    (presetDefault.when ?? "") === (binding.when ?? "")
  ) {
    return without; // back to the preset chord → no override
  }
  return [...without, { ...binding, source: "user" }];
}

/** Remove any USER override for `command`, restoring the preset default. Returns a NEW list. */
export function clearUserBinding(overrides: readonly KeyBinding[], command: string): KeyBinding[] {
  return overrides.filter((o) => o.command !== command);
}

/**
 * The EFFECTIVE binding list = the preset with each overridden command's chord replaced by
 * the user's (source:"user"); non-overridden preset rows keep their source. A user override
 * for a command the preset does NOT define (a brand-new binding) is appended. Pure — the
 * single place the UI + the live matcher both read so display + dispatch never drift.
 */
export function mergeUserBindings(
  preset: readonly KeyBinding[],
  overrides: readonly KeyBinding[],
): KeyBinding[] {
  const byCommand = new Map(overrides.map((o) => [o.command, o]));
  const merged = preset.map((p) => {
    const o = byCommand.get(p.command);
    return o ? { ...o, source: "user" as const } : { ...p };
  });
  for (const o of overrides) {
    if (!preset.some((p) => p.command === o.command)) merged.push({ ...o, source: "user" });
  }
  return merged;
}

/**
 * The conflicts a CANDIDATE `(keys, when)` bound to `candidate.command` would introduce,
 * computed BEFORE commit (the pre-save warning). Trial set = the current bindings with the
 * candidate command's existing binding removed + the candidate; reports only conflicts on
 * the candidate's normalized keys that involve the candidate command. Routes the candidate
 * through the SAME `normalizeKeys`/`detectConflicts` path so a modifier-order difference
 * (`shift+cmd+k` vs `cmd+shift+k`) never hides the duplicate.
 */
export function conflictsForCandidate(
  bindings: readonly KeyBinding[],
  candidate: { command: string; keys: string; when?: string },
): KeyConflict[] {
  const trial: KeyBinding[] = [
    ...bindings.filter((b) => b.command !== candidate.command),
    {
      command: candidate.command,
      keys: candidate.keys,
      source: "user",
      ...(candidate.when ? { when: candidate.when } : {}),
    },
  ];
  const norm = normalizeKeys(candidate.keys);
  return detectConflicts(trial).filter(
    (c) => c.keys === norm && c.commands.includes(candidate.command),
  );
}

/* ── keymap import / export (APP-093, shareable JSON round-trip) ─────────────── */

export const KEYMAP_EXPORT_VERSION = 1;

/** Canonicalize a binding for a stable on-disk form: keys normalized with cmd/ctrl KEPT
 *  distinct (a keymap file records the real modifier, unlike conflict-detection's fold), a
 *  fixed field set, and no undefined `when`. */
function canonBinding(x: KeyBinding): KeyBinding {
  return {
    command: x.command,
    keys: normalizeKeys(x.keys, false),
    source: x.source,
    ...(x.when ? { when: x.when } : {}),
  };
}

/**
 * Serialize a keymap to a shareable, DETERMINISTIC JSON string (APP-093). Bindings are
 * canonicalized + sorted by (command, keys) so `exportKeymap(importKeymap(exportKeymap(km)))`
 * is byte-identical to `exportKeymap(km)` — a stable round-trip regardless of input order.
 */
export function exportKeymap(km: Keymap): string {
  const bindings = km.bindings
    .map(canonBinding)
    .sort((a, b) => `${a.command}\x00${a.keys}`.localeCompare(`${b.command}\x00${b.keys}`));
  const obj = {
    version: KEYMAP_EXPORT_VERSION,
    id: km.id,
    ...(km.base ? { base: km.base } : {}),
    label: km.label,
    builtin: km.builtin,
    bindings,
  };
  return JSON.stringify(obj, null, 2);
}

const ALLOWED_TOP = new Set(["version", "id", "base", "label", "builtin", "bindings"]);
const ALLOWED_BINDING = new Set(["command", "keys", "when", "source"]);
const VALID_SOURCES = new Set<BindingSource>(["preset", "user", "extension"]);

/**
 * Parse + VALIDATE a keymap JSON file (APP-093). Fail-closed: any unknown top-level or
 * per-binding field, a missing required field, or a malformed value returns `{ error }`
 * (never a partially-built keymap) so a foreign/hand-mangled file can't corrupt the live
 * keymap. Bindings are normalized. `when` strings are carried VERBATIM (validated only as
 * strings — they are evaluated later by 07's `evaluateWhen`, never eval'd here). Callers
 * MUST narrow on `"error" in result`, not truthiness.
 */
export function importKeymap(json: string): Keymap | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { error: "not valid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "expected a keymap object" };
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!ALLOWED_TOP.has(k)) return { error: `unknown field: ${k}` };
  }
  if (typeof o.id !== "string" || !o.id) return { error: "missing or invalid id" };
  if (typeof o.label !== "string" || !o.label) return { error: "missing or invalid label" };
  if (!Array.isArray(o.bindings)) return { error: "missing bindings array" };
  const bindings: KeyBinding[] = [];
  for (const bx of o.bindings) {
    if (!bx || typeof bx !== "object" || Array.isArray(bx))
      return { error: "invalid binding entry" };
    const bo = bx as Record<string, unknown>;
    for (const k of Object.keys(bo)) {
      if (!ALLOWED_BINDING.has(k)) return { error: `unknown binding field: ${k}` };
    }
    if (typeof bo.command !== "string" || !bo.command) return { error: "binding missing command" };
    if (typeof bo.keys !== "string" || !bo.keys) return { error: "binding missing keys" };
    if (bo.when !== undefined && typeof bo.when !== "string") {
      return { error: "binding when must be a string" };
    }
    if (bo.source !== undefined && !VALID_SOURCES.has(bo.source as BindingSource)) {
      return { error: "invalid binding source" };
    }
    bindings.push(
      canonBinding({
        command: bo.command,
        keys: bo.keys,
        source: (bo.source as BindingSource | undefined) ?? "user",
        ...(typeof bo.when === "string" ? { when: bo.when } : {}),
      }),
    );
  }
  return {
    id: o.id,
    label: o.label,
    builtin: o.builtin === true,
    ...(typeof o.base === "string" ? { base: o.base } : {}),
    bindings,
  };
}
