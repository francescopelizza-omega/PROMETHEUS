/**
 * sidebar-view.test.ts — shell Sidebar pure helpers (APP-002).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { IdeGitStatus } from "../../shared/ipc-contract.js";
import {
  GIT_GROUP_ROW_CAP,
  SIDEBAR_BODY_ACTIVITIES,
  defaultSidebarCollapsed,
  effectiveSidebarCollapsed,
  hasSidebarBody,
  parseSidebarCollapsed,
  summarizeGitStatus,
  toggleSidebarMap,
} from "./sidebar-view.js";

test("hasSidebarBody: true exactly for the registered body activities", () => {
  for (const a of SIDEBAR_BODY_ACTIVITIES) assert.equal(hasSidebarBody(a), true);
  assert.equal(hasSidebarBody("chat"), false);
  assert.equal(hasSidebarBody("docs"), false);
  assert.equal(hasSidebarBody("security"), false);
});

test("defaultSidebarCollapsed: open for body routes, EXCEPT editor (owns its own tools)", () => {
  assert.equal(defaultSidebarCollapsed("home"), false);
  assert.equal(defaultSidebarCollapsed("repos"), false);
  assert.equal(defaultSidebarCollapsed("editor"), true);
  assert.equal(defaultSidebarCollapsed("chat"), true); // body-less → collapsed
});

test("effectiveSidebarCollapsed: explicit per-route override beats the default", () => {
  assert.equal(effectiveSidebarCollapsed({}, "home"), false);
  assert.equal(effectiveSidebarCollapsed({ home: true }, "home"), true);
  assert.equal(effectiveSidebarCollapsed({ editor: false }, "editor"), false);
});

test("parseSidebarCollapsed: v1 boolean migrates to a map over every body activity", () => {
  const m = parseSidebarCollapsed({ sidebarCollapsed: true });
  assert.ok(m);
  for (const a of SIDEBAR_BODY_ACTIVITIES) assert.equal(m[a], true);
  const open = parseSidebarCollapsed({ sidebarCollapsed: false });
  assert.equal(open?.home, false);
});

test("parseSidebarCollapsed: v2 map passes through, non-boolean junk dropped", () => {
  const m = parseSidebarCollapsed({
    sidebarCollapsedByActivity: { home: true, repos: "yes", editor: false },
  });
  assert.deepEqual(m, { home: true, editor: false });
});

test("parseSidebarCollapsed: neither shape (or garbage) → undefined, never throws", () => {
  assert.equal(parseSidebarCollapsed({}), undefined);
  assert.equal(parseSidebarCollapsed({ sidebarCollapsed: "true" }), undefined);
  assert.deepEqual(parseSidebarCollapsed({ sidebarCollapsedByActivity: [] }), undefined);
});

test("toggleSidebarMap: flips the active route's entry both ways", () => {
  const opened = toggleSidebarMap({ home: true }, "home");
  assert.equal(opened.home, false);
  const closed = toggleSidebarMap({}, "repos"); // default open → toggle collapses
  assert.equal(closed.repos, true);
  const editorOpen = toggleSidebarMap({}, "editor"); // default collapsed → toggle opens
  assert.equal(editorOpen.editor, false);
});

test("toggleSidebarMap: BODY-LESS activity is an identity no-op (same reference)", () => {
  const map = { home: true };
  assert.equal(toggleSidebarMap(map, "chat"), map);
  assert.equal(toggleSidebarMap(map, "docs"), map);
});

test("summarizeGitStatus: nullish / failed status → ok:false with an error string", () => {
  assert.equal(summarizeGitStatus(null).ok, false);
  assert.equal(summarizeGitStatus(undefined).ok, false);
  const failed = summarizeGitStatus({ ok: false, error: "not a repo" } as IdeGitStatus);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "not a repo");
});

test("summarizeGitStatus: PARTIAL payload (missing arrays) never throws", () => {
  const s = summarizeGitStatus({ ok: true, branch: "main" } as IdeGitStatus);
  assert.equal(s.ok, true);
  assert.equal(s.branch, "main");
  assert.deepEqual(s.groups, []);
  assert.equal(s.totalChanges, 0);
});

test("summarizeGitStatus: groups, kinds and ahead/behind from a full payload", () => {
  const s = summarizeGitStatus({
    ok: true,
    branch: "dev",
    ahead: 2,
    behind: 1,
    staged: [{ path: "a.ts", staged: "added" }],
    unstaged: [{ path: "b.ts", unstaged: "modified" }, { bogus: true } as never],
    untracked: [{ path: "c.ts" }],
    conflicted: [],
  });
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.deepEqual(
    s.groups.map((g) => [g.label, g.count]),
    [
      ["Staged", 1],
      ["Changes", 1],
      ["Untracked", 1],
    ],
  );
  assert.equal(s.groups[0]?.rows[0]?.kind, "added");
  assert.equal(s.groups[2]?.rows[0]?.kind, "untracked");
  assert.equal(s.totalChanges, 3);
});

test("summarizeGitStatus: rows cap at GIT_GROUP_ROW_CAP, count keeps the true total", () => {
  const many = Array.from({ length: GIT_GROUP_ROW_CAP + 5 }, (_, i) => ({
    path: `f${i}.ts`,
    unstaged: "modified" as const,
  }));
  const s = summarizeGitStatus({
    ok: true,
    staged: [],
    unstaged: many,
    untracked: [],
    conflicted: [],
  });
  assert.equal(s.groups[0]?.count, GIT_GROUP_ROW_CAP + 5);
  assert.equal(s.groups[0]?.rows.length, GIT_GROUP_ROW_CAP);
});
