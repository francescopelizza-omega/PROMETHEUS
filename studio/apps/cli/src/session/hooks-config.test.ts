/**
 * hooks-config.test.ts — the two-layer resolution of the user's lifecycle hooks.
 *
 * The failure this guards is a settings file that is READ but not obeyed: a workspace
 * `.prometheus/settings.json` that declares no hooks silently inheriting the user's global
 * ones (or the reverse — a global list disappearing the moment a repo has a settings file at
 * all). §7.1 says arrays REPLACE, and "present, even empty" has to be distinguishable from
 * "not set" for that rule to mean anything.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadHooks, loadHooksDetailed, workspaceSettingsPath } from "./hooks-config.js";

const GLOBAL = {
  hooks: [{ event: "PreToolUse", command: "global-guard.sh" }],
};

test("with no workspace layer the global hooks apply", () => {
  assert.deepEqual(loadHooks({ globalSettings: GLOBAL }), [
    { event: "PreToolUse", command: "global-guard.sh" },
  ]);
});

test("a workspace layer that omits `hooks` INHERITS the global list", () => {
  // Merely having a `.prometheus/settings.json` (for a theme, say) must not disarm the user's
  // own hooks — that would be a silent security regression triggered by an unrelated setting.
  assert.deepEqual(loadHooks({ globalSettings: GLOBAL, workspaceSettings: { theme: "dark" } }), [
    { event: "PreToolUse", command: "global-guard.sh" },
  ]);
});

test("a workspace layer that SETS `hooks` replaces the global list (arrays replace, §7.1)", () => {
  assert.deepEqual(
    loadHooks({
      globalSettings: GLOBAL,
      workspaceSettings: { hooks: [{ event: "PostToolUse", command: "repo-log.sh" }] },
    }),
    [{ event: "PostToolUse", command: "repo-log.sh" }],
  );
});

test('a workspace `"hooks": []` means "no hooks in this project", not "keep the global ones"', () => {
  assert.deepEqual(loadHooks({ globalSettings: GLOBAL, workspaceSettings: { hooks: [] } }), []);
});

test("a malformed row is dropped, the rest survive (a typo must not disarm every hook)", () => {
  assert.deepEqual(
    loadHooks({
      globalSettings: {
        hooks: [
          { event: "Whoops", command: "x.sh" },
          { event: "PreToolUse", command: "guard.sh", matcher: "write_*" },
        ],
      },
    }),
    [{ event: "PreToolUse", command: "guard.sh", matcher: "write_*" }],
  );
});

test("a corrupt `hooks` value yields [] rather than throwing the session open", () => {
  assert.deepEqual(loadHooks({ globalSettings: { hooks: "guard.sh" } }), []);
  assert.deepEqual(loadHooks({ globalSettings: {} }), []);
});

test("an unreadable workspace file contributes nothing (the global layer still applies)", () => {
  // `cwd` points at a directory with no `.prometheus/settings.json`, which is the ordinary case.
  assert.deepEqual(loadHooks({ globalSettings: GLOBAL, cwd: "/nonexistent-repo-9f2a" }), [
    { event: "PreToolUse", command: "global-guard.sh" },
  ]);
});

test("the workspace layer is <root>/.prometheus/settings.json", () => {
  assert.equal(workspaceSettingsPath("/repo"), "/repo/.prometheus/settings.json");
});

/* ── loadHooksDetailed: the source tag /hooks (CLI-102) reads to say "global" vs "workspace" ── */

test("loadHooksDetailed: no workspace layer → source is global", () => {
  assert.deepEqual(loadHooksDetailed({ globalSettings: GLOBAL }), {
    hooks: [{ event: "PreToolUse", command: "global-guard.sh" }],
    source: "global",
  });
});

test("loadHooksDetailed: a workspace layer that omits `hooks` still reports source global", () => {
  // The EFFECTIVE list is the inherited global one, so the source it's attributed to must be
  // global too — reporting "workspace" here would tell a user to go edit the wrong file.
  assert.deepEqual(
    loadHooksDetailed({ globalSettings: GLOBAL, workspaceSettings: { theme: "dark" } }),
    { hooks: [{ event: "PreToolUse", command: "global-guard.sh" }], source: "global" },
  );
});

test("loadHooksDetailed: a workspace layer that SETS `hooks` reports source workspace", () => {
  assert.deepEqual(
    loadHooksDetailed({
      globalSettings: GLOBAL,
      workspaceSettings: { hooks: [{ event: "PostToolUse", command: "repo-log.sh" }] },
    }),
    { hooks: [{ event: "PostToolUse", command: "repo-log.sh" }], source: "workspace" },
  );
});

test('loadHooksDetailed: a workspace `"hooks": []` is source workspace too (an explicit "none")', () => {
  assert.deepEqual(
    loadHooksDetailed({ globalSettings: GLOBAL, workspaceSettings: { hooks: [] } }),
    { hooks: [], source: "workspace" },
  );
});

test("loadHooksDetailed: zero-config default is [] with source global", () => {
  assert.deepEqual(loadHooksDetailed({ globalSettings: {} }), { hooks: [], source: "global" });
});
