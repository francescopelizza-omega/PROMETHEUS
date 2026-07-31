/**
 * modelhub/types.ts — the renderer-facing DISPLAY shapes the §7/§8 Model-Hub
 * components render, as @prometheus/ui-LOCAL structural mirrors (same discipline
 * as env/types.ts + security/types.ts).
 *
 * WHY MIRRORED HERE (not imported): @prometheus/ui is a sandboxed presentational
 * package (C5). It may import ONLY `react` + its own modules — NEVER
 * `@prometheus/engine-bridge` or `@prometheus/core` runtime, and has no project
 * reference to them, so a cross-package type import would not resolve under
 * `tsc -b`. These interfaces are STRUCTURAL mirrors of engine-bridge's
 * `HardwareProfile` / `Model` / `ScoredQuant` / `FitResult` / `ServeProfile` and
 * the camelCased `GateSummary`. Because they are structural, the renderer (which
 * DOES depend on both) passes the real engine-bridge value straight into these
 * props with no adapter — structural typing makes them assignment-compatible.
 *
 * GOLDEN RULE (C5): these are DISPLAY shapes only. The components that consume
 * them NEVER score, fit, allowlist, or decide "safe" — they render data the
 * engine / sidecar produced and accept every action as a callback prop. Every
 * engine string a component renders is first run through `inert()`.
 */

import type { FitVerdict, GateTier, ServeRowStatus } from "./util.js";

/* ── §2.1 hardware ─────────────────────────────────────────────────────────── */

/** One GPU row the HW summary bar may surface (mirror of engine-bridge HardwareGpu). */
export interface HardwareGpuData {
  index: number;
  name: string;
  vramGb: number;
  vramFreeGb: number;
  computeCap?: string;
  unified: boolean;
}

/** Derived capability flags — drive the §4.3 quant gate (mirror of HardwareCaps). */
export interface HardwareCapsData {
  fp8: boolean;
  flashAttn: boolean;
  awqMarlin: boolean;
  metal: boolean;
  maxSingleGpuVramGb: number;
  totalVramGb: number;
}

/** The host hardware profile the HW summary bar renders (mirror of HardwareProfile). */
export interface HardwareProfileData {
  id: string;
  os: "darwin" | "linux" | "win32";
  cpu: { brand: string; cores: number; threads: number };
  ramGb: number;
  ramFreeGb: number;
  accel: "cuda" | "rocm" | "metal" | "cpu";
  gpus: HardwareGpuData[];
  caps: HardwareCapsData;
  usableWeightGb: number;
  unified: boolean;
  detectedAt: string;
}

/* ── §2.2 model (the discover/library list row) ────────────────────────────── */

/** A discovered/owned model row the result list renders (mirror of engine-bridge Model). */
/** Precomputed compute-demand the row badge renders (mirror of engine-bridge ModelResource). */
export interface ModelResourceData {
  q4Gb?: number;
  minRamGb?: number;
  recRamGb?: number;
  gpuMinVramGb?: number;
  cpuOk?: boolean;
  tier?: string;
  needsOffload?: boolean;
  label?: string;
}

export interface ModelData {
  id: string;
  source: "huggingface" | "ollama" | "url";
  modality:
    | "text"
    | "embedding"
    | "vision"
    | "asr"
    | "reranker"
    | "diffusion"
    | "tts"
    | "multimodal";
  family?: string;
  /** one-line "what it is + what it excels at + when to pick" (mirror of engine-bridge Model.description). */
  description?: string;
  /** precomputed RAM/CPU/GPU compute demand (mirror of engine-bridge Model.resource). */
  resource?: ModelResourceData;
  params?: string;
  license: string;
  openWeight: boolean;
  gated: boolean;
  contextLen?: number;
  downloads?: number;
  likes?: number;
  updated?: string;
  cardUrl?: string;
  installed: boolean;
  localPath?: string;
}

/* ── §4 fit (the per-quant fit table row) ──────────────────────────────────── */

