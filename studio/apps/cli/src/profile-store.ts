// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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

/** Read `profile.active` out of one config TOML path; undefined if unset/unreadable. */
function activeProfileNameAt(path: string): string | undefined {
  const table = cliProfiles.parseToml(readConfigRaw(path));
  const v = cliProfiles.getPath(table, cliProfiles.PROFILE_ACTIVE_KEY);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The persisted active-profile name (S005 config `profile.active`), or undefined if unset.
 *
 * The current root wins over the legacy one whenever it holds a value, same as
 * `readSavedAuthLevel`/`readSavedEffort` — an unmigrated or migration-skipped install (a
 * read-only home, a container) must not have its chosen profile silently revert to the default
 * just because nothing ever copied the file forward.
 *
 * `$PROMETHEUS_HOME` is NOT such a case, and listing it here was wrong: the legacy root resolves
 * to the real OS home whatever that variable says, so falling back to it inside a sandbox read
 * the developer's real active profile on every run. `hasLegacyConfigDir` is the shared predicate
 * that keeps this in step with the migration, which refuses the same thing on the write side.
 */
export function getActiveProfileName(home?: string): string | undefined {
  const current = activeProfileNameAt(cliProfiles.configPath(home));
  if (current !== undefined) return current;
  if (!cliProfiles.hasLegacyConfigDir(home)) return undefined;
  return activeProfileNameAt(cliProfiles.legacyConfigPath(home));
}

/** Persist the active-profile name into the S005 config (read-modify-write atomic). */
export function setActiveProfileName(name: string, home?: string): void {
  const file = cliProfiles.configPath(home);
  const table = cliProfiles.parseToml(readConfigRaw(file));
  cliProfiles.setPath(table, cliProfiles.PROFILE_ACTIVE_KEY, name);
  writeTextAtomic(file, cliProfiles.stringifyToml(table));
}

/** The `.toml` base-names directly under one profiles directory; [] when it is absent. */
function profileNamesAt(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".toml"))
      .map((f) => f.slice(0, -".toml".length));
  } catch {
    return [];
  }
}

/**
 * The user profile file base-names (without `.toml`); [] when there are none.
 *
 * Unions the current root with the pre-consolidation one, for the same reason
 * `getActiveProfileName` falls back: a name the active-profile config still resolves must be
 * listable, or `/profile` shows a set that does not include the profile the session is running.
 */
export function listUserProfileNames(home?: string): string[] {
  const names = new Set(profileNamesAt(cliProfiles.profilesDir(home)));
  if (cliProfiles.hasLegacyConfigDir(home)) {
    for (const n of profileNamesAt(cliProfiles.legacyProfilesDir(home))) names.add(n);
  }
  return [...names].sort();
}

/**
 * Load a profile by name — a user TOML SHADOWS a same-named builtin; undefined if neither.
 *
 * The legacy profiles directory is tried between the two. Without it the halves of profile
 * resolution disagreed: the active-profile NAME had a legacy fallback while the profile FILES did
 * not, so an install whose migration was skipped or failed resolved the name `mine`, found no
 * `~/.prometheus/config/profiles/mine.toml`, and silently ran the BUILTIN default — a different
 * tool set, authorisation posture and effort pin than the user configured, while `/profile` still
 * reported `mine`. Current root first, so a stale legacy copy can never shadow a newer profile.
 */
export function loadProfile(name: string, home?: string): cliProfiles.CliProfile | undefined {
  const p = cliProfiles.profilePath(name, home);
  if (existsSync(p)) {
    const parsed = cliProfiles.parseProfile(readConfigRaw(p), name);
    if (parsed) return parsed;
  }
  if (cliProfiles.hasLegacyConfigDir(home)) {
    const legacy = cliProfiles.legacyProfilePath(name, home);
    if (existsSync(legacy)) {
      const parsed = cliProfiles.parseProfile(readConfigRaw(legacy), name);
      if (parsed) return parsed;
    }
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
