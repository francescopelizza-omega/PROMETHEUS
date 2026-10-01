// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import type { NemesisVerdictRef, VerdictTier } from "./security/verdict.js";
import { normalizeVerdict } from "./security/verdict.js";
/**
 * repo.ts — the GitHub Repo Manager client (file 06 §3, FEATURE #5a / 00-INDEX C6).
 *
 * A thin camelCasing marshaller over `runSidecar("repo.py", argv)` (engine-bridge is the
 * ONLY JS spawner of python3 — C5). The arbitrary-URL clone capability is realized as the
 * NEW `python/sidecar/repo.py` sidecar (consistent with envmgr.py/modelhub.py — NOT an
 * edit to the frozen prometheus.py), hard-wired through `_GIT_SAFE_FLAGS` + the REAL
 * nemesis gate. This is the ONLY arbitrary-URL clone path in Studio; catalogued repos
 * still go through the engine `apps install` (lifecycle.ts).
 *
 * THE GOLDEN RULE (C5): JS NEVER decides "safe". The clone is STAGED with the safe flags
 * (so no hook/ext::/fsmonitor code runs pre-scan), then the REAL nemesis scans the staged
 * tree inside the sidecar. The verdict rides through as a RETURNED `RepoResult`:
 *   - allow            → promoted:true, status:"cloned", + a NemesisVerdictRef bound to commit
 *   - warn  (no force) → needsConfirm:true, status:"warn" (kept staged; GUI confirms + re-runs)
 *   - block/error      → blocked:true, status:"blocked", quarantined (NOT promoted)
 *   - force            → promoted over block/error/warn, flagged `forcedDanger`
 * A BLOCK is a renderable value, NOT a thrown error, and NEVER upgraded toward "allow".
 *
 * The bridge REFUSES to pass `force` unless the caller explicitly sets `force:true` (the
 * deep-red typed-confirm is captured upstream by file 03's flow).
 *
 * ENV LIMIT (file 06 HONEST ENV LIMITS): a REAL `git clone` of a remote URL needs network.
 * The clone path is correct; the GATE DECISION is exercised deterministically via the
 * sidecar's `--staged` planted-dir path (tested in test_repo.py + repo.test.ts).
 */
import { type SidecarEnvelope, type SidecarOptions, runSidecar } from "./sidecar-runner.js";

export type { NemesisVerdictRef } from "./security/verdict.js";

export interface RepoClientOptions extends SidecarOptions {}

// ── gate summary (the camelCased verdict the GUI renders; mirrors verdict_summary) ──

export interface RepoGateSummary {
  verdict: VerdictTier;
  score: number;
  reasons: string[];
  signed: boolean;
  recommendation?: string;
  scannedAt?: string;
}

function toGate(raw: unknown): RepoGateSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as Record<string, unknown>;
  return {
    verdict: normalizeVerdict(g.verdict),
    score: typeof g.score === "number" ? g.score : 100,
    reasons: Array.isArray(g.reasons) ? g.reasons.map(String) : [],
    signed: Boolean(g.signed),
    recommendation: typeof g.recommendation === "string" ? g.recommendation : undefined,
    scannedAt: typeof g.scanned_at === "string" ? g.scanned_at : undefined,
  };
}

/** Project repo.py's `verdict_ref` → the C3 NemesisVerdictRef (+ the bound commit). */
export interface RepoVerdictRef extends NemesisVerdictRef {
  /** the commit SHA the verdict was bound to (Repo.lastVerdict's commit). */
  commit?: string;
}

function toVerdictRef(raw: unknown): RepoVerdictRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    verdict: normalizeVerdict(r.verdict),
    score: typeof r.score === "number" ? r.score : 100,
    signedAt: typeof r.signedAt === "string" ? r.signedAt : "",
    findingsRef: typeof r.findingsRef === "string" ? r.findingsRef : undefined,
    commit: typeof r.commit === "string" ? r.commit : undefined,
  };
}

/** The forced-override flag (rides through when a block/error/warn was force-promoted). */
export interface RepoForcedDanger {
  label: string;
  verdict: string;
  riskScore?: number;
  blockingReasons: string[];
}

