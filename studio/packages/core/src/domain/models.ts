/**
 * domain/models.ts — the shared Prometheus Studio domain types.
 *
 * This is the vocabulary BOTH the desktop GUI and the prom CLI render. Every
 * type here is a plain data shape (no behaviour) modelled directly on the REAL
 * envelopes emitted by the engine + sidecars:
 *   - prometheus.py --json scan/list/... (agents[], catalog[])
 *   - python/sidecar/envmgr.py   (env.* / pkg.* / template.* / cuda.info)
 *   - python/sidecar/modelhub.py (hw.scan / model.* / fit.score)
 *   - config/providers.config.json  (C11 provider promotion policy)
 *   - config/open-models.json       (Tier-A open-weight model catalog)
 *
 * The verdict model (C3) is the engine-bridge's single source of truth — we
 * RE-EXPORT it here, never redefine it, so callers can `import { VerdictTier }`
 * from "@prometheus/core" without reaching into engine-bridge.
 */

// --- C3 verdict model: re-exported, NEVER redefined ------------------------ //
export type {
  VerdictTier,
  Severity,
  Finding,
  SecurityVerdict,
  NemesisVerdictRef,
  GateBadge,
  ForcedDanger,
} from "@prometheus/engine-bridge";

// ====================================================================== //
//  Environments (envmgr.py: env.list / env.use / pkg.list / cuda.info)    //
// ====================================================================== //

/** How a Python environment is materialised on disk. */
export type EnvKind = "venv" | "conda" | "system";

/** A Python environment as reported by `envmgr.py env.list`. */
export interface Env {
  name: string;
  path: string;
  kind: EnvKind;
  pythonVersion: string | null;
  packagesCount: number;
}

/** An installed pip package within an env (`envmgr.py pkg.list`). */
export interface Package {
  name: string;
  version: string;
}

/** A reproducible env recipe (`envmgr.py template.list`). */
export interface Template {
  id: string;
  label: string;
  python: string;
  packages: string[];
  path?: string;
}

/** CUDA / accelerator probe (`envmgr.py cuda.info`). Any field may be null. */
export interface CudaInfo {
  gpu: string | null;
  driver: string | null;
  cudaVersion: string | null;
  nvidiaSmi: boolean;
  nvcc: boolean;
  torchCuda: boolean | null;
  available: boolean;
}

// ====================================================================== //
//  Models & hardware (modelhub.py: model.list / model.search / hw.scan)   //
// ====================================================================== //

/** A model kind bucket — LLM vs everything else (embeddings/ASR/diffusion). */
export type ModelKind = "llm" | "non-llm";

/** A quantization label (q4_k_m, q8_0, f16, …) — free-form by design. */
export type Quant = string;

/**
 * A catalog entry from config/open-models.json (the Tier-A open-weight set).
 * params_b is nominal; on-disk size depends on the chosen Quant (see fit.score).
 */
export interface Model {
  id: string;
  name: string;
  family: string;
  kind: ModelKind;
  /** sub-bucket for non-llm: embedding | asr | text-to-image | … */
  subtype?: string;
  paramsB: number;
  /** active params for MoE models (e.g. 30B-A3B -> 3). */
  activeParamsB?: number;
  license: string;
  context?: number;
  quants: Quant[];
  tags: string[];
  repo: string;
}

/** A locally-present model file (`modelhub.py model.list`). */
export interface LocalModel {
  name: string;
  path: string;
  format: string;
  sizeBytes: number;
  sizeGb: number;
  quant: Quant;
}

/** A single GPU as seen by `modelhub.py hw.scan`. */
export interface GpuInfo {
  name: string;
  vendor: string;
  vramMb: number | null;
  vramBytes: number | null;
  unifiedMemory: boolean;
}

/** The host hardware profile (`modelhub.py hw.scan`) used by fit scoring. */
export interface HardwareProfile {
  os: string;
  arch: string;
  cpu: { model: string; logical: number; physical: number };
  ramBytes: number;
  ramGb: number;
  gpus: GpuInfo[];
  gpuCount: number;
  unifiedMemory: boolean;
  usableWeightBytes: number;
  usableWeightGb: number;
  usableBasis: "vram" | "unified" | "system-ram" | "unknown";
}

/** The verdict of fitting a (model, quant) onto a HardwareProfile. */
export type FitVerdict = "fits" | "tight" | "no";

/** A fit score (`modelhub.py fit.score`) — does this model run on this host? */
export interface FitScore {
  verdict: FitVerdict;
  quant: Quant;
  recommendedQuant: Quant;
  paramsB: number;
  weightBytes: number;
  weightGb: number;
  neededBytes: number;
  neededGb: number;
  usableBytes: number;
  usableGb: number;
  headroomRatio: number;
  hwBasis: "provided" | "scanned";
}

// ====================================================================== //
//  Serving (C8: ServerSupervisor reads serve-profiles.json)               //
// ====================================================================== //

