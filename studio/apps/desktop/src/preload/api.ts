/**
 * preload/api.ts — the EXACT narrow contextBridge API surface (file 01 §5).
 *
 * This builds the full `window.prometheus.{scan,gate,list,info,install,env,
 * model,provider,version,onProgress, …}` object the brief enumerates. Each method
 * is a thin `ipcRenderer.invoke(<named channel>, …)` (request/response) or, for
 * the live feed, an `ipcRenderer.on(<event channel>, …)` subscription returning
 * an unsubscribe. The renderer therefore receives PLAIN PROMISES of PLAIN DATA
 * and NEVER a Node handle, an EngineClient, a ChildProcess, or `require`.
 *
 * It is split out of preload/index.ts so the API object is constructed in ONE
 * place from the single shared contract — preload/index.ts just exposes it via
 * contextBridge. Keeping it here also lets index.ts stay a 3-line entry.
 *
 * RENDERER-SANDBOX INVARIANT (C5): with sandbox:true + contextIsolation:true the
 * renderer's realm is isolated; contextBridge is the only sanctioned seam. We
 * expose FUNCTIONS ONLY (no live object refs), only the exact channels in the
 * contract, and the progress feed forwards PLAIN ProgressFeedEvent data — no
 * security decision crosses (the renderer cannot decide "safe").
 *
 * Imports electron (preload world) — never importable into the renderer.
 */

import { ipcRenderer } from "electron";

import {
  type AiProbeEndpointResult,
  type AiProbeModelsResult,
  type AiProgressEvent,
  type AiStreamRequest,
  type AiStreamResult,
  type BudgetApi,
  type BudgetStatusResult,
  type CatalogApi,
  type CatalogAppLifecycleRequest,
  type CatalogBrowseResult,
  type CatalogBundleRequest,
  type CatalogEnvelopeResult,
  type CatalogInstallRequest,
  type CatalogInstallResult,
  type CatalogProgressEvent,
  type CatalogRawRequest,
  type CatalogRawResult,
  type CatalogScaffoldRequest,
  type CatalogToggleRequest,
  type CatalogUninstallRequest,
  type CodebaseOverviewApi,
  type CodebaseOverviewResult,
  type CudaInfoResult,
  type CudaInstallRequest,
  type CudaTorchRequest,
  type EnvApi,
  type EnvCloneRequest,
  type EnvCreateRequest,
  type EnvGatedResult,
  type EnvImportRequest,
  type EnvListResult,
  type EnvMutationResult,
  type EnvelopeResult,
  type ExtActivateResult,
  type ExtApi,
  type ExtDeactivateResult,
  type ExtInstallResult,
  type ExtListResult,
  type ExtRescanResult,
  type FileOpenResult,
  type FolderOpenResult,
  type GateResult,
  type HealthResult,
  IPC,
  IPC_CANCEL,
  IPC_EVENTS,
  IPC_UPDATE,
  IPC_UPDATE_EVENTS,
  type IdeAckResult,
  type IdeActiveVenv,
  type IdeAgentFilesListResult,
  type IdeApi,
  type IdeCommandFilesListResult,
  type IdeCoverageResult,
  type IdeDapDetectAdapterResult,
  type IdeDapInstallAdapterResult,
  type IdeDapLaunchOptions,
  type IdeDapLaunchPlan,
  type IdeDapLaunchResult,
  type IdeDapRequestResult,
  type IdeEvent,
  type IdeExecRequest,
  type IdeExecResult,
  type IdeFloatingTerminalCreateRequest,
  type IdeFloatingTerminalResult,
  type IdeFsReadResult,
  type IdeFsWalkResult,
  type IdeGateRequest,
  type IdeGateResult,
  type IdeGitBlameResult,
  type IdeGitBranchesResult,
  type IdeGitConflictVersionsResult,
  type IdeGitDiffResult,
  type IdeGitLogResult,
  type IdeGitOpResult,
  type IdeGitRebaseState,
  type IdeGitRebaseTodoResult,
  type IdeGitRebaseTodoRow,
  type IdeGitShowResult,
  type IdeGitStashListResult,
  type IdeGitStatus,
  type IdeHistoryListResult,
  type IdeHistoryReadResult,
  type IdeKernelOkResult,
  type IdeKernelStartResult,
  type IdeLintDetectResult,
  type IdeLintRunRequest,
  type IdeLintRunResult,
  type IdeLspEnsureResult,
  type IdeLspListResult,
  type IdeLspRequestResult,
  type IdeOkResult,
  type IdePrDetailResult,
  type IdePrListResult,
  type IdePrOpResult,
  type IdePrStatus,
  type IdeProfileCompareRequest,
  type IdeProfileCompareResult,
  type IdeProfileListResult,
  type IdeProfileResult,
  type IdeProfileSaveResult,
  type IdeProfileSnapshotSaveRequest,
  type IdeProfileStartRequest,
  type IdePtySpawnResult,
  type IdeRefactorChangeSignatureReq,
  type IdeRefactorExtractReq,
  type IdeRefactorGenAtReq,
  type IdeRefactorGenDelegateReq,
  type IdeRefactorGenFieldsReq,
  type IdeRefactorGenOverrideReq,
  type IdeRefactorGenPropertyReq,
  type IdeRefactorInlineReq,
  type IdeRefactorMoveReq,
  type IdeRefactorRenameReq,
  type IdeRefactorResult,
  type IdeRefactorSafeDeleteReq,
  type IdeRepoMapRequest,
  type IdeRepoMapResult,
  type IdeRunKillResult,
  type IdeRunStartRequest,
  type IdeRunStartResult,
  type IdeSearchRequest,
  type IdeSearchResult,
  type IdeSqlConnectResult,
  type IdeSqlQueryRequest,
  type IdeSqlQueryResult,
  type IdeSqlSchemaResult,
  type IdeSteeringGlobalResult,
  type IdeStructSearchResult,
  type IdeTerminalMenuRequest,
  type IdeTerminalMenuResult,
  type IdeTerminalResolveRequest,
  type IdeTerminalResolveResult,
  type IdeTestDiscoverResult,
  type IdeTestEvent,
  type IdeTestFramework,
  type IdeTestRunResult,
  type IdeTreeNode,
  type IdeWorkspaceIndexResult,
  type IdeWorktreeListResult,
  type IdeWorktreeOpResult,
  type InstallOptions,
  type McpAddRequest,
  type McpApi,
  type McpImportResult,
  type McpListResult,
  type McpOpResult,
  type MetadataApi,
  type MetadataEditResult,
  type MetadataInspectResult,
  type MetadataScrubResult,
  type MetadataTimestompResult,
  type ModelApi,
  type ModelConvertRequest,
  type ModelConvertResult,
  type ModelDownloadRequest,
  type ModelDownloadResult,
  type ModelEndpointsResult,
  type ModelFetchHfRequest,
  type ModelFetchHfResult,
  type ModelFitRequest,
  type ModelFitResult,
  type ModelHardwareResult,
  type ModelHealthApi,
  type ModelHealthListResult,
  type ModelHealthRecordResult,
  type ModelHealthRecordView,
  type ModelInfoResult,
  type ModelInstallConverterResult,
  type ModelInstallHfCliResult,
  type ModelInstallRunnerRequest,
  type ModelInstallRunnerResult,
  type ModelInstallTargetRequest,
  type ModelInstallTargetResult,
  type ModelMutationResult,
  type ModelProgressEvent,
  type ModelPullRequest,
  type ModelPullResult,
  type ModelRepointRequest,
  type ModelRepointResult,
  type ModelSearchRequest,
  type ModelSearchResult,
  type ModelServeRequest,
  type ModelServeResult,
  type OpenPathResult,
  type PathCompletionApi,
  type PathCompletionListResult,
  type PathCompletionRecordUseResult,
  type PersonaApi,
  type PersonaExportResult,
  type PersonaImportResult,
  type PersonaListResult,
  type PersonaRemoveResult,
  type PkgInstallRequest,
  type PkgListResult,
  type PkgUpgradeRequest,
  type ProgressFeedEvent,
  type PrometheusApi,
  type ProvidersResult,
  type RepoApi,
  type RepoCloneRequest,
  type RepoCloneResult,
  type RepoListResult,
  type RepoRemoveResult,
  type RepoRescanResult,
  type ScanResult,
  type ScheduleApi,
  type ScheduleListResult,
  type ScheduleRemoveResult,
  type ScheduleUpsertResult,
  type ScheduledTaskView,
  type SecurityApi,
  type SecurityGateOptions,
  type SecurityGateResult,
  type SecurityInstallOptions,
  type SecurityRemediateRequest,
  type SecurityRemediateResult,
  type SecurityThreatDbRequest,
  type SecurityThreatDbResult,
  type SecurityTrustRequest,
  type SecurityTrustResult,
  type SecurityUrlAuditRequest,
  type SecurityUrlAuditResult,
  type ServersResult,
  type SettingsApi,
  type SettingsGetResult,
  type SettingsListResult,
  type SettingsResetResult,
  type SettingsSetResult,
  type SettingsSyncApi,
  type SettingsSyncPullResult,
  type SettingsSyncPushRequest,
  type SettingsSyncResult,
  type SettingsWriteScope,
  type SpectacularApi,
  type SpectacularCard,
  type SpectacularChatLocal,
  type SpectacularChatPreview,
  type SpectacularChatPreviewOpts,
  type SpectacularHarden,
  type SpectacularMethods,
  type SpectacularModelsBrowse,
  type SpectacularModelsConfig,
  type SpectacularTutorial,
  type SqlApi,
  type SystemTelemetry,
  type UninstallOptions,
  type UpdateAvailableInfo,
  type UpdateCheckResult,
  type UpdateDownloadResult,
  type UpdateInstallResult,
  type UpdateProgressInfo,
  type UpdatesApi,
  type VersionResult,
} from "../shared/ipc-contract.js";
import type {
  AgentCanaryTripRequest,
  AgentCanaryTripResult,
  AgentEngineToolRequest,
  AgentGrant,
  AgentGrantsResult,
  AgentHookRunRequest,
  AgentHookRunResult,
  AgentSystemToolRequest,
  AgentSystemToolResult,
  McpAgentCallRequest,
  McpAgentToolsResult,
} from "../shared/ipc-contract.js";

