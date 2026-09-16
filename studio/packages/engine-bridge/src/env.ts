import type {
  Env,
  EnvHealth,
  EnvKind,
  EnvManagedBy,
  EnvScope,
  GpuInfo,
  Package,
  PkgSource,
} from "./env.types.js";
/**
 * env.ts — the typed env client (file 04 §2/§8). A thin, camelCasing marshaller
 * over the existing `runSidecar("envmgr.py", argv)` (engine-bridge is the ONLY JS
 * spawner of python3 — C5). This module NEVER decides "safe": every gated verb
 * routes through `envmgr.py`'s `_gate_install` (stage → real nemesis → gated
 * install). A blocked/error install is a VALID returned result the GUI RENDERS —
 * it is NEVER thrown as a success and NEVER upgraded toward "allow" here.
 *
 * Boundary discipline:
 *   - the sidecar emits snake_case JSON; we camelCase at this boundary.
 *   - read-only verbs (listEnvs / pkgList / cudaInfo / doctorEnv / exportEnv)
 *     never touch the gate.
 *   - fetching verbs (pkgInstall / pkgUpdate / pkgUpgrade / importEnv / cudaTorch)
 *     carry the engine's verdict through unchanged (`gate`, `blocked`, `verdict`,
 *     `needsConfirm`, `forcedDanger`).
 */
import { type SidecarEnvelope, type SidecarOptions, runSidecar } from "./sidecar-runner.js";

export type { GateBadge } from "./security/verdict.js";

// ── client options + result shapes ───────────────────────────────────────────

export interface EnvClientOptions extends SidecarOptions {}

/** The camelCased gate summary the GUI renders (mirrors `_verdict_summary`). */
export interface GateSummary {
  verdict: "allow" | "warn" | "block" | "error";
  score: number;
  reasons: string[];
  signed: boolean;
  recommendation?: string;
  scannedAt?: string;
}

/** The forced-override flag (rides through when a block/error was force-installed). */
export interface ForcedDangerInfo {
  label: string;
  verdict: string;
  riskScore?: number;
  blockingReasons: string[];
}

/**
 * The unified install result (file 04 §8). EVERY outcome is a returned value —
 * `ok:false, blocked:true` is a VALID render target, NOT a thrown error. The gate
 * verdict rides through in `gate`; JS never decides safe.
 */
export interface GatedInstallResult {
  ok: boolean;
  command: string;
  /** the install actually ran (allow, or a forced override). */
  installed?: boolean;
  /** the engine refused (block/error, no force). render the deep-red sheet. */
  blocked?: boolean;
  /** warn verdict, no force — the GUI must collect a typed confirm + re-run. */
  needsConfirm?: boolean;
  /** dry plan returned (no --confirm) — preview before staging/scanning. */
  planned?: boolean;
  plan?: unknown;
  /** the engine's verdict tier, echoed (allow|warn|block|error). */
  verdict?: string;
  /** the camelCased gate summary (the GateBadge-ish projection). */
  gate?: GateSummary;
  /** present when a block/error was force-installed — flagged for audit. */
  forcedDanger?: ForcedDangerInfo;
  request?: unknown;
  message?: string;
  stdoutTail?: string;
  error?: string;
  /** the raw sidecar envelope (escape hatch for fields not modelled above). */
  raw: SidecarEnvelope;
}

/** A plain executed/planned mutation result (no gate — enable/disable/remove/…). */
export interface MutationResult {
  ok: boolean;
  command: string;
  executed?: boolean;
  planned?: boolean;
  plan?: unknown;
  message?: string;
  error?: string;
  raw: SidecarEnvelope;
  [k: string]: unknown;
}

// ── create / clone / import option bags ──────────────────────────────────────

export interface CreateEnvOptions {
  /** new env name or absolute path. */
  name: string;
  kind?: "venv" | "conda";
  /** python version hint, e.g. "3.11". */
  python?: string;
  confirm?: boolean;
}

