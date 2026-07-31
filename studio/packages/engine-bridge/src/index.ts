/**
 * @prometheus/engine-bridge — the ONLY JS->engine gateway (C5).
 *
 * Public surface (SHARED_API). core / cli / desktop import from here via the bare
 * specifier `@prometheus/engine-bridge`. This package is the single place allowed
 * to spawn python3 / nemesis; everything else renders the verdicts it returns.
 */

// --- verdict model (C3 — single source of truth) ---------------------------
export type {
  VerdictTier,
  Severity,
  Finding,
  SecurityVerdict,
  NemesisVerdictRef,
  GateBadge,
  ForcedDanger,
} from "./security/verdict.js";
export {
  tierFromExitCode,
  normalizeVerdict,
  normalizeSeverity,
  normalizeKlass,
  isBlockingTier,
} from "./security/verdict.js";

// --- error taxonomy --------------------------------------------------------
// EngineErrorCode = the established axis; EngineErrorKind = file 02 §3.5's axis
// (every EngineError carries BOTH — one failure space, two spellings).
export type { EngineErrorCode, EngineErrorKind, EngineErrorInit } from "./errors.js";
export { EngineError, isEngineError, ENGINE_ERROR_KINDS } from "./errors.js";

// --- config / resolution ---------------------------------------------------
export type { EngineConfig, ResolvedEngine } from "./config.js";
export { resolveEngine, DEFAULT_TIMEOUT_MS } from "./config.js";
// bundled-or-dev engine path resolver (file 10 §1): prepends process.resourcesPath
// (packaged extraResources) to the resolveEngine fallback chain.
export type { EnginePaths, EnginePathsOptions } from "./locate.js";
export { enginePaths } from "./locate.js";

// --- run core --------------------------------------------------------------
// NOTE: the public `EngineEnvelope` is the GENERIC one from contract.js (file 01
// §11.2). run.ts's structurally-identical base is re-exported as EngineEnvelopeBase.
export type { RunOptions } from "./run.js";
export { runPrometheus, runCommand, parseEngineObject } from "./run.js";

// --- command builders ------------------------------------------------------
export type {
  InstallFlags,
  UninstallFlags,
  ToggleFlags,
  CommandsApi,
  ChatPreviewOpts,
} from "./commands.js";
export { Commands } from "./commands.js";

// --- nemesis gate ----------------------------------------------------------
export type { NemesisRunResult } from "./security/gate.js";
export { gate, runNemesis } from "./security/gate.js";

// --- FULL nemesis.verdict/1 mirror (file 03 §3) ----------------------------
// The RICH verdict the security UI renders. Lives alongside the lightweight C3
// SecurityVerdict (verdict.js) — NEVER replaces it (core/cli/tests use that one).
export type {
  NemesisVerdict,
  NemesisVerdictLevel,
  NemesisSeverity,
  NemesisKlass,
  NemesisFinding,
  NemesisSignature,
  NemesisProvenance,
  DbProvenance,
  IndicatorsLoaded,
  SafeTo,
  SeverityCounts,
  ClassCounts,
  FindingsByClass,
  DisinfectionReport,
  ForcedDangerFull,
  InstallEnvelope as NemesisInstallEnvelope,
  InstallEventLite,
} from "./security/nemesis-verdict.js";
export {
  parseNemesisVerdict,
  parseNemesisFinding,
  syntheticErrorVerdict,
} from "./security/nemesis-verdict.js";

// --- the RICH gate + read-only deep audit (file 03 §4, §5) -----------------
export type { GateFullOptions } from "./security/gate-full.js";
export { gateFull, auditScan } from "./security/gate-full.js";
export type { ScanStage, ScanStageId } from "./security/progress.js";
export { parseStageLine, SCAN_STAGE_COUNT } from "./security/progress.js";

// --- URL-injection safeguard L6: safe-fetch proxy (web = DATA, never code) ---
export type {
  SafeFetchOptions,
  SafeFetchResult,
  SafeFetchCheck,
  IpiSignal,
  FetchProvenance,
  CloakProbeOptions,
  CloakProbeResult,
  CloakPersona,
} from "./security/fetchproxy.js";
export { safeFetch, safeFetchCheck, cloakProbe } from "./security/fetchproxy.js";

