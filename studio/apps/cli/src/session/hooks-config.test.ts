/**
 * hooks-config.test.ts — loading the two raw lifecycle-hook layers.
 *
 * This module no longer decides which layer wins — it just loads both, unfiltered, for
 * `hooks-trust.ts` to vet. See hooks-trust.test.ts for the narrow/scan/confirm behavior.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadHooksDetailed, workspaceSettingsPath } from "./hooks-config.js";

const GLOBAL = {
  hooks: [{ event: "PreToolUse", command: "global-guard.sh" }],
};

test("with no workspace layer, workspaceHooks is undefined and globalHooks is the global list", () => {
  assert.deepEqual(loadHooksDetailed({ globalSettings: GLOBAL }), {
    globalHooks: [{ event: "PreToolUse", command: "global-guard.sh" }],
    workspaceHooks: undefined,
  });
});

test("a workspace layer that omits `hooks` still reports workspaceHooks as undefined", () => {
  // Merely having a `.prometheus/settings.json` (for a theme, say) must not disarm the user's
  // own hooks — that would be a silent security regression triggered by an unrelated setting.
  assert.deepEqual(
    loadHooksDetailed({ globalSettings: GLOBAL, workspaceSettings: { theme: "dark" } }),
    {
      globalHooks: [{ event: "PreToolUse", command: "global-guard.sh" }],
      workspaceHooks: undefined,
    },
  );
});

test("a workspace layer that SETS `hooks` reports it separately — global is untouched here", () => {
  assert.deepEqual(
    loadHooksDetailed({
      globalSettings: GLOBAL,
      workspaceSettings: { hooks: [{ event: "PostToolUse", command: "repo-log.sh" }] },
    }),
    {
      globalHooks: [{ event: "PreToolUse", command: "global-guard.sh" }],
      workspaceHooks: [{ event: "PostToolUse", command: "repo-log.sh" }],
    },
  );
});

test('a workspace `"hooks": []` reports workspaceHooks as [] (an explicit "none"), not undefined', () => {
  assert.deepEqual(
    loadHooksDetailed({ globalSettings: GLOBAL, workspaceSettings: { hooks: [] } }),
    {
      globalHooks: [{ event: "PreToolUse", command: "global-guard.sh" }],
      workspaceHooks: [],
    },
  );
});

test("a malformed row is dropped, the rest survive (a typo must not disarm every hook)", () => {
  assert.deepEqual(
    loadHooksDetailed({
      globalSettings: {
        hooks: [
          { event: "Whoops", command: "x.sh" },
          { event: "PreToolUse", command: "guard.sh", matcher: "write_*" },
        ],
      },
    }),
    {
      globalHooks: [{ event: "PreToolUse", command: "guard.sh", matcher: "write_*" }],
      workspaceHooks: undefined,
    },
  );
});

test("a corrupt `hooks` value yields [] rather than throwing the session open", () => {
  assert.deepEqual(loadHooksDetailed({ globalSettings: { hooks: "guard.sh" } }).globalHooks, []);
  assert.deepEqual(loadHooksDetailed({ globalSettings: {} }).globalHooks, []);
});

test("an unreadable workspace file contributes nothing (the global layer still applies)", () => {
  // `cwd` points at a directory with no `.prometheus/settings.json`, which is the ordinary case.
  assert.deepEqual(loadHooksDetailed({ globalSettings: GLOBAL, cwd: "/nonexistent-repo-9f2a" }), {
    globalHooks: [{ event: "PreToolUse", command: "global-guard.sh" }],
    workspaceHooks: undefined,
  });
});

test("the workspace layer is <root>/.prometheus/settings.json", () => {
  assert.equal(workspaceSettingsPath("/repo"), "/repo/.prometheus/settings.json");
});

test("zero-config default is globalHooks: [], workspaceHooks: undefined", () => {
  assert.deepEqual(loadHooksDetailed({ globalSettings: {} }), {
    globalHooks: [],
    workspaceHooks: undefined,
  });
});
