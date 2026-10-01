// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * modelhub/client.ts — the typed Model-Hub client (file 05 §1/§2/§3).
 *
 * A thin marshaller over the existing `runSidecar("modelhub.py", argv)` (engine-bridge
 * is the ONLY JS spawner of python3 — C5). It validates the sidecar's one-JSON-object
 * stdout at the boundary (the zod-shaped schemas in ./types.ts) and projects snake_case
 * → the typed camelCase shapes the rest of the app renders.
 *
 * THE GOLDEN RULE (C5): JS NEVER decides "safe". The download GATE decision is the REAL
 * `nemesis` run inside the sidecar (stage → nemesis → admit | quarantine). A nemesis
 * BLOCK rides through as a RETURNED `DownloadResult` (`ok:false, blocked:true, gate:…`)
 * — it is a renderable value, NOT a thrown error and NEVER upgraded toward "allow".
 *
 * Long ops (download) stream JSON-lines progress on stderr ({"event":"progress",…});
 * `download({onProgress})` consumes those via the sidecar runner's stderr — see note
 * on the runner below. The runner-serving + multi-GB HF fetch cannot execute in this
 * sandbox; those code paths are correct + design-complete and the GATE / fit / argv
 * LOGIC is what is exercised deterministically.
 */
import { normalizeVerdict } from "../security/verdict.js";
import { type SidecarEnvelope, type SidecarOptions, runSidecar } from "../sidecar-runner.js";
import {
  type FitResult,
  FitResultSchema,
  type HardwareProfile,
  HardwareProfileSchema,
  type Model,
  type ModelResource,
  type ScoredQuant,
  type ServeProfile,
} from "./types.js";

export type { GateBadge } from "../security/verdict.js";

export interface ModelHubClientOptions extends SidecarOptions {}

/**
 * Refuse a sidecar envelope that reports failure, or that carries no payload at all.
 *
 * The schemas in `types.ts` are DEFAULTING parsers: they fill in every field they cannot find so
 * a partial-but-real envelope still yields a usable object. That is right for a real scan and
 * catastrophic for a failed one — a failure envelope has none of the fields, so every default
 * fires at once and the result reads as a real answer about a machine that does not exist.
 */
function assertScanSucceeded(env: SidecarEnvelope, what: string): void {
  if (env.ok === false) {
    const detail = typeof env.error === "string" && env.error ? env.error : "no reason given";
    throw new Error(`${what} failed: ${detail}`);
  }
  // An envelope with no keys beyond the envelope's own is not a scan result either.
  const payloadKeys = Object.keys(env).filter(
    (k) => k !== "ok" && k !== "command" && k !== "_exit",
  );
  if (payloadKeys.length === 0) throw new Error(`${what} returned no data`);
}

// ── progress (the JSON-lines stderr stream, C2/C6) ────────────────────────────

/** One `{"event":"progress",...}` JSON-line the sidecar streams on stderr. */
export interface DownloadProgress {
  event: "progress" | "log" | string;
  /** 0..100 when present. */
  pct?: number;
  message?: string;
  bytes?: number;
  totalBytes?: number;
  /** the raw stderr line (escape hatch). */
  raw: string;
}

/** Parse one stderr line into a DownloadProgress, or undefined if it is not one. */
export function parseDownloadProgressLine(line: string): DownloadProgress | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    if (!o || typeof o !== "object" || typeof o.event !== "string") return undefined;
    return {
      event: o.event,
      pct: typeof o.pct === "number" ? o.pct : undefined,
      message: typeof o.message === "string" ? o.message : undefined,
      bytes: typeof o.bytes === "number" ? o.bytes : undefined,
      totalBytes: typeof o.total_bytes === "number" ? o.total_bytes : undefined,
      raw: trimmed,
    };
  } catch {
    return undefined;
  }
}

// ── gate summary (the camelCased verdict the GUI renders) ─────────────────────

/** The camelCased gate summary (mirrors `nemesis_gate.verdict_summary`). */
export interface GateSummary {
  verdict: "allow" | "warn" | "block" | "error";
  score: number;
  reasons: string[];
  signed: boolean;
  recommendation?: string;
  scannedAt?: string;
}

function toGate(raw: unknown): GateSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as Record<string, unknown>;
  return {
    // normalizeVerdict fails CLOSED on any unknown/typo/crafted token → "error" (C3).
    // A raw cast here let a bogus token (e.g. "ok"/"safe") ride through as non-block.
    verdict: normalizeVerdict(g.verdict),
    score: typeof g.score === "number" ? g.score : 100,
    reasons: Array.isArray(g.reasons) ? g.reasons.map(String) : [],
    signed: Boolean(g.signed),
    recommendation: typeof g.recommendation === "string" ? g.recommendation : undefined,
    scannedAt: typeof g.scanned_at === "string" ? g.scanned_at : undefined,
  };
}

/** The forced-override flag (rides through when a block/error was force-admitted). */
export interface ForcedDangerInfo {
  label: string;
  verdict: string;
  riskScore?: number;
  blockingReasons: string[];
}

function toForcedDanger(raw: unknown): ForcedDangerInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Record<string, unknown>;
  return {
    label: String(f.label ?? ""),
    verdict: String(f.verdict ?? ""),
    riskScore: typeof f.risk_score === "number" ? f.risk_score : undefined,
    blockingReasons: Array.isArray(f.blocking_reasons) ? f.blocking_reasons.map(String) : [],
  };
}

// ── result shapes ─────────────────────────────────────────────────────────────

/** Pickle (*.bin/*.pt/*.ckpt) vs safetensors/gguf supply-chain risk (§5.3). */
export interface FormatRisk {
  highRiskFiles: string[];
  safeFiles: string[];
  risk: "high" | "low";
}

