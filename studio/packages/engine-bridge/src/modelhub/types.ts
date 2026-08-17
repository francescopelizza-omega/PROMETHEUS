/**
 * modelhub/types.ts — the canonical TS shapes for the Model Hub (file 05 §2).
 *
 * These are the post-boundary camelCase-friendly shapes the rest of the app
 * (core / ui / desktop) consumes. The sidecar (`modelhub.py` + hardware/fit/gate)
 * emits snake_case JSON; `client.ts` validates + projects it here at the boundary.
 *
 * RUNTIME VALIDATION AT THE BOUNDARY
 * ----------------------------------
 * file 05 §2 asks for "a Zod schema + inferred type" so the bridge is a thin
 * `JSON.parse` + validate. ENV LIMIT (honest): `zod` is present in this monorepo
 * ONLY as a dependency of `@prometheus/desktop` (node_modules/.pnpm/zod@3.25.76) —
 * it is NOT linked into `@prometheus/engine-bridge`, and the root `tsconfig.json`
 * EXPLICITLY excludes `apps/desktop` from `tsc -b` "because its renderer/main pull
 * external npm deps (… zod) that are NOT installed in this environment." Importing
 * `zod` into the tsc-compiled engine-bridge sources would therefore break
 * `tsc -b` / `biome` / `node:test`, and the task forbids running package installs.
 *
 * So we implement the SAME boundary-validation contract zod provides — a schema
 * object with `.parse()` (throws on shape violation) and `.safeParse()` (returns a
 * typed result) over the inferred type — WITHOUT a runtime dep. This keeps the
 * engine-bridge stdlib-only (mirroring `verdict.ts` / `env.ts`, neither of which
 * uses zod today) and fail-closed: a malformed sidecar object is a `parse` failure
 * the caller surfaces, never a silently-trusted "safe" value (C5). When zod is
 * later linked into engine-bridge, these schemas can be swapped 1:1 for
 * `z.object({...})` with the inferred types unchanged.
 */

// GateBadge / NemesisVerdictRef are SHARED with file 03 (security). We RE-EXPORT
// them, never redefine — the gate verdict is the engine's (C5). Models below that
// carry a verdict reference use these exact types.
export type { GateBadge, NemesisVerdictRef } from "../security/verdict.js";

// ── §2.1 HardwareProfile ──────────────────────────────────────────────────────

export type Accel = "cuda" | "rocm" | "metal" | "cpu";

export interface HardwareGpu {
  index: number;
  name: string;
  /** dedicated VRAM (CUDA/ROCm) OR the unified-memory budget (Metal). */
  vramGb: number;
  vramFreeGb: number;
  /** "8.9" → enables FP8 (>=8.9), flash-attn (>=8.0). */
  computeCap?: string;
  /** Apple Silicon: VRAM is shared with system RAM. */
  unified: boolean;
}

/** Derived capability flags — drive the §4.3 quant recommender. */
export interface HardwareCaps {
  /** Ada/Hopper, compute_cap >= 8.9. */
  fp8: boolean;
  /** Ampere+, ties to `models install flashattention`. */
  flashAttn: boolean;
  /** vLLM Marlin kernel available. */
  awqMarlin: boolean;
  metal: boolean;
  maxSingleGpuVramGb: number;
  /** sum across GPUs (for tensor-parallel fit). */
  totalVramGb: number;
}

export interface HardwareProfile {
  /** "local" | a named saved profile. */
  id: string;
  os: "darwin" | "linux" | "win32";
  cpu: { brand: string; cores: number; threads: number };
  /** total system RAM. */
  ramGb: number;
  ramFreeGb: number;
  accel: Accel;
  gpus: HardwareGpu[];
  caps: HardwareCaps;
  /** the single number the fit-scorer budgets against (VRAM | unified | RAM share). */
  usableWeightGb: number;
  unified: boolean;
  /** ISO; stale after 24h → re-scan offered. */
  detectedAt: string;
}

// ── §2.3 Quant ────────────────────────────────────────────────────────────────

export type QuantFmt = "gguf" | "safetensors" | "awq" | "gptq" | "fp8" | "mlx";
export type RunnerHint = "llamacpp" | "vllm" | "ollama" | "mlx";

export interface QuantFile {
  rfilename: string;
  sizeBytes: number;
  sha256?: string;
}

/** One downloadable artifact of a model. The fit-scorer ranks these. */
export interface Quant {
  /** "Q4_K_M" | "FP8" | "AWQ-4bit" | "F16" | "Q8_0". */
  label: string;
  fmt: QuantFmt;
  files: QuantFile[];
  totalBytes: number;
  /** effective bits/weight: 4, 5, 6, 8, 16. */
  bits: number;
  /** computed: weights + kv-cache headroom (fit.py). */
  estVramGb: number;
  /** 0..1; higher = closer to F16 (Q4_K_M≈0.82, Q8_0≈0.99). */
  qualityRank: number;
  runnerHint: RunnerHint[];
}

