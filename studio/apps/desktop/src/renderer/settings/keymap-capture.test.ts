/**
 * keymap-capture.test.ts — the PURE keydown → chord-string translator (APP-057).
 *
 * The recorder's load-bearing logic: modifier folding (primary→mod, literal-ctrl on mac),
 * canonical ordering, named-key mapping, and the never-commit cases (auto-repeat, lone
 * modifier). ChordRecorder.tsx is a thin DOM wrapper over this (no JSX render under
 * node:test — the harness type-strips but does not transform JSX, so the coverage lives
 * here, matching the repo's pure-logic test convention).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeKeys } from "@prometheus/core/keymap";

import { captureKeyToken, chordFromEvent, isCancelKey } from "./keymap-capture.js";

/** Build a CaptureKeyEvent with sane modifier defaults. */
function ev(key: string, mods: Partial<Record<string, boolean>> = {}) {
  return {
    key,
    metaKey: !!mods.metaKey,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    shiftKey: !!mods.shiftKey,
    repeat: !!mods.repeat,
  };
}

test("chordFromEvent: mac primary (⌘) folds to mod; letter lowercased", () => {
  assert.equal(chordFromEvent(ev("K", { metaKey: true }), "mac"), "mod+k");
  // the same physical chord on linux (Ctrl is primary) folds to the SAME mod string.
  assert.equal(chordFromEvent(ev("k", { ctrlKey: true }), "other"), "mod+k");
});

test("chordFromEvent: modifier ordering is canonical + matches normalizeKeys", () => {
  // shift + ⌘ + K → the stored string, and it normalizes identically regardless of order.
  const s = chordFromEvent(ev("k", { metaKey: true, shiftKey: true }), "mac");
  assert.equal(s, "shift+mod+k");
  assert.equal(normalizeKeys(s ?? ""), normalizeKeys("mod+shift+k"));
});

test("chordFromEvent: literal Control on mac stays ctrl (⌃`)", () => {
  assert.equal(chordFromEvent(ev("`", { ctrlKey: true }), "mac"), "ctrl+`");
  // ⌃⌥K on mac → both literal-ctrl and alt present, primary(meta) absent.
  assert.equal(chordFromEvent(ev("k", { ctrlKey: true, altKey: true }), "mac"), "ctrl+alt+k");
});

test("chordFromEvent: named keys map through the token table", () => {
  assert.equal(chordFromEvent(ev("Enter", { metaKey: true }), "mac"), "mod+enter");
  assert.equal(chordFromEvent(ev("ArrowUp"), "mac"), "up");
  assert.equal(chordFromEvent(ev(" ", { metaKey: true }), "mac"), "mod+space");
  assert.equal(chordFromEvent(ev("F5"), "other"), "f5");
});

test("chordFromEvent: never commits on auto-repeat or a lone modifier", () => {
  assert.equal(chordFromEvent(ev("k", { metaKey: true, repeat: true }), "mac"), null);
  assert.equal(chordFromEvent(ev("Shift", { shiftKey: true }), "mac"), null);
  assert.equal(chordFromEvent(ev("Meta", { metaKey: true }), "mac"), null);
  assert.equal(chordFromEvent(ev("Control", { ctrlKey: true }), "other"), null);
});

test("captureKeyToken: letters/named/modifier-only", () => {
  assert.equal(captureKeyToken("A"), "a");
  assert.equal(captureKeyToken("Escape"), "escape");
  assert.equal(captureKeyToken("Alt"), null);
});

test("isCancelKey: bare Escape only (Esc+mod is a real chord)", () => {
  assert.equal(isCancelKey(ev("Escape")), true);
  assert.equal(isCancelKey(ev("Escape", { shiftKey: true })), false);
  assert.equal(isCancelKey(ev("k")), false);
});
