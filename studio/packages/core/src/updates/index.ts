/**
 * updates/index.ts — the update-checking engine barrel (PURE).
 *
 * Three checkers, all data-in/decision-out so the CLI/GUI inject the IO (fetch/spawn):
 *   • vendor CLI versions   — sources table + npm/github/version parsers + semver compare
 *   • local model updates   — Ollama digest diffs + a curated FREE commercial-safe catalog
 *   • Prometheus self-update — install-method → a copyable command (never an auto-swap)
 * report.ts assembles the three into an UpdateReport + the human notices.
 */
export type { SemverParts } from "./semver.js";
export { parseVersion, compareVersions, isNewer } from "./semver.js";

export type { UpdateChannel, UpdateSource } from "./sources.js";
export {
  CLI_UPDATE_SOURCES,
  UPDATE_SERVICES,
  updateSourceFor,
  parseCliVersion,
  latestFromNpm,
  latestFromGithub,
} from "./sources.js";

export type {
  OllamaModel,
  DigestSnapshot,
  ModelDigestDiff,
  LicenseClass,
  CatalogModel,
  RecommendOpts,
} from "./models.js";
export {
  snapshotDigests,
  diffDigests,
  LOCAL_MODEL_CATALOG,
  recommendUpgrades,
} from "./models.js";

export type {
  InstallMethod,
  SelfUpdateConfig,
  SelfUpdatePlan,
  BuildSelfUpdateInput,
} from "./self-update.js";
export { DEFAULT_SELF_UPDATE, buildSelfUpdatePlan } from "./self-update.js";

export type {
  CliUpdateStatus,
  ModelUpdateStatus,
  SelfUpdateStatus,
  UpdateReport,
  UpdateSeverity,
  UpdateComponentJson,
  UpdatesJson,
} from "./report.js";
export {
  hasUpdates,
  countUpdates,
  summarizeForStartup,
  formatUpdateReport,
  toUpdatesJson,
} from "./report.js";
