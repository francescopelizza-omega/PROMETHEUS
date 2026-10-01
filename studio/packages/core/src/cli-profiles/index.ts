// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * cli-profiles/index.ts — the §6 profile barrel (file 11).
 *
 * The TOML subset parser, the CliProfile schema + flags-win merge + resolveTuning,
 * the four shipped profiles, and the shared profiles dir. PURE; SHARED with the GUI.
 */
export type { TomlValue, TomlTable } from "./toml.js";
export { parseToml, stringifyToml, getPath, setPath } from "./toml.js";
export type { CliProfile, ProfileFlagOverrides, ProjectLayerRejection } from "./profile.js";
export {
  parseProfile,
  parseModelRef,
  mergeFlags,
  resolveTuning,
  resolveEffectiveProfile,
  resolveEffectiveProfileWithNotes,
  sanitizeProjectLayer,
  serializeProfile,
} from "./profile.js";
export type { ProfileEntry } from "./seeds.js";
export {
  BUILTIN_CLI_PROFILES,
  DEFAULT_PROFILE_NAME,
  PROFILE_ACTIVE_KEY,
  getCliProfile,
  profileForbidsForce,
  forceOverrideAllowed,
  listProfiles,
} from "./seeds.js";
export type { DiscoverProjectOpts } from "./paths.js";
export {
  profilesDir,
  profilePath,
  configDir,
  configPath,
  legacyConfigDir,
  legacyConfigPath,
  legacyProfilesDir,
  legacyProfilePath,
  hasLegacyConfigDir,
  discoverProjectToml,
  PROJECT_TOML_NAME,
} from "./paths.js";
// The one non-pure member of this barrel: moving an existing install's config into the single
// `~/.prometheus` home needs fs. Reachable only through the core ROOT barrel (which already
// loads node:fs); nothing in the sandboxed renderer imports it.
export type { ConfigMigration } from "./migrate.js";
export { migrateLegacyConfigDir } from "./migrate.js";
// The saved autonomy level, shared by every surface (CLI hosts, desktop main, VS Code) so the
// setting is one setting rather than three that share a name.
export {
  AUTH_LEVEL_FILE,
  authLevelPath,
  legacyAuthLevelPath,
  readSavedAuthLevel,
  saveAuthLevel,
} from "./authorisation-store.js";
// The saved thinking-effort tier, shared by the same four surfaces. Stores the REQUESTED tier,
// never the one a particular model clamped it to — see the module docblock.
export {
  EFFORT_FILE,
  effortPath,
  legacyEffortPath,
  readSavedEffort,
  saveEffort,
} from "./effort-store.js";
export type {
  ConfigType,
  ConfigKeySpec,
  ConfigIssue,
  ConfigValidation,
  EffectiveEntry,
} from "./schema.js";
export {
  CONFIG_SCHEMA,
  valueType,
  flattenConfig,
  nearestKey,
  validateConfig,
  effectiveConfig,
} from "./schema.js";
