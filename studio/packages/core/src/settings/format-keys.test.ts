/**
 * format-keys.test.ts — node:test pinning the APP-019 format settings keys are wired
 * into the tree (so the settings IPC accepts them) + validated as booleans.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SETTINGS, validateSettings } from "./schema.js";
import { FORMAT_LANGS, findNodeBySchemaKey } from "./tree.js";

test("format schemaKeys are addressable in the settings tree (settings IPC accepts them)", () => {
  assert.ok(findNodeBySchemaKey("format.onSave"));
  assert.ok(findNodeBySchemaKey("format.optimizeImportsOnSave"));
  for (const l of FORMAT_LANGS) {
    assert.ok(findNodeBySchemaKey(`format.lang.${l.id}`), l.id);
  }
});

test("DEFAULT_SETTINGS: onSave off, per-language flags on", () => {
  assert.equal(DEFAULT_SETTINGS["format.onSave"], false);
  assert.equal(DEFAULT_SETTINGS["format.optimizeImportsOnSave"], false);
  for (const l of FORMAT_LANGS) {
    assert.equal(DEFAULT_SETTINGS[`format.lang.${l.id}`], true, l.id);
  }
});

test("validateSettings keeps boolean format keys, drops non-boolean ones", () => {
  const out = validateSettings({
    "format.onSave": true,
    "format.lang.python": false,
    "format.lang.go": "yes", // wrong type → dropped
    "ext.some.key": 42, // non-format extension key → passes through
  });
  assert.equal(out["format.onSave"], true);
  assert.equal(out["format.lang.python"], false);
  assert.equal("format.lang.go" in out, false);
  assert.equal(out["ext.some.key"], 42);
});
