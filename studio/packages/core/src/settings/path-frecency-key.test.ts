/**
 * path-frecency-key.test.ts — pins the `completion.pathFrecency` settings key (the
 * desktop's "Tools ▸ Path Completion" toggle, and the shared source of truth the CLI's
 * `/tab-complete` conceptually mirrors): it resolves through `findNodeBySchemaKey` (the
 * settings IPC accept-gate), defaults to OFF, and the validator keeps only a real boolean.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SETTINGS, validateSettings } from "./schema.js";
import { findNodeBySchemaKey } from "./tree.js";

test("completion.pathFrecency is a known schemaKey (settings IPC would accept get/set/reset)", () => {
  const node = findNodeBySchemaKey("completion.pathFrecency");
  assert.ok(node, "tools.pathCompletion node must carry the completion.pathFrecency schemaKey");
  assert.equal(node?.id, "tools.pathCompletion");
  assert.equal(node?.control, "toggle");
});

test("DEFAULT_SETTINGS['completion.pathFrecency'] is off", () => {
  assert.equal(DEFAULT_SETTINGS["completion.pathFrecency"], false);
});

test("validateSettings keeps a real boolean, drops a corrupt value (never leaks a wrong type)", () => {
  assert.equal(
    validateSettings({ "completion.pathFrecency": true })["completion.pathFrecency"],
    true,
  );
  assert.equal(
    "completion.pathFrecency" in validateSettings({ "completion.pathFrecency": "yes" }),
    false,
  );
});
