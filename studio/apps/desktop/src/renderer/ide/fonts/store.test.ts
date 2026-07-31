/**
 * store.test.ts — the font registry + settings store pure logic (no DOM).
 *
 * The store module guards all window/document access, so it loads clean under
 * node:test and returns the PyCharm defaults; we exercise the clamp/coerce rules
 * (size + line-height bounds, unknown-family fallback, ligature-capability drop)
 * that keep a persisted or user-entered value safe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_FONT_FAMILY_ID, familyHasLigatures, resolveFontStack } from "./registry.js";
import {
  DEFAULT_EDITOR_FONT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  useFontStore,
} from "./store.js";

test("resolveFontStack leads with the chosen family + appends the fallback tail", () => {
  const stack = resolveFontStack("jetbrains-mono");
  assert.ok(stack.startsWith('"JetBrains Mono"'), stack);
  assert.match(stack, /monospace$/);
});

test("resolveFontStack falls back to the default family for an unknown id", () => {
  const dflt = resolveFontStack(DEFAULT_FONT_FAMILY_ID);
  assert.equal(resolveFontStack("no-such-font"), dflt);
});

test("familyHasLigatures reflects the registry (JetBrains/Fira yes, IBM Plex no)", () => {
  assert.equal(familyHasLigatures("jetbrains-mono"), true);
  assert.equal(familyHasLigatures("fira-code"), true);
  assert.equal(familyHasLigatures("ibm-plex-mono"), false);
  assert.equal(familyHasLigatures("unknown"), false);
});

test("store starts at the PyCharm defaults", () => {
  useFontStore.getState().resetEditor();
  useFontStore.getState().resetTerminal();
  assert.deepEqual(useFontStore.getState().editor, DEFAULT_EDITOR_FONT);
});

test("setEditor clamps size + line-height to the allowed bounds", () => {
  useFontStore.getState().resetEditor();
  useFontStore.getState().setEditor({ size: 999, lineHeight: 99 });
  assert.equal(useFontStore.getState().editor.size, FONT_SIZE_MAX);
  assert.equal(useFontStore.getState().editor.lineHeight, LINE_HEIGHT_MAX);
  useFontStore.getState().setEditor({ size: 1 });
  assert.equal(useFontStore.getState().editor.size, FONT_SIZE_MIN);
});

test("setEditor ignores an unknown family id (keeps the current one)", () => {
  useFontStore.getState().resetEditor();
  useFontStore.getState().setEditor({ familyId: "totally-made-up" });
  assert.equal(useFontStore.getState().editor.familyId, DEFAULT_FONT_FAMILY_ID);
});

test("ligatures only stick on a ligature-capable family", () => {
  useFontStore.getState().resetEditor();
  // IBM Plex Mono has no ligatures → the request is dropped.
  useFontStore.getState().setEditor({ familyId: "ibm-plex-mono", ligatures: true });
  assert.equal(useFontStore.getState().editor.ligatures, false);
  // Fira Code supports them → the request sticks.
  useFontStore.getState().setEditor({ familyId: "fira-code", ligatures: true });
  assert.equal(useFontStore.getState().editor.ligatures, true);
});

test("editor and terminal configs are independent", () => {
  useFontStore.getState().resetEditor();
  useFontStore.getState().resetTerminal();
  useFontStore.getState().setTerminal({ familyId: "roboto-mono", size: 16 });
  assert.equal(useFontStore.getState().terminal.familyId, "roboto-mono");
  assert.equal(useFontStore.getState().terminal.size, 16);
  // editor untouched
  assert.equal(useFontStore.getState().editor.familyId, DEFAULT_FONT_FAMILY_ID);
});