/**
 * Build the `window.prometheus.security.*` surface (file 03 §5,§7). Each method
 * is a thin invoke of its `security:*` channel; the renderer receives plain data
 * the MAIN process obtained from engine-bridge. NO security decision is made here
 * — the renderer renders verdicts, it never decides "safe" (C5).
 */
function createSecurityApi(): SecurityApi {
  const gate = (target: string, opts?: SecurityGateOptions): Promise<SecurityGateResult> =>
    ipcRenderer.invoke(IPC.securityGate, { target, ...(opts ?? {}) });
  return {
    gate,
    // gateFull is the same rich verdict path under the brief's name.
    gateFull: (target: string, opts?: SecurityGateOptions): Promise<SecurityGateResult> =>
      ipcRenderer.invoke(IPC.securityGateFull, { target, ...(opts ?? {}) }),
    audit: (name: string): Promise<EnvelopeResult> =>
      ipcRenderer.invoke(IPC.securityAudit, { name }),
    install: (name: string, opts?: SecurityInstallOptions): Promise<EnvelopeResult> =>
      ipcRenderer.invoke(IPC.securityInstall, { name, ...(opts ?? {}) }),
    remediate: (req: SecurityRemediateRequest): Promise<SecurityRemediateResult> =>
      ipcRenderer.invoke(IPC.securityRemediate, req),
    threatdb: (req: SecurityThreatDbRequest): Promise<SecurityThreatDbResult> =>
      ipcRenderer.invoke(IPC.securityThreatdb, req),
    trust: (req: SecurityTrustRequest): Promise<SecurityTrustResult> =>
      ipcRenderer.invoke(IPC.securityTrust, req),
    urlAudit: (req: SecurityUrlAuditRequest): Promise<SecurityUrlAuditResult> =>
      ipcRenderer.invoke(IPC.securityUrlAudit, req),
    onProgress: (listener: (event: ProgressFeedEvent) => void): (() => void) => {
      const wrapped = (_evt: unknown, payload: ProgressFeedEvent): void => listener(payload);
      ipcRenderer.on(IPC_EVENTS.securityProgress, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.securityProgress, wrapped);
      };
    },
  };
}

/**
 * Build the `window.prometheus.env.*` surface (file 04 §1,§3). Each method is a
 * thin invoke of its `env:* / pkg:* / cuda:*` channel; the renderer receives plain
 * data the MAIN process obtained from engine-bridge's env client. NO gate decision
 * is made here — the renderer renders the verdict the engine produced, it never
 * decides "safe" (C5/the SPINE).
 */
function createEnvApi(): EnvApi {
  return {
    list: (): Promise<EnvListResult> => ipcRenderer.invoke(IPC.envEnvList),
    create: (req: EnvCreateRequest): Promise<EnvMutationResult> =>
      ipcRenderer.invoke(IPC.envEnvCreate, req),
    clone: (req: EnvCloneRequest): Promise<EnvGatedResult> =>
      ipcRenderer.invoke(IPC.envEnvClone, req),
    delete: (id: string, confirm?: boolean): Promise<EnvMutationResult> =>
      ipcRenderer.invoke(IPC.envEnvDelete, { id, confirm }),
    use: (id: string): Promise<EnvMutationResult> => ipcRenderer.invoke(IPC.envEnvUse, { id }),
    export: (id: string, to?: string): Promise<EnvMutationResult> =>
      ipcRenderer.invoke(IPC.envEnvExport, { id, to }),
    import: (req: EnvImportRequest): Promise<EnvGatedResult> =>
      ipcRenderer.invoke(IPC.envEnvImport, req),
    doctor: (id: string): Promise<EnvMutationResult> =>
      ipcRenderer.invoke(IPC.envEnvDoctor, { id }),
    pkgList: (envId: string): Promise<PkgListResult> =>
      ipcRenderer.invoke(IPC.envPkgList, { envId }),
    pkgInstall: (req: PkgInstallRequest): Promise<EnvGatedResult> =>
      ipcRenderer.invoke(IPC.envPkgInstall, req),
    pkgUpdate: (req: PkgInstallRequest): Promise<EnvGatedResult> =>
      ipcRenderer.invoke(IPC.envPkgUpdate, req),
    pkgUpgrade: (req: PkgUpgradeRequest): Promise<EnvGatedResult> =>
      ipcRenderer.invoke(IPC.envPkgUpgrade, req),
    pkgRemove: (
      envId: string,
      pkgs: string | string[],
      confirm?: boolean,
    ): Promise<EnvMutationResult> =>
      ipcRenderer.invoke(IPC.envPkgRemove, {
        envId,
        pkgs: Array.isArray(pkgs) ? pkgs : [pkgs],
        confirm,
      }),
    pkgUninstall: (
      envId: string,
      pkgs: string | string[],
      confirm?: boolean,
    ): Promise<EnvMutationResult> =>
      ipcRenderer.invoke(IPC.envPkgUninstall, {
        envId,
        pkgs: Array.isArray(pkgs) ? pkgs : [pkgs],
        confirm,
      }),
    pkgEnable: (envId: string, pkg: string, confirm?: boolean): Promise<EnvMutationResult> =>
      ipcRenderer.invoke(IPC.envPkgEnable, { envId, pkg, confirm }),
    pkgDisable: (envId: string, pkg: string, confirm?: boolean): Promise<EnvMutationResult> =>
      ipcRenderer.invoke(IPC.envPkgDisable, { envId, pkg, confirm }),
    cudaInfo: (): Promise<CudaInfoResult> => ipcRenderer.invoke(IPC.envCudaInfo),
    cudaTorch: (req: CudaTorchRequest): Promise<EnvGatedResult> =>
      ipcRenderer.invoke(IPC.envCudaTorch, req),
    cudaInstall: (req?: CudaInstallRequest): Promise<EnvMutationResult> =>
      ipcRenderer.invoke(IPC.envCudaInstall, req ?? {}),
    onProgress: (listener: (event: ProgressFeedEvent) => void): (() => void) => {
      const wrapped = (_evt: unknown, payload: ProgressFeedEvent): void => listener(payload);
      ipcRenderer.on(IPC_EVENTS.envProgress, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.envProgress, wrapped);
      };
    },
  };
}

/**
 * Build the `window.prometheus.model.*` surface (file 05 §1,§7,§8). Each method is
 * a thin invoke of its `model:*` channel; the renderer receives plain data the
 * MAIN process obtained from the engine-bridge modelhub client (downloads) + the
 * C8 ServeSupervisor (serve). NO gate decision is made here — the renderer renders
 * the verdict the engine produced, it never decides "safe" (C5/the SPINE).
 */
/**
 * Build the `window.prometheus.mcp.*` surface (file 09 §2) — the MCP connector
 * manager. Each method thin-invokes its `mcp:*` channel; MAIN owns the McpHostManager
 * (persistence + nemesis gate + real stdio transport). The renderer receives plain
 * `McpConnectorView` data — never a live transport or a ChildProcess (C5).
 */
