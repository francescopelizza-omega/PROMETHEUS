/**
 * editor-commands.test.ts — node:test for the PURE editor-action palette surface.
 *
 * Pins that every command is a routable Monaco editor-action id, ids are unique, titles
 * are present, and the routing predicate is correct. Pure — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EDITOR_ACTION_COMMANDS,
  MONACO_CORE_COMMAND_IDS,
  isEditorActionId,
} from "./editor-commands.js";

test("every command id is a routable editor-action id", () => {
  // isEditorActionId is the single source of truth for "routes to the focused editor"
  // (editor.action.* actions, the APP-074 fold actions, or the allowlisted core commands).
  for (const c of EDITOR_ACTION_COMMANDS) {
    assert.equal(isEditorActionId(c.id), true, c.id);
  }
});

test("multi-caret commands are palette-discoverable (APP-018)", () => {
  const ids = new Set(EDITOR_ACTION_COMMANDS.map((c) => c.id));
  for (const id of [
    "editor.action.insertCursorAbove",
    "editor.action.insertCursorBelow",
    "editor.action.addSelectionToNextFindMatch",
    "editor.action.selectHighlights",
    "cursorUndo",
  ]) {
    assert.equal(ids.has(id), true, id);
  }
  // trigger-only core commands route through the same predicate…
  assert.equal(isEditorActionId("cursorUndo"), true);
  assert.equal(isEditorActionId("cursorColumnSelectDown"), true);
  // …but arbitrary non-allowlisted ids still don't.
  assert.equal(isEditorActionId("cursorHome"), false);
});

test("fold actions route via getAction despite lacking the editor.action. prefix (APP-074)", () => {
  const ids = new Set(EDITOR_ACTION_COMMANDS.map((c) => c.id));
  for (const id of ["editor.foldAll", "editor.unfoldAll", "editor.foldRecursively"]) {
    assert.equal(ids.has(id), true, `${id} palette-discoverable`);
    assert.equal(isEditorActionId(id), true, `${id} routes to the editor`);
  }
});

test("ids are unique", () => {
  const ids = EDITOR_ACTION_COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("titles + category are present", () => {
  for (const c of EDITOR_ACTION_COMMANDS) {
    assert.equal(c.title.length > 0, true, c.id);
    // category is present (Edit for editing actions, Fold for folding — APP-074).
    assert.ok(c.category.length > 0, c.id);
    assert.ok(c.category === "Edit" || c.category === "Fold", `${c.id}:${c.category}`);
  }
});

test("isEditorActionId rejects non-editor ids", () => {
  assert.equal(isEditorActionId("ai.inlineEdit"), false);
  assert.equal(isEditorActionId("git.commit"), false);
  assert.equal(isEditorActionId("editor.newScratchFile"), false);
  assert.equal(isEditorActionId("editor.action.formatDocument"), true);
});
