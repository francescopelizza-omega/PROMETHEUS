/**
 * agent/system/host/host-tool-probe.ts — is this program on PATH? (no spawn, cached)
 *
 * Two constraints shaped this, and both are load-bearing:
 *
 *  1. NO SPAWN. Every existing binary probe in the TS tree shells out — `whichTool`, `canStart`,
 *     `grepTool` and `globTool` each fork a process, none of them caches, and none of that is
 *     affordable for an inventory consulted once per turn: fourteen tools would be fourteen
 *     forks, every turn, on a machine whose whole resource policy exists because fork storms
 *     took the display down (CLAUDE.md §2.3). `lookPath` is a pure `access(X_OK)` walk of PATH.
 *
 *  2. THE PATH MAY BE A LIE. A GUI-launched app inherits macOS's minimal launchd PATH
 *     (`/usr/bin:/bin:/usr/sbin:/sbin`) which omits Homebrew entirely, so every probe reports a
 *     false negative — the bug `apps/desktop/src/main/resolve-path.ts` already documents and
 *     fixes, except that fix lives in the desktop main process where nothing else can reach it.
 *     `searchPath()` repairs the PATH the same way, here, so a probe is honest whichever way
 *     Prometheus was started. (It is also why this repo's own `system-tools.test.ts` reports
 *     ripgrep "not installed on this machine" while `rg` sits in /opt/homebrew/bin.)
 *
 * The cache is process-lifetime with an explicit invalidation (`clearHostToolCache`), called by
 * `/install` and `/deps --refresh`. A tool does not appear or vanish on its own.
 */
import { constants, accessSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

import { HOST_TOOLS, type HostToolStatus } from "../../host-tools.js";

/**
 * Tool directories a GUI-launched process tends to miss, in preference order.
 *
 * Kept in step with `apps/desktop/src/main/resolve-path.ts`'s `wellKnownDirs` — that copy runs
 * before any spawn in the desktop main process and repairs `process.env.PATH` for the whole
 * child chain; this one repairs only the string this module searches, and never mutates env.
 */
function wellKnownDirs(home: string): string[] {
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    `${home}/.local/bin`,
    `${home}/bin`,
    `${home}/.cargo/bin`,
    `${home}/go/bin`,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

/** The directories to search: the inherited PATH first, then the well-known dirs that exist. */
export function searchPath(
  env: NodeJS.ProcessEnv = process.env,
  opts: { home?: string; exists?: (p: string) => boolean; platform?: NodeJS.Platform } = {},
): string[] {
  const exists = opts.exists ?? existsSync;
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if ((opts.platform ?? platform()) === "win32") return dirs;
  const seen = new Set(dirs);
  for (const d of wellKnownDirs(opts.home ?? homedir())) {
    if (!seen.has(d) && exists(d)) {
      dirs.push(d);
      seen.add(d);
    }
  }
  return dirs;
}

/** Where `bin` resolves on PATH, or null. Pure fs — never spawns, never runs the program. */
export function lookPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { home?: string; exists?: (p: string) => boolean } = {},
): string | null {
  const exts =
    platform() === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
      : [""];
  for (const dir of searchPath(env, opts)) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* keep scanning — a missing or non-executable candidate is the normal case */
      }
    }
  }
  return null;
}

let cache: HostToolStatus[] | null = null;

/** Forget the probe result. Call after an install, or on an explicit refresh. */
export function clearHostToolCache(): void {
  cache = null;
}

/**
 * Probe every catalog entry. Cached for the life of the process.
 *
 * `which` is injectable so tests never touch the real filesystem; passing it also bypasses the
 * cache, because a test that seeded a fake probe must not poison the next caller.
 */
export function probeHostTools(which?: (bin: string) => string | null): HostToolStatus[] {
  if (which) {
    return HOST_TOOLS.map((tool) => ({
      tool,
      found: tool.bins.map((b) => (which(b) ? b : null)).find((b) => b !== null) ?? null,
    }));
  }
  if (cache) return cache;
  cache = HOST_TOOLS.map((tool) => ({
    tool,
    found: tool.bins.find((b) => lookPath(b) !== null) ?? null,
  }));
  return cache;
}