// ── §2.2 Model ────────────────────────────────────────────────────────────────

export type ModelSource = "huggingface" | "ollama" | "url";
export type Modality =
  | "text"
  | "embedding"
  | "vision"
  | "asr"
  | "reranker"
  | "diffusion"
  | "tts"
  | "multimodal";

/**
 * Precomputed compute-demand (open-models.json `resource`, from the model-resource
 * investigation) — surfaced beside the descriptor so users see "can my machine run
 * this?" at a glance. All GiB, computed at Q4_K_M.
 */
export interface ModelResource {
  q4Gb?: number;
  kv8kGb?: number;
  kvNativeGb?: number;
  minRamGb?: number;
  recRamGb?: number;
  gpuMinVramGb?: number;
  cpuOk?: boolean;
  /** tiny | light | moderate | heavy | workstation | server. */
  tier?: string;
  needsOffload?: boolean;
  /** one-line "≈4.5GB Q4 · 16GB RAM · CPU-ok". */
  label?: string;
}

export interface Model {
  /** "TheBloke/Llama-3.1-8B-Instruct-GGUF" | "ollama:qwen3:8b". */
  id: string;
  /** friendly display name (catalog `name`), e.g. "Qwen3 8B". */
  name?: string;
  /** the ollama pull tag (catalog `ollama`), e.g. "qwen3:8b" — what `ollama pull` fetches. */
  ollama?: string;
  source: ModelSource;
  modality: Modality;
  /** "llama3" | "qwen3" — cross-links to OPEN_MODELS in localai. */
  family?: string;
  /** one-line "what it is + what it excels at + when to pick" — surfaced in the picker so users choose consciously. */
  description?: string;
  /** precomputed RAM/CPU/GPU compute demand (catalog `resource`). */
  resource?: ModelResource;
  /** "8B" | "70B" | "30B-A3B" (MoE active). */
  params?: string;
  /** SPDX-ish; surfaced + policy-gated. */
  license: string;
  /** emphasized in UI; ties to localai OPEN_MODELS catalog. */
  openWeight: boolean;
  /** HF gated repo → needs accepted license + token. */
  gated: boolean;
  quants: Quant[];
  contextLen?: number;
  /** free-form capability/domain tags from the catalog (vision/multimodal/tool-use/coding/…).
   *  APP-092: threaded through so the AI model picker can derive capability badges. */
  tags?: string[];
  downloads?: number;
  likes?: number;
  updated?: string;
  cardUrl?: string;
  /** present in the local library. */
  installed: boolean;
  /** where the file(s) live once downloaded. */
  localPath?: string;

  /* ── local-library facts (`model.list` only) ──────────────────────────────
   * The sidecar's `model.list` measures what is actually ON DISK — the file size, the
   * quantization it could infer, the container format — and, for Ollama-indexed rows, whether
   * the daemon is already serving it and at which endpoint. `quants` is empty for those rows
   * (there is nothing to rank: the bytes are already here), so `totalBytes` cannot carry the
   * size and these fields exist instead of guessing from a catalog entry that may not match
   * the file the user actually has. All optional: a CATALOG row has none of them.
   */
  /** on-disk size in bytes (`size_bytes`). */
  sizeBytes?: number;
  /** the quantization read off the file / Ollama details (`quant`), e.g. "Q4_K_M". */
  quant?: string;
  /** container format (`format`), e.g. "gguf" | "safetensors". */
  format?: string;
  /** the Ollama daemon already serves this one. */
  served?: boolean;
  /** the OpenAI-compatible endpoint it is served at, when `served`. */
  endpoint?: string;
}

// ── §2.4 ServeProfile ─────────────────────────────────────────────────────────

export type Runner = "llamacpp" | "vllm" | "ollama";
export type ServeStatus = "stopped" | "starting" | "ready" | "error";

export interface ServeEndpoint {
  host: string;
  port: number;
  /** the OpenAI-compatible /v1 base URL (== LOCAL_AI_ENDPOINTS). */
  baseUrl: string;
}

export interface ServeArgs {
  ctxLen: number;
  /** llama.cpp -ngl (fit-scorer computes the max that fits). */
  gpuLayers?: number;
  /** vLLM, across HardwareProfile.gpus. */
  tensorParallel?: number;
  kvCacheDtype?: "auto" | "fp8";
  maxModelLen?: number;
  /** the id callers pass as "model". */
  servedModelName: string;
}