function toForcedDanger(raw: unknown): RepoForcedDanger | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Record<string, unknown>;
  return {
    label: String(f.label ?? ""),
    verdict: String(f.verdict ?? ""),
    riskScore: typeof f.risk_score === "number" ? f.risk_score : undefined,
    blockingReasons: Array.isArray(f.blocking_reasons) ? f.blocking_reasons.map(String) : [],
  };
}

// ── the typed Repo (mirrors file 06 §2 `Repo`, camelCased from the index entry) ──

export type RepoStatus = "cloned" | "stale" | "blocked" | "dirty" | "missing" | "warn";

export interface Repo {
  id: string;
  url: string;
  owner: string;
  name: string;
  localPath: string;
  branch: string;
  pinnedCommit?: string;
  commit?: string;
  lastFetched?: string;
  lastVerdict?: RepoVerdictRef;
  status: RepoStatus;
  linkedCatalogItemId?: string;
}

function toRepo(raw: Record<string, unknown>): Repo {
  return {
    id: String(raw.id ?? ""),
    url: String(raw.url ?? ""),
    owner: String(raw.owner ?? ""),
    name: String(raw.name ?? ""),
    localPath: String(raw.localPath ?? raw.local_path ?? ""),
    branch: String(raw.branch ?? "main"),
    pinnedCommit:
      typeof raw.pinnedCommit === "string"
        ? raw.pinnedCommit
        : typeof raw.pinned_commit === "string"
          ? raw.pinned_commit
          : undefined,
    commit: typeof raw.commit === "string" ? raw.commit : undefined,
    lastFetched:
      typeof raw.lastFetched === "string"
        ? raw.lastFetched
        : typeof raw.last_fetched === "string"
          ? raw.last_fetched
          : undefined,
    lastVerdict: toVerdictRef(raw.lastVerdict ?? raw.last_verdict),
    status: (String(raw.status ?? "cloned") as RepoStatus) || "cloned",
    linkedCatalogItemId:
      typeof raw.linkedCatalogItemId === "string"
        ? raw.linkedCatalogItemId
        : typeof raw.linked_catalog_item_id === "string"
          ? raw.linked_catalog_item_id
          : undefined,
  };
}

// ── the unified clone/update result (file 06 §3.1) ────────────────────────────

/**
 * EVERY outcome is a RETURNED value:
 *   - `promoted:true`            → the staged clone was moved to the live repo dir.
 *   - `blocked:true, ok:false`   → nemesis BLOCK/error; QUARANTINED, NOT promoted.
 *   - `needsConfirm:true`        → nemesis WARN, no force — the GUI confirms + re-runs.
 * The gate verdict rides through in `gate` / `verdictRef`; JS never decides safe (C5).
 */
export interface RepoResult {
  ok: boolean;
  command: string;
  id?: string;
  url?: string;
  owner?: string;
  name?: string;
  branch?: string;
  pinnedCommit?: string;
  commit?: string;
  /** the live clone path once promoted. */
  localPath?: string;
  promoted?: boolean;
  blocked?: boolean;
  needsConfirm?: boolean;
  status?: RepoStatus;
  verdict?: VerdictTier;
  gate?: RepoGateSummary;
  /** the signed verdict ref bound to the cloned commit (Repo.lastVerdict). */
  verdictRef?: RepoVerdictRef;
  /** the kept-for-inspection quarantine dir on a refusal (never auto-deleted). */
  quarantined?: string;
  stageDir?: string;
  forcedDanger?: RepoForcedDanger;
  message?: string;
  error?: string;
  /** the raw sidecar envelope (escape hatch). */
  raw: SidecarEnvelope;
}

