/**
 * main/env-ipc.ts — the typed `env:* / pkg:* / cuda:*` ipcMain handlers (file 04 §1,§3).
 *
 * The trusted side of the contextBridge seam for the Package & Environment
 * Manager. It is RELAY-ONLY (mirrors security-ipc.ts): every handler
 *   1. zod-validates the renderer's arg at the seam (env-validate.ts),
 *   2. delegates to the engine-bridge env client — the ONLY python3 spawner (C5),
 *      which routes every FETCHING verb through envmgr.py's gate (stage → REAL
 *      nemesis → gated install) and already fails closed,
 *   3. maps the result down to a renderer-safe plain-data shape from the shared
 *      contract, and NEVER lets a live handle cross back.
 *
 * GOLDEN RULE (C5 / the SPINE): JavaScript never decides "safe". A gated install
 * returns whatever the engine produced — `ok:false, blocked:true` with the gate
 * verdict attached when nemesis refused (missing/timeout/unparseable ⇒ verdict
 * "error" ⇒ fail-closed BLOCK). This file performs NO scoring, NO allowlist, NO
 * heuristic, and never upgrades a verdict toward allow.
 *
 * Node/Electron only at runtime (privileged main process). It imports
 * @prometheus/engine-bridge — which the renderer is forbidden from doing. The
 * pure, testable arg-validation lives in env-validate.ts (zod-double-tested, no
 * electron), exactly as security-ipc.ts splits its logic into security-validate.ts.
 */

import { ipcMain } from "electron";
import { resolveEnvRefWith } from "./env-ref.js";

import {
  type EnvClientOptions,
  type GatedInstallResult,
  type MutationResult,
  createEnvClient,
} from "@prometheus/engine-bridge";

import {
  type CudaInfoResult,
  type EnvGatedResult,
  type EnvListResult,
  type EnvMutationResult,
  IPC,
  IPC_EVENTS,
  type PkgListResult,
  type ProgressFeedEvent,
} from "../shared/ipc-contract.js";
import {
  validateCudaInstall,
  validateCudaTorch,
  validateEnvClone,
  validateEnvCreate,
  validateEnvDelete,
  validateEnvDoctor,
  validateEnvExport,
  validateEnvImport,
  validateEnvUse,
  validatePkgInstall,
  validatePkgList,
  validatePkgRemove,
  validatePkgToggle,
  validatePkgUpgrade,
} from "./env-validate.js";

/** Coerce an unknown caught value to a short error string. */
function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}

/** Extract the renderer's WebContents `sender` WITHOUT importing the electron type. */
function senderOf(
  evt: unknown,
):
  | { send(channel: string, payload: ProgressFeedEvent): void; isDestroyed?(): boolean }
  | undefined {
  if (!evt || typeof evt !== "object") return undefined;
  const sender = (evt as { sender?: unknown }).sender;
  if (sender && typeof (sender as { send?: unknown }).send === "function") {
    return sender as { send(channel: string, payload: ProgressFeedEvent): void };
  }
  return undefined;
}

/** Map a typed engine-bridge GatedInstallResult → the renderer-safe EnvGatedResult. */
function toGated(r: GatedInstallResult): EnvGatedResult {
  const out: EnvGatedResult = { ok: r.ok, command: r.command, data: r.raw };
  if (r.installed !== undefined) out.installed = r.installed;
  if (r.blocked !== undefined) out.blocked = r.blocked;
  if (r.needsConfirm !== undefined) out.needsConfirm = r.needsConfirm;
  if (r.planned !== undefined) out.planned = r.planned;
  if (r.verdict !== undefined) out.verdict = r.verdict;
  if (r.gate !== undefined) out.gate = r.gate;
  if (r.forcedDanger !== undefined)
    out.forcedDanger = r.forcedDanger as unknown as Record<string, unknown>;
  if (r.message !== undefined) out.message = r.message;
  if (r.error !== undefined) out.error = r.error;
  return out;
}

/** Map a typed engine-bridge MutationResult → the renderer-safe EnvMutationResult. */
function toMutation(r: MutationResult): EnvMutationResult {
  const out: EnvMutationResult = { ok: r.ok, command: r.command, data: r.raw };
  if (r.executed !== undefined) out.executed = r.executed;
  if (r.message !== undefined) out.message = r.message;
  if (r.error !== undefined) out.error = r.error;
  return out;
}

/** Construction-time wiring (engine/sidecar options + the shared run registry). */
export interface EnvIpcWiring {
  /** optional client options (timeouts etc.); else defaults resolve (C2). */
  clientOptions?: EnvClientOptions;
  /**
   * the shared runId→AbortController registry the main ipc owns. Present so a long
   * env op carrying a runId is abortable via the existing `cancel(runId)`.
   */
  runs?: Map<string, AbortController>;
}