function createMcpApi(): McpApi {
  return {
    list: (): Promise<McpListResult> => ipcRenderer.invoke(IPC.mcpList),
    add: (req: McpAddRequest): Promise<McpOpResult> => ipcRenderer.invoke(IPC.mcpAdd, req),
    connect: (id: string): Promise<McpOpResult> => ipcRenderer.invoke(IPC.mcpConnect, { id }),
    disconnect: (id: string): Promise<McpOpResult> => ipcRenderer.invoke(IPC.mcpDisconnect, { id }),
    remove: (id: string): Promise<McpOpResult> => ipcRenderer.invoke(IPC.mcpRemove, { id }),
    setEnabled: (id: string, enabled: boolean): Promise<McpOpResult> =>
      ipcRenderer.invoke(IPC.mcpSetEnabled, { id, enabled }),
    import: (): Promise<McpImportResult> => ipcRenderer.invoke(IPC.mcpImport),
    // The agent pane as an MCP client: descriptors in, one call out.
    agentTools: (): Promise<McpAgentToolsResult> => ipcRenderer.invoke(IPC.mcpAgentTools),
    agentCall: (req: McpAgentCallRequest): Promise<AgentSystemToolResult> =>
      ipcRenderer.invoke(IPC.mcpAgentCall, req),
  };
}

/** APP-095: the git-backed settings-sync surface. */
function createSettingsSyncApi(): SettingsSyncApi {
  return {
    push: (req: SettingsSyncPushRequest): Promise<SettingsSyncResult> =>
      ipcRenderer.invoke(IPC.settingsSyncPush, req),
    pull: (req: { repoDir: string }): Promise<SettingsSyncPullResult> =>
      ipcRenderer.invoke(IPC.settingsSyncPull, req),
  };
}

/**
 * Build `window.prometheus.updates.*` (file 10 §5, APP-005) — thin invokes of the
 * update:* channels plus the three MAIN→renderer event feeds. Payloads are the
 * already-mapped PLAIN shapes (main strips electron-updater objects — DataCloneError
 * rule); each wrapper drops the IpcRendererEvent so it never leaks to the renderer.
 * Policy (ask-before-download / never-auto-install) is enforced in MAIN, not here.
 */
function createUpdatesApi(): UpdatesApi {
  const subscribe = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
    const wrapped = (_evt: unknown, payload: T): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  };
  return {
    check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC_UPDATE.check),
    download: (): Promise<UpdateDownloadResult> => ipcRenderer.invoke(IPC_UPDATE.download),
    install: (): Promise<UpdateInstallResult> => ipcRenderer.invoke(IPC_UPDATE.install),
    onAvailable: (listener: (info: UpdateAvailableInfo) => void): (() => void) =>
      subscribe(IPC_UPDATE_EVENTS.available, listener),
    onProgress: (listener: (p: UpdateProgressInfo) => void): (() => void) =>
      subscribe(IPC_UPDATE_EVENTS.progress, listener),
    onReady: (listener: () => void): (() => void) =>
      subscribe(IPC_UPDATE_EVENTS.ready, () => listener()),
  };
}

function createSettingsApi(): SettingsApi {
  return {
    list: (workspaceRoot?: string): Promise<SettingsListResult> =>
      ipcRenderer.invoke(IPC.settingsList, { workspaceRoot }),
    get: (key: string, workspaceRoot?: string): Promise<SettingsGetResult> =>
      ipcRenderer.invoke(IPC.settingsGet, { key, workspaceRoot }),
    set: (
      key: string,
      value: unknown,
      scope: SettingsWriteScope,
      workspaceRoot?: string,
    ): Promise<SettingsSetResult> =>
      ipcRenderer.invoke(IPC.settingsSet, { key, value, scope, workspaceRoot }),
    reset: (
      key: string,
      scope: SettingsWriteScope,
      workspaceRoot?: string,
    ): Promise<SettingsResetResult> =>
      ipcRenderer.invoke(IPC.settingsReset, { key, scope, workspaceRoot }),
  };
}

function createPathCompletionApi(): PathCompletionApi {
  return {
    list: (
      dir: string,
      query: string,
      workspaceRoot?: string,
      useFrecency?: boolean,
    ): Promise<PathCompletionListResult> =>
      ipcRenderer.invoke(IPC.pathCompletionList, { dir, query, workspaceRoot, useFrecency }),
    recordUse: (workspaceRoot: string, path: string): Promise<PathCompletionRecordUseResult> =>
      ipcRenderer.invoke(IPC.pathCompletionRecordUse, { workspaceRoot, path }),
  };
}

function createModelHealthApi(): ModelHealthApi {
  return {
    list: (): Promise<ModelHealthListResult> => ipcRenderer.invoke(IPC.modelHealthList),
    record: (record: ModelHealthRecordView): Promise<ModelHealthRecordResult> =>
      ipcRenderer.invoke(IPC.modelHealthRecord, record),
  };
}

function createBudgetApi(): BudgetApi {
  return {
    status: (): Promise<BudgetStatusResult> => ipcRenderer.invoke(IPC.budgetStatus),
  };
}

function createCodebaseOverviewApi(): CodebaseOverviewApi {
  return {
    generate: (): Promise<CodebaseOverviewResult> => ipcRenderer.invoke(IPC.codebaseOverview),
  };
}

function createScheduleApi(): ScheduleApi {
  return {
    list: (): Promise<ScheduleListResult> => ipcRenderer.invoke(IPC.scheduleList),
    upsert: (task: ScheduledTaskView): Promise<ScheduleUpsertResult> =>
      ipcRenderer.invoke(IPC.scheduleUpsert, task),
    remove: (id: string): Promise<ScheduleRemoveResult> =>
      ipcRenderer.invoke(IPC.scheduleRemove, { id }),
  };
}

function createPersonaApi(): PersonaApi {
  return {
    list: (): Promise<PersonaListResult> => ipcRenderer.invoke(IPC.personaList),
    export: (name: string): Promise<PersonaExportResult> =>
      ipcRenderer.invoke(IPC.personaExport, { name }),
    importText: (suggestedName: string, markdown: string): Promise<PersonaImportResult> =>
      ipcRenderer.invoke(IPC.personaImportText, { suggestedName, markdown }),
    importPath: (path: string): Promise<PersonaImportResult> =>
      ipcRenderer.invoke(IPC.personaImportPath, { path }),
    remove: (name: string): Promise<PersonaRemoveResult> =>
      ipcRenderer.invoke(IPC.personaRemove, { name }),
  };
}

function createExtApi(): ExtApi {
  return {
    list: (): Promise<ExtListResult> => ipcRenderer.invoke(IPC.extList),
    install: (archivePath: string): Promise<ExtInstallResult> =>
      ipcRenderer.invoke(IPC.extInstall, { archivePath }),
    activate: (id: string): Promise<ExtActivateResult> =>
      ipcRenderer.invoke(IPC.extActivate, { id }),
    deactivate: (id: string): Promise<ExtDeactivateResult> =>
      ipcRenderer.invoke(IPC.extDeactivate, { id }),
    rescan: (id: string): Promise<ExtRescanResult> => ipcRenderer.invoke(IPC.extRescan, { id }),
  };
}

function createModelApi(): ModelApi {
  return {
    hardware: (rescan?: boolean): Promise<ModelHardwareResult> =>
      ipcRenderer.invoke(IPC.modelHardware, { rescan }),
    search: (req?: ModelSearchRequest): Promise<ModelSearchResult> =>
      ipcRenderer.invoke(IPC.modelSearch, req ?? {}),
    info: (id: string): Promise<ModelInfoResult> => ipcRenderer.invoke(IPC.modelInfo, { id }),
    fit: (req: ModelFitRequest): Promise<ModelFitResult> => ipcRenderer.invoke(IPC.modelFit, req),
    download: (req: ModelDownloadRequest): Promise<ModelDownloadResult> =>
      ipcRenderer.invoke(IPC.modelDownload, req),
    pull: (req: ModelPullRequest): Promise<ModelPullResult> =>
      ipcRenderer.invoke(IPC.modelPull, req),
    installRunner: (req?: ModelInstallRunnerRequest): Promise<ModelInstallRunnerResult> =>
      ipcRenderer.invoke(IPC.modelInstallRunner, req ?? {}),
    library: (modality?: string): Promise<ModelSearchResult> =>
      ipcRenderer.invoke(IPC.modelLibrary, { modality }),
    remove: (
      id: string,
      opts?: { quant?: string; force?: boolean },
    ): Promise<ModelMutationResult> => ipcRenderer.invoke(IPC.modelRemove, { id, ...(opts ?? {}) }),
    serve: (req: ModelServeRequest): Promise<ModelServeResult> =>
      ipcRenderer.invoke(IPC.modelServe, req),
    unserve: (profileId: string): Promise<ModelServeResult> =>
      ipcRenderer.invoke(IPC.modelUnserve, { profileId }),
    serving: (): Promise<ModelServeResult> => ipcRenderer.invoke(IPC.modelServing),
    endpoints: (): Promise<ModelEndpointsResult> => ipcRenderer.invoke(IPC.modelEndpoints),
    repoint: (req: ModelRepointRequest): Promise<ModelRepointResult> =>
      ipcRenderer.invoke(IPC.modelRepoint, req),
    fetchHf: (req: ModelFetchHfRequest): Promise<ModelFetchHfResult> =>
      ipcRenderer.invoke(IPC.modelFetchHf, req),
    installHfCli: (): Promise<ModelInstallHfCliResult> =>
      ipcRenderer.invoke(IPC.modelInstallHfCli, {}),
    convert: (req: ModelConvertRequest): Promise<ModelConvertResult> =>
      ipcRenderer.invoke(IPC.modelConvert, req),
    installConverter: (): Promise<ModelInstallConverterResult> =>
      ipcRenderer.invoke(IPC.modelInstallConverter, {}),
    installTarget: (req: ModelInstallTargetRequest): Promise<ModelInstallTargetResult> =>
      ipcRenderer.invoke(IPC.modelInstallTarget, req),
    onProgress: (listener: (event: ModelProgressEvent) => void): (() => void) => {
      const wrapped = (_evt: unknown, payload: ModelProgressEvent): void => listener(payload);
      ipcRenderer.on(IPC_EVENTS.modelProgress, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.modelProgress, wrapped);
      };
    },
  };
}

