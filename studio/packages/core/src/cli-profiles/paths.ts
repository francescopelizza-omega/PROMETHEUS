// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * cli-profiles/paths.ts — profile file locations (file 11 §6).
 *
 * Profiles live under ~/.config/prometheus-studio/profiles/ and are SHARED with the
 * GUI (same dir, same TOML). Pure path math; the host reads/writes the files.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The one Prometheus home: `$PROMETHEUS_HOME`, else `<home>/.prometheus`.
 *
 * Deliberately a local twin of `agent/system/host/home.ts`'s `prometheusHome()` rather than an
 * import of it: that module is part of the agent HOST layer (it pulls the system-tools graph),
 * and this file is imported by the desktop's sandboxed renderer through the pure profiles
 * subpath. The two must agree, and `paths.test.ts` asserts they do so the twin cannot drift.
 *
 * An explicit `home` still wins over the env for the same reason `configDir` documents: it is
 * the injection seam the hosts and the tests rely on.
 */
function promHome(home?: string): string {
  if (home !== undefined) return join(home, ".prometheus");
  const override = process.env.PROMETHEUS_HOME?.trim();
  if (!override) return join(homedir(), ".prometheus");
  const expanded = override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** The per-project config file name discovered upward from cwd (CLI-046). */
export const PROJECT_TOML_NAME = ".prometheus.toml";

/** Pre-rename project config name, still honoured so existing repos keep working. */
export const LEGACY_PROJECT_TOML_NAME = ".prom.toml";

/** Project config names probed in each directory, most-preferred first. */
export const PROJECT_TOML_NAMES = [PROJECT_TOML_NAME, LEGACY_PROJECT_TOML_NAME] as const;

export interface DiscoverProjectOpts {
  /** existence probe (file OR dir) — injected so core stays pure (no node:fs at module scope). */
  exists: (path: string) => boolean;
  /** the user's home dir — the walk searches home itself, then stops (a dotfile-repo config). */
  home: string;
  /** upward-iteration cap (symlink-loop / UNC guard). Default 64. */
  maxDepth?: number;
}

/**
 * Walk upward from `cwd` looking for a `.prometheus.toml` (CLI-046) — or the legacy `.prom.toml`,
 * still honoured so repos written before the rename keep working. Each dir is SEARCHED before its
 * stop condition is checked, so a repo's config beside `.git` is found. Stops at: (a) the user's
 * home dir (searched then stop), (b) a dir containing `.git` (a FILE — submodule/worktree — or a
 * dir), (c) the filesystem root (`dirname(x)===x`). Pure: all fs access goes through `exists`.
 */
export function discoverProjectToml(cwd: string, opts: DiscoverProjectOpts): string | undefined {
  const { exists, home } = opts;
  const maxDepth = opts.maxDepth ?? 64;
  let dir = cwd;
  for (let i = 0; i < maxDepth; i++) {
    // the new name wins over the legacy one in the SAME dir; a nearer dir still beats a farther one
    for (const name of PROJECT_TOML_NAMES) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate; // found — this dir's config wins
    }
    if (exists(join(dir, ".git"))) return undefined; // repo root (already searched) → stop
    if (dir === home) return undefined; // home searched → stop (never cross into $HOME's parents)
    const parent = dirname(dir);
    if (parent === dir) return undefined; // filesystem root
    dir = parent;
  }
  return undefined;
}

/**
 * The shared config root: `~/.prometheus/config` — GUI + CLI.
 *
 * It used to be `~/.config/prometheus-studio`, a THIRD root beside `~/.prometheus` (state,
 * sessions, cache, logs) and `~/.config/prometheus` (the Python engine). Three roots for one
 * product is how the authorisation level came to be read from a directory nothing ever created,
 * and it is why "where does Prometheus keep my settings" had no single answer. Everything now
 * hangs off ONE home.
 *
 * The legacy root is still READ — see `legacyConfigDir` and the migration helper beside it — so
 * an existing install keeps its profiles, its config.toml and its saved posture.
 *
 * `home` is the OS home (`os.homedir()`); passing it explicitly is the DI seam every test and
 * every `deps.configHome` uses, so an explicit argument always wins. Only the DEFAULT consults
 * `$PROMETHEUS_HOME`, which is what makes one variable sandbox the whole product.
 */
export function configDir(home?: string): string {
  return join(promHome(home), "config");
}

/**
 * The pre-consolidation config root (`<home>/.config/prometheus-studio`).
 *
 * Exported so the migration can find what to move and so readers can fall back to it: a user who
 * never runs the migration (a read-only home, a container, a rollback) must not silently lose
 * their settings.
 */
export function legacyConfigDir(home: string = homedir()): string {
  return join(home, ".config", "prometheus-studio");
}

/**
 * Is the pre-consolidation root in scope to READ at all?
 *
 * An explicit `home` always has one — that is the DI seam every host and test relies on. But a
 * home steered by `$PROMETHEUS_HOME` is an explicit sandbox (a container, CI, a test), and the
 * legacy root resolves to the real OS home regardless, so falling back to it reaches OUTSIDE the
 * sandbox on every run: an empty `PROMETHEUS_HOME` tree would still inherit the developer's saved
 * autonomy level, effort tier and active profile from `~/.config/prometheus-studio`.
 *
 * This is the same rule `migrateLegacyConfigDir` already applies to the WRITE side ("it is not a
 * request to import whatever the real `~/.config` happens to hold"). It lives here so the read
 * and write sides cannot drift apart — the readers must not undo what the migration refuses.
 *
 * A predicate rather than an optional return on the path helpers deliberately: the paths are pure
 * math and stay `string`, the sandbox rule is a policy about whether to read them.
 */
export function hasLegacyConfigDir(home?: string): boolean {
  return home !== undefined || (process.env.PROMETHEUS_HOME?.trim() ?? "") === "";
}

/** The user config TOML (`~/.prometheus/config/config.toml`) that `config get/set` edits. */
export function configPath(home?: string): string {
  return join(configDir(home), "config.toml");
}

/** The pre-consolidation config TOML — the fallback read side of `configPath`, same pattern as
 *  `legacyAuthLevelPath`/`legacyEffortPath`, for a value written before the one-home migration. */
export function legacyConfigPath(home: string = homedir()): string {
  return join(legacyConfigDir(home), "config.toml");
}

/** The profiles directory (`~/.prometheus/config/profiles`). */
export function profilesDir(home?: string): string {
  return join(configDir(home), "profiles");
}

/** The path of a named profile's TOML file. */
export function profilePath(name: string, home?: string): string {
  return join(profilesDir(home), `${name}.toml`);
}

/**
 * The pre-consolidation profiles directory — the fallback read side of `profilesDir`.
 *
 * Without this twin the two halves of profile resolution disagreed: the active profile NAME had a
 * legacy fallback (`legacyConfigPath`) while the profile FILES did not, so an install whose
 * migration was skipped or failed resolved the name `mine` from the legacy `config.toml`, found
 * no `~/.prometheus/config/profiles/mine.toml`, and silently ran the BUILTIN default profile — a
 * different tool set, authorisation posture and effort pin than the user configured, while
 * `/profile` still reported the name `mine`.
 *
 * Gate reads on `hasLegacyConfigDir` like every other legacy path.
 */
export function legacyProfilesDir(home: string = homedir()): string {
  return join(legacyConfigDir(home), "profiles");
}

/** The pre-consolidation path of a named profile's TOML — fallback read side of `profilePath`. */
export function legacyProfilePath(name: string, home: string = homedir()): string {
  return join(legacyProfilesDir(home), `${name}.toml`);
}
