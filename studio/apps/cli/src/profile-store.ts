/**
 * profile-store.ts — the CLI-side (fs) half of profile persistence (CLI-044).
 *
 * `@prometheus/core` stays PURE (path math + serialize only); the actual reads of user profile
 * TOMLs, the active-profile persistence into the S005 config, and the `$EDITOR` spawn live here.
 * Active-profile persistence is read-modify-write ATOMIC (temp+fsync+rename) against the shared
 * `config.toml` under the `profile.active` key, so a fresh `prometheus` process reads the last choice.
 */
// biome-ignore lint/nursery/noRestrictedImports: interactive $EDITOR launch needs an inherited TTY, which engine-bridge's capture-spawn cannot provide (mirrors pty/backend.ts).
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { cliProfiles } from "@prometheus/core";

/** Spawn `$EDITOR` (fallback `vi`) on `file` with an inherited TTY; returns its exit status. */
export function defaultOpenEditor(file: string): number {
  const editorEnv = (process.env.VISUAL || process.env.EDITOR || "vi").trim();
  const parts = editorEnv.split(/\s+/).filter(Boolean);
  const bin = parts[0] ?? "vi";
  const flags = parts.slice(1);
  // vim/emacs/nano honor `--` end-of-options → a file literally named "-x.toml" can't read as a flag.
  const supportsDashDash = /(^|\/)(vi|vim|nvim|emacs|nano)$/.test(bin);
  const argv = supportsDashDash ? [...flags, "--", file] : [...flags, file];
  try {
    const r = spawnSync(bin, argv, { stdio: "inherit" });
    return typeof r.status === "number" ? r.status : 0;
  } catch {
    return 127; // editor not found
  }
}

/** Read a config/profile file's raw text ("" when it is missing/unreadable). */
export function readConfigRaw(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Atomic write: temp file in the SAME dir (no EXDEV) + fsync + rename (overwrites). */
export function writeTextAtomic(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** The persisted active-profile name (S005 config `profile.active`), or undefined if unset. */
export function getActiveProfileName(home?: string): string | undefined {
  const table = cliProfiles.parseToml(readConfigRaw(cliProfiles.configPath(home)));
  const v = cliProfiles.getPath(table, cliProfiles.PROFILE_ACTIVE_KEY);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Persist the active-profile name into the S005 config (read-modify-write atomic). */
export function setActiveProfileName(name: string, home?: string): void {
  const file = cliProfiles.configPath(home);
  const table = cliProfiles.parseToml(readConfigRaw(file));
  cliProfiles.setPath(table, cliProfiles.PROFILE_ACTIVE_KEY, name);
  writeTextAtomic(file, cliProfiles.stringifyToml(table));
}

/** The user profile file base-names (without `.toml`) under `profilesDir()`; [] when absent. */
export function listUserProfileNames(home?: string): string[] {
  try {
    return readdirSync(cliProfiles.profilesDir(home))
      .filter((f) => f.endsWith(".toml"))
      .map((f) => f.slice(0, -".toml".length))
      .sort();
  } catch {
    return [];
  }
}

/** Load a profile by name — a user TOML SHADOWS a same-named builtin; undefined if neither. */
export function loadProfile(name: string, home?: string): cliProfiles.CliProfile | undefined {
  const p = cliProfiles.profilePath(name, home);
  if (existsSync(p)) {
    const parsed = cliProfiles.parseProfile(readConfigRaw(p), name);
    if (parsed) return parsed;
  }
  return cliProfiles.getCliProfile(name);
}

/** True when a profile of this name exists (builtin OR a user file). */
export function profileExists(name: string, home?: string): boolean {
  return loadProfile(name, home) !== undefined;
}

/**
 * The startup profile name: the `--profile` flag wins; else the persisted active profile; else the
 * builtin default. The flag override happens AFTER the persisted value is read (deliverable 6).
 */
export function resolveActiveProfileName(flagProfile: string | undefined, home?: string): string {
  return flagProfile ?? getActiveProfileName(home) ?? cliProfiles.DEFAULT_PROFILE_NAME;
}

/** The nearest `.prom.toml` project config path walking up from `cwd`, or undefined (CLI-046).
 *  `PROM_NO_PROJECT_CONFIG=1` short-circuits BEFORE the walk so behavior is byte-identical to today. */
export function discoverProjectConfigPath(cwd: string): string | undefined {
  if (process.env.PROM_NO_PROJECT_CONFIG === "1") return undefined;
  return cliProfiles.discoverProjectToml(cwd, { exists: existsSync, home: homedir() });
}

/** Load the nearest `.prom.toml` as a profile overlay (must be parseProfile-valid — i.e. carry
 *  agent.model), or undefined. The project layer wins over user/builtin in the effective merge. */
export function loadProjectProfile(
  cwd: string,
): { path: string; profile: cliProfiles.CliProfile } | undefined {
  const path = discoverProjectConfigPath(cwd);
  if (!path) return undefined;
  const profile = cliProfiles.parseProfile(readConfigRaw(path));
  return profile ? { path, profile } : undefined;
}

/**
 * The full startup profile: builtin ⊕ user(active/flag) ⊕ project `.prom.toml` (project wins).
 * Always returns a valid CliProfile (the builtin default is the floor). Used by the REPL/session
 * startup so a repo's `.prom.toml` pins model/tuning for everyone who runs `prometheus` inside it.
 */
export function loadEffectiveStartupProfile(parsed: {
  profile?: string;
  cwd?: string;
}): cliProfiles.CliProfile {
  return loadEffectiveStartupProfileWithNotes(parsed).profile;
}

/**
 * The same resolution, plus everything the project `.prometheus.toml` was REFUSED.
 *
 * The project layer is tighten-only on the security keys (`cliProfiles.sanitizeProjectLayer`),
 * because it arrives with the code — walking up from the working directory means cloning a repo
 * is enough to apply it. A refusal has to be visible: someone wrote that line expecting it to
 * work, and a setting that is silently dropped teaches them it did.
 */
export function loadEffectiveStartupProfileWithNotes(parsed: {
  profile?: string;
  cwd?: string;
}): { profile: cliProfiles.CliProfile; rejected: cliProfiles.ProjectLayerRejection[] } {
  const builtin = cliProfiles.getCliProfile(
    cliProfiles.DEFAULT_PROFILE_NAME,
  ) as cliProfiles.CliProfile;
  const user = loadProfile(resolveActiveProfileName(parsed.profile)) ?? builtin;
  const project = loadProjectProfile(parsed.cwd ?? process.cwd())?.profile;
  return cliProfiles.resolveEffectiveProfileWithNotes({ builtin, user, project });
}