/**
 * Build the `window.prometheus.catalog.*` surface (file 06 §4). Each method is a
 * thin invoke of its `catalog:*` channel; the renderer receives plain data the
 * MAIN process obtained from the engine-bridge catalog + lifecycle clients. NO
 * gate decision is made here — every STATE-CHANGING verb's verdict is the
 * engine's nemesis, rendered by the renderer, never decided here (C5/the SPINE).
 * The MAIN process refuses `force` without the paired `confirmForce` (§8).
 */
function createCatalogApi(): CatalogApi {
  return {
    browse: (): Promise<CatalogBrowseResult> => ipcRenderer.invoke(IPC.catalogBrowse),
    list: (): Promise<CatalogEnvelopeResult> => ipcRenderer.invoke(IPC.catalogList),
    info: (name: string): Promise<CatalogEnvelopeResult> =>
      ipcRenderer.invoke(IPC.catalogInfo, { name }),
    where: (name: string): Promise<CatalogEnvelopeResult> =>
      ipcRenderer.invoke(IPC.catalogWhere, { name }),
    matrix: (): Promise<CatalogEnvelopeResult> => ipcRenderer.invoke(IPC.catalogMatrix),
    status: (name: string): Promise<CatalogEnvelopeResult> =>
      ipcRenderer.invoke(IPC.catalogStatus, { name }),
    audit: (
      name: string,
      opts?: { strict?: boolean; gateFresh?: boolean },
    ): Promise<CatalogEnvelopeResult> =>
      ipcRenderer.invoke(IPC.catalogAudit, { name, ...(opts ?? {}) }),
    superscan: (): Promise<CatalogEnvelopeResult> => ipcRenderer.invoke(IPC.catalogSuperscan),
    skillsList: (): Promise<CatalogEnvelopeResult> => ipcRenderer.invoke(IPC.catalogSkillsList),
    vaultStatus: (): Promise<CatalogEnvelopeResult> => ipcRenderer.invoke(IPC.catalogVaultStatus),
    inventory: (host?: string): Promise<CatalogRawResult> =>
      ipcRenderer.invoke(IPC.catalogInventory, { host }),
    raw: (req: CatalogRawRequest): Promise<CatalogRawResult> => {
      // route the localai surface to its dedicated channel for clarity; all others
      // share the per-surface read channel. Both reach the same readRaw in main.
      const channel = req.surface === "localai" ? IPC.catalogLocalai : IPC.catalogApps;
      return ipcRenderer.invoke(channel, req);
    },
    install: (req: CatalogInstallRequest): Promise<CatalogInstallResult> =>
      ipcRenderer.invoke(IPC.catalogInstall, req),
    uninstall: (req: CatalogUninstallRequest): Promise<CatalogInstallResult> =>
      ipcRenderer.invoke(IPC.catalogUninstall, req),
    enable: (req: CatalogToggleRequest): Promise<CatalogEnvelopeResult> =>
      ipcRenderer.invoke(IPC.catalogEnable, req),
    disable: (req: CatalogToggleRequest): Promise<CatalogEnvelopeResult> =>
      ipcRenderer.invoke(IPC.catalogDisable, req),
    bundle: (req?: CatalogBundleRequest): Promise<CatalogInstallResult> =>
      ipcRenderer.invoke(IPC.catalogBundle, req ?? {}),
    sync: (skill: string, to: string): Promise<CatalogEnvelopeResult> =>
      ipcRenderer.invoke(IPC.catalogSync, { skill, to }),
    scaffoldSkill: (req: CatalogScaffoldRequest): Promise<CatalogEnvelopeResult> =>
      ipcRenderer.invoke(IPC.catalogScaffoldSkill, req),
    appLifecycle: (req: CatalogAppLifecycleRequest): Promise<CatalogEnvelopeResult> =>
      ipcRenderer.invoke(IPC.catalogAppLifecycle, req),
    onProgress: (listener: (event: CatalogProgressEvent) => void): (() => void) => {
      const wrapped = (_evt: unknown, payload: CatalogProgressEvent): void => listener(payload);
      ipcRenderer.on(IPC_EVENTS.catalogProgress, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.catalogProgress, wrapped);
      };
    },
  };
}

/**
 * Build the `window.prometheus.repo.*` surface (file 06 §3, FEATURE #5a). Each
 * method is a thin invoke of its `repo:*` channel; the renderer receives plain
 * data the MAIN process obtained from the engine-bridge repo client → the repo.py
 * sidecar. The gate decision is the REAL nemesis inside the sidecar (STAGE → gate
 * → promote | quarantine) — the renderer renders the verdict, it never decides
 * "safe" (C5). The MAIN process refuses `force` without `confirmForce` (§8).
 */
function createRepoApi(): RepoApi {
  return {
    clone: (req: RepoCloneRequest): Promise<RepoCloneResult> =>
      ipcRenderer.invoke(IPC.repoClone, req),
    list: (): Promise<RepoListResult> => ipcRenderer.invoke(IPC.repoList),
    update: (
      id: string,
      opts?: { force?: boolean; confirmForce?: boolean },
    ): Promise<RepoCloneResult> => ipcRenderer.invoke(IPC.repoUpdate, { id, ...(opts ?? {}) }),
    pin: (
      id: string,
      sha: string,
      opts?: { force?: boolean; confirmForce?: boolean },
    ): Promise<RepoCloneResult> => ipcRenderer.invoke(IPC.repoPin, { id, sha, ...(opts ?? {}) }),
    branch: (
      id: string,
      branch: string,
      opts?: { force?: boolean; confirmForce?: boolean },
    ): Promise<RepoCloneResult> =>
      ipcRenderer.invoke(IPC.repoBranch, { id, branch, ...(opts ?? {}) }),
    rescan: (id: string, opts?: { gateFresh?: boolean }): Promise<RepoRescanResult> =>
      ipcRenderer.invoke(IPC.repoRescan, { id, ...(opts ?? {}) }),
    remove: (id: string): Promise<RepoRemoveResult> => ipcRenderer.invoke(IPC.repoRemove, { id }),
  };
}

/**
 * Build the `window.prometheus.ide.*` surface (file 07 §3.2/§4/§5/§6/§9). Each
 * method is a thin invoke (request/response) or `send` (fire-and-forget notify) of
 * its `ide:*` channel; the renderer receives plain data the MAIN process obtained
 * from the LSP/DAP/PTY/git/fs hosts + the REAL engine-bridge run-gate. The renderer
 * NEVER spawns a child; it drives the hosts over IPC and decides nothing about
 * safety — the run-gate verdict is the engine's (C5/the GOLDEN RULE). The host feed
 * (diagnostics/events/output/fs changes) arrives over the single `ide:event` push.
 */