// --- APP-085: gated GitHub/GitLab PR review client (every call via the L6 proxy) ---
export type {
  ForgeRemote,
  PrSummary,
  PrComment,
  PrDetail,
  PrListResult,
  PrDetailResult,
  PrOpResult,
  SafeFetchFn,
} from "./pr/provider.js";
export { listPullRequests, getPullRequest, postComment } from "./pr/provider.js";

// --- URL-injection L4 classifier + §4 verdict fusion ------------------------
export type {
  ClassifyResult,
  ClassifyOptions,
  UrlFinding,
  UrlContext,
  FuseInput,
  FusedUrlVerdict,
} from "./security/urlfindings.js";
export { classifyContent, fuseUrlSignals } from "./security/urlfindings.js";

// --- URL-injection L5 installed-source audit bridge (§5.2/§9) ----------------
export type { UrlAuditResult } from "./security/urlaudit.js";
export {
  urlSourceAudit,
  urlQuarantineList,
  urlQuarantineRestore,
} from "./security/urlaudit.js";

// --- remediation: disinfect / quarantine / purge / accept (file 03 §9, §5.5) ---
export type {
  DisinfectOptions,
  DisinfectResult,
  QuarantineListResult,
  RestoreResult,
  PurgeOptions,
  PurgeResult,
  IgnoreListResult,
  AcceptFindingResult,
} from "./security/remediate.js";
export {
  disinfect,
  quarantineList,
  restore,
  purge,
  ignoreList,
  acceptFinding,
} from "./security/remediate.js";

// --- threat-DB status & control (file 03 §6) -------------------------------
export type {
  ThreatDbStatus,
  UpdateFeedsOptions,
  UpdateFeedsResult,
  AuthKeyResult,
  CacheStatusResult,
  ClearCacheResult,
} from "./security/threatdb.js";
export {
  threatDbStatus,
  updateFeeds,
  authKey,
  cacheStatus,
  clearCache,
} from "./security/threatdb.js";

// --- audit log / trusted sources / verify (file 03 §8) ---------------------
export type {
  TrustedSource,
  RevokeResult,
  AuditLogEntry,
  AuditLogFilter,
  VerifyResult,
} from "./security/trust.js";
export { listTrusted, revoke, auditLog, auditBounds, verify } from "./security/trust.js";

// --- stderr progress stream ------------------------------------------------
export type { ProgressPhase, ProgressEvent } from "./stream.js";
export { parseProgressLine, makeProgressSink, parseProgress } from "./stream.js";

// --- canonical wire types (file 01 §11.2 — single import site) -------------
// NOTE: the install wire types (InstallEvent/Result/Scope/Summary/Results,
// InstallEnvelope) are surfaced ONCE — through the file-02 types barrel below
// (src/types/index.ts), which itself re-exports them FROM contract.ts. So this
// block only carries the generic envelope aliases that have no types/ home.
// The contract's `request` ECHO shape is exported as `InstallRequestEcho`
// (below); the PUBLIC `InstallRequest` is the typed builder (types/request.ts).
export type {
  EngineEnvelope,
  EngineEnvelopeBase,
  AnyEngineEnvelope,
} from "./contract.js";

// --- engine version-skew negotiation (file 01 §Open-Q7) --------------------
export type {
  SemverParts,
  EngineVersion,
  EngineCapabilities,
  VersionProbeTarget,
} from "./version.js";
export {
  MIN_ENGINE,
  parseSemver,
  compareSemver,
  parseVersionLine,
  detectEngineVersion,
  negotiateCapabilities,
} from "./version.js";

// --- assembled client (the EngineClient SHARED_API) ------------------------
export type { EngineClient } from "./client.js";
export { createEngineClient } from "./client.js";

