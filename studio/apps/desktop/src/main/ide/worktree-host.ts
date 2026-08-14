/**
 * main/ide/worktree-host.ts — the desktop IPC's worktree backend (Task #5, desktop parity).
 *
 * Thin main-process wrapper over `@prometheus/core/git-worktree` — the SAME
 * dependency-injected functions the CLI's `/worktree` slash (CLI-054) calls, so desktop does
 * not reimplement the trust rules (option-injection guard, never `--force`, the
 * locked/dirty refusal). Only the presentation differs: the CLI's `/worktree remove` asks
 * an interactive typed confirmation (`ctx.ask`); a single IPC round-trip has no such
 * back-and-forth, so `removeWorktreeChecked` re-derives the SAME refusal (locked → refuse,
 * dirty → refuse) from a fresh `listWorktrees`/`isDirty` call server-side — the renderer's own
 * confirm dialog is a UX nicety, never the security boundary.
 *
 * `spawn` is the same `GitSpawn` seam core exports (engine-bridge's `execCapture`, shell-free,
 * sandboxed env, hard timeout) — injectable so node:test never spawns real git.
 */
import {
  type GitSpawn,
  type Worktree,
  addWorktree,
  isDirty,
  isGitRepo,
  listWorktrees,
  realGitSpawn,
  removeWorktree,
  samePath,
} from "@prometheus/core/git-worktree";

export interface WorktreeListResult {
  ok: boolean;
  worktrees: Worktree[];
  error?: string;
}

export interface WorktreeOpResult {
  ok: boolean;
  path?: string;
  message: string;
}

/** List worktrees, or a typed `not a git repository` refusal (never throws). */
export async function listWorktreesChecked(
  root: string,
  spawn: GitSpawn = realGitSpawn,
): Promise<WorktreeListResult> {
  if (!(await isGitRepo(root, spawn))) {
    return { ok: false, worktrees: [], error: "not a git repository" };
  }
  return { ok: true, worktrees: await listWorktrees(root, spawn) };
}

/** Create a worktree for `branch` (new or existing) — see `addWorktree` for the safety rules. */
export async function createWorktreeChecked(
  root: string,
  branch: string,
  path?: string,
  spawn: GitSpawn = realGitSpawn,
): Promise<WorktreeOpResult> {
  if (!(await isGitRepo(root, spawn))) {
    return { ok: false, message: "not a git repository" };
  }
  return addWorktree(root, branch, path, spawn);
}

/**
 * Remove a worktree by path — refuses a locked or dirty worktree (NEVER `--force`), exactly
 * like the CLI's `/worktree remove` after its typed confirmation. The renderer is expected to
 * have already confirmed with the user; this is the fail-closed re-check, not a formality.
 */
export async function removeWorktreeChecked(
  root: string,
  path: string,
  spawn: GitSpawn = realGitSpawn,
): Promise<WorktreeOpResult> {
  if (!(await isGitRepo(root, spawn))) {
    return { ok: false, message: "not a git repository" };
  }
  const wts = await listWorktrees(root, spawn);
  const match = wts.find((w) => w.path === path || samePath(path, w.path));
  if (!match) {
    return { ok: false, message: `no worktree matches "${path}"` };
  }
  if (match.locked) {
    return {
      ok: false,
      message: `worktree is locked${typeof match.locked === "string" ? `: ${match.locked}` : ""} — unlock it first`,
    };
  }
  const dirty = await isDirty(match.path, spawn);
  if (dirty.dirty) {
    return {
      ok: false,
      message: `refusing to remove a dirty worktree — ${dirty.tracked} tracked · ${dirty.untracked} untracked file(s). Commit/stash or clean it first.`,
    };
  }
  const r = await removeWorktree(root, match.path, spawn);
  return r.ok
    ? { ok: true, path: match.path, message: `removed ${match.path}` }
    : { ok: false, message: r.stderr.trim() || "remove failed" };
}
