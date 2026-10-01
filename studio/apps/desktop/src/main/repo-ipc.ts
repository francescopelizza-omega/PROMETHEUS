// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/repo-ipc.ts — the typed `repo:*` ipcMain handlers (file 06 §3, FEATURE #5a).
 *
 * The trusted side of the contextBridge seam for the GitHub Repo Manager. RELAY-ONLY
 * (mirrors model-ipc.ts / catalog-ipc.ts): every handler
 *   1. zod-validates the renderer's arg at the seam (repo-validate.ts),
 *   2. delegates to the engine-bridge REPO client — the ONLY python3 spawner (C5),
 *      which runs the `repo.py` sidecar: the ONLY arbitrary-URL clone path,
 *      hard-wired through `_GIT_SAFE_FLAGS` + the REAL nemesis gate (00-INDEX C6).
 *      The sidecar STAGES with the safe flags (so no hook/ext::/fsmonitor code runs
 *      pre-scan), runs the REAL nemesis on the staged tree, then promotes (allow) |
 *      keeps-staged (warn) | quarantines (block/error). It already fails closed,
 *   3. maps the result down to a renderer-safe plain-data shape from the shared
 *      contract, and NEVER lets a live handle cross back.
 *
 * GOLDEN RULE (C5/the SPINE): JavaScript never decides "safe". A clone returns
 * whatever the sidecar produced — `ok:false, blocked:true` with the gate verdict
 * attached + the quarantine dir when nemesis refused. This file performs NO scoring,
 * NO allowlist, NO heuristic, and never upgrades a verdict toward allow.
 *
 * THE FORCE GATE (§8): the seam REFUSES `--force` unless the renderer ALSO passed
 * the typed-confirm flag (`confirmForce:true`) — repo-validate.ts collapses
 * `force && confirmForce` to the honoured `force`, so a missing confirm silently
 * downgrades to a normal gated clone (a BLOCK stays blocked + quarantined). The
 * MAIN process therefore cannot be tricked into a silent force-promote.
 *
 * ENV LIMIT (file 06 HONEST ENV LIMITS): a REAL `git clone` of a remote URL needs
 * network; the sidecar's `--staged` planted-dir path drives the GATE DECISION
 * deterministically (tested in test_repo.py + repo.test.ts). The clone path is
 * correct; only the network fetch may be unavailable in a sandbox.
 *
 * Node/Electron only at runtime (privileged main process). It imports
 * @prometheus/engine-bridge — which the renderer is forbidden from doing. The
 * pure, testable arg-validation lives in repo-validate.ts (zod-double-tested).
 */

import { ipcMain } from "electron";

import { grantWorkingSetRoot } from "./ide/path-guard.js";

import {
  type RepoRemoveResult as BridgeRemoveResult,
  type RepoResult as BridgeRepoResult,
  type Repo as BridgeRepoRow,
  type RepoRescanResult as BridgeRescanResult,
  type RepoClientOptions,
  createRepoClient,
  describeEngineFailure,
} from "@prometheus/engine-bridge";

import {
  IPC,
  type RepoCloneResult,
  type RepoForcedDanger,
  type RepoGateSummary,
  type RepoListResult,
  type RepoRemoveResult,
  type RepoRescanResult,
  type RepoRow,
  type RepoVerdictRef,
} from "../shared/ipc-contract.js";
import {
  validateRepoBranch,
  validateRepoClone,
  validateRepoPin,
  validateRepoRemove,
  validateRepoRescan,
  validateRepoUpdate,
} from "./repo-validate.js";

/** Coerce an unknown caught value to a short error string. */
// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

/** Map an engine-bridge RepoGateSummary → the renderer-safe shape (already plain). */
function toGate(g: BridgeRepoResult["gate"]): RepoGateSummary | undefined {
  if (!g) return undefined;
  const out: RepoGateSummary = {
    verdict: g.verdict,
    score: g.score,
    reasons: g.reasons,
    signed: g.signed,
  };
  if (g.recommendation !== undefined) out.recommendation = g.recommendation;
  if (g.scannedAt !== undefined) out.scannedAt = g.scannedAt;
  return out;
}

/** Map an engine-bridge RepoVerdictRef → the renderer-safe ref (plain C3 shape). */
function toVerdictRef(r: BridgeRepoResult["verdictRef"]): RepoVerdictRef | undefined {
  if (!r) return undefined;
  const out: RepoVerdictRef = { verdict: r.verdict, score: r.score, signedAt: r.signedAt };
  if (r.findingsRef !== undefined) out.findingsRef = r.findingsRef;
  if (r.commit !== undefined) out.commit = r.commit;
  return out;
}