// --- per-command typed envelopes + the discriminated union (file 02 §3.3) ---
// EnvelopeBase here is the canonical EngineEnvelope<T> from contract.ts (NOT a
// redefinition). InstallEnvelope is the SINGLE one shared with contract.ts.
export type {
  EnvelopeBase,
  LooseEnvelope,
  Envelope,
  EnvelopeByCommand,
  KnownCommand,
  // scan / superscan
  ScanEnvelope,
  ScanOs,
  ScanAgent,
  SuperscanEnvelope,
  SuperscanAgent,
  SuperscanCounts,
  // list
  ListEnvelope,
  CatalogEntry,
  CatalogTarget,
  CatalogTier,
  CatalogScope,
  // install / uninstall
  InstallEnvelope,
  InstallEvent,
  InstallResult,
  InstallResults,
  InstallScope,
  InstallSummary,
  InstallRequestEcho,
  // audit
  AuditEnvelope,
  AuditEntry,
  AuditScanReport,
  AuditFinding,
  AuditNemesisVerdict,
  // info / where / status
  InfoEnvelope,
  InfoPlugin,
  InfoTarget,
  InfoComponent,
  WhereEnvelope,
  WherePlugin,
  WhereTarget,
  StatusEnvelope,
  StatusPlugin,
  StatusAgent,
  StatusComponent,
  // matrix / skills / vault / doctor
  MatrixEnvelope,
  MatrixReach,
  // harden (defensive self-audit)
  HardenEnvelope,
  HardenFinding,
  // chat (agentic-local response + terminal-launch preview)
  ChatLocalEnvelope,
  ChatTerminalEnvelope,
  // model hub (browse rows — surfaced by the CLI model picker)
  OpenModelRow,
  SkillsEnvelope,
  SkillEntry,
  VaultEnvelope,
  VaultRepo,
  DoctorEnvelope,
  DoctorReport,
  // request builders
  InstallRequest,
  UninstallRequest,
  ToggleComponent,
} from "./types/index.js";
export { isCommand } from "./types/index.js";

// --- sidecar lifecycle (file 02 §4.2/§4.4) ---------------------------------
export type { SidecarHealth, ExecOptions, OpClass } from "./sidecar.js";
export {
  PythonSidecar,
  READONLY_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  MUTATION_TIMEOUT_MS,
} from "./sidecar.js";

// --- python helper-sidecar runner (C7; child_process centralized here per C5) ---
// The CLI and desktop main process call THIS instead of importing child_process,
// so node:child_process is imported by exactly one package (file 02 §1.1).
export type { SidecarEnvelope, SidecarOptions } from "./sidecar-runner.js";
export { runSidecar, parseSidecarObject, resolveSidecarDir } from "./sidecar-runner.js";
// APP-044: the persistent kernel.py serve sidecar (NDJSON event stream, not one-shot).
export type {
  KernelEvent,
  KernelRequest,
  KernelSidecar,
  KernelSidecarOptions,
} from "./sidecar-runner.js";
export { spawnKernelSidecar } from "./sidecar-runner.js";
// file 14 §3.26: the SQL console backend marshaller (APP-041).
export type {
  SqlClient,
  SqlCell,
  SqlColumn,
  SqlTable,
  SqlConnectResult,
  SqlQueryResult,
  SqlSchemaResult,
  SqlQueryArgs,
  SidecarRunner,
} from "./sql-client.js";
export { createSqlClient, sqlSidecar } from "./sql-client.js";

// --- typed command facade (file 02 §3.4) -----------------------------------
export type { CallOptions } from "./engine.js";
export {
  PrometheusEngine,
  createPrometheusEngine,
  buildInstallArgv,
  buildUninstallArgv,
} from "./engine.js";

// --- the typed env client (file 04 §2/§8 — Package & Environment Manager) ---
// A camelCasing marshaller over runSidecar("envmgr.py", …). The gate verdict
// rides through every fetching verb UNCHANGED — JS never decides "safe" (C5).
// GateBadge is re-exported from ./security/verdict.js (NOT redefined here).
export type {
  EnvKind,
  EnvScope,
  EnvManagedBy,
  EnvHealth,
  EnvOrigin,
  EnvCuda,
  Env,
  PkgState,
  PkgSource,
  Package,
  TemplatePkg,
  Template,
  GpuDevice,
  GpuInfo,
} from "./env.types.js";
export type {
  EnvClientOptions,
  GateSummary,
  ForcedDangerInfo,
  GatedInstallResult,
  MutationResult,
  CreateEnvOptions,
  CloneEnvOptions,
  ImportEnvOptions,
  PkgInstallOptions,
  CudaTorchOptions,
  CudaInstallOptions,
} from "./env.js";
export {
  EnvClient,
  createEnvClient,
  toGpuInfo,
  listEnvs,
  createEnv,
  cloneEnv,
  deleteEnv,
  useEnv,
  exportEnv,
  importEnv,
  doctorEnv,
  pkgList,
  pkgInstall,
  pkgUpdate,
  pkgUpgrade,
  pkgRemove,
  pkgUninstall,
  pkgEnable,
  pkgDisable,
  cudaInfo,
  cudaTorch,
  cudaInstall,
} from "./env.js";