export interface ServeProfile {
  id: string;
  /** FK → Model.id. */
  modelId: string;
  /** FK → Quant.label. */
  quant: string;
  runner: Runner;
  endpoint: ServeEndpoint;
  /** dummy key; never a real secret (engine secret rule §6). */
  apiKey: string;
  args: ServeArgs;
  /** the fit-derived runner command line the MAIN-process supervisor spawns (C8). */
  argv: string[];
  autostart: boolean;
  status: ServeStatus;
  pid?: number;
  logPath?: string;
}

// ── §4 FitResult ──────────────────────────────────────────────────────────────

export type FitVerdict = "FITS" | "TIGHT" | "PARTIAL" | "OVERFLOW";

/** One scored quant from the Cookbook fit-scorer (fit.py `score_quant`). */
export interface ScoredQuant {
  label: string;
  fmt: QuantFmt;
  bits: number | null;
  qualityRank: number;
  runnerHint: RunnerHint[];
  weightsGb: number;
  kvCacheGb: number;
  overheadGb: number;
  estVramGb: number;
  budgetGb: number;
  /** est/budget; null when the budget is 0 (no usable memory). */
  ratio: number | null;
  verdict: FitVerdict;
  /** gated out by hardware caps? (FP8 needs fp8, AWQ/GPTQ need vLLM, …). */
  runnable: boolean;
  blockedReason: string | null;
}

/** The `fit` verb result (file 05 §4): recommended + ranked + the explainer. */
export interface FitResult {
  id?: string;
  paramsB: number;
  family?: string;
  ctxLen: number;
  accel: Accel;
  usableGb: number;
  /** the recommended quant, or null when nothing fits (OVERFLOW escape hatch). */
  recommended: ScoredQuant | null;
  ranked: ScoredQuant[];
  /** always explains WHY (the recommendation ethos, §4.4). */
  reasons: string[];
}

// ── runtime validation (the zod-shaped boundary; see file header) ─────────────

/** Mirrors zod's `safeParse` result so callers branch on `.success`. */
export type SafeParse<T> = { success: true; data: T } | { success: false; error: SchemaError };

/** A boundary-validation failure (mirrors `z.ZodError` enough for our callers). */
export class SchemaError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "SchemaError";
    this.path = path;
  }
}

/** The zod-shaped schema surface our boundary validators implement. */
export interface Schema<T> {
  /** validate; THROW a SchemaError on a shape violation (zod `.parse`). */
  parse(input: unknown): T;
  /** validate; return a typed result (zod `.safeParse`) — never throws. */
  safeParse(input: unknown): SafeParse<T>;
}

function schema<T>(name: string, validate: (input: unknown, path: string) => T): Schema<T> {
  return {
    parse: (input: unknown): T => validate(input, name),
    safeParse: (input: unknown): SafeParse<T> => {
      try {
        return { success: true, data: validate(input, name) };
      } catch (err) {
        if (err instanceof SchemaError) return { success: false, error: err };
        return { success: false, error: new SchemaError(name, String(err)) };
      }
    },
  };
}

// — small typed field accessors (fail-closed: a wrong type is a SchemaError) —

function obj(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SchemaError(path, "expected an object");
  }
  return input as Record<string, unknown>;
}
function str(v: unknown, path: string): string {
  if (typeof v !== "string") throw new SchemaError(path, "expected a string");
  return v;
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new SchemaError(path, "expected a finite number");
  }
  return v;
}
function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean {
  return Boolean(v);
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new SchemaError(path, "expected an array");
  return v;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
/**
 * Match `v` against `allowed` case-INSENSITIVELY, returning the CANONICAL allowed
 * value (preserving its casing — e.g. "fits" → "FITS"), else `fallback`. Robust to
 * either side's casing so an uppercase verdict union and a lowercase accel union both
 * resolve correctly.
 */
function inSet<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = String(v ?? "").toLowerCase();
  for (const a of allowed) {
    if (a.toLowerCase() === s) return a;
  }
  return fallback;
}

const ACCELS: readonly Accel[] = ["cuda", "rocm", "metal", "cpu"];
const QUANT_FMTS: readonly QuantFmt[] = ["gguf", "safetensors", "awq", "gptq", "fp8", "mlx"];
const RUNNER_HINTS: readonly RunnerHint[] = ["llamacpp", "vllm", "ollama", "mlx"];
const FIT_VERDICTS: readonly FitVerdict[] = ["FITS", "TIGHT", "PARTIAL", "OVERFLOW"];

function runnerHints(v: unknown): RunnerHint[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => inSet<RunnerHint>(x, RUNNER_HINTS, "llamacpp"));
}

// — ScoredQuant (the fit.py `score_quant` row) —

