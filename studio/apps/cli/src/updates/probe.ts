/**
 * updates/probe.ts — the local-process seams: a CLI's installed version + the install method.
 *
 * `cliVersion` spawns `<bin> <args>` to read its `--version` (some CLIs print to stderr, so we
 * read both). child_process is loaded LAZILY via createRequire — a runtime call, not the
 * statically-forbidden import (C5) — matching session/onboarding.ts. `which` resolves a bin on
 * PATH (pure fs). `detectInstallMethod` heuristically classifies how prometheus itself was installed,
 * so the self-update plan offers the right command. All fail-soft.
 */
import { constants, accessSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

import { updates as u } from "@prometheus/core";

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

/** Is `bin` an executable on PATH? (pure fs, no spawn). */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (bin.includes("/")) {
    try {
      accessSync(bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  // On Windows a CLI is `npm.cmd` / `foo.exe`, not a bare `npm` — probe the bare name AND every
  // PATHEXT so installed vendor CLIs aren't reported as absent (mirrors tmux.ts's lookup).
  const exts =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
      : [""];
  for (const d of dirs) {
    for (const ext of exts) {
      try {
        accessSync(join(d, bin + ext), constants.X_OK);
        return true;
      } catch {
        /* keep scanning */
      }
    }
  }
  return false;
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
 * and the cwd. Heuristic + fail-soft → "unknown" with both options offered downstream.
 */
export function detectInstallMethod(
  scriptPath: string | undefined,
  cwd: string = process.cwd(),
): { method: u.InstallMethod; repoDir?: string } {
  const p = scriptPath ?? "";
  if (/[\\/](Cellar|homebrew|linuxbrew)[\\/]/.test(p)) return { method: "brew" };
  if (/[\\/]pipx[\\/]/.test(p)) return { method: "pipx" };
  if (/[\\/]node_modules[\\/]|[\\/]\.npm-global[\\/]|[\\/]lib[\\/]node_modules[\\/]/.test(p))
    return { method: "npm-global" };
  // Walk up from the script (or cwd) looking for a .git → a source checkout.
  const start = p ? dirname(p) : cwd;
  let dir = start;
  for (let i = 0; i < 8 && dir && dir !== dirname(dir); i++) {
    if (existsSync(join(dir, ".git"))) return { method: "git", repoDir: dir };
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