// --- the Model Hub (file 05 — discover / fit / download / serve / repoint) ----
// A camelCasing marshaller over runSidecar("modelhub.py", …) for weights + the
// LIVE `localai` engine passthrough. The download GATE decision is the REAL nemesis
// (stage → nemesis → admit | quarantine) inside the sidecar — JS NEVER decides safe
// (C5); a BLOCK rides through as a returned DownloadResult, not a throw. GateBadge /
// NemesisVerdictRef are re-exported from ./security/verdict.js (NOT redefined here).
export type {
  Accel,
  HardwareGpu,
  HardwareCaps,
  HardwareProfile,
  QuantFmt,
  RunnerHint,
  QuantFile,
  Quant,
  ModelSource,
  Modality,
  Model,
  Runner,
  ServeStatus,
  ServeEndpoint,
  ServeArgs,
  ServeProfile,
  FitVerdict,
  ScoredQuant,
  FitResult,
  SafeParse,
  Schema,
} from "./modelhub/types.js";
export { SchemaError, FitResultSchema, HardwareProfileSchema } from "./modelhub/types.js";
export type {
  ModelHubClientOptions,
  DownloadProgress,
  GateSummary as ModelHubGateSummary,
  ForcedDangerInfo as ModelHubForcedDangerInfo,
  FormatRisk,
  DownloadResult,
  MutationResult as ModelHubMutationResult,
  Endpoint,
  EndpointsResult,
  RepointResult,
  SearchOptions,
  FitOptions,
  DownloadOptions,
  ServeOptions,
  RepointOptions,
} from "./modelhub/client.js";
export {
  ModelHubClient,
  createModelHubClient,
  parseDownloadProgressLine,
  hardware,
  search,
  info,
  fit,
  download,
  library,
  remove as removeModel,
  serve,
  unserve,
  endpoints,
  repoint,
} from "./modelhub/client.js";
export type { LocalaiSub, LocalaiOptions, LocalaiResult } from "./modelhub/localai.js";
export {
  localai,
  LOCALAI_CLIENT_VERSION,
  projectLocalaiEnvelope,
  audit as localaiAudit,
  models as localaiModels,
  endpoints as localaiEndpoints,
  show as localaiShow,
  model as localaiModel,
} from "./modelhub/localai.js";

// --- the Catalog READ surface (file 06 §4.2 — catalog browser front-end) -------
// Typed reads over runPrometheus for the JSON-envelope commands + a LIVE human-table
// passthrough (rawEngine) for apps/worldsim/models/localai/inventory (which print
// tables, not JSON — verified live). NOTHING here decides "safe" (C5): audit surfaces
// the engine/nemesis verdict, never a recomputed one. The bare per-verb helpers collide
// with the modelhub localai* names, so the PUBLIC surface is the CatalogClient class +
// factory + types (import the bare helpers from "./catalog.js" directly if needed).
export type {
  CatalogClientOptions,
  AuditOptions,
  AppActionOptions as CatalogAppActionOptions,
  RawEngineResult,
} from "./catalog.js";
export { CatalogClient, createCatalogClient, rawEngine } from "./catalog.js";

