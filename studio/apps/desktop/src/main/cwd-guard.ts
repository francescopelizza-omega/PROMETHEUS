// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/cwd-guard.ts — Prometheus Studio can never open a workspace inside Prometheus's OWN
 * source repo. Desktop twin of `apps/cli/src/cwd-guard.ts` — see that file's own header for the
 * full rationale (this repeatedly happened, in both the CLI and this app, over the course of
 * this project's own development).
 *
 * `findOwnWorkspaceRoot` walks up from THIS module's own on-disk location, so it finds the repo
 * root whether the app is running from source (dev) or a built `dist/`, and finds NOTHING at
 * all for a packaged, installed Prometheus Studio (no source checkout anywhere on disk) — the
 * guard is then correctly always a no-op. Discovered ONCE per process and cached.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CwdGuardResult,
  type PackageJsonFs,
  findOwnWorkspaceRoot,
  guardCwd,
} from "@prometheus/core/agent-system-host";

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

/** The directory of Prometheus's own source checkout, or undefined — memoized per process. */
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

/** The full guard decision for a folder a user just picked (or opened via the recents list). */
export function guardOwnRepo(target: string): CwdGuardResult {
  return guardCwd(target, ownRepoRoot(), homedir());
}