function createIdeApi(): IdeApi {
  return {
    // ── fs ────────────────────────────────────────────────────────────────
    fsRead: (uri: string): Promise<IdeFsReadResult> => ipcRenderer.invoke(IPC.ideFsRead, { uri }),
    steeringGlobal: (): Promise<IdeSteeringGlobalResult> =>
      ipcRenderer.invoke(IPC.ideSteeringGlobal),
    setWorkingSet: (roots: readonly string[]): Promise<IdeOkResult> =>
      ipcRenderer.invoke(IPC.ideSetWorkingSet, { roots: [...roots] }),
    approveOutsideWorkingSet: (
      path: string,
      scope?: "once" | "session" | "clear",
    ): Promise<IdeOkResult> =>
      ipcRenderer.invoke(IPC.ideApproveOutside, { path, scope: scope ?? "once" }),
    fsWrite: (uri: string, text: string): Promise<IdeOkResult> =>
      ipcRenderer.invoke(IPC.ideFsWrite, { uri, text }),
    fsTree: (dir: string): Promise<IdeTreeNode[]> => ipcRenderer.invoke(IPC.ideFsTree, { dir }),
    fsWalk: (root: string): Promise<IdeFsWalkResult> => ipcRenderer.invoke(IPC.ideFsWalk, { root }),
    fsWatch: (root: string): Promise<IdeOkResult> => ipcRenderer.invoke(IPC.ideFsWatch, { root }),
    fsUnwatch: (root: string): Promise<IdeOkResult> =>
      ipcRenderer.invoke(IPC.ideFsUnwatch, { root }),
    fsCreateFile: (path: string): Promise<IdeOkResult> =>
      ipcRenderer.invoke(IPC.ideFsCreateFile, { path }),
    fsMkdir: (path: string): Promise<IdeOkResult> => ipcRenderer.invoke(IPC.ideFsMkdir, { path }),
    fsRename: (src: string, dest: string): Promise<IdeOkResult> =>
      ipcRenderer.invoke(IPC.ideFsRename, { src, dest }),
    fsDelete: (path: string): Promise<IdeOkResult> => ipcRenderer.invoke(IPC.ideFsDelete, { path }),
    // ── LSP ───────────────────────────────────────────────────────────────
    lspEnsure: (
      languageId: string,
      workspaceRoot: string,
      interpreterPath?: string,
    ): Promise<IdeLspEnsureResult> =>
      ipcRenderer.invoke(IPC.ideLspEnsure, { languageId, workspaceRoot, interpreterPath }),
    lspList: (): Promise<IdeLspListResult> => ipcRenderer.invoke(IPC.ideLspList),
    lspApplyEditResult: (
      serverId: string,
      workspaceRoot: string,
      requestId: number | string,
      applied: boolean,
    ): Promise<IdeOkResult> =>
      ipcRenderer.invoke(IPC.ideLspApplyEditResult, {
        serverId,
        workspaceRoot,
        requestId,
        applied,
      }),
    lspRequest: (
      serverId: string,
      workspaceRoot: string,
      method: string,
      params?: unknown,
    ): Promise<IdeLspRequestResult> =>
      ipcRenderer.invoke(IPC.ideLspRequest, { serverId, workspaceRoot, method, params }),
    lspCancel: (serverId: string, workspaceRoot: string, requestId: number): void => {
      ipcRenderer.send(IPC.ideLspCancel, { serverId, workspaceRoot, requestId });
    },
    lspDidOpen: (
      serverId: string,
      workspaceRoot: string,
      uri: string,
      languageId: string,
      text: string,
      version?: number,
    ): void => {
      ipcRenderer.send(IPC.ideLspDidOpen, {
        serverId,
        workspaceRoot,
        uri,
        languageId,
        text,
        version,
      });
    },
    lspDidChange: (
      serverId: string,
      workspaceRoot: string,
      uri: string,
      text: string,
      version: number,
    ): void => {
      ipcRenderer.send(IPC.ideLspDidChange, { serverId, workspaceRoot, uri, text, version });
    },
    lspDidClose: (serverId: string, workspaceRoot: string, uri: string): void => {
      ipcRenderer.send(IPC.ideLspDidClose, { serverId, workspaceRoot, uri });
    },
    lspSetInterpreter: (
      serverId: string,
      workspaceRoot: string,
      interpreterPath: string,
    ): Promise<IdeOkResult> =>
      ipcRenderer.invoke(IPC.ideLspSetInterpreter, { serverId, workspaceRoot, interpreterPath }),
    // ── DAP ───────────────────────────────────────────────────────────────
    dapLaunch: (
      config: Record<string, unknown>,
      plan?: IdeDapLaunchPlan,
      opts?: IdeDapLaunchOptions,
    ): Promise<IdeDapLaunchResult> =>
      // fold the launch-time breakpoint/exception plan (APP-079) + the remote-attach
      // confirm flag (APP-080) into the DAP launch args; ide-validate/ide-ipc split them
      // back out so neither the plan nor allowRemote ever leaks into the adapter body.
      ipcRenderer.invoke(IPC.ideDapLaunch, {
        ...config,
        ...(plan?.sources ? { breakpoints: plan.sources } : {}),
        ...(plan?.exceptionFilters ? { exceptionFilters: plan.exceptionFilters } : {}),
        ...(opts?.allowRemote ? { allowRemote: true } : {}),
      }),
    dapRequest: (
      sessionId: string,
      command: string,
      args?: unknown,
    ): Promise<IdeDapRequestResult> =>
      ipcRenderer.invoke(IPC.ideDapRequest, { sessionId, command, args }),
    dapTerminate: (sessionId: string): Promise<IdeOkResult> =>
      ipcRenderer.invoke(IPC.ideDapTerminate, { sessionId }),
    dapDetectAdapter: (type: string, pythonPath?: string): Promise<IdeDapDetectAdapterResult> =>
      ipcRenderer.invoke(IPC.ideDapDetectAdapter, { type, pythonPath }),
    dapInstallAdapter: (
      type: string,
      opts?: { pythonPath?: string; confirm?: boolean },
    ): Promise<IdeDapInstallAdapterResult> =>
      ipcRenderer.invoke(IPC.ideDapInstallAdapter, { type, ...opts }),
    // ── plain Run (APP-032): gate → guard → spawn in MAIN; output via onEvent
    runStart: (req: IdeRunStartRequest): Promise<IdeRunStartResult> =>
      ipcRenderer.invoke(IPC.ideRunStart, req),
    runKill: (runId: string): Promise<IdeRunKillResult> =>
      ipcRenderer.invoke(IPC.ideRunKill, { runId }),
    // ── live Jupyter kernel (APP-045): one supervised session per notebook ───
    kernel: {
      start: (cwd: string, env?: Record<string, string>): Promise<IdeKernelStartResult> =>
        ipcRenderer.invoke(IPC.ideKernelStart, { cwd, ...(env ? { env } : {}) }),
      execute: (sessionId: string, cellId: string, code: string): Promise<IdeKernelOkResult> =>
        ipcRenderer.invoke(IPC.ideKernelExecute, { sessionId, cellId, code }),
      interrupt: (sessionId: string): Promise<IdeKernelOkResult> =>
        ipcRenderer.invoke(IPC.ideKernelInterrupt, { sessionId }),
      restart: (sessionId: string): Promise<IdeKernelOkResult> =>
        ipcRenderer.invoke(IPC.ideKernelRestart, { sessionId }),
      shutdown: (sessionId: string): Promise<IdeKernelOkResult> =>
        ipcRenderer.invoke(IPC.ideKernelShutdown, { sessionId }),
      dataframe: (
        sessionId: string,
        name: string,
        offset: number,
        limit: number,
      ): Promise<IdeKernelOkResult> =>
        ipcRenderer.invoke(IPC.ideKernelDataframe, { sessionId, name, offset, limit }),
    },
    // ── profiler (APP-046): gated cProfile run → flame folds ─────────────────
    profile: {
      start: (req: IdeProfileStartRequest): Promise<IdeProfileResult> =>
        ipcRenderer.invoke(IPC.ideProfileStart, req),
      stop: (): Promise<IdeOkResult> => ipcRenderer.invoke(IPC.ideProfileStop),
      snapshotSave: (req: IdeProfileSnapshotSaveRequest): Promise<IdeProfileSaveResult> =>
        ipcRenderer.invoke(IPC.ideProfileSnapshotSave, req),
      snapshotList: (): Promise<IdeProfileListResult> =>
        ipcRenderer.invoke(IPC.ideProfileSnapshotList),
      compare: (req: IdeProfileCompareRequest): Promise<IdeProfileCompareResult> =>
        ipcRenderer.invoke(IPC.ideProfileCompare, req),
    },
    // ── terminal launcher (APP-048): core profiles/AI presets/env → menu+resolve
    terminal: {
      menu: (req: IdeTerminalMenuRequest): Promise<IdeTerminalMenuResult> =>
        ipcRenderer.invoke(IPC.ideTerminalMenu, req),
      resolve: (req: IdeTerminalResolveRequest): Promise<IdeTerminalResolveResult> =>
        ipcRenderer.invoke(IPC.ideTerminalResolve, req),
    },
    // ── repo-map (APP-053): ranked symbol map for @codebase grounding ────────
    repoMap: {
      build: (req: IdeRepoMapRequest): Promise<IdeRepoMapResult> =>
        ipcRenderer.invoke(IPC.ideRepoMap, req),
    },
    // ── linter fan-in (APP-062): detect + run ruff/flake8/mypy/pylint ────────
    lint: {
      detect: (python?: string): Promise<IdeLintDetectResult> =>
        ipcRenderer.invoke(IPC.ideLintDetect, { python }),
      run: (req: IdeLintRunRequest): Promise<IdeLintRunResult> =>
        ipcRenderer.invoke(IPC.ideLintRun, req),
    },
    // ── Local History (APP-063): timeline + diff + revert + recover ──────────
    history: {
      bind: (root: string): Promise<IdeOkResult> =>
        ipcRenderer.invoke(IPC.ideHistoryBind, { root }),
      list: (root: string, uri: string): Promise<IdeHistoryListResult> =>
        ipcRenderer.invoke(IPC.ideHistoryList, { root, uri }),
      read: (root: string, uri: string, ts: number): Promise<IdeHistoryReadResult> =>
        ipcRenderer.invoke(IPC.ideHistoryRead, { root, uri, ts }),
      revert: (root: string, uri: string, ts: number): Promise<IdeOkResult> =>
        ipcRenderer.invoke(IPC.ideHistoryRevert, { root, uri, ts }),
    },
    // ── refactor (APP-026) — one concrete method per transform: contextBridge
    // does not expose Proxies/dynamic props, so each must be a real function.
    refactor: {
      // transform pinned AFTER the spread so a hostile req can't override it
      rename: (req: IdeRefactorRenameReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "rename" }),
      extract: (req: IdeRefactorExtractReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "extract" }),
      inline: (req: IdeRefactorInlineReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "inline" }),
      move: (req: IdeRefactorMoveReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "move" }),
      changeSignature: (req: IdeRefactorChangeSignatureReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "change-signature" }),
      safeDelete: (req: IdeRefactorSafeDeleteReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "safe-delete" }),
      // gen-* generators (APP-028) — transform pinned after the spread, as above
      genInit: (req: IdeRefactorGenFieldsReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "gen-init" }),
      genRepr: (req: IdeRefactorGenFieldsReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "gen-repr" }),
      genEq: (req: IdeRefactorGenFieldsReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "gen-eq" }),
      genDataclass: (req: IdeRefactorGenAtReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "gen-dataclass" }),
      genProperty: (req: IdeRefactorGenPropertyReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "gen-property" }),
      genOverride: (req: IdeRefactorGenOverrideReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "gen-override" }),
      genDelegate: (req: IdeRefactorGenDelegateReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "gen-delegate" }),
      genDocstring: (req: IdeRefactorGenAtReq): Promise<IdeRefactorResult> =>
        ipcRenderer.invoke(IPC.ideRefactor, { ...req, transform: "gen-docstring" }),
    },
    // ── PTY ───────────────────────────────────────────────────────────────
    ptySpawn: (req: {
      cwd: string;
      shell?: string;
      cols?: number;
      rows?: number;
      venv?: IdeActiveVenv | null;
    }): Promise<IdePtySpawnResult> => ipcRenderer.invoke(IPC.idePtySpawn, req),
    ptyWrite: (ptyId: string, data: string): void => {
      ipcRenderer.send(IPC.idePtyWrite, { ptyId, data });
    },
    ptyResize: (ptyId: string, cols: number, rows: number): void => {
      ipcRenderer.send(IPC.idePtyResize, { ptyId, cols, rows });
    },
    ptyKill: (ptyId: string): void => {
      ipcRenderer.send(IPC.idePtyKill, { ptyId });
    },
    // ── APP-090: tear-out terminal window ──────────────────────────────────
    floatingTerminal: {
      create: (req: IdeFloatingTerminalCreateRequest): Promise<IdeFloatingTerminalResult> =>
        ipcRenderer.invoke(IPC.ideFloatingTerminalCreate, req),
      close: (ptyId: string): Promise<IdeFloatingTerminalResult> =>
        ipcRenderer.invoke(IPC.ideFloatingTerminalClose, { ptyId }),
    },
    detectBins: (bins: string[]): Promise<Record<string, boolean>> =>
      ipcRenderer.invoke(IPC.ideDetectBins, { bins }),
    // ── git ───────────────────────────────────────────────────────────────
    gitStatus: (root: string): Promise<IdeGitStatus> =>
      ipcRenderer.invoke(IPC.ideGitStatus, { root }),
    gitDiff: (root: string, file: string, staged?: boolean): Promise<IdeGitDiffResult> =>
      ipcRenderer.invoke(IPC.ideGitDiff, { root, file, staged }),
    gitStage: (root: string, files: string[]): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitStage, { root, files }),
    gitUnstage: (root: string, files: string[]): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitUnstage, { root, files }),
    gitCommit: (
      root: string,
      message: string,
      opts?: { amend?: boolean },
    ): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitCommit, { root, message, ...(opts ?? {}) }),
    gitBranch: (root: string, name: string, opts?: { create?: boolean }): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitBranch, { root, name, ...(opts ?? {}) }),
    gitBranches: (root: string): Promise<IdeGitBranchesResult> =>
      ipcRenderer.invoke(IPC.ideGitBranches, { root }),
    gitStash: (root: string, message?: string): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitStash, { root, message }),
    gitStashList: (root: string): Promise<IdeGitStashListResult> =>
      ipcRenderer.invoke(IPC.ideGitStashList, { root }),
    gitStashPop: (root: string, index?: number): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitStashPop, { root, index }),
    gitStashApply: (root: string, index?: number): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitStashApply, { root, index }),
    gitStashDrop: (root: string, index?: number): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitStashDrop, { root, index }),
    gitBlame: (root: string, file: string): Promise<IdeGitBlameResult> =>
      ipcRenderer.invoke(IPC.ideGitBlame, { root, file }),
    gitMergeAbort: (root: string): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitMergeAbort, { root }),
    gitCheckoutSide: (
      root: string,
      file: string,
      side: "ours" | "theirs",
    ): Promise<IdeGitOpResult> => ipcRenderer.invoke(IPC.ideGitCheckoutSide, { root, file, side }),
    gitCheckoutCommit: (root: string, hash: string): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitCheckoutCommit, { root, hash }),
    gitCherryPick: (root: string, hash: string): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitCherryPick, { root, hash }),
    gitRevert: (root: string, hash: string): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitRevert, { root, hash }),
    gitReset: (
      root: string,
      hash: string,
      mode: "soft" | "mixed" | "hard",
    ): Promise<IdeGitOpResult> => ipcRenderer.invoke(IPC.ideGitReset, { root, hash, mode }),
    gitConflictVersions: (root: string, file: string): Promise<IdeGitConflictVersionsResult> =>
      ipcRenderer.invoke(IPC.ideGitConflictVersions, { root, file }),
    gitLog: (root: string, limit?: number): Promise<IdeGitLogResult> =>
      ipcRenderer.invoke(IPC.ideGitLog, { root, limit }),
    gitPush: (root: string): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitPush, { root }),
    gitPull: (root: string): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitPull, { root }),
    gitFetch: (root: string): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitFetch, { root }),
    gitRebaseTodo: (root: string, base: string): Promise<IdeGitRebaseTodoResult> =>
      ipcRenderer.invoke(IPC.ideGitRebaseTodo, { root, base }),
    gitRebaseRun: (
      root: string,
      base: string,
      todo: IdeGitRebaseTodoRow[],
    ): Promise<IdeGitOpResult> => ipcRenderer.invoke(IPC.ideGitRebaseRun, { root, base, todo }),
    gitRebaseState: (root: string): Promise<IdeGitRebaseState> =>
      ipcRenderer.invoke(IPC.ideGitRebaseState, { root }),
    gitRebaseContinue: (root: string): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitRebaseContinue, { root }),
    gitRebaseAbort: (root: string): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitRebaseAbort, { root }),
    gitShow: (root: string, sha: string): Promise<IdeGitShowResult> =>
      ipcRenderer.invoke(IPC.ideGitShow, { root, hash: sha }),
    gitApplyPatch: (
      root: string,
      patch: string,
      opts?: { cached?: boolean; reverse?: boolean },
    ): Promise<IdeGitOpResult> =>
      ipcRenderer.invoke(IPC.ideGitApplyPatch, { root, patch, ...(opts ?? {}) }),
    coverageRun: (
      root: string,
      framework: "pytest" | "unittest",
      ids?: string[],
    ): Promise<IdeCoverageResult> =>
      ipcRenderer.invoke(IPC.ideCoverageRun, { root, framework, ...(ids ? { ids } : {}) }),
    coverageImport: (path: string): Promise<IdeCoverageResult> =>
      ipcRenderer.invoke(IPC.ideCoverageImport, { path }),
    gitPrStatus: (root: string): Promise<IdePrStatus> =>
      ipcRenderer.invoke(IPC.ideGitPrStatus, { root }),
    gitPrList: (root: string): Promise<IdePrListResult> =>
      ipcRenderer.invoke(IPC.ideGitPrList, { root }),
    gitPrGet: (root: string, number: number): Promise<IdePrDetailResult> =>
      ipcRenderer.invoke(IPC.ideGitPrGet, { root, number }),
    gitPrComment: (root: string, number: number, body: string): Promise<IdePrOpResult> =>
      ipcRenderer.invoke(IPC.ideGitPrComment, { root, number, body }),
    gitPrSetToken: (root: string, token: string): Promise<IdePrOpResult> =>
      ipcRenderer.invoke(IPC.ideGitPrSetToken, { root, token }),
    // ── worktrees (Task #5, desktop parity): the SAME `@prometheus/core/git-worktree`
    // functions the CLI's `/worktree` slash calls ──────────────────────────
    worktreeList: (root: string): Promise<IdeWorktreeListResult> =>
      ipcRenderer.invoke(IPC.ideWorktreeList, { root }),
    worktreeCreate: (root: string, branch: string, path?: string): Promise<IdeWorktreeOpResult> =>
      ipcRenderer.invoke(IPC.ideWorktreeCreate, { root, branch, path }),
    worktreeRemove: (root: string, path: string): Promise<IdeWorktreeOpResult> =>
      ipcRenderer.invoke(IPC.ideWorktreeRemove, { root, path }),
    // ── sub-agent personas (Task #5, desktop parity): the SAME `@prometheus/core/agent-files`
    // clamping the CLI's `spawn_agent` applies ──────────────────────────────
    agentFilesList: (root: string): Promise<IdeAgentFilesListResult> =>
      ipcRenderer.invoke(IPC.ideAgentFilesList, { root }),
    // ── custom slash commands (Task #5, desktop parity): the SAME
    // `@prometheus/core/command-loader` the CLI's `/command` loader uses ──────
    commandFilesList: (root: string): Promise<IdeCommandFilesListResult> =>
      ipcRenderer.invoke(IPC.ideCommandFilesList, { root }),
    // ── the RUN-GATE (§5.2/§9) ──────────────────────────────────────────────
    gate: (req: IdeGateRequest): Promise<IdeGateResult> => ipcRenderer.invoke(IPC.ideGate, req),
    // ── gated command exec (§7.3): user-approved, screened in main ──────────
    exec: (req: IdeExecRequest): Promise<IdeExecResult> => ipcRenderer.invoke(IPC.ideExec, req),
    // ── Phase 6: core's shared system tools — the same six-layer path the CLI runs ──
    // Lifecycle hooks: the renderer never spawns — it lists and proxies, MAIN runs.
    hookRun: (req: AgentHookRunRequest): Promise<AgentHookRunResult> =>
      ipcRenderer.invoke(IPC.agentHookRun, req),
    // Point 6b: core detects a tripped canary token in the renderer; MAIN owns the audit disk.
    canaryTrip: (req: AgentCanaryTripRequest): Promise<AgentCanaryTripResult> =>
      ipcRenderer.invoke(IPC.agentCanaryTrip, req),
    systemTool: (req: AgentSystemToolRequest): Promise<AgentSystemToolResult> =>
      ipcRenderer.invoke(IPC.agentSystemTool, req),
    // ── the `prometheus_*` verbs: the product's own surface, run by the engine ──
    engineTool: (req: AgentEngineToolRequest): Promise<AgentSystemToolResult> =>
      ipcRenderer.invoke(IPC.agentEngineTool, req),
    // ── remembered grants: the same <config>/grants.json the CLI reads ──────
    grantsList: (): Promise<AgentGrantsResult> => ipcRenderer.invoke(IPC.agentGrantsList),
    grantsAdd: (grant: AgentGrant): Promise<AgentGrantsResult> =>
      ipcRenderer.invoke(IPC.agentGrantsAdd, grant),
    // ── workspace search (§6.3): bounded gitignore-aware walk in main ───────
    search: (req: IdeSearchRequest): Promise<IdeSearchResult> =>
      ipcRenderer.invoke(IPC.ideSearch, req),
    // ── APP-066: cancel an in-flight worker search + a worker-offloaded repo walk ──
    searchCancel: (requestId: string): Promise<IdeAckResult> =>
      ipcRenderer.invoke(IPC.ideSearchCancel, { requestId }),
    workspaceIndex: (root: string): Promise<IdeWorkspaceIndexResult> =>
      ipcRenderer.invoke(IPC.ideWorkspaceIndex, { root }),
    // APP-076: structural (AST) search via the structsearch.py sidecar (read-only match).
    structSearch: (root: string, pattern: string): Promise<IdeStructSearchResult> =>
      ipcRenderer.invoke(IPC.ideStructSearch, { root, pattern }),
    // ── test discovery (§9): testmgr.py AST scan via the sidecar ────────────
    testDiscover: (root: string): Promise<IdeTestDiscoverResult> =>
      ipcRenderer.invoke(IPC.ideTestDiscover, { root }),
    // ── test RUN (APP-013): EXECUTES node ids via testmgr.py (user-initiated);
    //    per-test events stream over onTestEvent, the summary rides back here ──
    testRun: (
      root: string,
      framework: IdeTestFramework,
      ids: string[],
    ): Promise<IdeTestRunResult> => ipcRenderer.invoke(IPC.ideTestRun, { root, framework, ids }),
    testRerunFailed: (
      root: string,
      framework: IdeTestFramework,
      failedIds: string[],
    ): Promise<IdeTestRunResult> =>
      ipcRenderer.invoke(IPC.ideTestRun, { root, framework, ids: failedIds, rerun: true }),
    // ── the live per-test event stream (ide:test.event, APP-013) ─────────────
    onTestEvent: (listener: (event: IdeTestEvent) => void): (() => void) => {
      const wrapped = (_evt: unknown, payload: IdeTestEvent): void => listener(payload);
      ipcRenderer.on(IPC_EVENTS.ideTestEvent, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.ideTestEvent, wrapped);
      };
    },
    // ── the multiplexed host feed (LSP/DAP/PTY/fs events) ────────────────────
    onEvent: (listener: (event: IdeEvent) => void): (() => void) => {
      const wrapped = (_evt: unknown, payload: IdeEvent): void => listener(payload);
      ipcRenderer.on(IPC_EVENTS.ideEvent, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.ideEvent, wrapped);
      };
    },
  };
}

