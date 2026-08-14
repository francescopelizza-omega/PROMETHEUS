/**
 * tree.test.ts — the §2.1 Settings tree: shape helpers + provenance resolution (APP-017).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SETTINGS_TREE,
  findNode,
  findNodeBySchemaKey,
  flattenTree,
  nodePath,
  resetInLayer,
  resolveProvenance,
  resolveRows,
  searchSettings,
  setInLayer,
} from "./tree.js";

test("flattenTree: visits parents before children, covers every node", () => {
  const flat = flattenTree();
  assert.ok(flat.length > SETTINGS_TREE.length); // has nested children
  assert.equal(flat[0]?.id, SETTINGS_TREE[0]?.id); // root-first order
});

test("findNode: locates a nested node by id; undefined for unknown", () => {
  const editor = findNode("editor.font");
  assert.equal(editor?.title, "Font");
  assert.equal(findNode("does-not-exist"), undefined);
});

test("findNodeBySchemaKey: locates by persisted key, distinct from id", () => {
  const n = findNodeBySchemaKey("theme");
  assert.equal(n?.id, "appearance");
  assert.equal(findNodeBySchemaKey("no-such-key"), undefined);
});

test("findNodeBySchemaKey: 'hooks' resolves to the Lifecycle Hooks node under AI & Agents", () => {
  const n = findNodeBySchemaKey("hooks");
  assert.equal(n?.id, "ai-agents.hooks");
  assert.equal(n?.title, "Lifecycle Hooks");
  assert.equal(n?.category, "AI & Agents");
  // structured (array) value ⇒ edited on its own page, not a generic scalar control —
  // same convention as templates.user / todoPatterns.
  assert.equal(n?.control, "page");
});

test("hooks: settings:get/settings:set round-trip through setInLayer/resolveProvenance", () => {
  const hooks = [{ event: "PreToolUse", matcher: "write_file", command: "./guard.sh" }];
  // set: a pure layer write, mirroring what the settings:set IPC handler does.
  const global = setInLayer({}, "hooks", hooks);
  assert.deepEqual(global.hooks, hooks);
  // get: resolved through the SAME provenance path settings:get uses.
  const effective = { hooks };
  const row = resolveProvenance("hooks", effective, { global });
  assert.deepEqual(row.value, hooks);
  assert.equal(row.layer, "global");
  // reset: falls back to unset once no layer sets the key.
  const cleared = resetInLayer(global, "hooks");
  assert.equal("hooks" in cleared, false);
  const clearedRow = resolveProvenance("hooks", {}, { global: cleared });
  assert.equal(clearedRow.layer, "unset");
});

test("nodePath: root-to-node breadcrumb", () => {
  const path = nodePath("editor.font");
  assert.deepEqual(
    path.map((n) => n.id),
    ["editor", "editor.font"],
  );
});

test("searchSettings: matches title/category/searchTerms, title-match ranked first", () => {
  // "theme" matches only via searchTerms/schemaKey — no node title contains it.
  const hits = searchSettings("theme");
  assert.ok(hits.some((n) => n.id === "appearance"));
  // "font" has a real title match ("Font") — it must outrank searchTerm-only hits.
  const fontHits = searchSettings("font");
  assert.equal(fontHits[0]?.title.toLowerCase().includes("font"), true);
});

test("resolveProvenance: layer precedence workspace > profile > global > default > unset", () => {
  const effective = { theme: "workspace-value", gateStrict: true, density: "comfortable" };
  const workspaceRow = resolveProvenance("theme", effective, { workspace: { theme: "x" } });
  assert.equal(workspaceRow.layer, "workspace");

  const profileRow = resolveProvenance("gateStrict", effective, {
    global: { gateStrict: false },
    profile: { gateStrict: true },
  });
  assert.equal(profileRow.layer, "profile");

  const globalRow = resolveProvenance("gateStrict", effective, { global: { gateStrict: false } });
  assert.equal(globalRow.layer, "global");

  const defaultRow = resolveProvenance("density", effective, {});
  assert.equal(defaultRow.layer, "default");
  assert.equal(defaultRow.value, "comfortable");

  const unsetRow = resolveProvenance("nope", effective, {});
  assert.equal(unsetRow.layer, "unset");
  assert.equal(unsetRow.value, undefined);
});

test("resolveRows: one row per schemaKey-bearing node, in tree order", () => {
  const effective = { theme: "dracula", keymap: "pycharm" };
  const rows = resolveRows(effective, {});
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => typeof r.schemaKey === "string"));
  const themeRow = rows.find((r) => r.schemaKey === "theme");
  assert.equal(themeRow?.value, "dracula");
  assert.equal(themeRow?.layer, "default");
});

test("setInLayer: pure — returns a NEW object with the key overridden, original untouched", () => {
  const layer = { a: 1 };
  const next = setInLayer(layer, "b", 2);
  assert.deepEqual(next, { a: 1, b: 2 });
  assert.deepEqual(layer, { a: 1 }); // original untouched
  assert.deepEqual(setInLayer(undefined, "a", 1), { a: 1 });
});

test("resetInLayer: pure — removes the key, leaves siblings, undefined layer → {}", () => {
  const layer = { a: 1, b: 2 };
  const next = resetInLayer(layer, "a");
  assert.deepEqual(next, { b: 2 });
  assert.deepEqual(layer, { a: 1, b: 2 }); // original untouched
  assert.deepEqual(resetInLayer(undefined, "a"), {});
});
