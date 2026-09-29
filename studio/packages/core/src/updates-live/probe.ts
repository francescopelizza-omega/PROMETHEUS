/**
 * updates/probe.ts — the local-process seams: a CLI's installed version + the install method.
 *
 * `cliVersion` spawns `<bin> <args>` to read its `--version` (some CLIs print to stderr, so we
 * read both). child_process is loaded LAZILY via createRequire — a runtime call, not the
 * statically-forbidden import (C5) — matching session/onboarding.ts. `which` resolves a bin on
 * PATH (pure fs). `detectInstallMethod` heuristically classifies how prometheus itself was installed,
 * so the self-update plan offers the right command. All fail-soft.
 */
import { constants, accessSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { lookPath } from "../agent/system/host/host-tool-probe.js";
import * as u from "../updates/index.js";

const nodeRequire = createRequire(import.meta.url);

interface SpawnSyncResult {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  status?: number | null;
}
type SpawnSyncLike = (
  cmd: string,
  args: readonly string[],
  opts: Record<string, unknown>,
) => SpawnSyncResult;

/**
 * Is `bin` an executable on PATH? (pure fs, no spawn).
 *
 * Delegates to core's `lookPath` rather than walking PATH itself. This file used to carry its own
 * copy of that walk, which meant the repo had THREE PATH resolvers that could disagree — and the
 * copy here was the only one that did not repair a GUI-launched PATH, so `/updates` and `/doctor`
 * could reach opposite conclusions about the same machine in the same process.
 */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (bin.includes("/")) {
    try {
      accessSync(bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return lookPath(bin, env) !== null;
}

/** Run `<bin> <args>` and return the parsed semver from its output, or null (fail-soft). */
export function cliVersion(
  bin: string,
  args: readonly string[] = ["--version"],
  timeoutMs = 5000,
): string | null {
  try {
    const cp = nodeRequire("node:child_process") as { spawnSync?: SpawnSyncLike };
    if (typeof cp.spawnSync !== "function") return null;
    const r = cp.spawnSync(bin, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      shell: false,
      // cosmetic only — never CI=1 (could change a CLI's behavior).
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    return u.parseCliVersion(out);
  } catch {
    return null;
  }
}

/**
 * Classify how the running Prometheus was installed, from a starting path (process.argv[1])
 * and the cwd. Fail-soft → "unknown", where every real option is offered instead of one guess.
 *
 * ── THREE BUGS THIS REPLACES, ALL REACHABLE ─────────────────────────────────────────────────
 *
 * **It never resolved symlinks.** Node does NOT resolve `process.argv[1]` — measured:
 * `ln -sfn real.js link.js; node link.js` reports `argv[1]` as `link.js`. Every install method
 * here presents as a symlink (`~/.local/bin/prometheus`, `<npm prefix>/bin/prometheus`), so the
 * classifier was reading the shim and learning nothing from it.
 *
 * **It tested the brew prefix BEFORE node_modules.** An npm-global install under Homebrew's node
 * lives at `/opt/homebrew/lib/node_modules/…`, matched `/homebrew/`, and was classified "brew" —
 * which then produced `brew upgrade prometheus`, a command that upgrades the CNCF monitoring
 * server. Homebrew has never heard of this package.
 *
 * **Its `.git` walk claimed any repo.** Eight levels up from `<npm prefix>/bin/prometheus` will
 * find `.git` in a dotfiles-managed `$HOME`, and the user was told to run
 * `git -C ~/ pull --ff-only` to update Prometheus.
 */
export function detectInstallMethod(
  scriptPath: string | undefined,
  cwd: string = process.cwd(),
  deps: { home?: string; exists?: (p: string) => boolean; realpath?: (p: string) => string } = {},
): { method: u.InstallMethod; repoDir?: string } {
  const exists = deps.exists ?? existsSync;
  const home = deps.home ?? homedir();
  const rp = deps.realpath ?? ((x: string) => realpathSync.native(x));

  // RESOLVE FIRST. Everything below reads the real layout, not the shim that points at it.
  let p = scriptPath ?? "";
  if (p) {
    try {
      p = rp(p);
    } catch {
      /* dangling or unreadable — classify the literal path, which is still better than nothing */
    }
  }

  // The specific layouts first, because they nest inside the generic ones.
  if (/[\\/]node_modules[\\/]|[\\/]\.npm-global[\\/]/.test(p)) return { method: "npm-global" };
  if (/[\\/]pipx[\\/]/.test(p)) return { method: "pipx" };

  /**
   * The managed checkout `install.sh` creates (`~/.prometheus` by default, `$PROMETHEUS_HOME`
   * otherwise). Recognised before the generic git walk so the user gets the installer's own
   * update path rather than a `git -C` into a directory they never chose.
   */
  const installerHome = process.env.PROMETHEUS_HOME || join(home, ".prometheus");
  if (p.startsWith(`${installerHome}/`) || p === installerHome) {
    return exists(join(installerHome, ".git"))
      ? { method: "installer", repoDir: installerHome }
      : { method: "installer" };
  }

  /**
   * A source checkout — but only if it is THIS project's.
   *
   * The marker files are what stop a dotfiles `$HOME` or a repo-managed `/opt` from being claimed
   * as the Prometheus checkout. A repo that has a `.git` but none of these is somebody else's.
   */
  const start = p ? dirname(p) : cwd;
  let dir = start;
  for (let i = 0; i < 8 && dir && dir !== dirname(dir); i++) {
    if (
      exists(join(dir, ".git")) &&
      (exists(join(dir, "prometheus.py")) || exists(join(dir, "studio", "pnpm-workspace.yaml")))
    ) {
      return { method: "git", repoDir: dir };
    }
    dir = dirname(dir);
  }
  return { method: "unknown" };
}

/** The engine (prometheus.py) version via the injected engine client, or null (fail-soft). */
export async function engineVersion(
  run: (args: string[]) => Promise<{ ok?: boolean; response?: string }>,
): Promise<string | null> {
  try {
    const r = await run(["--version"]);
    return u.parseCliVersion(r?.response ?? "");
  } catch {
    return null;
  }
}
