// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * keymap-capture.ts — PURE keyboard-event → normalized chord string (APP-057).
 *
 * Extracted from ChordRecorder so the translation is unit-testable under node:test (no
 * DOM). Emits the same `mod`-token convention the shell registry uses (chordToKeysString /
 * EDITOR_BINDINGS) so a captured chord round-trips: recorder → keys string → core
 * normalizeKeys (conflict check) and → registry parseChordString (live matcher). The key
 * segment follows `event.key` (layout-following) to match the live matcher (`matchChord`
 * compares `e.key`), NOT `event.code` — one convention end to end, per the plan gotcha.
 */
export type CapturePlatform = "mac" | "other";

/** The subset of a KeyboardEvent the pure translator reads (so tests need no DOM). */
export interface CaptureKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** OS auto-repeat — a held key; never commit a chord from a repeat (plan refinement). */
  repeat?: boolean;
}

/** Lone modifier presses (event.key values) never commit a chord. */
const MODIFIER_ONLY = new Set([
  "control",
  "shift",
  "alt",
  "meta",
  "os",
  "hyper",
  "super",
  "capslock",
  "dead",
  "altgraph",
  "fn",
  "contextmenu",
]);

/** event.key → the canonical named-key token (matches settings-view's glyph table). */
const NAMED: Record<string, string> = {
  " ": "space",
  spacebar: "space",
  enter: "enter",
  return: "enter",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  pageup: "pageup",
  pagedown: "pagedown",
  home: "home",
  end: "end",
};

/**
 * The single-key token from `event.key` (layout-following). Returns null for a lone
 * modifier. Letters/digits/punctuation lowercase to their char ("K"→"k", "`"→"`"); named
 * keys map through NAMED; function keys (f1…f24) pass through lowercased.
 */
export function captureKeyToken(rawKey: string): string | null {
  const k = rawKey.toLowerCase();
  if (MODIFIER_ONLY.has(k)) return null;
  if (NAMED[k]) return NAMED[k];
  if (rawKey.length === 1) return k;
  return k;
}

/**
 * Translate one keydown into a normalized chord string ("mod+shift+k") or null when the
 * event is not committable (auto-repeat, or a modifier-only press). The PRIMARY accelerator
 * folds to `mod` (⌘ on mac, Ctrl elsewhere) so a chord recorded on mac matches on linux; a
 * LITERAL Ctrl on mac stays `ctrl` (⌃` etc). Modifier order mirrors chordToKeysString
 * (ctrl → alt → shift → mod) so the stored string is registry-shaped.
 */
export function chordFromEvent(e: CaptureKeyEvent, platform: CapturePlatform): string | null {
  if (e.repeat) return null;
  const token = captureKeyToken(e.key);
  if (!token) return null;
  const mods: string[] = [];
  if (platform === "mac" && e.ctrlKey) mods.push("ctrl"); // literal Control (non-primary on mac)
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  const primary = platform === "mac" ? e.metaKey : e.ctrlKey;
  if (primary) mods.push("mod");
  return [...mods, token].join("+");
}

/** True when the event is the bare Escape key (recorder cancel) — no modifiers. */
export function isCancelKey(e: CaptureKeyEvent): boolean {
  return e.key.toLowerCase() === "escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}
