/**
 * settings-view.test.ts — pure Settings display helpers (file 13): tree filter + key glyphs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { detectConflicts, normalizeKeys } from "@prometheus/core/keymap";
import {
  type SettingsNodeView,
  bindingHasConflict,
  filterNodes,
  flattenNodes,
  formatKeys,
  isEditableControl,
  normalizeForDisplay,
} from "./settings-view.js";

const TREE: SettingsNodeView[] = [
  {
    id: "editor",
    title: "Editor",
    category: "root",
    ownerFile: "07",
    children: [
      {
        id: "editor.font",
        title: "Font",
        category: "Editor",
        ownerFile: "08",
        searchTerms: ["ligatures"],
      },
      {
        id: "editor.todo",
        title: "TODO",
        category: "Editor",
        ownerFile: "13",
        searchTerms: ["fixme"],
      },
    ],
  },
  {
    id: "keymap",
    title: "Keymap",
    category: "root",
    ownerFile: "13",
    searchTerms: ["shortcut", "vim"],
  },
];

test("flattenNodes expands children depth-first", () => {
  assert.deepEqual(
    flattenNodes(TREE).map((n) => n.id),
    ["editor", "editor.font", "editor.todo", "keymap"],
  );
});

test("filterNodes matches title + searchTerms; empty query returns all", () => {
  assert.deepEqual(
    filterNodes(TREE, "font").map((n) => n.id),
    ["editor.font"],
  );
  assert.ok(filterNodes(TREE, "vim").some((n) => n.id === "keymap")); // via searchTerms
  assert.equal(filterNodes(TREE, "").length, flattenNodes(TREE).length);
});

test("filterNodes ranks title matches before searchTerm matches", () => {
  const res = filterNodes(TREE, "editor");
  assert.equal(res[0]?.id, "editor", "the title-matching node comes first");
});

test("formatKeys renders platform glyphs for chords", () => {
  assert.equal(formatKeys("cmd+shift+p"), "⌘⇧P");
  assert.equal(formatKeys("ctrl+`"), "⌃`");
  assert.equal(formatKeys("g d"), "G D");
  assert.equal(formatKeys("alt+enter"), "⌥⏎");
});

test("isEditableControl: scalar controls with scalar values are editable", () => {
  assert.equal(isEditableControl("toggle", true), true);
  assert.equal(isEditableControl("number", 5), true);
  assert.equal(isEditableControl("text", "hi"), true);
  assert.equal(isEditableControl("select", "opt"), true);
  assert.equal(isEditableControl("color", "#fff"), true);
  assert.equal(isEditableControl("text", undefined), true); // no value yet is still editable
});

test("isEditableControl: page/custom/keymap controls are never editable", () => {
  assert.equal(isEditableControl("page", "anything"), false);
  assert.equal(isEditableControl("custom", "anything"), false);
  assert.equal(isEditableControl("keymap", { id: "pycharm" }), false);
  assert.equal(isEditableControl(undefined, "x"), false);
});

test("isEditableControl: a structured (object/array) value is never editable, even under a scalar control", () => {
  assert.equal(isEditableControl("text", { nested: true }), false);
  assert.equal(isEditableControl("select", [1, 2, 3]), false);
});

test("conflict highlighting normalizes cmd/ctrl and modifier order", () => {
  const conflicts = new Set([normalizeForDisplay("cmd+k")]);
  assert.equal(
    bindingHasConflict({ command: "x", keys: "ctrl+k", source: "user" }, conflicts),
    true,
  );
  assert.equal(
    bindingHasConflict({ command: "y", keys: "cmd+j", source: "user" }, conflicts),
    false,
  );
});

test("normalizeForDisplay MATCHES core normalizeKeys so a real conflict set (built from core) highlights", () => {
  // the bug: the local normalizer sorted the key in with the mods (`cmd+shift+p` → `p+…`),
  // never matching a conflict SET built from core's `normalizeKeys` (`shift+mod+p`). Parity now.
  for (const k of ["cmd+shift+p", "cmd+k", "ctrl+alt+f10", "shift+cmd+o"]) {
    assert.equal(normalizeForDisplay(k), normalizeKeys(k, true), k);
  }
  // end-to-end: a conflict set built the way KeymapPage builds it (core detectConflicts) must
  // light up the display row for a colliding binding.
  const conflicts = detectConflicts([
    { command: "a", keys: "cmd+shift+p", source: "preset" },
    { command: "b", keys: "cmd+shift+p", source: "preset" },
  ]);
  const set = new Set(conflicts.map((c) => c.keys));
  assert.equal(
    bindingHasConflict({ command: "a", keys: "cmd+shift+p", source: "preset" }, set),
    true,
  );
});
