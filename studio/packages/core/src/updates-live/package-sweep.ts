/**
 * updates/package-sweep.ts — ask every package manager on this machine what is upgradable.
 *
 * The spawn half of `packages/core/src/updates/package-managers.ts`. Core owns the argv, the
 * environment, the exit semantics and the parsers; this runs them.
 *
 * ── WHY ASK THE MANAGER AT ALL ──────────────────────────────────────────────────────────────
 *
 * `tool-registry.ts` checks the ~16 tools PROMETHEUS knows by name, one HTTP request each. This
 * asks the authority that INSTALLED them, in one command, and gets back everything — including
 * the packages PROMETHEUS has never heard of. The two answers are different on purpose: a
 * registry says what exists, a package manager says what *this machine* would actually get.
 *
 * ── THREE RULES, EACH PAID FOR ──────────────────────────────────────────────────────────────
 *
 * **1. Only the declared `list` argv is ever run.** Not a variant, not with an extra flag. Four
 * commands that look like listings are not: `checkupdates -d` escalates to root and writes the
 * package cache, `checkupdates -c` writes state and prints NOTHING when unchanged (reporting
 * "up to date" for a machine that is not), `pacman -Sy` is the documented route to a broken
 * partial upgrade, and dnf without `-C` syncs metadata over the network. Core's `MUTATING_FLAGS`
 * list is asserted against every `readOnly` row by a test.
 *
 * **2. Exit codes are read per manager, never generically.** dnf says 100 for "updates exist";
 * pacman's `checkupdates` says 2 for "none"; `npm outdated` says 1 for "found some"; apt says
 * nothing at all. A shared `code !== 0` check would report Arch as current, npm as broken, and
 * Debian as silent.
 *
 * **3. A failure is never an empty list.** `{ ok: false }` and `{ ok: true, packages: [] }` are
 * different answers and the report renders them differently. Collapsing them is how a machine
 * with nine stale packages gets told "✓ everything is up to date" — which is what this repo's
 * `/updates` did, because nothing called this module at all.
 */
import { createRequire } from "node:module";

import { lookPath } from "../agent/system/host/host-tool-probe.js";
import * as u from "../updates/index.js";

const nodeRequire = createRequire(import.meta.url);

/** A listing command must not become the slow part of a startup check. */
export const SWEEP_TIMEOUT_MS = 20_000;

export interface SweepDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  which?: (bin: string) => boolean;
  /** test seam: run argv, return the captured result. */
  run?: (
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    timeoutMs: number,
  ) => { stdout: string; stderr: string; code: number | null };
  /** contents of /etc/os-release, for manager ranking on Linux. */
  osRelease?: string | null;
}

/** What one manager said. */
export interface ManagerSweep {
  manager: u.ManagerId;
  label: string;
  /** false when the manager is not installed here. */
  available: boolean;
  /**
   * The manager cannot answer "what is out of date" at all (pipx). Distinct from `ok: false`,
   * which means we asked and it went wrong.
   */
  unsupported?: boolean;
  /** false when the command failed, timed out, or could not be understood. */
  ok: boolean;
  packages: u.OutdatedPackage[];
  /** why `ok` is false, or a caveat worth showing alongside a successful listing. */
  note?: string;
}

function defaultRun(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): { stdout: string; stderr: string; code: number | null } {
  try {
    const cp = nodeRequire("node:child_process") as {
      spawnSync?: (
        c: string,
        a: readonly string[],
        o: Record<string, unknown>,
      ) => { stdout?: string; stderr?: string; status?: number | null };
    };
    if (typeof cp.spawnSync !== "function") return { stdout: "", stderr: "no spawn", code: null };
    const [cmd, ...args] = argv;
    const r = cp.spawnSync(cmd as string, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      shell: false,
      /**
       * `stdin: "ignore"` is the load-bearing part.
       *
       * Several of these will prompt if they can — for a password, for a confirmation, for a
       * pager. Inheriting the TTY means a "read-only check" can silently block a startup sweep
       * forever, waiting for input the user never sees a prompt for.
       */
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? null };
  } catch {
    return { stdout: "", stderr: "spawn failed", code: null };
  }
}

