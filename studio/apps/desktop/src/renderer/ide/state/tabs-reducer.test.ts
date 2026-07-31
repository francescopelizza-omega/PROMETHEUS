/**
 * tabs-reducer.test.ts — node:test for the PURE tab / model-swap reducer (§3.1).
 *
 * Pins the one-editor-per-group + model-swap discipline: preview-tab replacement,
 * edit-promotes-to-pinned, close fallback within a group, and split copying the
 * active model into a fresh group. Imports ONLY the pure module — no zustand, no
 * react, no monaco — so it runs under node --test directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activateTab,
  activeDoc,
  closeTab,
  groupIds,
  hasDirty,
  initialTabsState,
  openTab,
  pinTab,
  setDirty,
  splitActive,
  tabsOf,
} from "./tabs-reducer.js";

const O = (name: string, lang = "python") => ({ name, languageId: lang });

test("openTab adds a doc and makes it active in its group", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", O("a.py"));
  assert.equal(s.docs.length, 1);
  assert.equal(activeDoc(s, 0)?.uri, "file:///a.py");
  assert.equal(s.focusedGroup, 0);
});

test("a new preview tab REPLACES the group's existing preview tab", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", { ...O("a.py"), preview: true });
  s = openTab(s, "file:///b.py", { ...O("b.py"), preview: true });
  // only one preview tab survives in group 0.
  assert.equal(tabsOf(s, 0).length, 1);
  assert.equal(activeDoc(s, 0)?.uri, "file:///b.py");
});

test("a pinned tab is NOT replaced by a later preview open", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", { ...O("a.py"), preview: false }); // pinned
  s = openTab(s, "file:///b.py", { ...O("b.py"), preview: true }); // preview
  assert.equal(tabsOf(s, 0).length, 2);
});

test("re-opening a preview tab as an edit PROMOTES it to pinned", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", { ...O("a.py"), preview: true });
  assert.equal(s.docs[0]?.preview, true);
  s = openTab(s, "file:///a.py", { ...O("a.py"), preview: false });
  assert.equal(s.docs[0]?.preview, false);
  assert.equal(s.docs.length, 1); // not duplicated
});

test("setDirty marks dirty and pins a preview tab (an edit pins it)", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", { ...O("a.py"), preview: true });
  s = setDirty(s, "file:///a.py", true);
  assert.equal(s.docs[0]?.dirty, true);
  assert.equal(s.docs[0]?.preview, false);
  assert.equal(hasDirty(s), true);
});

test("closeTab falls back to the previous tab in the same group", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", O("a.py"));
  s = openTab(s, "file:///b.py", O("b.py"));
  s = openTab(s, "file:///c.py", O("c.py")); // active = c
  s = closeTab(s, "file:///c.py");
  assert.equal(activeDoc(s, 0)?.uri, "file:///b.py");
});

test("closeTab on the last tab in a group drops the group's active pointer", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", O("a.py"));
  s = closeTab(s, "file:///a.py");
  assert.equal(activeDoc(s, 0), undefined);
  assert.equal(s.docs.length, 0);
});

test("closeTab is a no-op for an unknown uri", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", O("a.py"));
  const before = s;
  s = closeTab(s, "file:///nope.py");
  assert.equal(s, before);
});

test("splitActive copies the active model into a fresh group", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", O("a.py"));
  const { state, group } = splitActive(s);
  assert.equal(group, 1);
  assert.deepEqual(groupIds(state), [0, 1]);
  // same uri in both groups (Monaco shares the ITextModel).
  assert.equal(activeDoc(state, 0)?.uri, "file:///a.py");
  assert.equal(activeDoc(state, 1)?.uri, "file:///a.py");
  assert.equal(state.focusedGroup, 1);
});

test("activateTab swaps the active model and focuses its group", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", O("a.py"));
  s = openTab(s, "file:///b.py", O("b.py"));
  s = activateTab(s, "file:///a.py");
  assert.equal(activeDoc(s, 0)?.uri, "file:///a.py");
});

test("pinTab promotes a preview tab", () => {
  let s = initialTabsState();
  s = openTab(s, "file:///a.py", { ...O("a.py"), preview: true });
  s = pinTab(s, "file:///a.py");
  assert.equal(s.docs[0]?.preview, false);
});
