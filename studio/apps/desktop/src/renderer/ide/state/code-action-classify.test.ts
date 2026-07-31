/**
 * code-action-classify.test.ts — node:test for the code-action run classifier (APP-078).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCodeAction } from "./code-action-classify.js";

test("edit-carrying action → kind:edit (unchanged behaviour)", () => {
  assert.deepEqual(classifyCodeAction({ edit: { changes: {} } }), { kind: "edit" });
  // edit takes precedence even if a command is also present.
  assert.deepEqual(classifyCodeAction({ edit: {}, command: { command: "x" } }), { kind: "edit" });
});

test("command-only action → kind:command with the command + arguments", () => {
  assert.deepEqual(
    classifyCodeAction({ command: { command: "pyright.organizeimports", arguments: [1] } }),
    {
      kind: "command",
      command: "pyright.organizeimports",
      arguments: [1],
    },
  );
  // missing arguments → empty array.
  assert.deepEqual(classifyCodeAction({ command: { command: "c" } }), {
    kind: "command",
    command: "c",
    arguments: [],
  });
});

test("neither edit nor command → skip (previously silently dropped)", () => {
  assert.deepEqual(classifyCodeAction({ title: "noop" } as never), { kind: "skip" });
  assert.deepEqual(classifyCodeAction(null), { kind: "skip" });
  assert.deepEqual(classifyCodeAction({ command: { title: "no command field" } }), {
    kind: "skip",
  });
});