export interface CloneEnvOptions {
  from: string;
  /** dest path (or name) for the clone. */
  to: string;
  confirm?: boolean;
  force?: boolean;
}

export interface ImportEnvOptions {
  /** requirements.txt | environment.yml. */
  file: string;
  name: string;
  python?: string;
  confirm?: boolean;
  force?: boolean;
}

export interface PkgInstallOptions {
  envId: string;
  /** one or more pip specs. */
  spec: string | string[];
  scope?: EnvScope | "venv" | "conda" | "global";
  confirm?: boolean;
  force?: boolean;
}

export interface CudaTorchOptions {
  envId: string;
  index?: string;
  confirm?: boolean;
  force?: boolean;
}

export interface CudaInstallOptions {
  toolkit?: string;
  confirm?: boolean;
  force?: boolean;
}

// ── snake→camel mappers (the boundary) ───────────────────────────────────────

/** djb2-xor hash → short, filename-safe, base36 digest of an absolute path. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  // >>> 0 → unsigned; base36 keeps it short.
  return (h >>> 0).toString(36);
}

/** Stable, dependency-free id from an absolute path — mirrors `env_<hash>`. */
function envId(path: string): string {
  return path ? `env_${djb2(path)}` : "";
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "venv",
  "virtualenv",
  "conda",
  "pyenv",
  "system",
  "engine",
]);

function asKind(raw: unknown): EnvKind {
  const k = String(raw ?? "").toLowerCase();
  return (KNOWN_KINDS.has(k) ? k : "venv") as EnvKind;
}

function scopeFor(kind: EnvKind): EnvScope {
  if (kind === "engine") return "engine";
  // conda/system live host-wide; venvs default to global until a workspace binds
  // them (the store re-tags project-scoped venvs). A safe, non-deciding default.
  return "global";
}

function managedByFor(kind: EnvKind): EnvManagedBy {
  if (kind === "engine") return "engine";
  if (kind === "system") return "external";
  return "studio";
}

function pythonPathFor(row: Record<string, unknown>): string {
  // the sidecar's env.list rows don't carry an explicit interpreter path; derive
  // the conventional bin/Scripts python under the env root. env.use returns the
  // exact `python` when a single env is resolved (used by useEnv()).
  const explicit = row.python ?? row.pythonPath;
  if (typeof explicit === "string" && explicit) return explicit;
  const path = String(row.path ?? "");
  if (!path) return "";
  const binDir = process.platform === "win32" ? "Scripts" : "bin";
  const exe = process.platform === "win32" ? "python.exe" : "python3";
  return `${path}/${binDir}/${exe}`;
}

/**
 * Map ONE sidecar env row → the typed Env. `active` is derived deterministically
 * (the store overrides it once a user `useEnv()`s one); we never invent safety.
 */
function toEnv(row: Record<string, unknown>, active: boolean): Env {
  const path = String(row.path ?? "");
  const kind = asKind(row.kind);
  const count = row.packages_count;
  return {
    id: envId(path),
    name: String(row.name ?? path),
    kind,
    scope: scopeFor(kind),
    path,
    pythonPath: pythonPathFor(row),
    pythonVersion: typeof row.python_version === "string" ? row.python_version : "",
    active,
    managedBy: managedByFor(kind),
    // UNMEASURED stays unmeasured. The sidecar reports `packages_count: None` for anything
    // it cannot count cheaply (conda, system pythons — envmgr.py), and coercing that to 0
    // printed "0 packages" beside a populated conda env. Every consumer already handles the
    // absent case; this one line was defeating all of them.
    ...(typeof count === "number" && count >= 0 ? { packageCount: count } : {}),
    health: (typeof row.health === "string" ? row.health : "unknown") as EnvHealth,
  };
}

const KNOWN_SOURCES: ReadonlySet<string> = new Set([
  "pypi",
  "conda",
  "conda-forge",
  "git",
  "local-wheel",
  "editable",
  "cuda",
]);