/** Map an engine-bridge RepoForcedDanger → the renderer-safe shape. */
function toForced(f: BridgeRepoResult["forcedDanger"]): RepoForcedDanger | undefined {
  if (!f) return undefined;
  const out: RepoForcedDanger = {
    label: f.label,
    verdict: f.verdict,
    blockingReasons: f.blockingReasons,
  };
  if (f.riskScore !== undefined) out.riskScore = f.riskScore;
  return out;
}

/** Map an engine-bridge RepoResult → the renderer-safe RepoCloneResult. */
function toClone(r: BridgeRepoResult): RepoCloneResult {
  const out: RepoCloneResult = { ok: r.ok };
  if (r.command !== undefined) out.command = r.command;
  if (r.id !== undefined) out.id = r.id;
  if (r.url !== undefined) out.url = r.url;
  if (r.owner !== undefined) out.owner = r.owner;
  if (r.name !== undefined) out.name = r.name;
  if (r.branch !== undefined) out.branch = r.branch;
  if (r.pinnedCommit !== undefined) out.pinnedCommit = r.pinnedCommit;
  if (r.commit !== undefined) out.commit = r.commit;
  if (r.localPath !== undefined) out.localPath = r.localPath;
  if (r.promoted !== undefined) out.promoted = r.promoted;
  if (r.blocked !== undefined) out.blocked = r.blocked;
  if (r.needsConfirm !== undefined) out.needsConfirm = r.needsConfirm;
  if (r.status !== undefined) out.status = r.status;
  if (r.verdict !== undefined) out.verdict = r.verdict;
  const gate = toGate(r.gate);
  if (gate !== undefined) out.gate = gate;
  const ref = toVerdictRef(r.verdictRef);
  if (ref !== undefined) out.verdictRef = ref;
  if (r.quarantined !== undefined) out.quarantined = r.quarantined;
  if (r.stageDir !== undefined) out.stageDir = r.stageDir;
  const forced = toForced(r.forcedDanger);
  if (forced !== undefined) out.forcedDanger = forced;
  if (r.message !== undefined) out.message = r.message;
  if (r.error !== undefined) out.error = r.error;
  return out;
}

/** Map an engine-bridge Repo row → the renderer-safe RepoRow. */
function toRow(r: BridgeRepoRow): RepoRow {
  const out: RepoRow = {
    id: r.id,
    url: r.url,
    owner: r.owner,
    name: r.name,
    localPath: r.localPath,
    branch: r.branch,
    status: r.status,
  };
  if (r.pinnedCommit !== undefined) out.pinnedCommit = r.pinnedCommit;
  if (r.commit !== undefined) out.commit = r.commit;
  if (r.lastFetched !== undefined) out.lastFetched = r.lastFetched;
  const ref = toVerdictRef(r.lastVerdict);
  if (ref !== undefined) out.lastVerdict = ref;
  if (r.linkedCatalogItemId !== undefined) out.linkedCatalogItemId = r.linkedCatalogItemId;
  return out;
}

/** Map an engine-bridge RepoRescanResult → the renderer-safe shape. */
function toRescan(r: BridgeRescanResult): RepoRescanResult {
  const out: RepoRescanResult = { ok: r.ok };
  if (r.id !== undefined) out.id = r.id;
  if (r.verdict !== undefined) out.verdict = r.verdict;
  const gate = toGate(r.gate);
  if (gate !== undefined) out.gate = gate;
  const ref = toVerdictRef(r.verdictRef);
  if (ref !== undefined) out.verdictRef = ref;
  if (r.gateFresh !== undefined) out.gateFresh = r.gateFresh;
  if (r.status !== undefined) out.status = r.status;
  if (r.localPath !== undefined) out.localPath = r.localPath;
  if (r.message !== undefined) out.message = r.message;
  if (r.error !== undefined) out.error = r.error;
  return out;
}

/** Map an engine-bridge RepoRemoveResult → the renderer-safe shape. */
function toRemove(r: BridgeRemoveResult): RepoRemoveResult {
  const out: RepoRemoveResult = { ok: r.ok };
  if (r.id !== undefined) out.id = r.id;
  if (r.removedDir !== undefined) out.removedDir = r.removedDir;
  if (r.removedEntry !== undefined) out.removedEntry = r.removedEntry;
  if (r.found !== undefined) out.found = r.found;
  if (r.localPath !== undefined) out.localPath = r.localPath;
  if (r.error !== undefined) out.error = r.error;
  return out;
}