/**
 * A long-lived server the Studio MAIN process supervises (C8): a model runner,
 * an embedding server, a kernel. Spawned via node:child_process; autostart is
 * driven by serve-profiles.json.
 */
export interface ServeProfile {
  id: string;
  label?: string;
  /** absolute path or PATH-resolved command to exec. */
  command: string;
  args?: string[];
  /** extra env merged over process.env at spawn. */
  env?: Record<string, string>;
  cwd?: string;
  /** start automatically when the supervisor boots. */
  autostart?: boolean;
  /** restart the child when it exits non-zero (best-effort backoff). */
  restartOnExit?: boolean;
  /** optional health URL the supervisor (or GUI) may poll. */
  healthUrl?: string;
}

// ====================================================================== //
//  Catalog / repos / agents (prometheus.py scan / list / catalog)         //
// ====================================================================== //

/** A source repo / git target a CatalogItem or download originates from. */
export interface Repo {
  /** owner/repo, a git URL, or a local path — whatever nemesis can gate. */
  ref: string;
  url?: string;
  branch?: string;
}

/**
 * A unified catalog row the GUI/CLI render: an installable plugin/agent OR a
 * downloadable model. The `gate` badge (a NemesisVerdictRef) is attached only
 * after the engine-bridge nemesis runner has produced a verdict (C4/C5).
 */
export interface CatalogItem {
  id: string;
  name: string;
  label: string;
  kind: "agent" | "plugin" | "model" | "cli" | "ide" | "mcp";
  present: boolean;
  where?: string;
  description?: string;
  repo?: Repo;
  /** populated only by an explicit gate(); absent means "not yet scanned". */
  gate?: import("@prometheus/engine-bridge").NemesisVerdictRef;
}

// ====================================================================== //
//  Providers (C11 promotion policy: providers.config.json)                //
// ====================================================================== //

/** How a provider is wired in. */
export type IntegrationKind =
  | "local-endpoint"
  | "openai-compatible"
  | "first-party-api"
  | "ide-subscription";

/** How a provider charges. */
export type BillingMode = "free" | "subscription" | "metered" | "external";

/** The promotion tier (C11). A = local/free, B = subscription-covered, C = metered. */
export type ProviderTier = "A" | "B" | "C";

/** The cost light shown in the UI. green = free, blue = covered, red = metered. */
export type CostLight = "green" | "blue" | "red";

/** Loudness of the warning the UI must surface before enabling. */
export type ProviderWarn = "none" | "low" | "high";

/**
 * A model/inference provider as declared in config/providers.config.json (C11).
 * Field names mirror the JSON (camelCase here; the loader maps from snake/JSON).
 */
export interface Provider {
  id: string;
  label: string;
  aliases?: string[];
  integrationKind: IntegrationKind;
  billingMode: BillingMode;
  includedInSubscription: boolean;
  /** the static, config-declared tier (before runtime promotion). */
  promotedTier: ProviderTier;
  /** the tier to use when a covering subscription/seat is detected at setup. */
  promotedTierIfSubscription?: ProviderTier;
  /** condition (a capability id) under which the subscription covers IDE use. */
  subscriptionCoversIf?: string;
  includedInSubscriptionVia?: string;
  costLight: CostLight;
  costLightIfSubscription?: CostLight;
  warn: ProviderWarn;
  verifyAtSetup: boolean;
  defaultBaseUrl?: string;
  /** the literal string the user must type to enable a metered provider. */
  requiresTypedConfirm?: string;
  /** true only for the `local` escape-hatch provider (engine localai re-point). */
  isEscapeHatch?: boolean;
  notes?: string;
}

// ====================================================================== //
//  Cost guardrails & connectors (C11)                                     //
// ====================================================================== //

/**
 * A spend guardrail attached to a metered (Tier-C) provider. The supervisor /
 * GUI evaluates it; when spend exceeds the cap the provider is auto-disabled.
 */
export interface CostGuardrail {
  /** the provider this guardrail governs. */
  providerId: string;
  /** hard ceiling, in the provider's billing currency (USD by default). */
  budgetCap: number;
  /** amount already spent this period. */
  spent: number;
  /** currency code for display (default USD). */
  currency?: string;
  /** auto-disable the provider once spent >= budgetCap. */
  autoDisableAtCap?: boolean;
  /** optional soft alert threshold as a fraction of the cap (0..1). */
  warnAtFraction?: number;
}

/** A configured connection to a Provider (an endpoint + credentials handle). */
export interface ConnectorConfig {
  providerId: string;
  /** the realised tier after promotion (may differ from Provider.promotedTier). */
  tier: ProviderTier;
  enabled: boolean;
  baseUrl?: string;
  /** an opaque handle/ref into the engine vault — NEVER a raw secret. */
  credentialRef?: string;
  /** the model id this connector defaults to. */
  defaultModel?: string;
  guardrail?: CostGuardrail;
}