/**
 * The concrete, frozen API. Every method forwards to a single channel and
 * returns the MAIN process's already-renderer-safe response. No logic lives
 * here — the trust boundary is the MAIN process; preload is a typed pass-through.
 */
/** The `window.prometheus.sql` surface (APP-042): connect / query (paged) / schema —
 *  thin invokes; credentials go MAIN→sidecar only, responses are redacted in MAIN. */
function createSqlApi(): SqlApi {
  return {
    connect: (conn: string): Promise<IdeSqlConnectResult> =>
      ipcRenderer.invoke(IPC.ideSqlConnect, { conn }),
    query: (req: IdeSqlQueryRequest): Promise<IdeSqlQueryResult> =>
      ipcRenderer.invoke(IPC.ideSqlQuery, req),
    schema: (conn: string, table?: string): Promise<IdeSqlSchemaResult> =>
      ipcRenderer.invoke(IPC.ideSqlSchema, { conn, table }),
  };
}

export function createPrometheusApi(): PrometheusApi {
  const api: PrometheusApi = {
    // ── engine/scanner health pill (read-only, §4.2) ─────────────────────────
    health: (): Promise<HealthResult> => ipcRenderer.invoke(IPC.health),

    // ── whole-machine resource telemetry + launch guard (read-only) ──────────
    systemTelemetry: (): Promise<SystemTelemetry> => ipcRenderer.invoke(IPC.systemTelemetry),

    // ── inventory ──────────────────────────────────────────────────────────
    scan: (): Promise<ScanResult> => ipcRenderer.invoke(IPC.scan),
    list: (): Promise<EnvelopeResult> => ipcRenderer.invoke(IPC.list),
    info: (name: string): Promise<EnvelopeResult> => ipcRenderer.invoke(IPC.info, name),
    audit: (name: string): Promise<EnvelopeResult> => ipcRenderer.invoke(IPC.audit, name),
    status: (name: string): Promise<EnvelopeResult> => ipcRenderer.invoke(IPC.status, name),
    where: (name: string): Promise<EnvelopeResult> => ipcRenderer.invoke(IPC.where, name),
    matrix: (): Promise<EnvelopeResult> => ipcRenderer.invoke(IPC.matrix),

    // ── security (fail-closed; verdict comes from the MAIN process, C5) ──────
    gate: (target: string): Promise<GateResult> => ipcRenderer.invoke(IPC.gate, target),

    // ── install / uninstall (engine runs nemesis itself; JS never pre-judges, C5) ─
    install: (name: string, opts?: InstallOptions): Promise<EnvelopeResult> =>
      ipcRenderer.invoke(IPC.install, name, opts ?? {}),
    uninstall: (name: string, opts?: UninstallOptions): Promise<EnvelopeResult> =>
      ipcRenderer.invoke(IPC.uninstall, name, opts ?? {}),
    enable: (name: string, component?: "hooks" | "mcp"): Promise<EnvelopeResult> =>
      ipcRenderer.invoke(IPC.enable, name, component),
    disable: (name: string, component?: "hooks" | "mcp"): Promise<EnvelopeResult> =>
      ipcRenderer.invoke(IPC.disable, name, component),

    // ── cancel an in-flight long op by runId (fire-and-forget, §4.3) ─────────
    cancel: (runId: string): void => {
      ipcRenderer.send(IPC_CANCEL, runId);
    },

    // ── providers (Tier-A-first, C11) — plural + singular alias ──────────────
    providers: (): Promise<ProvidersResult> => ipcRenderer.invoke(IPC.providers),
    provider: (): Promise<ProvidersResult> => ipcRenderer.invoke(IPC.providers),

    // ── environments (envmgr sidecar) — the M1 read-only list panel ──────────
    envList: (): Promise<EnvelopeResult> => ipcRenderer.invoke(IPC.envList),

    // ── models / hardware (modelhub sidecar) — verbose + §5 alias ────────────
    modelHw: (): Promise<EnvelopeResult> => ipcRenderer.invoke(IPC.modelHw),
    model: (): Promise<EnvelopeResult> => ipcRenderer.invoke(IPC.modelHw),

    // ── supervised servers (C8) ──────────────────────────────────────────────
    servers: (): Promise<ServersResult> => ipcRenderer.invoke(IPC.servers),
    startServer: (id: string): Promise<ServersResult> => ipcRenderer.invoke(IPC.serverStart, id),
    stopServer: (id: string): Promise<ServersResult> => ipcRenderer.invoke(IPC.serverStop, id),

    // ── engine version ───────────────────────────────────────────────────────
    version: (): Promise<VersionResult> => ipcRenderer.invoke(IPC.version),

    // ── live progress feed (one-way MAIN→renderer; cosmetic, C5) ─────────────
    onProgress: (listener: (event: ProgressFeedEvent) => void): (() => void) => {
      // Wrap so the raw IpcRendererEvent never leaks to the renderer callback —
      // it only ever sees the PLAIN ProgressFeedEvent payload.
      const wrapped = (_evt: unknown, payload: ProgressFeedEvent): void => listener(payload);
      ipcRenderer.on(IPC_EVENTS.progress, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.progress, wrapped);
      };
    },

    // ── §9c: model chat streaming (runs in MAIN — the prod CSP forbids it here) ──
    ai: {
      stream: (req: AiStreamRequest): Promise<AiStreamResult> =>
        ipcRenderer.invoke(IPC.aiStream, req),
      cancel: (runId: string): Promise<boolean> => ipcRenderer.invoke(IPC.aiCancel, { runId }),
      onProgress: (listener: (event: AiProgressEvent) => void): (() => void) => {
        const wrapped = (_evt: unknown, payload: AiProgressEvent): void => listener(payload);
        ipcRenderer.on(IPC_EVENTS.aiProgress, wrapped);
        return () => {
          ipcRenderer.removeListener(IPC_EVENTS.aiProgress, wrapped);
        };
      },
      // Task #18: the local-runner model probe, moved to MAIN for the same CSP reason `stream`
      // is above — a renderer `fetch` to `http://127.0.0.1:<port>/models` is refused in prod.
      probeModels: (baseUrl: string): Promise<AiProbeModelsResult> =>
        ipcRenderer.invoke(IPC.aiProbeModels, { baseUrl }),
      // Measure ONE local model (real context window + the runner's capability array). Same
      // MAIN detour and same CSP reason as `probeModels`; this is what lets the effort chip
      // resolve a probe-backed capability instead of falling through to "not available".
      probeEndpoint: (baseUrl: string, model: string): Promise<AiProbeEndpointResult> =>
        ipcRenderer.invoke(IPC.aiProbeEndpoint, { baseUrl, model }),
    },

    // ── the FULL security surface (file 03 §5,§7) ────────────────────────────
    security: createSecurityApi(),

    // ── the Package & Environment Manager surface (file 04 §1,§3) ─────────────
    env: createEnvApi(),

    // ── the Model Hub surface (file 05 §1,§7,§8) ──────────────────────────────
    models: createModelApi(),

    // ── the Catalog manager surface (file 06 §4) ──────────────────────────────
    catalog: createCatalogApi(),

    // ── the GitHub Repo Manager surface (file 06 §3, FEATURE #5a) ─────────────
    repo: createRepoApi(),

    // ── the Code-Editor / IDE surface (file 07 §3.2/§4/§5/§6/§9) ──────────────
    ide: createIdeApi(),
    sql: createSqlApi(),

    // ── file-metadata control (file 0C — privacy protection) ──────────────────
    metadata: createMetadataApi(),

    // ── MCP connectors (file 09 §2 — Studio as an MCP client) ─────────────────
    mcp: createMcpApi(),
    settingsSync: createSettingsSyncApi(),
    settings: createSettingsApi(),
    pathCompletion: createPathCompletionApi(),
    modelHealth: createModelHealthApi(),
    schedule: createScheduleApi(),
    persona: createPersonaApi(),
    budget: createBudgetApi(),
    codebaseOverview: createCodebaseOverviewApi(),

    // ── extension host (file 09 §5, APP-059) — install/activate/deactivate/list ──
    ext: createExtApi(),

    // ── auto-updater bridge (file 10 §5, APP-005) — UX over main's ask-first gates ──
    updates: createUpdatesApi(),
    fileOpen: (opts?: { title?: string }): Promise<FileOpenResult> =>
      ipcRenderer.invoke(IPC.fileOpen, opts ?? {}),

    // ── SPECTACULAR power-up: catalog cards + chat + models folder + harden ────
    folderOpen: (opts?: { title?: string }): Promise<FolderOpenResult> =>
      ipcRenderer.invoke(IPC.folderOpen, opts ?? {}),
    openPath: (path: string): Promise<OpenPathResult> => ipcRenderer.invoke(IPC.openPath, { path }),
    spectacular: createSpectacularApi(),
  };
  return Object.freeze(api);
}