function toPackage(row: Record<string, unknown>, envIdValue: string): Package {
  const rawSource = String(row.source ?? "").toLowerCase();
  const source: PkgSource = (KNOWN_SOURCES.has(rawSource) ? rawSource : "pypi") as PkgSource;
  const installed = row.version ?? row.installed;
  return {
    name: String(row.name ?? "").toLowerCase(),
    installed: typeof installed === "string" ? installed : undefined,
    latest: typeof row.latest === "string" ? row.latest : undefined,
    source,
    envId: envIdValue,
    state: installed ? "installed" : "absent",
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** camelCase the sidecar's `gate` summary ({verdict,score,reasons,signed,…}). */
function toGate(raw: unknown): GateSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as Record<string, unknown>;
  return {
    verdict: (String(g.verdict ?? "error") as GateSummary["verdict"]) || "error",
    score: typeof g.score === "number" ? g.score : 100,
    reasons: Array.isArray(g.reasons) ? g.reasons.map(String) : [],
    signed: Boolean(g.signed),
    recommendation: typeof g.recommendation === "string" ? g.recommendation : undefined,
    scannedAt: typeof g.scanned_at === "string" ? g.scanned_at : undefined,
  };
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

/**
 * Normalise ANY gated-install envelope (allow/warn/block/error/planned) into the
 * typed `GatedInstallResult`. FAIL-CLOSED: a missing/unknown verdict stays as-is; we
 * never coerce toward success. `ok:false, blocked:true` is a returned value.
 */
function toInstallResult(env: SidecarEnvelope): GatedInstallResult {
  return {
    ok: env.ok !== false,
    command: env.command,
    installed: typeof env.installed === "boolean" ? env.installed : undefined,
    blocked: typeof env.blocked === "boolean" ? env.blocked : undefined,
    needsConfirm: typeof env.needs_confirm === "boolean" ? env.needs_confirm : undefined,
    planned: typeof env.planned === "boolean" ? env.planned : undefined,
    plan: env.plan,
    verdict: typeof env.verdict === "string" ? env.verdict : undefined,
    gate: toGate(env.gate),
    forcedDanger: toForcedDanger(env.forced_danger),
    request: env.request,
    message: typeof env.message === "string" ? env.message : undefined,
    stdoutTail: typeof env.stdout_tail === "string" ? env.stdout_tail : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

function toMutationResult(env: SidecarEnvelope): MutationResult {
  return {
    ...env,
    ok: env.ok !== false,
    command: env.command,
    executed: typeof env.executed === "boolean" ? env.executed : undefined,
    planned: typeof env.planned === "boolean" ? env.planned : undefined,
    plan: env.plan,
    message: typeof env.message === "string" ? env.message : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

// ── the client ───────────────────────────────────────────────────────────────

/** Build the `--confirm`/`--force` flag tail shared by mutating verbs. */
function confirmFlags(opts: { confirm?: boolean; force?: boolean }): string[] {
  const out: string[] = [];
  if (opts.confirm) out.push("--confirm");
  if (opts.force) out.push("--force");
  return out;
}

function specList(spec: string | string[]): string[] {
  return Array.isArray(spec) ? spec : [spec];
}

/**
 * A typed env client bound to a set of sidecar options. Stateless beyond the
 * options it closes over; each method is one sidecar round-trip.
 */
export class EnvClient {
  // NOTE: a plain field (not a TS "parameter property") so the client runs under
  // Node's strip-only type-stripping (dev-register) AND tsc — both must pass.
  private readonly opts: EnvClientOptions;

  constructor(opts: EnvClientOptions = {}) {
    this.opts = opts;
  }

  private run<T extends SidecarEnvelope = SidecarEnvelope>(argv: string[]): Promise<T> {
    return runSidecar<T>("envmgr.py", argv, this.opts);
  }

  // — read-only enumeration (M1; never gates) —

  /**
   * List every detected env (venv + conda + system), camelCased. Exactly ONE env
   * is marked `active`: the resolved env whose path matches the active token (when
   * provided), else the system env (always present), else the first row. The store
   * overrides this once a user `useEnv()`s one.
   */
  async listEnvs(activePath?: string): Promise<Env[]> {
    const env = await this.run(["env.list"]);
    const rows = Array.isArray(env.environments)
      ? (env.environments as Record<string, unknown>[])
      : [];
    if (rows.length === 0) return [];
    const wantPath = activePath ? String(activePath) : "";
    // choose the active index deterministically (fail-safe: always one active).
    let activeIdx = wantPath ? rows.findIndex((r) => String(r.path ?? "") === wantPath) : -1;
    if (activeIdx < 0) activeIdx = rows.findIndex((r) => String(r.kind ?? "") === "system");
    if (activeIdx < 0) activeIdx = 0;
    return rows.map((r, i) => toEnv(r, i === activeIdx));
  }

  /** Resolve one env's activation info (the exact interpreter + env vars). */
  async useEnv(envId: string): Promise<MutationResult & { python?: string }> {
    const env = await this.run(["env.use", envId]);
    return {
      ...toMutationResult(env),
      python: typeof env.python === "string" ? env.python : undefined,
    };
  }

  async doctorEnv(
    envId: string,
  ): Promise<MutationResult & { health?: string; checks?: Record<string, unknown> }> {
    const env = await this.run(["env.doctor", envId]);
    return {
      ...toMutationResult(env),
      health: typeof env.health === "string" ? env.health : undefined,
      checks: asRecord(env.checks),
    };
  }

  async exportEnv(
    envId: string,
    to?: string,
  ): Promise<MutationResult & { requirements?: string[]; format?: string }> {
    const argv = ["env.export", envId];
    if (to) argv.push("--to", to);
    const env = await this.run(argv);
    return {
      ...toMutationResult(env),
      requirements: Array.isArray(env.requirements) ? env.requirements.map(String) : undefined,
      format: typeof env.format === "string" ? env.format : undefined,
    };
  }

  // — venv CRUD (M2; mutations guarded by confirm; clone/import are GATED) —

  createEnv(opts: CreateEnvOptions): Promise<MutationResult> {
    const argv = ["env.create", opts.name];
    if (opts.kind === "conda") argv.push("--conda");
    if (opts.python) argv.push("--python", opts.python);
    if (opts.confirm) argv.push("--confirm");
    return this.run(argv).then(toMutationResult);
  }

  cloneEnv(opts: CloneEnvOptions): Promise<GatedInstallResult> {
    // clone freezes the source then GATED-reinstalls the frozen set → GatedInstallResult.
    const argv = ["env.clone", opts.from, opts.to, ...confirmFlags(opts)];
    return this.run(argv).then(toInstallResult);
  }

  deleteEnv(envId: string, opts: { confirm?: boolean } = {}): Promise<MutationResult> {
    const argv = ["env.delete", envId];
    if (opts.confirm) argv.push("--confirm");
    return this.run(argv).then(toMutationResult);
  }

  importEnv(opts: ImportEnvOptions): Promise<GatedInstallResult> {
    const argv = ["env.import", "--file", opts.file, "--name", opts.name];
    if (opts.python) argv.push("--python", opts.python);
    argv.push(...confirmFlags(opts));
    return this.run(argv).then(toInstallResult);
  }

  // — package read (M1) —

  async pkgList(envRef: string): Promise<Package[]> {
    const env = await this.run(["pkg.list", envRef]);
    const rows = Array.isArray(env.packages) ? (env.packages as Record<string, unknown>[]) : [];
    // id from the env's resolved absolute path (the envelope echoes it); falls
    // back to a hash of the caller's ref so the rows always carry a stable envId.
    const id = typeof env.path === "string" && env.path ? envId(env.path) : envId(envRef);
    return rows.map((r) => toPackage(r, id));
  }

  // — gated fetching verbs (M3/M4; gate rides through — JS never decides) —

  pkgInstall(opts: PkgInstallOptions): Promise<GatedInstallResult> {
    const argv = ["pkg.install", opts.envId, ...specList(opts.spec), ...confirmFlags(opts)];
    return this.run(argv).then(toInstallResult);
  }

  pkgUpdate(opts: PkgInstallOptions): Promise<GatedInstallResult> {
    const argv = ["pkg.update", opts.envId, ...specList(opts.spec), ...confirmFlags(opts)];
    return this.run(argv).then(toInstallResult);
  }

  /** bulk upgrade; with no spec, the sidecar resolves `pip list --outdated`. */
  pkgUpgrade(opts: {
    envId: string;
    spec?: string | string[];
    confirm?: boolean;
    force?: boolean;
  }): Promise<GatedInstallResult> {
    const specs = opts.spec ? specList(opts.spec) : [];
    const argv = ["pkg.upgrade", opts.envId, ...specs, ...confirmFlags(opts)];
    return this.run(argv).then(toInstallResult);
  }

  // — non-fetching mutations (M4; no gate) —

  pkgRemove(
    envId: string,
    pkgs: string | string[],
    opts: { confirm?: boolean } = {},
  ): Promise<MutationResult> {
    const argv = ["pkg.remove", envId, ...specList(pkgs)];
    if (opts.confirm) argv.push("--confirm");
    return this.run(argv).then(toMutationResult);
  }

  pkgUninstall(
    envId: string,
    pkgs: string | string[],
    opts: { confirm?: boolean } = {},
  ): Promise<MutationResult> {
    const argv = ["pkg.uninstall", envId, ...specList(pkgs)];
    if (opts.confirm) argv.push("--confirm");
    return this.run(argv).then(toMutationResult);
  }

  pkgEnable(envId: string, pkg: string, opts: { confirm?: boolean } = {}): Promise<MutationResult> {
    const argv = ["pkg.enable", envId, pkg];
    if (opts.confirm) argv.push("--confirm");
    return this.run(argv).then(toMutationResult);
  }

  pkgDisable(
    envId: string,
    pkg: string,
    opts: { confirm?: boolean } = {},
  ): Promise<MutationResult> {
    const argv = ["pkg.disable", envId, pkg];
    if (opts.confirm) argv.push("--confirm");
    return this.run(argv).then(toMutationResult);
  }

  // — CUDA (M1 read / M6 mutate) —

  /** Host GPU/CUDA info, camelCased to GpuInfo. Read-only; never gates. */
  async cudaInfo(): Promise<GpuInfo> {
    const env = await this.run(["cuda.info"]);
    return toGpuInfo(env);
  }

  /** Gated install of the CUDA/CPU torch wheel into an env (the #1 real need). */
  cudaTorch(opts: CudaTorchOptions): Promise<GatedInstallResult> {
    const argv = ["cuda.torch", "--env", opts.envId];
    if (opts.index) argv.push("--index", opts.index);
    argv.push(...confirmFlags(opts));
    return this.run(argv).then(toInstallResult);
  }

  /**
   * CUDA toolkit install (file 04 §5.2). NEVER silent — the sidecar prints the
   * OS-specific plan and gates any downloaded installer. On macOS there is no
   * NVIDIA CUDA, so this surfaces the engine's refusal as a returned result.
   */
  cudaInstall(opts: CudaInstallOptions = {}): Promise<MutationResult> {
    const argv = ["cuda.install"];
    if (opts.toolkit) argv.push("--toolkit", opts.toolkit);
    argv.push(...confirmFlags(opts));
    return this.run(argv).then(toMutationResult);
  }
}

/** Map the flat `cuda.info` envelope → GpuInfo (file 04 §2 EXACT shape). */
export function toGpuInfo(env: SidecarEnvelope): GpuInfo {
  const hasNvidia = Boolean(env.nvidia_smi) || Boolean(env.nvcc);
  const gpuName = typeof env.gpu === "string" ? env.gpu : undefined;
  const cudaVersion = typeof env.cuda_version === "string" ? env.cuda_version : undefined;
  const info: GpuInfo = {
    hasNvidia,
    driverVersion: typeof env.driver === "string" ? env.driver : undefined,
    cudaRuntime: cudaVersion,
    nvccVersion: env.nvcc ? cudaVersion : undefined,
    gpus: gpuName ? [{ name: gpuName, vramTotalMB: 0, vramFreeMB: 0 }] : [],
    toolkitInstalled: Boolean(env.nvcc),
    torchCuda: typeof env.torch_cuda === "boolean" ? env.torch_cuda : undefined,
  };
  if (cudaVersion) {
    const cu = cudaVersion.replace(/\./g, "").slice(0, 3);
    if (/^\d{3}$/.test(cu)) {
      info.recommendedTorchIndex = `https://download.pytorch.org/whl/cu${cu}`;
    }
  }
  return info;
}

// ── module-level convenience (mirrors the security module's free functions) ───

const defaultClient = new EnvClient();

export const listEnvs = (activePath?: string): Promise<Env[]> => defaultClient.listEnvs(activePath);
export const createEnv = (opts: CreateEnvOptions): Promise<MutationResult> =>
  defaultClient.createEnv(opts);
export const cloneEnv = (opts: CloneEnvOptions): Promise<GatedInstallResult> =>
  defaultClient.cloneEnv(opts);
export const deleteEnv = (envId: string, opts?: { confirm?: boolean }): Promise<MutationResult> =>
  defaultClient.deleteEnv(envId, opts);
export const useEnv = (envId: string) => defaultClient.useEnv(envId);
export const exportEnv = (envId: string, to?: string) => defaultClient.exportEnv(envId, to);
export const importEnv = (opts: ImportEnvOptions): Promise<GatedInstallResult> =>
  defaultClient.importEnv(opts);
export const doctorEnv = (envId: string) => defaultClient.doctorEnv(envId);
export const pkgList = (envId: string): Promise<Package[]> => defaultClient.pkgList(envId);
export const pkgInstall = (opts: PkgInstallOptions): Promise<GatedInstallResult> =>
  defaultClient.pkgInstall(opts);
export const pkgUpdate = (opts: PkgInstallOptions): Promise<GatedInstallResult> =>
  defaultClient.pkgUpdate(opts);
export const pkgUpgrade = (opts: {
  envId: string;
  spec?: string | string[];
  confirm?: boolean;
  force?: boolean;
}): Promise<GatedInstallResult> => defaultClient.pkgUpgrade(opts);
export const pkgRemove = (
  envId: string,
  pkgs: string | string[],
  opts?: { confirm?: boolean },
): Promise<MutationResult> => defaultClient.pkgRemove(envId, pkgs, opts);
export const pkgUninstall = (
  envId: string,
  pkgs: string | string[],
  opts?: { confirm?: boolean },
): Promise<MutationResult> => defaultClient.pkgUninstall(envId, pkgs, opts);
export const pkgEnable = (
  envId: string,
  pkg: string,
  opts?: { confirm?: boolean },
): Promise<MutationResult> => defaultClient.pkgEnable(envId, pkg, opts);
export const pkgDisable = (
  envId: string,
  pkg: string,
  opts?: { confirm?: boolean },
): Promise<MutationResult> => defaultClient.pkgDisable(envId, pkg, opts);
export const cudaInfo = (): Promise<GpuInfo> => defaultClient.cudaInfo();
export const cudaTorch = (opts: CudaTorchOptions): Promise<GatedInstallResult> =>
  defaultClient.cudaTorch(opts);
export const cudaInstall = (opts?: CudaInstallOptions): Promise<MutationResult> =>
  defaultClient.cudaInstall(opts);

/** Construct an env client bound to specific sidecar options. */
export const createEnvClient = (opts?: EnvClientOptions): EnvClient => new EnvClient(opts);