function toRepoResult(env: SidecarEnvelope): RepoResult {
  return {
    ok: env.ok !== false,
    command: env.command,
    id: typeof env.id === "string" ? env.id : undefined,
    url: typeof env.url === "string" ? env.url : undefined,
    owner: typeof env.owner === "string" ? env.owner : undefined,
    name: typeof env.name === "string" ? env.name : undefined,
    branch: typeof env.branch === "string" ? env.branch : undefined,
    pinnedCommit:
      typeof env.pinnedCommit === "string"
        ? env.pinnedCommit
        : typeof env.pinned_commit === "string"
          ? env.pinned_commit
          : undefined,
    commit: typeof env.commit === "string" ? env.commit : undefined,
    localPath: typeof env.local_path === "string" ? env.local_path : undefined,
    promoted: typeof env.promoted === "boolean" ? env.promoted : undefined,
    blocked: typeof env.blocked === "boolean" ? env.blocked : undefined,
    needsConfirm: typeof env.needs_confirm === "boolean" ? env.needs_confirm : undefined,
    status: typeof env.status === "string" ? (env.status as RepoStatus) : undefined,
    verdict: env.verdict !== undefined ? normalizeVerdict(env.verdict) : undefined,
    gate: toGate(env.gate),
    verdictRef: toVerdictRef(env.verdict_ref),
    quarantined: typeof env.quarantined === "string" ? env.quarantined : undefined,
    stageDir: typeof env.stage_dir === "string" ? env.stage_dir : undefined,
    forcedDanger: toForcedDanger(env.forced_danger),
    message: typeof env.message === "string" ? env.message : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

// ── a rescan result (re-run the gate over the live tree; no fetch, no promote) ──

export interface RepoRescanResult {
  ok: boolean;
  id?: string;
  verdict?: VerdictTier;
  gate?: RepoGateSummary;
  verdictRef?: RepoVerdictRef;
  gateFresh?: boolean;
  status?: RepoStatus;
  localPath?: string;
  message?: string;
  error?: string;
  raw: SidecarEnvelope;
}

function toRescanResult(env: SidecarEnvelope): RepoRescanResult {
  return {
    ok: env.ok !== false,
    id: typeof env.id === "string" ? env.id : undefined,
    verdict: env.verdict !== undefined ? normalizeVerdict(env.verdict) : undefined,
    gate: toGate(env.gate),
    verdictRef: toVerdictRef(env.verdict_ref),
    gateFresh: typeof env.gate_fresh === "boolean" ? env.gate_fresh : undefined,
    status: typeof env.status === "string" ? (env.status as RepoStatus) : undefined,
    localPath: typeof env.local_path === "string" ? env.local_path : undefined,
    message: typeof env.message === "string" ? env.message : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

export interface RepoRemoveResult {
  ok: boolean;
  id?: string;
  removedDir?: boolean;
  removedEntry?: boolean;
  found?: boolean;
  localPath?: string;
  error?: string;
  raw: SidecarEnvelope;
}

function toRemoveResult(env: SidecarEnvelope): RepoRemoveResult {
  return {
    ok: env.ok !== false,
    id: typeof env.id === "string" ? env.id : undefined,
    removedDir: typeof env.removed_dir === "boolean" ? env.removed_dir : undefined,
    removedEntry: typeof env.removed_entry === "boolean" ? env.removed_entry : undefined,
    found: typeof env.found === "boolean" ? env.found : undefined,
    localPath: typeof env.local_path === "string" ? env.local_path : undefined,
    error: typeof env.error === "string" ? env.error : undefined,
    raw: env,
  };
}

// ── option bags ───────────────────────────────────────────────────────────────

export interface CloneOptions {
  branch?: string;
  /** detached-checkout this SHA on clone (the explicit pin) → `--pin`. */
  pin?: string;
  /** a dir already holding the (fetched/planted) bytes → drives the gate offline. */
  staged?: string;
  /** override a nemesis BLOCK → forced_danger. DEFAULT false (refused unless explicit). */
  force?: boolean;
  /** if this clone backs a catalog git_clone install, the catalog item id. */
  linkedCatalogItemId?: string;
}

export interface UpdateOptions {
  force?: boolean;
}

export interface RescanOptions {
  /** force a full feed re-download + bypass the verdict cache → `--gate-fresh`. */
  gateFresh?: boolean;
}

// ── the client ────────────────────────────────────────────────────────────────

export class RepoClient {
  private readonly opts: RepoClientOptions;

  constructor(opts: RepoClientOptions = {}) {
    this.opts = opts;
  }

  private run<T extends SidecarEnvelope = SidecarEnvelope>(argv: string[]): Promise<T> {
    return runSidecar<T>("repo.py", argv, this.opts);
  }

  /**
   * Clone an arbitrary GitHub URL: STAGE with safe flags → REAL nemesis gate → promote |
   * quarantine (the SECURITY SPINE, file 06 §3.1). `staged` drives the gate over a dir
   * already on disk (the offline/test path). A BLOCK is a RETURNED `RepoResult`
   * (`ok:false, blocked:true`), NEVER a throw — JS does not decide safety (C5).
   */
  async repoClone(url: string, opts: CloneOptions = {}): Promise<RepoResult> {
    const argv = ["clone", "--url", url];
    if (opts.branch) argv.push("--branch", opts.branch);
    if (opts.pin) argv.push("--pin", opts.pin);
    if (opts.staged) argv.push("--staged", opts.staged);
    if (opts.linkedCatalogItemId) argv.push("--linked", opts.linkedCatalogItemId);
    if (opts.force) argv.push("--force"); // emitted ONLY when explicitly true (C5/§8)
    return toRepoResult(await this.run(argv));
  }

  /** Re-stage the new HEAD under safe flags → re-gate → promote on allow (pin-aware). */
  async repoUpdate(id: string, opts: UpdateOptions = {}): Promise<RepoResult> {
    const argv = ["update", "--id", id];
    if (opts.force) argv.push("--force");
    return toRepoResult(await this.run(argv));
  }

  /** Detached `--pin` checkout under safe flags → re-gate the pinned tree. */
  async repoPin(id: string, sha: string, opts: UpdateOptions = {}): Promise<RepoResult> {
    const argv = ["pin", "--id", id, "--sha", sha];
    if (opts.force) argv.push("--force");
    return toRepoResult(await this.run(argv));
  }

  /** Switch branch under safe flags → re-gate (clears the pin). */
  async repoBranch(id: string, branch: string, opts: UpdateOptions = {}): Promise<RepoResult> {
    const argv = ["branch", "--id", id, "--branch", branch];
    if (opts.force) argv.push("--force");
    return toRepoResult(await this.run(argv));
  }

  /** Re-run the REAL nemesis over the live tree (no fetch, no promote); refresh the ref. */
  async repoRescan(id: string, opts: RescanOptions = {}): Promise<RepoRescanResult> {
    const argv = ["rescan", "--id", id];
    if (opts.gateFresh) argv.push("--gate-fresh");
    return toRescanResult(await this.run(argv));
  }

  /** Drop the clone dir + index entry (idempotent-ok on an unknown id). */
  async repoRemove(id: string): Promise<RepoRemoveResult> {
    return toRemoveResult(await this.run(["remove", "--id", id]));
  }

  /** List every Studio-managed repo from the index (on-disk status reconciled). */
  async repoList(): Promise<Repo[]> {
    const env = await this.run(["list"]);
    const rows = Array.isArray(env.repos) ? (env.repos as Record<string, unknown>[]) : [];
    return rows.map(toRepo);
  }
}

// ── module-level convenience (mirrors env.ts / modelhub) ──────────────────────

const defaultClient = new RepoClient();

export const createRepoClient = (opts?: RepoClientOptions): RepoClient => new RepoClient(opts);

export const repoClone = (url: string, opts?: CloneOptions): Promise<RepoResult> =>
  defaultClient.repoClone(url, opts);
export const repoUpdate = (id: string, opts?: UpdateOptions): Promise<RepoResult> =>
  defaultClient.repoUpdate(id, opts);
export const repoPin = (id: string, sha: string, opts?: UpdateOptions): Promise<RepoResult> =>
  defaultClient.repoPin(id, sha, opts);
export const repoBranch = (id: string, branch: string, opts?: UpdateOptions): Promise<RepoResult> =>
  defaultClient.repoBranch(id, branch, opts);
export const repoRescan = (id: string, opts?: RescanOptions): Promise<RepoRescanResult> =>
  defaultClient.repoRescan(id, opts);
export const repoRemove = (id: string): Promise<RepoRemoveResult> => defaultClient.repoRemove(id);
export const repoList = (): Promise<Repo[]> => defaultClient.repoList();
