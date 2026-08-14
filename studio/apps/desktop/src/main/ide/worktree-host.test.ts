/**
 * worktree-host.test.ts — desktop's worktree IPC backend, with a FAKE `GitSpawn` (no real git).
 *
 * Mirrors apps/cli/src/session/git-helpers.test.ts's `fakeGit` harness (same seam, same shape)
 * so the two suites read as the same test for the same underlying functions — the point of
 * Task #5 is that desktop calls the EXACT functions the CLI does, not a reimplementation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { GitSpawn } from "@prometheus/core/git-worktree";

import {
  createWorktreeChecked,
  listWorktreesChecked,
  removeWorktreeChecked,
} from "./worktree-host.js";

/** A scripted fake spawn: records argv, replies from a matcher list (first match wins). */
function fakeGit(script: Array<[RegExp, { code: number; stdout?: string; stderr?: string }]>): {
  spawn: GitSpawn;
  argv: string[][];
} {
  const argv: string[][] = [];
  const spawn: GitSpawn = async (args) => {
    argv.push(args);
    const joined = args.join(" ");
    for (const [rx, res] of script) {
      if (rx.test(joined))
        return { code: res.code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { spawn, argv };
}

const REPO_YES: [RegExp, { code: number; stdout?: string }] = [
  /is-inside-work-tree/,
  { code: 0, stdout: "true\n" },
];
const REPO_NO: [RegExp, { code: number; stdout?: string; stderr?: string }] = [
  /is-inside-work-tree/,
  { code: 128, stderr: "fatal: not a git repository" },
];

test("listWorktreesChecked: refuses a non-repo before any list spawn", async () => {
  const { spawn } = fakeGit([REPO_NO]);
  const r = await listWorktreesChecked("/x", spawn);
  assert.equal(r.ok, false);
  assert.equal(r.worktrees.length, 0);
  assert.match(r.error ?? "", /not a git repository/);
});

test("listWorktreesChecked: parses `git worktree list --porcelain` in a real repo", async () => {
  const porcelain = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n";
  const { spawn } = fakeGit([REPO_YES, [/worktree list/, { code: 0, stdout: porcelain }]]);
  const r = await listWorktreesChecked("/repo", spawn);
  assert.equal(r.ok, true);
  assert.equal(r.worktrees.length, 1);
  assert.equal(r.worktrees[0]?.branch, "main");
});

test("createWorktreeChecked: refuses a non-repo; else delegates to addWorktree (new branch → -b)", async () => {
  const refused = await createWorktreeChecked(
    "/x",
    "feature/y",
    undefined,
    fakeGit([REPO_NO]).spawn,
  );
  assert.equal(refused.ok, false);
  assert.match(refused.message, /not a git repository/);

  const { spawn, argv } = fakeGit([
    REPO_YES,
    [/rev-parse --verify refs\/heads\/feature\/y/, { code: 1, stderr: "not found" }],
    [/check-ref-format/, { code: 0 }],
    [/worktree list/, { code: 0, stdout: "" }],
    [/rev-parse --show-toplevel/, { code: 0, stdout: "/repo\n" }],
    [/worktree add/, { code: 0, stdout: "" }],
  ]);
  const r = await createWorktreeChecked("/repo", "feature/y", undefined, spawn);
  assert.equal(r.ok, true);
  assert.equal(r.path, "./repo-wt-feature-y");
  const addCall = argv.find((a) => a.includes("add"));
  assert.ok(addCall?.includes("-b"));
});

test("createWorktreeChecked: option-injection is refused before any spawn (unsafe branch)", async () => {
  const { spawn, argv } = fakeGit([REPO_YES]);
  const r = await createWorktreeChecked("/repo", "--upload-pack=evil", undefined, spawn);
  assert.equal(r.ok, false);
  assert.match(r.message, /unsafe branch/);
  // only the isGitRepo probe spawned — addWorktree never reached a second spawn.
  assert.equal(argv.length, 1);
});

test("removeWorktreeChecked: refuses when no worktree matches the path", async () => {
  const { spawn } = fakeGit([REPO_YES, [/worktree list/, { code: 0, stdout: "" }]]);
  const r = await removeWorktreeChecked("/repo", "/nope", spawn);
  assert.equal(r.ok, false);
  assert.match(r.message, /no worktree matches/);
});

test("removeWorktreeChecked: refuses a locked worktree WITHOUT checking dirty/removing", async () => {
  const porcelain = "worktree /repo-wt-x\nHEAD abc\nbranch refs/heads/x\nlocked reason\n\n";
  const { spawn, argv } = fakeGit([REPO_YES, [/worktree list/, { code: 0, stdout: porcelain }]]);
  const r = await removeWorktreeChecked("/repo", "/repo-wt-x", spawn);
  assert.equal(r.ok, false);
  assert.match(r.message, /locked/);
  assert.match(r.message, /reason/);
  assert.ok(!argv.some((a) => a.includes("status")), "must not probe dirty state on a locked wt");
  assert.ok(!argv.some((a) => a.includes("remove")), "must never remove a locked worktree");
});

test("removeWorktreeChecked: refuses a dirty worktree; never passes --force", async () => {
  const porcelain = "worktree /repo-wt-x\nHEAD abc\nbranch refs/heads/x\n\n";
  const { spawn, argv } = fakeGit([
    REPO_YES,
    [/worktree list/, { code: 0, stdout: porcelain }],
    [/status --porcelain/, { code: 0, stdout: " M dirty.txt\n" }],
  ]);
  const r = await removeWorktreeChecked("/repo", "/repo-wt-x", spawn);
  assert.equal(r.ok, false);
  assert.match(r.message, /dirty/);
  assert.ok(!argv.some((a) => a.includes("remove")));
});

test("removeWorktreeChecked: removes a clean, unlocked worktree without --force", async () => {
  const porcelain = "worktree /repo-wt-x\nHEAD abc\nbranch refs/heads/x\n\n";
  const { spawn, argv } = fakeGit([
    REPO_YES,
    [/worktree list/, { code: 0, stdout: porcelain }],
    [/status --porcelain/, { code: 0, stdout: "" }],
    [/worktree remove/, { code: 0, stdout: "" }],
  ]);
  const r = await removeWorktreeChecked("/repo", "/repo-wt-x", spawn);
  assert.equal(r.ok, true);
  assert.equal(r.path, "/repo-wt-x");
  const removeCall = argv.find((a) => a.includes("remove"));
  assert.ok(removeCall && !removeCall.includes("--force"));
});
