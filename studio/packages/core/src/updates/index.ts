/**
 * updates/index.ts — the update-checking engine barrel (PURE).
 *
 * Four checkers, all data-in/decision-out so the CLI/GUI inject the IO (fetch/spawn):
 *   • vendor CLI versions   — sources table + npm/github/version parsers + semver compare
 *   • UPSTREAM model builds — `model-registry.ts`: does this tag point somewhere new?
 *   • local model churn     — `models.ts`: Ollama digest diffs + a curated FREE catalog
 *   • Prometheus self-update — install-method → a copyable command (never an auto-swap)
 * report.ts assembles them into an UpdateReport + the human notices.
 *
 * The two model checkers answer DIFFERENT questions and neither replaces the other:
 * `models.ts` diffs this machine against its own previous snapshot, so it notices a pull that
 * already happened; `model-registry.ts` asks the registry, so it notices one that has not. The
 * header of `model-registry.ts` has the full argument, and `report.ts:133` records why the
 * former was never allowed to drive an update nudge on its own.
 */
export type { SemverParts } from "./semver.js";
export { parseVersion, compareVersions, isNewer, withoutRevision } from "./semver.js";

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
  ManagerId,
  ExitSemantics,
  ListCommand,
  ManagerSpec,
  OutdatedPackage,
} from "./package-managers.js";
export {
  MANAGERS,
  MUTATING_FLAGS,
  manager,
  managersForPlatform,
  rankByDistro,
  parseOsRelease,
  exitSaysUpdates,
  exitIsFailure,
  upgradeCommand,
  parseListing,
  parseBrewOutdated,
  parseAptList,
  parseDnfCheckUpdate,
  parseDnf5Json,
  parseZypperListUpdates,
  parseCheckupdates,
  parseNpmOutdated,
  parseApkVersion,
} from "./package-managers.js";

/**
 * Install ATTRIBUTION — which copy of a tool actually runs, and who installed it.
 *
 * This answers the question the other four checkers assumed away. Everything that emits an update
 * command must go through it first: a command aimed at a copy that is not on PATH succeeds,
 * reports success, and changes nothing the user runs.
 */
export type {
  InstallOwner,
  OwnerInfo,
  OwnerHints,
  ToolCopy,
  InstallState,
  ToolResolution,
} from "./install-owner.js";
export {
  classifyPath,
  viaForOwner,
  fallbackCommandFor,
  resolveTool,
  targetsWinner,
  partitionCommands,
  ownerLabel,
  zapHazard,
} from "./install-owner.js";

/**
 * CONFLICTS — what a package manager offers, cross-checked against what actually runs.
 *
 * The two facts are individually correct and together describe a trap: brew offering
 * `claude-code 2.1.274 -> 2.1.277` is true, and so is "you run 2.1.284 from a different
 * install". Only together do they say that the upgrade is a downgrade into a path PATH never
 * reaches.
 */
export type { ConflictKind, Conflict, ConflictInput } from "./conflicts.js";
export { findConflicts, plainUpgrades, MANAGED_OWNERS } from "./conflicts.js";

export type {
  ToolRole,
  LatestChannel,
  UpdateCommand,
  ToolCheck,
} from "./tool-registry.js";
export {
  TOOL_CHECKS,
  toolCheck,
  toolsInRole,
  latestUrl,
  packageIdFor,
  vendorDeltaUrl,
  parseLatest,
  parseVendorDelta,
  updateCommandsFor,
} from "./tool-registry.js";

export type {
  ModelRef,
  ManifestLayer,
  RemoteManifest,
  RemoteConfig,
  RemoteBuild,
  InstalledModel,
  BuildDelta,
  SkipReason,
  ModelUpdate,
  ModelCheck,
} from "./model-registry.js";
export {
  DEFAULT_REGISTRY,
  DEFAULT_NAMESPACE,
  DEFAULT_TAG,
  MANIFEST_ACCEPT,
  DIGEST_HEADER,
  PUSH_TIME_HEADER,
  parseModelRef,
  formatModelRef,
  manifestUrl,
  blobUrl,
  normalizeDigest,
  manifestDigest,
  digestFromHeaders,
  pushTimeFromHeaders,
  parseManifest,
  parseConfigBlob,
  compareBuild,
  reclaimableAfterUpdate,
  offerable,
} from "./model-registry.js";

/**
 * THE CATALOGUE — one shape for "a model you could install", from several sources.
 *
 * Pure. `ollama.com/library` is deliberately NOT a source: its terms prohibit automated access.
 * HuggingFace is, and closes the loop anyway because `ollama pull hf.co/<repo>` is official.
 */
export type {
  CatalogSource,
  InstallRoute,
  CatalogEntry,
  FitBudget,
  Fit,
  CatalogSort,
} from "./catalog.js";
export {
  fitOf,
  mergeCatalog,
  routeKey,
  sortCatalog,
  filterCatalog,
  installCommand,
} from "./catalog.js";

/**
 * CONVERSION — the escape hatch for a model with no published GGUF.
 *
 * Deliberately the exception, not the happy path: almost every model already has a GGUF someone
 * published, and `ollama pull hf.co/<repo>` fetches it with no conversion at all. Two measured
 * facts drive the module — ollama 0.34.1 dropped GGUF conversion from `ollama create`, and
 * Homebrew's llama.cpp formula has no Python dependency, so it does NOT ship the converter.
 */
export type {
  ModelFormat,
  TargetEngine,
  Prerequisite,
  ConversionStep,
  ConversionPlan,
  ConversionEnv,
  ConversionRequest,
} from "./conversion.js";
export {
  OLLAMA_GGUF_CONVERSION_REMOVED_IN,
  GGUF_QUANT_TYPES,
  MLX_QUANT_TYPES,
  GGUF_IS_ONE_WAY,
  ollamaConvertsGguf,
  planConversion,
  missingPrerequisites,
  planIsReady,
} from "./conversion.js";

/**
 * MODEL ACTIONS — what may be done about a model, and how to read a pull's progress.
 *
 * Pure. The stream reader exists because HTTP 200 does NOT mean a pull worked: ollama commits
 * the response before it can fail, and an error then arrives as an NDJSON line.
 */
export type {
  PullEvent,
  PullProgress,
  ModelActionKind,
  ModelAction,
  ReclaimInput,
  ReclaimVerdict,
} from "./model-actions.js";
export {
  AUTH_CONFIG,
  AUTH_INSTALL,
  AUTH_DESTRUCTIVE,
  PullProgressTracker,
  parsePullLine,
  actionsFor,
  pullBlockedReason,
  honestReclaim,
  removalAction,
} from "./model-actions.js";

export type {
  InstallMethod,
  SelfUpdateConfig,
  SelfUpdatePlan,
  BuildSelfUpdateInput,
} from "./self-update.js";
export {
  DEFAULT_SELF_UPDATE,
  buildSelfUpdatePlan,
  gitlabLatestUrl,
  latestFromGitlab,
} from "./self-update.js";

export type {
  ToolUpdateStatus,
  ManagerReport,
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
