// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/host/own-repo-guard.ts — refuse to ever operate with a cwd inside Prometheus's
 * OWN source repo.
 *
 * A session (interactive, headless, or scheduled) pointed at Prometheus's own checkout treats
 * the product's own codebase as an ordinary project: every write/edit/apply_patch/run_command
 * tool the agent has is then free to modify the very tree the running code came from — exactly
 * what happened repeatedly over the course of this project's own development, mixing live
 * agent-testing traffic into this repo's own working tree and its author's real `~/.prometheus`
 * session history. This guard closes that specific, narrow case structurally rather than
 * relying on every caller remembering not to point Prometheus at itself.
 *
 * DETECTION is deliberately narrow: walk up from a starting directory looking for the nearest
 * ancestor whose `package.json` is EXACTLY this repo's own workspace root
 * (`"name": "prometheus-studio-workspace"`, the literal name in this monorepo's own root
 * package.json) — never a generic ".git" or "node_modules" sniff, which would false-positive on
 * an unrelated project. An installed/packaged Prometheus (a global npm install, a bundled
 * Electron app) has no such ancestor anywhere on disk, so the guard is a no-op there: this only
 * ever matters for a source checkout of Prometheus's own monorepo.
 *
 * PURE core: `isInsideRepo`/`guardCwd` take an already-discovered repo root as a plain string —
 * the fs walk that discovers it (`findOwnWorkspaceRoot`) takes an injected `PackageJsonFs`, the
 * same injected-fs discipline every other module in this directory uses, so both halves stay
 * unit-testable without touching a real disk.
 */
import { dirname, resolve, sep } from "node:path";

/** This repo's own root package.json name (see the repo root's own `package.json`). Matching on
 *  this exact string, rather than any looser marker, is what keeps this guard from ever
 *  false-positiving on an unrelated project a user happens to name similarly. */
export const OWN_WORKSPACE_NAME = "prometheus-studio-workspace";

/** The fs surface `findOwnWorkspaceRoot` needs (injected in tests). */
export interface PackageJsonFs {
  /** the parsed `name` field of `<dir>/package.json`, or undefined if missing/unreadable/not JSON. */
  packageNameAt(dir: string): string | undefined;
}

/**
 * Walk up from `startDir` looking for the nearest ancestor whose package.json is Prometheus's
 * own workspace root. Returns that directory, or undefined when none is found on the way to the
 * filesystem root — the ordinary case for an installed/packaged Prometheus with no source
 * checkout on disk at all. Call ONCE per process (from the running module's own location) and
 * cache the result — this is a startup-time check, not a per-request one.
 */
export function findOwnWorkspaceRoot(startDir: string, fs: PackageJsonFs): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (fs.packageNameAt(dir) === OWN_WORKSPACE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root — never found it
    dir = parent;
  }
}

/** Whether `target` IS `repoRoot`, or nested inside it. */
export function isInsideRepo(target: string, repoRoot: string): boolean {
  const t = resolve(target);
  const r = resolve(repoRoot);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

export interface CwdGuardResult {
  /** the cwd to actually use — `homeDir` when redirected, `requested` (resolved) otherwise. */
  cwd: string;
  /** true when `requested` was inside Prometheus's own repo and got redirected away from it. */
  redirected: boolean;
  /** the resolved, ORIGINAL path that triggered the redirect — present only when `redirected`. */
  requestedCwd?: string;
}

/**
 * Redirect `requested` to `homeDir` when it is inside Prometheus's own repo. `ownRepoRoot` is
 * `findOwnWorkspaceRoot`'s result — `undefined` (no source checkout found) is always a
 * pass-through. `homeDir` is whatever the caller resolves as "the user's home" (`os.homedir()`
 * in every real caller); passed in, not read here, so this stays a pure, string-only function.
 */
export function guardCwd(
  requested: string,
  ownRepoRoot: string | undefined,
  homeDir: string,
): CwdGuardResult {
  if (ownRepoRoot && isInsideRepo(requested, ownRepoRoot)) {
    return { cwd: resolve(homeDir), redirected: true, requestedCwd: resolve(requested) };
  }
  return { cwd: resolve(requested), redirected: false };
}