/** Which managers exist on this machine, in the order worth asking them. */
export function availableManagers(deps: SweepDeps = {}): u.ManagerSpec[] {
  const platform = deps.platform ?? process.platform;
  const has = deps.which ?? ((b: string) => lookPath(b) !== null);
  const candidates =
    platform === "linux" && deps.osRelease
      ? u.rankByDistro(u.parseOsRelease(deps.osRelease))
      : u.managersForPlatform(platform);
  return candidates.filter((m) => m.platforms.includes(platform) && has(m.bin));
}

/** Ask ONE manager. Never throws. */
export function sweepManager(spec: u.ManagerSpec, deps: SweepDeps = {}): ManagerSweep {
  const base = { manager: spec.id, label: spec.label, available: true };
  if (spec.unsupported) {
    return {
      ...base,
      unsupported: true,
      ok: false,
      packages: [],
      note: `${spec.label} has no "what is outdated" command — PROMETHEUS cannot check it. \`${spec.upgradeAll.join(" ")}\` upgrades everything it manages.`,
    };
  }

  /**
   * A prerequisite the listing needs (`checkupdates` needs `fakeroot`). Missing one is not a
   * failure of the manager — it is a gap the user can close — so it is reported as itself.
   */
  const has = deps.which ?? ((b: string) => lookPath(b) !== null);
  for (const req of spec.list.requires ?? []) {
    if (!has(req)) {
      return {
        ...base,
        ok: false,
        packages: [],
        note: `needs \`${req}\`, which is not installed`,
      };
    }
  }

  const run = deps.run ?? defaultRun;
  const r = run(spec.list.argv, spec.list.env ?? {}, SWEEP_TIMEOUT_MS);

  if (r.code === null) {
    /**
     * A null status means the child was killed by a signal or never started — a TIMEOUT lands
     * here. `parseListing` on the partial stdout would produce a plausible, short list, which is
     * worse than saying nothing: it would read as "these are the only updates".
     */
    return { ...base, ok: false, packages: [], note: "the listing did not complete" };
  }
  if (u.exitIsFailure(spec.list.exit, r.code)) {
    const detail = r.stderr.trim().split("\n")[0] ?? "";
    return {
      ...base,
      ok: false,
      packages: [],
      note: `exited ${r.code}${detail ? `: ${detail}` : ""}`,
    };
  }

  const packages = u.parseListing(spec.id, r.stdout);
  const says = u.exitSaysUpdates(spec.list.exit, r.code);
  /**
   * The exit code and the parsed rows disagreeing is a real signal, and the only reason the dnf5
   * JSON bug was findable: exit 100 ("updates available") with zero parsed rows means the parser
   * is wrong, not that the machine is current. Reporting it as a caveat beats silently trusting
   * either side.
   */
  const mismatch =
    says === true && packages.length === 0
      ? `${spec.label} reports updates are available but none could be read — the output format may have changed`
      : undefined;

  return {
    ...base,
    ok: true,
    packages,
    ...(mismatch ? { note: mismatch } : spec.list.note ? { note: spec.list.note } : {}),
  };
}

/** Ask every manager on this machine. Sequential on purpose — see the note. */
export function sweepPackages(deps: SweepDeps = {}): ManagerSweep[] {
  /**
   * Sequential, not parallel.
   *
   * These are the machine's package managers, several of them hold a lock, and running `brew`,
   * `npm` and `dnf` at once on a laptop whose whole resource policy exists because of fork
   * storms (CLAUDE.md §2.3) buys a second of wall-clock for a real risk. The sweep is off the
   * critical path anyway.
   */
  return availableManagers(deps).map((m) => sweepManager(m, deps));
}

/**
 * The exact command to upgrade ONE package, with the manager's own flags.
 *
 * This is the thing the user asked for by name: not "run brew upgrade", but the specific line
 * for the specific package, ready to paste. `kind` carries Homebrew's formula/cask distinction
 * through from the listing, because `brew upgrade ollama` and `brew upgrade --cask ollama-app`
 * are different packages and picking the wrong one is how a second CLI gets installed beside a
 * running app.
 */
export function upgradeLineFor(pkg: u.OutdatedPackage): string | null {
  const spec = u.manager(pkg.manager);
  if (!spec) return null;
  const argv = u.upgradeCommand(spec, pkg.name, pkg.kind);
  return argv ? argv.join(" ") : null;
}