export function registerEnvIpcHandlers(wiring: EnvIpcWiring = {}): () => void {
  const client = createEnvClient(wiring.clientOptions);
  const runs = wiring.runs;

  /** Forward an env progress line to the initiating window (cosmetic, C5). */
  function emitEnvProgress(
    sender:
      | { send(channel: string, payload: ProgressFeedEvent): void; isDestroyed?(): boolean }
      | undefined,
    runId: string | undefined,
    line: string,
  ): void {
    // A progress feed OUTLIVES its window: an op started, the user closed that window,
    // and every later line threw "Object has been destroyed" out of a fire-and-forget
    // emit — which surfaced as the op appearing to die mid-run.
    if (!sender || sender.isDestroyed?.()) return;
    const event: ProgressFeedEvent = { message: line, phase: "info", raw: line };
    if (runId !== undefined) event.runId = runId;
    sender.send(IPC_EVENTS.envProgress, event);
  }

  /** Register/clean an AbortController under a runId (no-op without a registry). */
  function trackRun(runId: string | undefined): void {
    if (!runId || !runs) return;
    runs.set(runId, new AbortController());
  }
  function untrackRun(runId: string | undefined): void {
    if (runId && runs) runs.delete(runId);
  }

  /**
   * Translate a renderer-facing environment id back into the identifier the SIDECAR understands.
   *
   * `env:list` hands the renderer rows whose `id` is `env_<hash>` — a djb2 of the absolute path,
   * minted by engine-bridge (`env.ts`'s `envIdFromPath`) purely so React has a stable key. The
   * envmgr sidecar has never heard of it: it resolves environments by NAME. Every handler passed
   * that id straight through, so for EVERY environment in the panel:
   *
   *   env:doctor {id:"env_1t4gemz"} → ok:false "environment not found: env_1t4gemz"
   *   env:doctor {id:"skytronix"}   → ok:true
   *   pkg:list  {envId:"env_1t4gemz"} → ok:true, packages: []      ← a SUCCESS with no rows,
   *   pkg:list  {envId:"skytronix"}   → the real package list         so nothing signalled an error
   *
   * Measured against this machine's real environments. The package table rendered empty and
   * Doctor / Export / Use / Delete all failed, on every row.
   *
   * A name (or a path) passed directly still works — the map only ever rewrites ids it minted.
   */
  const envRefById = new Map<string, string>();

  /** Refresh the id→name map from the sidecar's own listing. Never throws. */
  async function refreshEnvRefs(): Promise<void> {
    try {
      for (const e of await client.listEnvs()) {
        const row = e as unknown as { id?: unknown; name?: unknown };
        if (typeof row.id === "string" && typeof row.name === "string" && row.id && row.name) {
          envRefById.set(row.id, row.name);
        }
      }
    } catch {
      /* the caller falls back to the id verbatim, which is what it used to send anyway */
    }
  }

  async function resolveEnvRef(idOrName: string): Promise<string> {
    const direct = resolveEnvRefWith(envRefById, idOrName);
    if (direct !== null) return direct;
    // cold map (a handler called before any env:list this session) — build it once, then retry.
    await refreshEnvRefs();
    return resolveEnvRefWith(envRefById, idOrName) ?? idOrName;
  }

  // ── env:list — read-only enumeration (never gates) ────────────────────────
  ipcMain.handle(IPC.envEnvList, async (): Promise<EnvListResult> => {
    try {
      const envs = await client.listEnvs();
      // keep the id→name map warm for every other handler (see `resolveEnvRef`)
      envRefById.clear();
      for (const e of envs) {
        const row = e as unknown as { id?: unknown; name?: unknown };
        if (typeof row.id === "string" && typeof row.name === "string" && row.id && row.name) {
          envRefById.set(row.id, row.name);
        }
      }
      return { ok: true, envs: envs as unknown as Record<string, unknown>[] };
    } catch (e) {
      return { ok: false, envs: [], error: errString(e) };
    }
  });

  // ── env:create ────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.envEnvCreate, async (_evt, arg: unknown): Promise<EnvMutationResult> => {
    const v = validateEnvCreate(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const opts: Parameters<typeof client.createEnv>[0] = {
        name: v.value.name,
        kind: v.value.kind === "conda" ? "conda" : "venv",
        confirm: v.value.confirm,
      };
      if (v.value.python !== undefined) opts.python = v.value.python;
      return toMutation(await client.createEnv(opts));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── env:clone — freeze → GATED reinstall ──────────────────────────────────
  ipcMain.handle(IPC.envEnvClone, async (_evt, arg: unknown): Promise<EnvGatedResult> => {
    const v = validateEnvClone(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toGated(
        await client.cloneEnv({
          from: v.value.from,
          to: v.value.to,
          confirm: v.value.confirm,
          force: v.value.force,
        }),
      );
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── env:delete ────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.envEnvDelete, async (_evt, arg: unknown): Promise<EnvMutationResult> => {
    const v = validateEnvDelete(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toMutation(
        await client.deleteEnv(await resolveEnvRef(v.value.id), { confirm: v.value.confirm }),
      );
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── env:use ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.envEnvUse, async (_evt, arg: unknown): Promise<EnvMutationResult> => {
    const v = validateEnvUse(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const r = await client.useEnv(await resolveEnvRef(v.value.id));
      return toMutation(r);
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── env:export — read-only ────────────────────────────────────────────────
  ipcMain.handle(IPC.envEnvExport, async (_evt, arg: unknown): Promise<EnvMutationResult> => {
    const v = validateEnvExport(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toMutation(await client.exportEnv(await resolveEnvRef(v.value.id), v.value.to));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── env:import — GATED installs ───────────────────────────────────────────
  ipcMain.handle(IPC.envEnvImport, async (_evt, arg: unknown): Promise<EnvGatedResult> => {
    const v = validateEnvImport(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const opts: Parameters<typeof client.importEnv>[0] = {
        file: v.value.file,
        name: v.value.name,
        confirm: v.value.confirm,
        force: v.value.force,
      };
      if (v.value.python !== undefined) opts.python = v.value.python;
      return toGated(await client.importEnv(opts));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── env:doctor — read-only ────────────────────────────────────────────────
  ipcMain.handle(IPC.envEnvDoctor, async (_evt, arg: unknown): Promise<EnvMutationResult> => {
    const v = validateEnvDoctor(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toMutation(await client.doctorEnv(await resolveEnvRef(v.value.id)));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── pkg:list — read-only ──────────────────────────────────────────────────
  ipcMain.handle(IPC.envPkgList, async (_evt, arg: unknown): Promise<PkgListResult> => {
    const v = validatePkgList(arg);
    if (!v.ok) return { ok: false, packages: [], error: v.error.message };
    try {
      const pkgs = await client.pkgList(await resolveEnvRef(v.value.envId));
      return { ok: true, packages: pkgs as unknown as Record<string, unknown>[] };
    } catch (e) {
      return { ok: false, packages: [], error: errString(e) };
    }
  });

  // ── pkg:install — GATED (the SPINE) ───────────────────────────────────────
  ipcMain.handle(IPC.envPkgInstall, async (evt: unknown, arg: unknown): Promise<EnvGatedResult> => {
    const v = validatePkgInstall(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const a = v.value;
    const sender = senderOf(evt);
    trackRun(a.runId);
    emitEnvProgress(sender, a.runId, `staging ${a.spec.join(" ")} for gate…`);
    try {
      const opts: Parameters<typeof client.pkgInstall>[0] = {
        envId: await resolveEnvRef(a.envId),
        spec: a.spec,
        confirm: a.confirm,
        force: a.force,
      };
      if (a.scope !== undefined) opts.scope = a.scope;
      return toGated(await client.pkgInstall(opts));
    } catch (e) {
      return { ok: false, error: errString(e) };
    } finally {
      untrackRun(a.runId);
    }
  });

  // ── pkg:update — GATED ────────────────────────────────────────────────────
  ipcMain.handle(IPC.envPkgUpdate, async (evt: unknown, arg: unknown): Promise<EnvGatedResult> => {
    const v = validatePkgInstall(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const a = v.value;
    const sender = senderOf(evt);
    trackRun(a.runId);
    emitEnvProgress(sender, a.runId, `staging ${a.spec.join(" ")} for gate…`);
    try {
      const opts: Parameters<typeof client.pkgUpdate>[0] = {
        envId: await resolveEnvRef(a.envId),
        spec: a.spec,
        confirm: a.confirm,
        force: a.force,
      };
      if (a.scope !== undefined) opts.scope = a.scope;
      return toGated(await client.pkgUpdate(opts));
    } catch (e) {
      return { ok: false, error: errString(e) };
    } finally {
      untrackRun(a.runId);
    }
  });

  // ── pkg:upgrade — GATED bulk ──────────────────────────────────────────────
  ipcMain.handle(IPC.envPkgUpgrade, async (evt: unknown, arg: unknown): Promise<EnvGatedResult> => {
    const v = validatePkgUpgrade(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const a = v.value;
    const sender = senderOf(evt);
    trackRun(a.runId);
    emitEnvProgress(sender, a.runId, "resolving outdated set + staging for gate…");
    try {
      const opts: Parameters<typeof client.pkgUpgrade>[0] = {
        envId: await resolveEnvRef(a.envId),
        confirm: a.confirm,
        force: a.force,
      };
      if (a.spec !== undefined) opts.spec = a.spec;
      return toGated(await client.pkgUpgrade(opts));
    } catch (e) {
      return { ok: false, error: errString(e) };
    } finally {
      untrackRun(a.runId);
    }
  });

  // ── pkg:remove — no gate (drops pkg, keeps pin) ───────────────────────────
  ipcMain.handle(IPC.envPkgRemove, async (_evt, arg: unknown): Promise<EnvMutationResult> => {
    const v = validatePkgRemove(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toMutation(
        await client.pkgRemove(await resolveEnvRef(v.value.envId), v.value.pkgs, {
          confirm: v.value.confirm,
        }),
      );
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── pkg:uninstall — no gate (drop + forget) ───────────────────────────────
  ipcMain.handle(IPC.envPkgUninstall, async (_evt, arg: unknown): Promise<EnvMutationResult> => {
    const v = validatePkgRemove(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toMutation(
        await client.pkgUninstall(await resolveEnvRef(v.value.envId), v.value.pkgs, {
          confirm: v.value.confirm,
        }),
      );
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── pkg:enable — re-gates from cache ──────────────────────────────────────
  ipcMain.handle(IPC.envPkgEnable, async (_evt, arg: unknown): Promise<EnvMutationResult> => {
    const v = validatePkgToggle(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toMutation(
        await client.pkgEnable(await resolveEnvRef(v.value.envId), v.value.pkg, {
          confirm: v.value.confirm,
        }),
      );
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── pkg:disable — no gate (reversible sentinel) ───────────────────────────
  ipcMain.handle(IPC.envPkgDisable, async (_evt, arg: unknown): Promise<EnvMutationResult> => {
    const v = validatePkgToggle(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toMutation(
        await client.pkgDisable(await resolveEnvRef(v.value.envId), v.value.pkg, {
          confirm: v.value.confirm,
        }),
      );
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── cuda:info — read-only ─────────────────────────────────────────────────
  ipcMain.handle(IPC.envCudaInfo, async (): Promise<CudaInfoResult> => {
    try {
      const gpu = await client.cudaInfo();
      return { ok: true, gpu: gpu as unknown as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── cuda:torch — GATED ────────────────────────────────────────────────────
  ipcMain.handle(IPC.envCudaTorch, async (evt: unknown, arg: unknown): Promise<EnvGatedResult> => {
    const v = validateCudaTorch(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const a = v.value;
    const sender = senderOf(evt);
    trackRun(a.runId);
    emitEnvProgress(sender, a.runId, "staging the CUDA-matched torch wheel for gate…");
    try {
      const opts: Parameters<typeof client.cudaTorch>[0] = {
        envId: await resolveEnvRef(a.envId),
        confirm: a.confirm,
        force: a.force,
      };
      if (a.index !== undefined) opts.index = a.index;
      return toGated(await client.cudaTorch(opts));
    } catch (e) {
      return { ok: false, error: errString(e) };
    } finally {
      untrackRun(a.runId);
    }
  });

  // ── cuda:install — prints the OS plan + gates any downloaded installer ─────
  ipcMain.handle(IPC.envCudaInstall, async (_evt, arg: unknown): Promise<EnvMutationResult> => {
    const v = validateCudaInstall(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const opts: Parameters<typeof client.cudaInstall>[0] = {
        confirm: v.value.confirm,
        force: v.value.force,
      };
      if (v.value.toolkit !== undefined) opts.toolkit = v.value.toolkit;
      return toMutation(await client.cudaInstall(opts));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── disposer ─────────────────────────────────────────────────────────────
  return () => {
    for (const channel of [
      IPC.envEnvList,
      IPC.envEnvCreate,
      IPC.envEnvClone,
      IPC.envEnvDelete,
      IPC.envEnvUse,
      IPC.envEnvExport,
      IPC.envEnvImport,
      IPC.envEnvDoctor,
      IPC.envPkgList,
      IPC.envPkgInstall,
      IPC.envPkgUpdate,
      IPC.envPkgUpgrade,
      IPC.envPkgRemove,
      IPC.envPkgUninstall,
      IPC.envPkgEnable,
      IPC.envPkgDisable,
      IPC.envCudaInfo,
      IPC.envCudaTorch,
      IPC.envCudaInstall,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