function toFormatRisk(raw: unknown): FormatRisk | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    highRiskFiles: Array.isArray(r.high_risk_files) ? r.high_risk_files.map(String) : [],
    safeFiles: Array.isArray(r.safe_files) ? r.safe_files.map(String) : [],
    risk: r.risk === "high" ? "high" : "low",
  };
}

/**
 * The unified download / gate result (file 05 §5). EVERY outcome is a RETURNED value:
 *   - `admitted:true`            → the stage was moved to the live library.
 *   - `blocked:true, ok:false`   → nemesis BLOCK/error (or sha256 mismatch); QUARANTINED.
 *   - `needsConfirm:true`        → nemesis WARN, no force — the GUI confirms + re-runs.
 *   - `planned:true`             → the resumable download plan (no `--staged`; no bytes).
 * The gate verdict rides through in `gate`; JS never decides safe (C5).
 */
export interface DownloadResult {
  ok: boolean;
  command: string;
  id?: string;
  /** the live library path once admitted. */
  localPath?: string;
  manifest?: string;
  admitted?: boolean;
  blocked?: boolean;
  needsConfirm?: boolean;
  planned?: boolean;
  plan?: unknown;
  verdict?: string;
  gate?: GateSummary;
  formatRisk?: FormatRisk;
  /** the kept-for-inspection stage dir on a refusal (never auto-deleted). */
  quarantined?: string;
  forcedDanger?: ForcedDangerInfo;
  stageDir?: string;
  message?: string;
  error?: string;
  /** the raw sidecar envelope (escape hatch). */
  raw: SidecarEnvelope;
}