/** One scored quant the §7 fit table renders (mirror of engine-bridge ScoredQuant). */
export interface ScoredQuantData {
  label: string;
  fmt: string;
  bits: number | null;
  qualityRank: number;
  runnerHint: string[];
  weightsGb: number;
  kvCacheGb: number;
  overheadGb: number;
  estVramGb: number;
  budgetGb: number;
  /** est/budget; null when budget is 0 (no usable memory). */
  ratio: number | null;
  verdict: FitVerdict;
  /** gated out by hardware caps? (FP8/AWQ/accel). */
  runnable: boolean;
  blockedReason: string | null;
}

/** The §4 fit envelope: recommended + ranked + the explainer (mirror of FitResult). */
export interface FitResultData {
  id?: string;
  paramsB: number;
  family?: string;
  ctxLen: number;
  accel: "cuda" | "rocm" | "metal" | "cpu";
  usableGb: number;
  recommended: ScoredQuantData | null;
  ranked: ScoredQuantData[];
  reasons: string[];
}

/* ── §5 download queue (the per-item state + nemesis badge) ─────────────────── */

/** A gate verdict summary a download row renders — mirror of engine-bridge GateSummary. */
export interface ModelGateBadge {
  verdict: GateTier;
  score?: number;
  reasons?: string[];
  signed?: boolean;
  recommendation?: string;
  scannedAt?: string;
}

/**
 * The §5 download-queue item lifecycle state (mirror of core modelhub-store
 * DownloadState). `admitted` = moved stage→live; `quarantined` = blocked stage
 * dir retained for inspection (TERMINAL); `blocked` halts admission.
 */
export type DownloadRowState =
  | "queued"
  | "staging"
  | "scanning"
  | "confirm"
  | "admitted"
  | "blocked"
  | "quarantined";

/** A download-queue row the §5 DownloadQueue renders (mirror of core DownloadItem). */
export interface DownloadRowData {
  id: string;
  modelId: string;
  /** the chosen quant label (e.g. "Q4_K_M"). */
  quant: string;
  modality?: string;
  state: DownloadRowState;
  /** 0..100 while `staging`. */
  pct?: number;
  /** GB/s or a free-form rate string (cosmetic). */
  rate?: string;
  stagePath?: string;
  localPath?: string;
  sha256?: string;
  /** the §5 nemesis verdict, populated only after a real scan. */
  gate?: ModelGateBadge;
  /** the kept-for-inspection stage dir on a quarantine (never auto-deleted). */
  quarantineDir?: string;
}

/* ── §2.4 / §7 serve profile (the Serving panel row) ───────────────────────── */

/** A serve endpoint the Serving panel renders (mirror of engine-bridge ServeEndpoint). */
export interface ServeEndpointData {
  host: string;
  port: number;
  baseUrl: string;
}

/** The fit-derived runner args a serve row may surface (mirror of ServeArgs). */
export interface ServeArgsData {
  ctxLen: number;
  gpuLayers?: number;
  tensorParallel?: number;
  kvCacheDtype?: "auto" | "fp8";
  maxModelLen?: number;
  servedModelName: string;
}

/** A serve-profile row the §7 Serving panel renders (mirror of engine-bridge ServeProfile). */
export interface ServeProfileData {
  id: string;
  modelId: string;
  quant: string;
  runner: "llamacpp" | "vllm" | "ollama";
  endpoint: ServeEndpointData;
  apiKey: string;
  args: ServeArgsData;
  /** the live status the MAIN-process supervisor reports (§2.4). */
  status: ServeRowStatus;
  /** an "external — open-weight API" row (OpenRouter/Groq/…) renders differently. */
  external?: boolean;
  pid?: number;
  lastError?: string;
}

/* ── the served/open-weight endpoint a Serving footer can list (LIVE localai) ── */

/** One endpoint row (FREE local server OR open-weight billing API). */
export interface EndpointData {
  name: string;
  baseUrl: string;
}
