/**
 * templates-key.test.ts — pins the APP-020 `templates.user` settings key: it resolves
 * through `findNodeBySchemaKey` (the settings IPC accept-gate), defaults to [], and the
 * validator keeps a JSON array while dropping a non-array (so a corrupt layer never leaks
 * a wrong-typed value).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SETTINGS, validateSettings } from "./schema.js";
import { findNodeBySchemaKey, setInLayer } from "./tree.js";

test("templates.user is a known schemaKey (settings IPC would accept get/set/reset)", () => {
  const node = findNodeBySchemaKey("templates.user");
  assert.ok(node, "editor.snippets node must carry the templates.user schemaKey");
  assert.equal(node?.id, "editor.snippets");
});

test("DEFAULT_SETTINGS['templates.user'] is an empty array", () => {
  assert.deepEqual(DEFAULT_SETTINGS["templates.user"], []);
});

test("validateSettings keeps a JSON array of templates, drops a non-array", () => {
  const arr = [
    { abbrev: "log", body: "console.log($1)$0", languages: ["javascript"], kind: "live" },
  ];
  assert.deepEqual(validateSettings({ "templates.user": arr })["templates.user"], arr);
  // a corrupt non-array value is dropped (not fatal, not leaked)
  assert.equal("templates.user" in validateSettings({ "templates.user": "oops" }), false);
});

test("a body with $, backticks, and newlines survives a JSON layer round-trip", () => {
  const arr = [
    {
      abbrev: "tmpl",
      body: "const s = `total: $${1:n}`\n$SELECTION$$END$",
      languages: ["typescript"],
      kind: "surround",
    },
  ];
  const layer = setInLayer({}, "templates.user", arr);
  const roundTripped = JSON.parse(JSON.stringify(layer));
  assert.deepEqual(validateSettings(roundTripped)["templates.user"], arr);
});