function toDownloadResult(env: SidecarEnvelope): DownloadResult {
  return {
    ok: env.ok !== false,
    command: env.command,
    id: typeof env.id === "string" ? env.id : undefined,
    localPath: typeof env.local_path === "string" ? env.local_path : undefined,
    manifest: typeof env.manifest === "string" ? env.manifest : undefined,
    admitted: typeof env.admitted === "boolean" ? env.admitted : undefined,
    blocked: typeof env.blocked === "boolean" ? env.blocked : undefined,
    needsConfirm: typeof env.needs_confirm === "boolean" ? env.needs_confirm : undefined,
    planned: typeof env.planned === "boolean" ? env.planned : undefined,
    plan: env.plan,
    verdict: typeof env.verdict === "string" ? env.verdict : undefined,
    gate: toGate(env.gate),
    formatRisk: toFormatRisk(env.format_risk),
    quarantined: typeof env.quarantined === "string" ? env.quarantined : undefined,
    forcedDanger: toForcedDanger(env.forced_danger),
    stageDir: typeof env.stage_dir === "string" ? env.stage_dir : undefined,
    message: typeof env.message === "string" ? env.message : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

/** A plain executed/planned mutation result (remove / unserve — no gate). */
export interface MutationResult {
  ok: boolean;
  command: string;
  message?: string;
  error?: string;
  raw: SidecarEnvelope;
  [k: string]: unknown;
}

function toMutationResult(env: SidecarEnvelope): MutationResult {
  return {
    ...env,
    ok: env.ok !== false,
    command: env.command,
    message: typeof env.message === "string" ? env.message : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

/** The REAL local-model install result (ollama `pull`, file 05 §5). `installable:true`
 *  means the ollama runner itself is missing → the UI shows an "Install ollama" hint. */
export interface PullResult {
  ok: boolean;
  command: string;
  installed: boolean;
  id: string;
  tag?: string;
  runner: string;
  /** the OpenAI-compatible endpoint the model is served at on success. */
  endpoint?: string;
  /** true when the failure is "runner not installed" (actionable, not a real error). */
  installable?: boolean;
  install?: string;
  error?: string;
  raw: SidecarEnvelope;
}

function toPullResult(env: SidecarEnvelope): PullResult {
  return {
    ...env,
    ok: env.ok !== false,
    command: env.command,
    installed: env.installed === true,
    id: typeof env.id === "string" ? env.id : "",
    tag: typeof env.tag === "string" ? env.tag : undefined,
    runner: typeof env.runner === "string" ? env.runner : "ollama",
    endpoint: typeof env.endpoint === "string" ? env.endpoint : undefined,
    installable: env.installable === true ? true : undefined,
    install: typeof env.install === "string" ? env.install : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

/** Result of auto-installing the local RUNNER (ollama) on the user's behalf, OS-aware.
 *  `manual:true` means the host needs a step we won't automate (no Homebrew / Windows). */
export interface InstallRunnerResult {
  ok: boolean;
  command?: string;
  runner: string;
  /** the OS family the command was chosen for ("macos" | "linux" | …). */
  os?: string;
  installed: boolean;
  manual?: boolean;
  install?: string;
  url?: string;
  error?: string;
  raw: SidecarEnvelope;
}

function toInstallRunnerResult(env: SidecarEnvelope): InstallRunnerResult {
  return {
    ...env,
    ok: env.ok !== false,
    // the sidecar emits the ACTUAL shell command it ran as `cmdline` (`command` is
    // reserved for the verb name); surface it as the result's `command`.
    command: typeof env.cmdline === "string" ? env.cmdline : undefined,
    runner: typeof env.runner === "string" ? env.runner : "ollama",
    os: typeof env.os === "string" ? env.os : undefined,
    installed: env.installed === true,
    manual: env.manual === true ? true : undefined,
    install: typeof env.install === "string" ? env.install : undefined,
    url: typeof env.url === "string" ? env.url : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

/** A served local endpoint (LIVE `localai endpoints` passthrough). */
export interface Endpoint {
  name: string;
  baseUrl: string;
}

export interface EndpointsResult {
  ok: boolean;
  /** FREE local servers (llama.cpp / vLLM / Ollama at localhost). */
  local: Endpoint[];
  /** big open-weight APIs (OpenRouter / Groq / Together / …). */
  openApi: Endpoint[];
  engine?: string;
  error?: string;
  raw: SidecarEnvelope;
}

/** The non-secret repoint env diff (LIVE `localai show <tool>` passthrough, §6). */
export interface RepointResult {
  ok: boolean;
  tool?: string;
  baseUrl?: string;
  patchable?: boolean;
  recipe?: string;
  /** the NON-SECRET env to write: base-URL + dummy KEY=ollama (never a real key). */
  proposedEnv?: Record<string, string>;
  referencedEnvVars?: string[];
  secretPolicy?: string;
  engine?: string;
  error?: string;
  raw: SidecarEnvelope;
}

// ── option bags ───────────────────────────────────────────────────────────────

export interface SearchOptions {
  q?: string;
  modality?: string;
  source?: "hf" | "ollama";
  freeOnly?: boolean;
  limit?: number;
}

export interface FitOptions {
  id?: string;
  params?: string;
  family?: string;
  ctx?: number;
  /** an hw.scan envelope OR the fit hardware shape, as JSON. */
  hw?: unknown;
}

export interface DownloadOptions {
  id: string;
  quant?: string;
  source?: "hf" | "ollama" | "url";
  license?: string;
  /** a dir already holding the (fetched/planted) bytes → drives the gate. */
  staged?: string;
  /** {rfilename: sha256} — verified before the scan (mismatch ⇒ BLOCK). */
  sha256?: Record<string, string>;
  force?: boolean;
  onProgress?: (p: DownloadProgress) => void;
}

export interface ServeOptions {
  id: string;
  quant?: string;
  runner?: "llamacpp" | "vllm" | "ollama";
  gguf?: string;
  ctx?: number;
  port?: number;
  hw?: unknown;
  autostart?: boolean;
  /**
   * Override the sidecar's OVERFLOW RAM refusal, which itself says "re-run with --force".
   * `download()` and `remove()` have always plumbed this; `serve` did not, so the hint the
   * user was shown could not be acted on from any surface. A GUI must only set this behind an
   * explicit "serve anyway" confirmation — an unconfirmed force defeats the guard silently.
   */
  force?: boolean;
}

export interface RepointOptions {
  tool: string;
  baseUrl: string;
}

// ── /hug: fetch → convert → install-target (each a thin marshaller, same discipline) ──

export interface FetchHfOptions {
  repo: string;
  out?: string;
  revision?: string;
}

/** The ACTUAL raw-weights fetch for an HF repo (via HF's own `hf`/`huggingface-cli`
 *  downloader) — `download()` above never fetches bytes itself; this does. */
export interface FetchHfResult {
  ok: boolean;
  command?: string;
  repo?: string;
  path?: string;
  /** true when the failure is "no hf CLI on PATH" (actionable — offer installHfCli). */
  installable?: boolean;
  error?: string;
  raw: SidecarEnvelope;
}

function toFetchHfResult(env: SidecarEnvelope): FetchHfResult {
  return {
    ok: env.ok !== false,
    command: env.command,
    repo: typeof env.repo === "string" ? env.repo : undefined,
    path: typeof env.path === "string" ? env.path : undefined,
    installable: env.installable === true ? true : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

/** `pip install huggingface_hub[cli]` on the user's behalf — the one-time
 *  "detect absence, offer install" step for the HF fetch tool. */
export interface InstallHfCliResult {
  ok: boolean;
  installed?: boolean;
  manual?: boolean;
  install?: string;
  error?: string;
  raw: SidecarEnvelope;
}

function toInstallHfCliResult(env: SidecarEnvelope): InstallHfCliResult {
  return {
    ok: env.ok !== false,
    installed: env.installed === true,
    manual: env.manual === true ? true : undefined,
    install: typeof env.install === "string" ? env.install : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

export interface ConvertOptions {
  src: string;
  quant?: string;
  id?: string;
  out?: string;
}

/**
 * HF directory → GGUF (+ quantize), ALWAYS by shelling out to llama.cpp's own tools
 * (convert_hf_to_gguf.py / llama-quantize) — this client never re-implements either.
 * `lowDisk:true` means the sidecar's own 7%-floor disk guard refused BEFORE writing
 * anything; `installable:true` means llama.cpp's converter/quantizer isn't present yet
 * (offer installConverter). Both are actionable, not a generic failure.
 */
export interface ConvertResult {
  ok: boolean;
  id?: string;
  path?: string;
  /** the canonical open_models path — a symlink to `path` when `--out` pointed elsewhere. */
  canonicalPath?: string;
  quant?: string;
  sizeBytes?: number;
  sizeGb?: number;
  installable?: boolean;
  lowDisk?: boolean;
  hint?: string;
  error?: string;
  raw: SidecarEnvelope;
}

function toConvertResult(env: SidecarEnvelope): ConvertResult {
  return {
    ok: env.ok !== false,
    id: typeof env.id === "string" ? env.id : undefined,
    path: typeof env.path === "string" ? env.path : undefined,
    canonicalPath: typeof env.canonical_path === "string" ? env.canonical_path : undefined,
    quant: typeof env.quant === "string" ? env.quant : undefined,
    sizeBytes: typeof env.size_bytes === "number" ? env.size_bytes : undefined,
    sizeGb: typeof env.size_gb === "number" ? env.size_gb : undefined,
    installable: env.installable === true ? true : undefined,
    lowDisk: env.low_disk === true ? true : undefined,
    hint: typeof env.hint === "string" ? env.hint : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

/** Fetch llama.cpp's OWN convert_hf_to_gguf.py (a shallow git clone), once. */
export interface InstallConverterResult {
  ok: boolean;
  installed?: boolean;
  path?: string;
  manual?: boolean;
  install?: string;
  error?: string;
  raw: SidecarEnvelope;
}

function toInstallConverterResult(env: SidecarEnvelope): InstallConverterResult {
  return {
    ok: env.ok !== false,
    installed: env.installed === true,
    path: typeof env.path === "string" ? env.path : undefined,
    manual: env.manual === true ? true : undefined,
    install: typeof env.install === "string" ? env.install : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

export interface InstallTargetOptions {
  target: "ollama" | "llamacpp" | "vllm" | "lmstudio";
  id: string;
  /** required for llamacpp/lmstudio/ollama — an existing GGUF path. */
  gguf?: string;
  /** required for vllm — the HF-format directory (vLLM never needs the GGUF). */
  src?: string;
  quant?: string;
}

/**
 * Wire an already-converted (or already-GGUF) model into ONE target runtime, never
 * duplicating the payload: llama.cpp/vLLM read the file/directory directly; Ollama
 * ingests it into its own store; LM Studio gets a SYMLINK (or an `lms import`).
 */
export interface InstallTargetResult {
  ok: boolean;
  target?: string;
  id?: string;
  path?: string;
  endpoint?: string;
  method?: string;
  note?: string;
  error?: string;
  raw: SidecarEnvelope;
}

function toInstallTargetResult(env: SidecarEnvelope): InstallTargetResult {
  return {
    ok: env.ok !== false,
    target: typeof env.target === "string" ? env.target : undefined,
    id: typeof env.id === "string" ? env.id : undefined,
    path: typeof env.path === "string" ? env.path : undefined,
    endpoint: typeof env.endpoint === "string" ? env.endpoint : undefined,
    method: typeof env.method === "string" ? env.method : undefined,
    note: typeof env.note === "string" ? env.note : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

// ── catalog Model projection (model.search rows → typed Model) ────────────────

/** Project the catalog snake_case `resource` block → the camelCase ModelResource. */
function toResource(raw: unknown): ModelResource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  return {
    q4Gb: num(r.q4_gb),
    kv8kGb: num(r.kv_8k_gb),
    kvNativeGb: num(r.kv_native_gb),
    minRamGb: num(r.min_ram_gb),
    recRamGb: num(r.rec_ram_gb),
    gpuMinVramGb: num(r.gpu_min_vram_gb),
    cpuOk: typeof r.cpu_ok === "boolean" ? r.cpu_ok : undefined,
    tier: typeof r.tier === "string" ? r.tier : undefined,
    needsOffload: typeof r.needs_offload === "boolean" ? r.needs_offload : undefined,
    label: typeof r.label === "string" ? r.label : undefined,
  };
}

function toModel(row: Record<string, unknown>): Model {
  const kind = String(row.kind ?? "llm").toLowerCase();
  const subtype = String(row.subtype ?? "").toLowerCase();
  const license = String(row.license ?? "");
  const lic = license.toLowerCase();
  // "open-weight" = the weights are downloadable (NOT a commercial-use claim — the
  // freeOnly filter below additionally requires a PERMISSIVE license). This broad
  // allowlist makes NVIDIA Nemotron + the other open catalogs surface as open-weight.
  const open =
    lic.includes("apache") ||
    lic === "mit" ||
    lic.startsWith("bsd") ||
    lic.includes("gemma") ||
    lic.includes("llama") ||
    lic.includes("deepseek") ||
    lic.includes("nvidia") ||
    lic.includes("open-model-license") ||
    lic.includes("research-license") ||
    lic.includes("cc-by") ||
    lic.includes("openrail") ||
    lic.includes("falcon") ||
    lic.includes("qwen") ||
    lic.includes("mistral") ||
    lic.includes("exaone") ||
    lic.includes("tencent") ||
    lic.includes("hunyuan") ||
    lic.includes("minimax") ||
    lic.includes("bigcode") ||
    lic.includes("stabilityai") ||
    kind === "non-llm";
  const modality: Model["modality"] =
    subtype === "embedding"
      ? "embedding"
      : subtype === "asr"
        ? "asr"
        : subtype === "text-to-image"
          ? "diffusion"
          : kind === "non-llm"
            ? "embedding"
            : "text";
  const paramsB = typeof row.params_b === "number" ? row.params_b : undefined;
  return {
    id: String(row.id ?? ""),
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    ...(typeof row.ollama === "string" ? { ollama: row.ollama } : {}),
    source: "huggingface",
    modality,
    family: typeof row.family === "string" ? row.family : undefined,
    description: typeof row.description === "string" ? row.description : undefined,
    resource: toResource(row.resource),
    params: paramsB != null ? `${paramsB}B` : undefined,
    license,
    openWeight: open,
    gated: false,
    quants: [],
    contextLen: typeof row.context === "number" ? row.context : undefined,
    // APP-092: carry the catalog capability tags through so the AI picker can badge them.
    ...(Array.isArray(row.tags)
      ? { tags: (row.tags as unknown[]).filter((t): t is string => typeof t === "string") }
      : {}),
    cardUrl: typeof row.repo === "string" ? `https://huggingface.co/${row.repo}` : undefined,
    installed: false,
  };
}

const PERMISSIVE = ["apache", "mit", "bsd"];

// ── the client ────────────────────────────────────────────────────────────────

export class ModelHubClient {
  private readonly opts: ModelHubClientOptions;

  constructor(opts: ModelHubClientOptions = {}) {
    this.opts = opts;
  }

  private run<T extends SidecarEnvelope = SidecarEnvelope>(
    argv: string[],
    extra?: Partial<SidecarOptions>,
  ): Promise<T> {
    return runSidecar<T>("modelhub.py", argv, { ...this.opts, ...extra });
  }

  /**
   * REAL hardware detection (`hw.scan`) → a typed HardwareProfile. `rescan` is honored
   * by the client surface (the sidecar scan is always live; there is no stale cache on
   * the python side yet, so a rescan is just a re-run). Validated at the boundary.
   */
  async hardware(opts: { rescan?: boolean } = {}): Promise<HardwareProfile> {
    const argv = ["hw.scan"];
    if (opts.rescan) argv.push("--rescan");
    const env = await this.run(argv);
    /**
     * FAIL CLOSED. `HardwareProfileSchema` defaults every field it cannot find — missing `os`
     * becomes "linux", missing cpu becomes 0 cores, missing `ram_gb` becomes 0 — so a FAILURE
     * envelope (`{ok:false, error:"sidecar not found"}`, a python traceback, an empty object)
     * parsed cleanly into a plausible-looking machine and was returned as a successful scan.
     * On this real macOS/arm64 host it reported linux / "" / 0 cores / 0 GB / cpu, and model-fit
     * scoring then answered from those numbers. A readout that says nothing is safe; a readout
     * that confidently says the wrong thing is not.
     */
    assertScanSucceeded(env, "hw.scan");
    return HardwareProfileSchema.parse(env);
  }

  /** Catalog search (bundled open-models.json + best-effort HF). Returns typed Models. */
  async search(opts: SearchOptions = {}): Promise<Model[]> {
    const argv = ["model.search"];
    if (opts.q) argv.push(opts.q);
    if (opts.modality) argv.push("--family", opts.modality);
    if (opts.source) argv.push("--source", opts.source);
    const env = await this.run(argv);
    const rows = Array.isArray(env.results) ? (env.results as Record<string, unknown>[]) : [];
    let models = rows.map(toModel);
    if (opts.freeOnly) {
      models = models.filter(
        (m) => m.openWeight && PERMISSIVE.some((p) => m.license.toLowerCase().includes(p)),
      );
    }
    if (typeof opts.limit === "number" && opts.limit >= 0) {
      models = models.slice(0, opts.limit);
    }
    return models;
  }

  /** Model detail (quants populated from the HF tree where available). */
  async info(id: string): Promise<Model | undefined> {
    const env = await this.run(["model.search", id]);
    const rows = Array.isArray(env.results) ? (env.results as Record<string, unknown>[]) : [];
    const match = rows.find((r) => String(r.id ?? "") === id) ?? rows[0];
    return match ? toModel(match) : undefined;
  }

  /**
   * The Cookbook fit-score (file 05 §4): recommended quant + ranked + reasons. Validated
   * at the boundary into a typed FitResult. `hw` (an hw.scan envelope OR the fit shape)
   * is threaded as JSON so callers can score against a saved/overridden profile.
   */
  async fit(id?: string, opts: Omit<FitOptions, "id"> = {}): Promise<FitResult> {
    const argv = ["fit"];
    if (id) argv.push("--id", id);
    if (opts.params) argv.push("--params", opts.params);
    if (opts.family) argv.push("--family", opts.family);
    if (typeof opts.ctx === "number") argv.push("--ctx", String(opts.ctx));
    if (opts.hw !== undefined) argv.push("--hw", JSON.stringify(opts.hw));
    const env = await this.run(argv);
    return FitResultSchema.parse(env);
  }

  /**
   * Download → stage → REAL nemesis gate → admit | quarantine (the SECURITY SPINE §5).
   *
   * Without `staged`, the sidecar returns the resumable download PLAN (no bytes moved).
   * With `staged` (a dir already holding the bytes), the GATE runs over them: a BLOCK is
   * a RETURNED `DownloadResult` (`ok:false, blocked:true`), NEVER a throw — JS does not
   * decide safety (C5). `onProgress` consumes the JSON-lines stderr stream.
   *
   * ENV LIMIT: the multi-GB HF fetch + the runner serving cannot run in this sandbox; the
   * gate decision over staged bytes is the security-load-bearing part and IS exercised.
   */
  async download(opts: DownloadOptions): Promise<DownloadResult> {
    const argv = ["download", "--id", opts.id];
    if (opts.quant) argv.push("--quant", opts.quant);
    if (opts.source) argv.push("--source", opts.source);
    if (opts.license) argv.push("--license", opts.license);
    if (opts.staged) argv.push("--staged", opts.staged);
    if (opts.sha256) argv.push("--sha256", JSON.stringify(opts.sha256));
    if (opts.force) argv.push("--force");
    // The sidecar streams `{"event":"progress",...}` JSON-lines on stderr during a real
    // multi-GB fetch, and they are consumed AS THEY ARRIVE via the runner's `onStderr` hook.
    //
    // This used to scan `env._stderr` after the run instead — a field nothing in this repo
    // ever sets. So `onProgress` could not fire even once, for any download: the Models
    // pull readout and the chat's "Live download %" sat at their initial "starting" state
    // through a multi-GB fetch and then jumped straight to done. Reading it post-hoc would
    // also have been useless for a progress bar even if the field had existed.
    const onProgress = opts.onProgress;
    const env = await this.run(
      argv,
      onProgress
        ? {
            onStderr: (line: string): void => {
              const p = parseDownloadProgressLine(line);
              if (p) onProgress(p);
            },
          }
        : undefined,
    );
    return toDownloadResult(env);
  }

  /**
   * REAL local-model install via the ollama runner (`ollama pull`). Unlike `download`
   * (the HF/GGUF gate spine), this actually fetches AND serves the weights on the user's
   * machine — ollama's signed registry is the trust boundary. `onProgress` consumes the
   * JSON-lines stderr stream. Returns an actionable `PullResult` (`installable:true` when
   * the ollama runner itself is missing); it NEVER throws for the "not installed" case.
   */
  async pull(opts: {
    id: string;
    tag?: string;
    /** Override the OVERFLOW RAM refusal — see `ServeOptions.force`. The CLI already sends
     *  this through `runMutation`/`execArgv`; without it here the desktop could not. */
    force?: boolean;
    onProgress?: (p: DownloadProgress) => void;
  }): Promise<PullResult> {
    const argv = ["pull", "--id", opts.id];
    if (opts.tag) argv.push("--tag", opts.tag);
    if (opts.force) argv.push("--force");
    // Live, via the runner's per-line stderr hook — see `download` above for why the old
    // `env._stderr` scan could never fire.
    const onProgress = opts.onProgress;
    const env = await this.run(
      argv,
      onProgress
        ? {
            onStderr: (line: string): void => {
              const p = parseDownloadProgressLine(line);
              if (p) onProgress(p);
            },
          }
        : undefined,
    );
    return toPullResult(env);
  }

  /**
   * Auto-install the local RUNNER (ollama) ON THE USER'S BEHALF. The sidecar
   * discriminates macOS (`brew install ollama`) vs Linux (`curl … install.sh | sh`)
   * and runs the command itself, streaming its output as JSON-lines on stderr.
   * Returns `manual:true` when the host needs a step we won't automate.
   */
  async installRunner(opts?: {
    runner?: "ollama";
    onProgress?: (p: DownloadProgress) => void;
  }): Promise<InstallRunnerResult> {
    const argv = ["install-runner", "--runner", opts?.runner ?? "ollama"];
    // Live, via the runner's per-line stderr hook — see `download` above for why the old
    // `env._stderr` scan could never fire.
    const onProgress = opts?.onProgress;
    const env = await this.run(
      argv,
      onProgress
        ? {
            onStderr: (line: string): void => {
              const p = parseDownloadProgressLine(line);
              if (p) onProgress(p);
            },
          }
        : undefined,
    );
    return toInstallRunnerResult(env);
  }

  /** Installed models in the local library (+ Ollama index). */
  async library(modality?: string): Promise<Model[]> {
    const argv = ["model.list"];
    void modality; // model.list takes a dir, not a modality filter, on the sidecar today
    const env = await this.run(argv);
    const rows = Array.isArray(env.models) ? (env.models as Record<string, unknown>[]) : [];
    return rows.map((r) => {
      // Honor the sidecar's real fields so Ollama-indexed models (spec §9) carry their
      // true source/modality/params instead of being flattened to a HF text model.
      // Honour every source the sidecar actually emits. This was
      // `r.source === "ollama" || r.source === "url" ? r.source : "huggingface"`, which reported
      // LM Studio and shared-HF-cache models as Hugging Face ones — the union had no member for
      // them (see `ModelSource`). Anything genuinely unrecognised still falls back rather than
      // widening the type at runtime.
      const KNOWN: readonly Model["source"][] = ["ollama", "url", "lmstudio", "hf-cache"];
      const source: Model["source"] = KNOWN.includes(r.source as Model["source"])
        ? (r.source as Model["source"])
        : "huggingface";
      const modality = (typeof r.modality === "string" ? r.modality : "text") as Model["modality"];
      const params =
        typeof r.params === "string" ? r.params : typeof r.quant === "string" ? r.quant : undefined;
      // `model.list` measures the FILE — size, quantization, container, and (for
      // Ollama-indexed rows) whether the daemon already serves it. All of that used to be
      // dropped on the floor here, which is why the Model Hub's Installed list could show a
      // name and nothing else: the data existed at the source and died in this mapper.
      // Passed through only when present, so a catalog row is unaffected.
      const size = typeof r.size_bytes === "number" ? r.size_bytes : undefined;
      const quant = typeof r.quant === "string" && r.quant ? r.quant : undefined;
      const fmt = typeof r.format === "string" && r.format ? r.format : undefined;
      const endpoint = typeof r.endpoint === "string" && r.endpoint ? r.endpoint : undefined;
      return {
        id: String(r.id ?? r.name ?? ""),
        source,
        modality,
        license: typeof r.license === "string" ? r.license : "",
        openWeight: r.openWeight !== false,
        gated: r.gated === true,
        quants: [],
        installed: r.installed !== false,
        localPath: typeof r.path === "string" && r.path ? r.path : undefined,
        params,
        ...(typeof r.name === "string" && r.name ? { name: r.name } : {}),
        ...(typeof r.family === "string" && r.family ? { family: r.family } : {}),
        ...(size !== undefined ? { sizeBytes: size } : {}),
        ...(quant !== undefined ? { quant } : {}),
        ...(fmt !== undefined ? { format: fmt } : {}),
        ...(r.served === true ? { served: true } : {}),
        ...(endpoint !== undefined ? { endpoint } : {}),
      };
    });
  }

  /** Remove model files (refuses if a ServeProfile references it, unless force). */
  remove(id: string, opts: { quant?: string; force?: boolean } = {}): Promise<MutationResult> {
    const argv = ["remove", "--id", id];
    if (opts.quant) argv.push("--quant", opts.quant);
    if (opts.force) argv.push("--force");
    return this.run(argv).then(toMutationResult);
  }

  /**
   * Build a ServeProfile + fit-derived runner argv (file 05 §8). PURE on the sidecar —
   * it does NOT spawn: the long-lived runner is supervised by the desktop MAIN process
   * (C8 ServerSupervisor). The returned profile's `status` is "starting"; the supervisor
   * flips it to "ready" once `/v1/models` answers. ENV LIMIT: the runner binaries
   * (llama.cpp / vLLM / ollama) are not installed here, so only the argv CONSTRUCTION is
   * exercised — which is the testable, load-bearing part.
   */
  async serve(opts: ServeOptions): Promise<ServeProfile> {
    const argv = ["serve", "--id", opts.id];
    if (opts.quant) argv.push("--quant", opts.quant);
    if (opts.runner) argv.push("--runner", opts.runner);
    if (opts.gguf) argv.push("--gguf", opts.gguf);
    if (typeof opts.ctx === "number") argv.push("--ctx", String(opts.ctx));
    if (typeof opts.port === "number") argv.push("--port", String(opts.port));
    if (opts.hw !== undefined) argv.push("--hw", JSON.stringify(opts.hw));
    if (opts.autostart) argv.push("--autostart");
    if (opts.force) argv.push("--force");
    const env = await this.run(argv);
    /**
     * FAIL CLOSED, exactly as `hardware()` above does — this is the seam every surface but
     * the CLI crosses.
     *
     * `runSidecar` RESOLVES a failure envelope (`{ok:false, command, error, _exit}`, with no
     * `profile` key) — it never throws — and `toServeProfile` defaults every field it cannot
     * find. So a REFUSAL turned into a GHOST profile: `id: ""`, `modelId: ""`, `argv: []`,
     * `runner: "llamacpp"`, `port: 8080`, `status: "starting"`. The desktop then handed that
     * to the C8 supervisor and answered `ok: true`, which means §8's OVERFLOW RAM guard
     * ("… serving it risks exhausting RAM/swap") and the "unknown model id" refusal — the two
     * things standing between a 70B q4 on a 16 GB machine and a swap-thrash — were discarded
     * before anyone could read them.
     *
     * The throw is caught by each host's existing `catch` (desktop model-ipc returns
     * `{ok:false, error: errString(e)}`), so the sidecar's own prose reaches the user and no
     * runner is spawned.
     */
    assertScanSucceeded(env, "serve");
    if (!env.profile || typeof env.profile !== "object") {
      throw new Error("serve failed: the sidecar returned no serve profile");
    }
    return toServeProfile(env.profile);
  }

  /** Stop a served runner (SIGTERM the pid via the supervisor). */
  unserve(profileId: string): Promise<MutationResult> {
    return this.run(["unserve", "--profile", profileId]).then(toMutationResult);
  }

  /**
   * Stop the ollama background daemon — but ONLY if Prometheus itself started it (a marker
   * `_ensure_ollama_daemon` records on the ONE code path that actually spawns it — see
   * modelhub.py). A daemon the user started by hand, via `brew services`, or that some
   * other app also needs is never touched: `stopped:false` with a `reason` is the normal,
   * expected result whenever this session didn't wake it up itself. Best-effort, called on
   * app quit — "we woke it, we let it rest" — never a hard requirement to succeed.
   */
  releaseOllama(): Promise<MutationResult> {
    return this.run(["ollama.release"]).then(toMutationResult);
  }

  /** LIVE local + open-weight endpoints (`prometheus.py localai endpoints` passthrough). */
  async endpoints(): Promise<EndpointsResult> {
    const env = await this.run(["endpoints"]);
    const local = Array.isArray(env.local) ? (env.local as Record<string, unknown>[]) : [];
    const openApi = Array.isArray(env.open_api) ? (env.open_api as Record<string, unknown>[]) : [];
    const map = (r: Record<string, unknown>): Endpoint => ({
      name: String(r.name ?? ""),
      baseUrl: String(r.base_url ?? ""),
    });
    return {
      ok: env.ok !== false,
      local: local.map(map),
      openApi: openApi.map(map),
      engine: typeof env.engine === "string" ? env.engine : undefined,
      error: typeof env.error === "string" ? env.error : undefined,
      raw: env,
    };
  }

  /** LIVE repoint env diff (`localai show <tool>` passthrough, §6). Non-secret only. */
  async repoint(opts: RepointOptions): Promise<RepointResult> {
    const env = await this.run(["repoint", "--tool", opts.tool, "--base-url", opts.baseUrl]);
    const proposed =
      env.proposed_env && typeof env.proposed_env === "object"
        ? (env.proposed_env as Record<string, string>)
        : undefined;
    return {
      ok: env.ok !== false,
      tool: typeof env.tool === "string" ? env.tool : undefined,
      baseUrl: typeof env.base_url === "string" ? env.base_url : undefined,
      patchable: typeof env.patchable === "boolean" ? env.patchable : undefined,
      recipe: typeof env.recipe === "string" ? env.recipe : undefined,
      proposedEnv: proposed,
      referencedEnvVars: Array.isArray(env.referenced_env_vars)
        ? env.referenced_env_vars.map(String)
        : undefined,
      secretPolicy: typeof env.secret_policy === "string" ? env.secret_policy : undefined,
      engine: typeof env.engine === "string" ? env.engine : undefined,
      error: typeof env.error === "string" ? env.error : undefined,
      raw: env,
    };
  }

  /** The ACTUAL raw-weights fetch for an HF repo — via HF's own `hf` downloader. */
  async fetchHf(opts: FetchHfOptions): Promise<FetchHfResult> {
    const argv = ["fetch-hf", "--repo", opts.repo];
    if (opts.out) argv.push("--out", opts.out);
    if (opts.revision) argv.push("--revision", opts.revision);
    return toFetchHfResult(await this.run(argv));
  }

  /** `pip install huggingface_hub[cli]` on the user's behalf, once. */
  async installHfCli(): Promise<InstallHfCliResult> {
    return toInstallHfCliResult(await this.run(["install-hf-cli"]));
  }

  /** HF dir → GGUF (+ quantize), always via llama.cpp's own convert/quantize tools. */
  async convert(opts: ConvertOptions): Promise<ConvertResult> {
    const argv = ["convert", "--src", opts.src];
    if (opts.quant) argv.push("--quant", opts.quant);
    if (opts.id) argv.push("--id", opts.id);
    if (opts.out) argv.push("--out", opts.out);
    return toConvertResult(await this.run(argv));
  }

  /** Fetch llama.cpp's OWN convert_hf_to_gguf.py (a shallow git clone), once. */
  async installConverter(): Promise<InstallConverterResult> {
    return toInstallConverterResult(await this.run(["install-converter"]));
  }

  /** Wire a converted/GGUF model into ONE target runtime, never duplicating bytes. */
  async installTarget(opts: InstallTargetOptions): Promise<InstallTargetResult> {
    const argv = ["install-target", "--target", opts.target, "--id", opts.id];
    if (opts.gguf) argv.push("--gguf", opts.gguf);
    if (opts.src) argv.push("--src", opts.src);
    if (opts.quant) argv.push("--quant", opts.quant);
    return toInstallTargetResult(await this.run(argv));
  }
}

// ── ServeProfile projection (serve `profile` envelope → typed ServeProfile) ────

function toServeProfile(raw: unknown): ServeProfile {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ep = (p.endpoint && typeof p.endpoint === "object" ? p.endpoint : {}) as Record<
    string,
    unknown
  >;
  const a = (p.args && typeof p.args === "object" ? p.args : {}) as Record<string, unknown>;
  const runner = String(p.runner ?? "llamacpp") as ServeProfile["runner"];
  return {
    id: String(p.id ?? ""),
    modelId: String(p.model_id ?? ""),
    quant: String(p.quant ?? ""),
    runner,
    endpoint: {
      host: String(ep.host ?? "127.0.0.1"),
      port: typeof ep.port === "number" ? ep.port : 8080,
      baseUrl: String(ep.base_url ?? ""),
    },
    apiKey: String(p.api_key ?? "local"),
    args: {
      ctxLen: typeof a.ctx_len === "number" ? a.ctx_len : 8192,
      gpuLayers: typeof a.gpu_layers === "number" ? a.gpu_layers : undefined,
      tensorParallel: typeof a.tensor_parallel === "number" ? a.tensor_parallel : undefined,
      kvCacheDtype:
        a.kv_cache_dtype === "fp8" ? "fp8" : a.kv_cache_dtype === "auto" ? "auto" : undefined,
      maxModelLen: typeof a.max_model_len === "number" ? a.max_model_len : undefined,
      servedModelName: String(a.served_model_name ?? p.model_id ?? ""),
    },
    argv: Array.isArray(p.argv) ? p.argv.map(String) : [],
    autostart: Boolean(p.autostart),
    // the sidecar builds a profile (status "stopped"); the client surfaces "starting"
    // because the very next step is the MAIN-process supervisor spawning it (C8).
    status: "starting",
  };
}

// re-export the ScoredQuant type used in serve fit responses for convenience.
export type { ScoredQuant };

// ── module-level convenience (mirrors env.ts / the security module) ───────────

const defaultClient = new ModelHubClient();

export const createModelHubClient = (opts?: ModelHubClientOptions): ModelHubClient =>
  new ModelHubClient(opts);

export const hardware = (opts?: { rescan?: boolean }): Promise<HardwareProfile> =>
  defaultClient.hardware(opts);
export const search = (opts?: SearchOptions): Promise<Model[]> => defaultClient.search(opts);
export const info = (id: string): Promise<Model | undefined> => defaultClient.info(id);
export const fit = (id?: string, opts?: Omit<FitOptions, "id">): Promise<FitResult> =>
  defaultClient.fit(id, opts);
export const download = (opts: DownloadOptions): Promise<DownloadResult> =>
  defaultClient.download(opts);
export const pull = (opts: {
  id: string;
  tag?: string;
  onProgress?: (p: DownloadProgress) => void;
}): Promise<PullResult> => defaultClient.pull(opts);
export const installRunner = (opts?: {
  runner?: "ollama";
  onProgress?: (p: DownloadProgress) => void;
}): Promise<InstallRunnerResult> => defaultClient.installRunner(opts);
export const library = (modality?: string): Promise<Model[]> => defaultClient.library(modality);
export const remove = (
  id: string,
  opts?: { quant?: string; force?: boolean },
): Promise<MutationResult> => defaultClient.remove(id, opts);
export const serve = (opts: ServeOptions): Promise<ServeProfile> => defaultClient.serve(opts);
export const unserve = (profileId: string): Promise<MutationResult> =>
  defaultClient.unserve(profileId);
export const releaseOllama = (): Promise<MutationResult> => defaultClient.releaseOllama();
export const endpoints = (): Promise<EndpointsResult> => defaultClient.endpoints();
export const repoint = (opts: RepointOptions): Promise<RepointResult> =>
  defaultClient.repoint(opts);
export const fetchHf = (opts: FetchHfOptions): Promise<FetchHfResult> =>
  defaultClient.fetchHf(opts);
export const installHfCli = (): Promise<InstallHfCliResult> => defaultClient.installHfCli();
export const convert = (opts: ConvertOptions): Promise<ConvertResult> =>
  defaultClient.convert(opts);
export const installConverter = (): Promise<InstallConverterResult> =>
  defaultClient.installConverter();
export const installTarget = (opts: InstallTargetOptions): Promise<InstallTargetResult> =>
  defaultClient.installTarget(opts);
