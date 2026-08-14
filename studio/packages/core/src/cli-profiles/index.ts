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
  listProfiles,
} from "./seeds.js";
export type { DiscoverProjectOpts } from "./paths.js";
export {
  profilesDir,
  profilePath,
  configDir,
  configPath,
  discoverProjectToml,
  PROJECT_TOML_NAME,
} from "./paths.js";
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