/** Construction-time wiring (the repo client options). */
export interface RepoIpcWiring {
  /** optional client options (the sidecar dir / timeouts); else defaults resolve. */
  clientOptions?: RepoClientOptions;
}

export function registerRepoIpcHandlers(wiring: RepoIpcWiring = {}): () => void {
  const client = createRepoClient(wiring.clientOptions);

  // ── clone (STAGE → REAL nemesis → promote | quarantine; force needs confirm) ─
  ipcMain.handle(IPC.repoClone, async (_evt, arg: unknown): Promise<RepoCloneResult> => {
    const v = validateRepoClone(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const a = v.value;
    try {
      const opts: Parameters<typeof client.repoClone>[1] = { force: a.force };
      if (a.branch !== undefined) opts.branch = a.branch;
      if (a.pin !== undefined) opts.pin = a.pin;
      if (a.staged !== undefined) opts.staged = a.staged;
      if (a.linkedCatalogItemId !== undefined) opts.linkedCatalogItemId = a.linkedCatalogItemId;
      const cloned = toClone(await client.repoClone(a.url, opts));
      /**
       * A clone MAIN performed at the user's request earns a working-set grant.
       *
       * `grantWorkingSetRoot` had exactly one call site — the native Open-Folder dialog — so a
       * repo cloned through the built-in Repo Manager appeared in Home ▸ recents with no grant
       * behind it. Opening it then declared a root main refused, and every save in the project
       * on screen was refused with "refusing to write outside the working set".
       *
       * The grant is safe to record HERE and nowhere else in this flow: the path is the one main
       * itself just wrote, not a path the renderer supplied, so the renderer still cannot widen
       * its own scope by asking. A blocked or quarantined clone is NOT granted — `ok` and a real
       * `localPath` are both required.
       */
      if (cloned.ok && !cloned.blocked && cloned.localPath) {
        grantWorkingSetRoot(cloned.localPath);
      }
      return cloned;
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── list (every Studio-managed repo; on-disk status reconciled) ────────────
  ipcMain.handle(IPC.repoList, async (): Promise<RepoListResult> => {
    try {
      const repos = await client.repoList();
      return { ok: true, repos: repos.map(toRow) };
    } catch (e) {
      return { ok: false, repos: [], error: errString(e) };
    }
  });

  // ── update (re-stage the new HEAD → re-gate → promote on allow) ────────────
  ipcMain.handle(IPC.repoUpdate, async (_evt, arg: unknown): Promise<RepoCloneResult> => {
    const v = validateRepoUpdate(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toClone(await client.repoUpdate(v.value.id, { force: v.value.force }));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── pin (detached --pin checkout under safe flags → re-gate) ───────────────
  ipcMain.handle(IPC.repoPin, async (_evt, arg: unknown): Promise<RepoCloneResult> => {
    const v = validateRepoPin(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toClone(await client.repoPin(v.value.id, v.value.sha, { force: v.value.force }));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── branch (switch branch under safe flags → re-gate; clears the pin) ──────
  ipcMain.handle(IPC.repoBranch, async (_evt, arg: unknown): Promise<RepoCloneResult> => {
    const v = validateRepoBranch(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toClone(await client.repoBranch(v.value.id, v.value.branch, { force: v.value.force }));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── rescan (re-run the REAL nemesis over the live tree; no fetch, no promote) ─
  ipcMain.handle(IPC.repoRescan, async (_evt, arg: unknown): Promise<RepoRescanResult> => {
    const v = validateRepoRescan(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toRescan(await client.repoRescan(v.value.id, { gateFresh: v.value.gateFresh }));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── remove (drop the clone dir + index entry; idempotent on unknown id) ────
  ipcMain.handle(IPC.repoRemove, async (_evt, arg: unknown): Promise<RepoRemoveResult> => {
    const v = validateRepoRemove(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toRemove(await client.repoRemove(v.value.id));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── disposer ───────────────────────────────────────────────────────────────
  return () => {
    for (const channel of [
      IPC.repoClone,
      IPC.repoList,
      IPC.repoUpdate,
      IPC.repoPin,
      IPC.repoBranch,
      IPC.repoRescan,
      IPC.repoRemove,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