function parseScoredQuant(input: unknown, path: string): ScoredQuant {
  const o = obj(input, path);
  return {
    label: str(o.label, `${path}.label`),
    fmt: inSet<QuantFmt>(o.fmt, QUANT_FMTS, "gguf"),
    bits: numOrNull(o.bits),
    qualityRank: num(o.quality_rank, `${path}.quality_rank`),
    runnerHint: runnerHints(o.runner_hint),
    weightsGb: num(o.weights_gb, `${path}.weights_gb`),
    kvCacheGb: num(o.kv_cache_gb, `${path}.kv_cache_gb`),
    overheadGb: num(o.overhead_gb, `${path}.overhead_gb`),
    estVramGb: num(o.est_vram_gb, `${path}.est_vram_gb`),
    budgetGb: num(o.budget_gb, `${path}.budget_gb`),
    ratio: numOrNull(o.ratio),
    verdict: inSet<FitVerdict>(o.verdict, FIT_VERDICTS, "OVERFLOW"),
    runnable: bool(o.runnable),
    blockedReason: typeof o.blocked_reason === "string" ? o.blocked_reason : null,
  };
}

/** The Cookbook fit `fit` envelope (file 05 §4). */
export const FitResultSchema: Schema<FitResult> = schema("FitResult", (input, path) => {
  const o = obj(input, path);
  const rec = o.recommended;
  return {
    id: optStr(o.id),
    paramsB: num(o.params_b, `${path}.params_b`),
    family: optStr(o.family),
    ctxLen: num(o.ctx_len, `${path}.ctx_len`),
    accel: inSet<Accel>(o.accel, ACCELS, "cpu"),
    usableGb: num(o.usable_gb, `${path}.usable_gb`),
    recommended: rec == null ? null : parseScoredQuant(rec, `${path}.recommended`),
    ranked: arr(o.ranked, `${path}.ranked`).map((q, i) =>
      parseScoredQuant(q, `${path}.ranked[${i}]`),
    ),
    reasons: strArr(o.reasons),
  };
});

/** The raw `hw.scan` envelope (file 05 §2.1) → a typed HardwareProfile. */
export const HardwareProfileSchema: Schema<HardwareProfile> = schema(
  "HardwareProfile",
  (input, path) => {
    const o = obj(input, path);
    const cpuRaw = obj(o.cpu ?? {}, `${path}.cpu`);
    const ramGb = optNum(o.ram_gb) ?? 0;
    const gpusRaw = Array.isArray(o.gpus) ? (o.gpus as unknown[]) : [];
    const gpus: HardwareGpu[] = gpusRaw.map((g, i) => {
      const gg = obj(g, `${path}.gpus[${i}]`);
      const vramBytes = optNum(gg.vram_bytes);
      const vramGb = vramBytes != null ? vramBytes / 1024 ** 3 : 0;
      return {
        index: i,
        name: typeof gg.name === "string" ? gg.name : "GPU",
        vramGb: Number(vramGb.toFixed(2)),
        vramFreeGb: Number(vramGb.toFixed(2)),
        computeCap: optStr(gg.compute_cap),
        unified: bool(gg.unified_memory),
      };
    });
    const unified = bool(o.unified_memory);
    const usableWeightGb = optNum(o.usable_weight_gb) ?? 0;
    const basis = String(o.usable_basis ?? "");
    let accel: Accel = "cpu";
    if (gpus.some((g) => !g.unified && g.vramGb > 0) || basis === "vram") accel = "cuda";
    else if (unified) accel = "metal";
    const totalVramGb = gpus.reduce((s, g) => s + (g.unified ? 0 : g.vramGb), 0);
    const maxSingle = gpus.reduce((m, g) => Math.max(m, g.unified ? 0 : g.vramGb), 0);
    const osRaw = String(o.os ?? "").toLowerCase();
    const os: HardwareProfile["os"] =
      osRaw === "darwin" ? "darwin" : osRaw === "windows" || osRaw === "win32" ? "win32" : "linux";
    return {
      id: "local",
      os,
      cpu: {
        brand: typeof cpuRaw.model === "string" ? cpuRaw.model : String(o.arch ?? ""),
        cores: optNum(cpuRaw.physical) ?? optNum(cpuRaw.logical) ?? 0,
        threads: optNum(cpuRaw.logical) ?? 0,
      },
      ramGb,
      ramFreeGb: ramGb,
      accel,
      gpus,
      caps: {
        fp8: false,
        flashAttn: accel === "cuda",
        awqMarlin: accel === "cuda",
        metal: accel === "metal",
        maxSingleGpuVramGb: Number(maxSingle.toFixed(2)),
        totalVramGb: Number(totalVramGb.toFixed(2)),
      },
      usableWeightGb,
      unified,
      detectedAt: new Date().toISOString(),
    };
  },
);
