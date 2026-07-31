/**
 * cli-profiles/paths.ts — profile file locations (file 11 §6).
 *
 * Profiles live under ~/.config/prometheus-studio/profiles/ and are SHARED with the
 * GUI (same dir, same TOML). Pure path math; the host reads/writes the files.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The per-project config file name discovered upward from cwd (CLI-046). */
export const PROJECT_TOML_NAME = ".prom.toml";

export interface DiscoverProjectOpts {
  /** existence probe (file OR dir) — injected so core stays pure (no node:fs at module scope). */
  exists: (path: string) => boolean;
  /** the user's home dir — the walk searches home itself, then stops (a dotfile-repo `.prom.toml`). */
  home: string;
  /** upward-iteration cap (symlink-loop / UNC guard). Default 64. */
  maxDepth?: number;
}

/**
 * Walk upward from `cwd` looking for a `.prom.toml` (CLI-046). Each dir is SEARCHED before its stop
 * condition is checked, so a repo's config beside `.git` is found. Stops at: (a) the user's home
 * dir (searched then stop), (b) a dir containing `.git` (a FILE — submodule/worktree — or a dir),
 * (c) the filesystem root (`dirname(x)===x`). Pure: all fs access goes through the injected `exists`.
 */
export function discoverProjectToml(cwd: string, opts: DiscoverProjectOpts): string | undefined {
  const { exists, home } = opts;
  const maxDepth = opts.maxDepth ?? 64;
  let dir = cwd;
  for (let i = 0; i < maxDepth; i++) {
    const candidate = join(dir, PROJECT_TOML_NAME);
    if (exists(candidate)) return candidate; // found — this dir's config wins
    if (exists(join(dir, ".git"))) return undefined; // repo root (already searched) → stop
    if (dir === home) return undefined; // home searched → stop (never cross into $HOME's parents)
    const parent = dirname(dir);
    if (parent === dir) return undefined; // filesystem root
    dir = parent;
  }
  return undefined;
}

/** The shared config root (~/.config/prometheus-studio) — GUI + CLI. */
export function configDir(home: string = homedir()): string {
  return join(home, ".config", "prometheus-studio");
}

/** The user config TOML (~/.config/prometheus-studio/config.toml) that `config get/set` edits. */
export function configPath(home: string = homedir()): string {
  return join(configDir(home), "config.toml");
}

/** The profiles directory (~/.config/prometheus-studio/profiles). */
export function profilesDir(home: string = homedir()): string {
  return join(configDir(home), "profiles");
}

/** The path of a named profile's TOML file. */
export function profilePath(name: string, home: string = homedir()): string {
  return join(profilesDir(home), `${name}.toml`);
}