// --- the catalog LIFECYCLE surface (file 06 §4.2 — state-changing) -------------
// install/uninstall/enable/disable/bundle/sync/scaffoldSkill + apps/worldsim/models
// lifecycle actions, with the surgical --host/--only/--skip/--arm/--component surface.
// The GOLDEN RULE (C5): install() never pre-judges — the engine runs nemesis itself and
// returns ok:false / forced_danger on a BLOCK (a rendered value, not a throw). Defaults
// dryRun:true / yes:false / force:false; force is emitted ONLY when explicitly set.
export type {
  LifecycleClientOptions,
  InstallOptions,
  UninstallOptions,
  ToggleOptions,
  BundleOptions,
  ScaffoldSkillOptions,
  AppActionOptions as LifecycleAppActionOptions,
} from "./lifecycle.js";
export {
  LifecycleClient,
  createLifecycleClient,
  install,
  uninstall,
  enable,
  disable,
  bundle,
  sync,
  scaffoldSkill,
} from "./lifecycle.js";

// --- the GitHub Repo Manager (file 06 §3 / FEATURE #5a / 00-INDEX C6) -----------
// A camelCasing marshaller over runSidecar("repo.py", …): the ONLY arbitrary-URL clone
// path, hard-wired through _GIT_SAFE_FLAGS + the REAL nemesis gate inside the sidecar.
// JS NEVER decides safe (C5): a BLOCK rides through as a returned RepoResult
// (ok:false, blocked:true), quarantined, never promoted. force is refused unless explicit.
// RepoVerdictRef extends the C3 NemesisVerdictRef (NOT a new shape).
export type {
  RepoClientOptions,
  RepoGateSummary,
  RepoVerdictRef,
  RepoForcedDanger,
  RepoStatus,
  Repo,
  RepoResult,
  RepoRescanResult,
  RepoRemoveResult,
  CloneOptions,
  UpdateOptions,
  RescanOptions,
} from "./repo.js";
export {
  RepoClient,
  createRepoClient,
  repoClone,
  repoUpdate,
  repoPin,
  repoBranch,
  repoRescan,
  repoRemove,
  repoList,
} from "./repo.js";

// --- test runner + remote interpreters (file 14 §3.19 / §3.7) -------------- //
// PURE contract types + roll-up/coverage math + remote launcher-argv builders the
// future testmgr.py / transport shims feed; this module never spawns + never decides
// "safe" (C5) — the run-gate + the persisted RemoteTarget.gate verdict do.
export type {
  TestNode,
  TestRunEvent,
  TestState,
  TestRunSummary,
  TestRunEnvelope,
  CoverageReport,
  TestStats,
} from "./test.types.js";
export {
  applyRunEvents,
  computeTotalCoverage,
  fileCoverage,
  findTestNode,
  flattenTestTree,
  lineCoverage,
  nodeState,
  rerunFailedIds,
  rollupStatus,
  testCases,
  worstState,
} from "./test.types.js";
export type { RemoteKind, PathMapping, RemoteTarget } from "./remote.types.js";
export {
  buildComposeArgv,
  buildDockerArgv,
  buildSshArgv,
  buildWslArgv,
  launcherArgv,
  remoteTargetAllowed,
  toLocalPath,
  toRemotePath,
} from "./remote.types.js";

// --- file metadata control (file 0C — privacy protection) ------------------ //
// A typed client over the metadata.py sidecar: inspect/scrub/edit/timestomp the
// metadata of ONE user-selected file. Mutations are plan-only without confirm (C5);
// copy-then-replace never loses the original on failure.
export type {
  FsMetadata,
  MetadataClientOptions,
  MetadataEdit,
  MetadataInspect,
  MetadataScrub,
  MetadataTimestomp,
  MetadataTools,
} from "./metadata.js";
export { MetadataClient, createMetadataClient } from "./metadata.js";

// the curated child-process env (strips linker/loader/interpreter hijack vars) — reused
// by the IDE's gated command-exec host so it spawns with the same hardening as nemesis.
export { safeChildEnv } from "./safe-env.js";
export {
  probeSystemCommand,
  execCapture,
  type ProbeOptions,
  type ExecCaptureResult,
} from "./system-probe.js";
export {
  LAUNCH_CEILING_PCT,
  type LaunchGuardSample,
  launchGuardVerdict,
  sampleLaunchGuard,
} from "./launch-guard.js";
export {
  createServeHost,
  serveStatePath,
  type ServeHostApi,
  type ServeHostDeps,
  type ServeLiveStatus,
  type ServeRecord,
  type ServeSpec,
  type ServeStartResult,
  type ServeStopResult,
} from "./serve-host.js";
