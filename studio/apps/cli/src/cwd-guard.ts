// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * cwd-guard.ts — the ONE place every CLI entry point resolves its working directory through,
 * so none of them can ever end up pointed at Prometheus's OWN source repo.
 *
 * This isn't hypothetical: over the course of this project's own development, live agent
 * testing was repeatedly run with `cwd` pointed straight at this very repo — mixing test
 * traffic into the codebase's own working tree and its author's real `~/.prometheus` session
 * history. `startup`/`explicit` below are the two shapes every call site needs: a session
 * START (an explicit `--cwd` flag, a scheduled task's `cwd`, or the raw `process.cwd()`
 * fallback) and an EXPLICIT mid-session move (`/cd`), which needs the full `CwdGuardResult` to
 * build its own user-facing message rather than a canned one.
 *
 * `findOwnWorkspaceRoot` walks up from THIS module's own on-disk location — so it finds the
 * repo root whether this file is running from `src/` (tsx dev) or a built `dist/`, and finds
 * NOTHING at all for a normal installed/packaged Prometheus (no source checkout anywhere on
 * disk), where the guard is correctly always a no-op. Discovered ONCE per process and cached —
 * a startup-time fs walk, never a per-call one.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expandHome } from "@prometheus/core/agent-system-host";
import {
  type CwdGuardResult,
  type PackageJsonFs,
  findOwnWorkspaceRoot,
  guardCwd,
} from "@prometheus/core/agent-system-host";

const nodeStat = { statSync };

const realPackageJsonFs: PackageJsonFs = {
  packageNameAt(dir) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
      return typeof pkg.name === "string" ? pkg.name : undefined;
    } catch {
      return undefined;
    }
  },
};

const UNRESOLVED = Symbol("unresolved");
let cachedOwnRepoRoot: string | undefined | typeof UNRESOLVED = UNRESOLVED;

/** The directory of Prometheus's own source checkout, or undefined — memoized per process.
 *  Exposed (not just used internally) so a host with its own module layout can pass a
 *  DIFFERENT `startDir` once via `resetOwnRepoRootCache` in a test, without needing a real
 *  monorepo checkout on the test machine. */
export function ownRepoRoot(): string | undefined {
  if (cachedOwnRepoRoot === UNRESOLVED) {
    cachedOwnRepoRoot = findOwnWorkspaceRoot(
      dirname(fileURLToPath(import.meta.url)),
      realPackageJsonFs,
    );
  }
  return cachedOwnRepoRoot;
}

/** Test-only: force the next `ownRepoRoot()` call to re-discover (or inject a fixed value). */
export function resetOwnRepoRootCache(
  value: string | undefined | typeof UNRESOLVED = UNRESOLVED,
): void {
  cachedOwnRepoRoot = value;
}

/** The full guard decision for an explicit target (e.g. `/cd`'s argument) — the caller builds
 *  its own user-facing message from `redirected`/`requestedCwd`. */
export function guardOwnRepo(target: string): CwdGuardResult {
  return guardCwd(target, ownRepoRoot(), homedir());
}

/**
 * Redirect notices already shown this process, keyed `from → to`.
 *
 * A single `prometheus` run resolves the cwd TWICE when the modern TUI cannot start: the TUI
 * bridge resolves it (`tui/session-bridge.ts`), throws afterwards, and the readline host then
 * resolves it again (`session/host.ts`) — so the user was told twice, in consecutive lines, that
 * their cwd had been redirected. The redirect itself is idempotent and must keep happening on
 * every call; only the NOTICE is deduplicated.
 */
const announcedRedirects = new Set<string>();

/** Test-only: forget which redirect notices have been printed this process. */
export function resetCwdNoticeCache(): void {
  announcedRedirects.clear();
}

/**
 * Resolve the working directory a CLI run should actually use: `requested` (an explicit
 * `--cwd` flag or a scheduled task's own `cwd`) or the real `process.cwd()`, redirected to the
 * user's home directory when it lands inside Prometheus's own repo. `write`, when given, prints
 * a one-line notice — omit it for a call site with no output sink handy; the redirect still
 * happens either way (this must never be a silent-only-with-a-writer safety net).
 *
 * The notice is printed at most ONCE per `from → to` pair per process — see
 * `announcedRedirects`. A second call still returns the redirected path.
 */
export function resolveCwd(requested: string | undefined, write?: (line: string) => void): string {
  const guard = guardCwd(requested ?? process.cwd(), ownRepoRoot(), homedir());
  if (guard.redirected) {
    const key = `${guard.requestedCwd}\u0000${guard.cwd}`;
    if (!announcedRedirects.has(key)) {
      announcedRedirects.add(key);
      write?.(
        `⚠ Prometheus refuses to operate inside its own repository (${guard.requestedCwd}) — redirected to ${guard.cwd}.`,
      );
    }
  }
  return guard.cwd;
}

/** The outcome of an explicit mid-session move (`/cwd`, `/cd`, `/worktree switch`). */
export type CwdMove =
  | { ok: true; cwd: string; redirectedFrom?: string }
  | {
      ok: false;
      error: string;
      /**
       * The target does not exist YET — as opposed to existing and being a file, or being
       * unreadable. Only this case is offerable as "create it?": the other two are answers,
       * not gaps, and `mkdir -p` over a file would fail anyway.
       */
      missing?: boolean;
      /** the fully resolved, guard-applied target — what a `create` would have to mkdir. */
      path?: string;
    };

/**
 * Resolve an EXPLICIT mid-session directory change, all the way to a real directory.
 *
 * `/cd` validated its target with `statSync` and reported `no such directory: …`; `/cwd` did
 * not — it expanded, resolved, guarded, and moved. So `/cwd /definitely/not/here` printed a
 * confident `cwd → /definitely/not/here` and pointed the whole session, its agent files, its
 * permission rules and its repo map at a directory that does not exist. The confirmation was
 * unconditional, which is exactly why it read as no confirmation at all.
 *
 * Both hosts and both commands go through here so the two can never drift again: the readline
 * host and the raw TUI each had their own copy of the expand → resolve → guard sequence, and
 * only one of them had ever grown the existence check.
 *
 * `from` is the directory a RELATIVE path resolves against — the session's current cwd, not
 * `process.cwd()`, which the CLI never chdir's.
 */
export function resolveCwdMove(
  dir: string,
  from: string,
  fs: { statSync: (p: string) => { isDirectory(): boolean } } = nodeStat,
): CwdMove {
  const trimmed = dir.trim();
  if (!trimmed) return { ok: false, error: "no directory given" };
  // `~`/`~/…` first — `isAbsolute("~/x")` is false, so without this a tilde path resolves
  // against the CURRENT directory instead of home.
  const expanded = expandHome(trimmed);
  const requested = isAbsolute(expanded) ? expanded : resolve(from, expanded);
  const guard = guardOwnRepo(requested);
  let stat: { isDirectory(): boolean };
  try {
    stat = fs.statSync(guard.cwd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { ok: false, error: `no such directory: ${guard.cwd}`, missing: true, path: guard.cwd }
      : { ok: false, error: `cannot access ${guard.cwd}: ${(err as Error).message}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${guard.cwd}`, path: guard.cwd };
  }
  return guard.redirected
    ? { ok: true, cwd: guard.cwd, redirectedFrom: guard.requestedCwd }
    : { ok: true, cwd: guard.cwd };
}