/**
 * The SPECTACULAR power-up surface. Each method is a thin invoke of its
 * `spectacular:*` channel; the renderer receives plain data, never a sidecar
 * handle. chat is preview/agentic-reply only — no terminal is launched here.
 */
function createSpectacularApi(): SpectacularApi {
  return {
    describe: (id: string): Promise<SpectacularCard> =>
      ipcRenderer.invoke(IPC.spectacularDescribe, id),
    tutorial: (id: string): Promise<SpectacularTutorial> =>
      ipcRenderer.invoke(IPC.spectacularTutorial, id),
    methods: (id: string): Promise<SpectacularMethods> =>
      ipcRenderer.invoke(IPC.spectacularMethods, id),
    harden: (): Promise<SpectacularHarden> => ipcRenderer.invoke(IPC.spectacularHarden),
    chatLocal: (model: string, prompt: string, runner?: string): Promise<SpectacularChatLocal> =>
      ipcRenderer.invoke(IPC.spectacularChatLocal, { model, prompt, runner }),
    chatPreview: (
      cli: string,
      opts?: SpectacularChatPreviewOpts,
    ): Promise<SpectacularChatPreview> =>
      ipcRenderer.invoke(IPC.spectacularChatPreview, { cli, opts }),
    modelsConfig: (setRoot?: string): Promise<SpectacularModelsConfig> =>
      ipcRenderer.invoke(IPC.spectacularModelsConfig, { setRoot }),
    modelsBrowse: (): Promise<SpectacularModelsBrowse> =>
      ipcRenderer.invoke(IPC.spectacularModelsBrowse),
  };
}

/**
 * The file-metadata control surface (file 0C). Each method is a thin invoke of its
 * `metadata:*` channel; the renderer receives plain data, never a sidecar handle. The
 * MAIN process owns the fs + spawns metadata.py (C5); mutations are plan-only without
 * `confirm` (the renderer renders the plan + collects the typed-confirm).
 */
function createMetadataApi(): MetadataApi {
  return {
    inspect: (uri: string): Promise<MetadataInspectResult> =>
      ipcRenderer.invoke(IPC.metadataInspect, { uri }),
    scrub: (uri: string, confirm = false): Promise<MetadataScrubResult> =>
      ipcRenderer.invoke(IPC.metadataScrub, { uri, confirm }),
    edit: (
      uri: string,
      field: string,
      value: string,
      confirm = false,
    ): Promise<MetadataEditResult> =>
      ipcRenderer.invoke(IPC.metadataEdit, { uri, field, value, confirm }),
    timestomp: (
      uri: string,
      mtime: number,
      atime?: number,
      confirm = false,
    ): Promise<MetadataTimestompResult> =>
      ipcRenderer.invoke(IPC.metadataTimestomp, { uri, mtime, atime, confirm }),
  };
}
