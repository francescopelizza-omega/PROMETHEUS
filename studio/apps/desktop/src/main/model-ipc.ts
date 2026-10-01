// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/model-ipc.ts — the typed `model:*` ipcMain handlers (file 05 §1,§7,§8).
 *
 * The trusted side of the contextBridge seam for the Model Hub. RELAY-ONLY
 * (mirrors env-ipc.ts / security-ipc.ts): every handler
 *   1. zod-validates the renderer's arg at the seam (model-validate.ts),
 *   2. delegates to the engine-bridge MODELHUB client — the ONLY python3 spawner
 *      (C5), which routes every DOWNLOAD through the sidecar's stage → REAL
 *      nemesis → admit | quarantine gate (it already fails closed),
 *   3. maps the result down to a renderer-safe plain-data shape from the shared
 *      contract, and NEVER lets a live handle cross back.
 *
 * GOLDEN RULE (C5 / the SPINE): JavaScript never decides "safe". A download
 * returns whatever the sidecar produced — `ok:false, blocked:true` with the gate
 * verdict attached when nemesis refused (missing/timeout/unparseable ⇒ verdict
 * "error" ⇒ fail-closed BLOCK + QUARANTINE). This file performs NO scoring, NO
 * allowlist, NO heuristic, and never upgrades a verdict toward allow.
 *
 * C8 (the SERVE seam): `model:serve` does NOT let the sidecar spawn the runner.
 * The sidecar builds the fit-derived ServeProfile (pure); THIS handler hands it to
 * the MAIN-process ServeSupervisor (over the core C8 ServerSupervisor) to actually
 * spawn the child + poll {base_url}/models, flipping the §2.4 status
 * stopped→starting→ready/error. The renderer supplies only ids/options, never a
 * spawnable command. ENV LIMIT: the runner binaries are absent here, so a real
 * spawn never answers /models → `error` (timeout/exit) — EXPECTED; the
 * status-machine is real, never faked-as-ready.
 *
 * Node/Electron only at runtime (privileged main process). It imports
 * @prometheus/engine-bridge — which the renderer is forbidden from doing. The
 * pure, testable arg-validation lives in model-validate.ts (zod-double-tested, no
 * electron), exactly as env-ipc.ts splits its logic into env-validate.ts.
 */

import { ipcMain } from "electron";

import {
  type DownloadResult,
  type EvictionEvent,
  type ModelHubClientOptions,
  type MutationResult,
  type ServeProfile,
  createModelHubClient,
  describeEngineFailure,
} from "@prometheus/engine-bridge";

import {
  IPC,
  IPC_EVENTS,
  type ModelConvertResult,
  type ModelDownloadResult,
  type ModelEndpointsResult,
  type ModelFetchHfResult,
  type ModelFitResult,
  type ModelHardwareResult,
  type ModelInfoResult,
  type ModelInstallConverterResult,
  type ModelInstallHfCliResult,
  type ModelInstallRunnerResult,
  type ModelInstallTargetResult,
  type ModelMutationResult,
  type ModelProgressEvent,
  type ModelPullResult,
  type ModelRepointResult,
  type ModelSearchResult,
  type ModelServeResult,
  type ModelServeRow,
} from "../shared/ipc-contract.js";
import {
  validateModelConvert,
  validateModelDownload,
  validateModelFetchHf,
  validateModelFit,
  validateModelHardware,
  validateModelInfo,
  validateModelInstallConverter,
  validateModelInstallHfCli,
  validateModelInstallRunner,
  validateModelInstallTarget,
  validateModelKill,
  validateModelLibrary,
  validateModelPull,
  validateModelRemove,
  validateModelRepoint,
  validateModelSearch,
  validateModelServe,
  validateModelUnserve,
} from "./model-validate.js";
import type { ServeRecipe, ServeRow, ServeSupervisor } from "./serve-supervisor.js";
import { readTelemetry } from "./telemetry.js";

/** Coerce an unknown caught value to a short error string. */
// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

/**
 * The launch guard: refuse to spawn a HEAVY process (model pull / serve / runner
 * install) when the host CPU% or RAM% is already at/above the ceiling — Prometheus
 * won't eat the whole machine it runs on. Fail-soft: a telemetry read error DOESN'T
 * fabricate headroom (the guard returns allow:false), but it also never throws.
 * Returns the block reason, or null when the launch is allowed.
 */
async function launchBlockReason(): Promise<string | null> {
  try {
    const t = await readTelemetry();
    return t.guard.allow ? null : (t.guard.reason ?? "system under heavy load");
  } catch {
    return "resource telemetry unavailable — launch held (fail-closed)";
  }
}

/**
 * Extract the renderer's WebContents `sender` WITHOUT importing the electron type — wrapped so
 * a send to a CLOSED window is a no-op instead of a throw.
 *
 * Since #52 made download/pull/install progress actually fire, these sends run synchronously
 * inside the sidecar's stderr pump (a stream 'data' listener). Closing the window mid-pull
 * destroyed the WebContents while a multi-GB transfer kept streaming, so every later progress
 * line threw out of that listener as an uncaughtException. Guarding here covers every send
 * site in this file at once — the #47 pattern (`isDestroyed?.()`), plus a catch for the
 * window closing between the check and the send.
 */
function senderOf(
  evt: unknown,
): { send(channel: string, payload: ModelProgressEvent): void } | undefined {
  if (!evt || typeof evt !== "object") return undefined;
  const sender = (evt as { sender?: unknown }).sender;
  if (sender && typeof (sender as { send?: unknown }).send === "function") {
    const wc = sender as {
      send(channel: string, payload: ModelProgressEvent): void;
      isDestroyed?(): boolean;
    };
    return {
      send(channel, payload) {
        if (wc.isDestroyed?.()) return;
        try {
          wc.send(channel, payload);
        } catch {
          /* the window went away between the check and the send */
        }
      },
    };
  }
  return undefined;
}

/** Map a typed engine-bridge DownloadResult → the renderer-safe ModelDownloadResult. */
function toDownload(r: DownloadResult): ModelDownloadResult {
  const out: ModelDownloadResult = { ok: r.ok, command: r.command, data: r.raw };
  if (r.id !== undefined) out.id = r.id;
  if (r.localPath !== undefined) out.localPath = r.localPath;
  if (r.manifest !== undefined) out.manifest = r.manifest;
  if (r.admitted !== undefined) out.admitted = r.admitted;
  if (r.blocked !== undefined) out.blocked = r.blocked;
  if (r.needsConfirm !== undefined) out.needsConfirm = r.needsConfirm;
  if (r.planned !== undefined) out.planned = r.planned;
  if (r.verdict !== undefined) out.verdict = r.verdict;
  if (r.gate !== undefined) out.gate = r.gate;
  if (r.formatRisk !== undefined) out.formatRisk = r.formatRisk;
  if (r.quarantined !== undefined) out.quarantined = r.quarantined;
  if (r.stageDir !== undefined) out.stageDir = r.stageDir;
  if (r.forcedDanger !== undefined)
    out.forcedDanger = r.forcedDanger as unknown as Record<string, unknown>;
  if (r.message !== undefined) out.message = r.message;
  if (r.error !== undefined) out.error = r.error;
  return out;
}

/** Map a typed engine-bridge MutationResult → the renderer-safe ModelMutationResult. */
function toMutation(r: MutationResult): ModelMutationResult {
  const out: ModelMutationResult = { ok: r.ok, command: r.command, data: r.raw };
  if (r.message !== undefined) out.message = r.message;
  if (r.error !== undefined) out.error = r.error;
  return out;
}

/** Map an engine-bridge ServeProfile → the supervisor's ServeRecipe (the C8 input). */
function toRecipe(p: ServeProfile): ServeRecipe {
  return {
    id: p.id,
    modelId: p.modelId,
    quant: p.quant,
    runner: p.runner,
    endpoint: { host: p.endpoint.host, port: p.endpoint.port, baseUrl: p.endpoint.baseUrl },
    apiKey: p.apiKey,
    args: {
      ctxLen: p.args.ctxLen,
      ...(p.args.gpuLayers !== undefined ? { gpuLayers: p.args.gpuLayers } : {}),
      ...(p.args.tensorParallel !== undefined ? { tensorParallel: p.args.tensorParallel } : {}),
      ...(p.args.kvCacheDtype !== undefined ? { kvCacheDtype: p.args.kvCacheDtype } : {}),
      ...(p.args.maxModelLen !== undefined ? { maxModelLen: p.args.maxModelLen } : {}),
      servedModelName: p.args.servedModelName,
    },
    argv: p.argv,
    autostart: p.autostart,
  };
}

/** Map a supervisor ServeRow → the renderer-safe ModelServeRow (plain data). */
function toServeRow(row: ServeRow): ModelServeRow {
  const out: ModelServeRow = {
    id: row.id,
    modelId: row.modelId,
    quant: row.quant,
    runner: row.runner,
    endpoint: { host: row.endpoint.host, port: row.endpoint.port, baseUrl: row.endpoint.baseUrl },
    apiKey: row.apiKey,
    args: {
      ctxLen: row.args.ctxLen,
      servedModelName: row.args.servedModelName,
    },
    status: row.status,
  };
  if (row.args.gpuLayers !== undefined) out.args.gpuLayers = row.args.gpuLayers;
  if (row.args.tensorParallel !== undefined) out.args.tensorParallel = row.args.tensorParallel;
  if (row.args.kvCacheDtype !== undefined) out.args.kvCacheDtype = row.args.kvCacheDtype;
  if (row.args.maxModelLen !== undefined) out.args.maxModelLen = row.args.maxModelLen;
  if (row.pid !== undefined) out.pid = row.pid;
  if (row.lastError !== undefined) out.lastError = row.lastError;
  return out;
}

/** Construction-time wiring (the modelhub client + the C8 serve supervisor). */
export interface ModelIpcWiring {
  /** the MAIN-process serve supervisor that drives the core C8 ServerSupervisor. */
  serveSupervisor: ServeSupervisor;
  /** optional client options (timeouts etc.); else defaults resolve (C2). */
  clientOptions?: ModelHubClientOptions;
  /**
   * push a model-progress / serve-status event to EVERY live renderer window. The
   * MAIN entry injects this (it owns the BrowserWindows); absent, serve-status
   * events are dropped (the renderer still re-reads via `serving()`). Keeping it
   * injected keeps this module electron-window-agnostic + testable.
   */
  broadcast?: (event: ModelProgressEvent) => void;
  /**
   * Raise a SYSTEM-level notice (OS notification, not just an in-app panel row) when
   * ACTIVE EVICTION force-kills a served recipe under critical RAM pressure — a user staring
   * at a chat pane, not the Serving panel, must still learn their model just got stopped to
   * save the machine. The MAIN entry injects the real (Electron `Notification`) implementation;
   * absent, the eviction is still broadcast via `broadcast` (the Serving panel still updates),
   * just without an OS-level notice. Keeps this module Electron-window-agnostic + testable.
   */
  notifyEviction?: (event: EvictionEvent) => void;
}

export function registerModelIpcHandlers(wiring: ModelIpcWiring): () => void {
  const client = createModelHubClient(wiring.clientOptions);
  const serve = wiring.serveSupervisor;
  const broadcast = wiring.broadcast ?? ((): void => {});
  const notifyEviction = wiring.notifyEviction ?? ((): void => {});

  // Per-model-id mutation queue: download and remove both touch the same on-disk
  // model files, so two ops on the SAME id must run sequentially (a download
  // writing while a remove deletes — or two downloads of one id — corrupts files).
  // Different ids stay fully parallel. The chain self-prunes when it drains.
  const mutationChains = new Map<string, Promise<unknown>>();
  const queueMutation = <T>(id: string, op: () => Promise<T>): Promise<T> => {
    const prev = mutationChains.get(id) ?? Promise.resolve();
    // run after prev regardless of its outcome; `result` is what the caller awaits.
    const result = prev.then(op, op);
    // the chain stored for the NEXT caller swallows errors (one failure must not
    // poison the queue) and self-prunes when it is still the tail.
    const tail = result.then(
      () => {},
      () => {},
    );
    mutationChains.set(id, tail);
    void tail.finally(() => {
      if (mutationChains.get(id) === tail) mutationChains.delete(id);
    });
    return result;
  };

  /** Forward a serve-status change to every renderer window (the §2.4 live feed). */
  const onServeStatus = (row: ServeRow): void => {
    const event: ModelProgressEvent = {
      profileId: row.id,
      phase: "serve",
      message: `${row.id}: ${row.status}${row.lastError ? ` — ${row.lastError}` : ""}`,
      status: row.status,
      raw: `${row.id} ${row.status}`,
    };
    broadcast(event);
  };
  serve.on("status", onServeStatus);

  /** ACTIVE EVICTION: the Serving panel's live feed AND a system-level notice — see
   *  `ModelIpcWiring.notifyEviction`'s doc for why both. */
  const onServeEviction = (event: EvictionEvent): void => {
    broadcast({
      profileId: event.runnerId,
      phase: "evicted",
      message: event.reason,
      raw: JSON.stringify(event),
    });
    notifyEviction(event);
  };
  serve.on("evicted", onServeEviction);

  /** A snapshot of every serve row (the §7 Serving panel state). */
  function servingResult(): ModelServeResult {
    return { ok: true, profiles: serve.list().map(toServeRow) };
  }

  // ── model:hardware — REAL host detection (read-only) ──────────────────────
  ipcMain.handle(IPC.modelHardware, async (_evt, arg: unknown): Promise<ModelHardwareResult> => {
    const v = validateModelHardware(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const hw = await client.hardware({ rescan: v.value.rescan });
      return { ok: true, hardware: hw as unknown as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── model:search — catalog + best-effort HF (read-only) ───────────────────
  ipcMain.handle(IPC.modelSearch, async (_evt, arg: unknown): Promise<ModelSearchResult> => {
    const v = validateModelSearch(arg);
    if (!v.ok) return { ok: false, models: [], error: v.error.message };
    try {
      const opts: Parameters<typeof client.search>[0] = { freeOnly: v.value.freeOnly };
      if (v.value.q !== undefined) opts.q = v.value.q;
      if (v.value.modality !== undefined) opts.modality = v.value.modality;
      if (v.value.source !== undefined) opts.source = v.value.source;
      if (v.value.limit !== undefined) opts.limit = v.value.limit;
      const models = await client.search(opts);
      return { ok: true, models: models as unknown as Record<string, unknown>[] };
    } catch (e) {
      return { ok: false, models: [], error: errString(e) };
    }
  });

  // ── model:info — model detail (read-only) ─────────────────────────────────
  ipcMain.handle(IPC.modelInfo, async (_evt, arg: unknown): Promise<ModelInfoResult> => {
    const v = validateModelInfo(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const model = await client.info(v.value.id);
      return model
        ? { ok: true, model: model as unknown as Record<string, unknown> }
        : { ok: false, error: `model not found: ${v.value.id}` };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── model:fit — the Cookbook fit-score (read-only) ────────────────────────
  ipcMain.handle(IPC.modelFit, async (_evt, arg: unknown): Promise<ModelFitResult> => {
    const v = validateModelFit(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const opts: Parameters<typeof client.fit>[1] = {};
      if (v.value.params !== undefined) opts.params = v.value.params;
      if (v.value.family !== undefined) opts.family = v.value.family;
      if (v.value.ctx !== undefined) opts.ctx = v.value.ctx;
      const fit = await client.fit(v.value.id, opts);
      return { ok: true, fit: fit as unknown as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── model:download — GATED (stage → REAL nemesis → admit | quarantine) ─────
  ipcMain.handle(
    IPC.modelDownload,
    async (evt: unknown, arg: unknown): Promise<ModelDownloadResult> => {
      const v = validateModelDownload(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a = v.value;
      const sender = senderOf(evt);
      if (sender) {
        const event: ModelProgressEvent = {
          phase: "download",
          // NOT "for the nemesis gate": whether a gate runs depends on the path the
          // sidecar takes. The HF/GGUF spine stages bytes locally and calls
          // `nemesis_gate.admit`; the ollama runner hands the tag to `ollama pull`, which
          // has no local stage dir and never reaches nemesis (see modelhub.py::v_pull).
          // This message is emitted before that branch is chosen, so it may not promise one.
          message: `staging ${a.id}${a.quant ? `:${a.quant}` : ""}…`,
          raw: `staging ${a.id}`,
        };
        if (a.runId !== undefined) event.runId = a.runId;
        sender.send(IPC_EVENTS.modelProgress, event);
      }
      try {
        const opts: Parameters<typeof client.download>[0] = { id: a.id, force: a.force };
        if (a.quant !== undefined) opts.quant = a.quant;
        if (a.source !== undefined) opts.source = a.source;
        if (a.license !== undefined) opts.license = a.license;
        if (a.staged !== undefined) opts.staged = a.staged;
        // forward the sidecar's JSON-lines staging progress to the renderer (cosmetic).
        opts.onProgress = (p): void => {
          if (!sender) return;
          const event: ModelProgressEvent = {
            phase: "download",
            message: p.message ?? p.raw,
            raw: p.raw,
          };
          if (a.runId !== undefined) event.runId = a.runId;
          if (typeof p.pct === "number") event.pct = p.pct;
          sender.send(IPC_EVENTS.modelProgress, event);
        };
        // serialize against any concurrent download/remove of the SAME model id.
        return toDownload(await queueMutation(a.id, () => client.download(opts)));
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── model:pull — REAL local install via ollama (fetch + serve the weights) ─
  ipcMain.handle(IPC.modelPull, async (evt: unknown, arg: unknown): Promise<ModelPullResult> => {
    const v = validateModelPull(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const a = v.value;
    const sender = senderOf(evt);
    // Don't launch a multi-GB fetch when the machine is already saturated (§ guard).
    const blocked = await launchBlockReason();
    if (blocked) return { ok: false, blockedByResources: true, error: blocked };
    try {
      const opts: Parameters<typeof client.pull>[0] = { id: a.id };
      if (a.tag !== undefined) opts.tag = a.tag;
      // forward the ollama pull progress (JSON-lines on stderr) to the Download Queue.
      opts.onProgress = (p): void => {
        if (!sender) return;
        const event: ModelProgressEvent = {
          phase: "download",
          message: p.message ?? p.raw,
          raw: p.raw,
        };
        if (a.runId !== undefined) event.runId = a.runId;
        if (typeof p.pct === "number") event.pct = p.pct;
        sender.send(IPC_EVENTS.modelProgress, event);
      };
      const r = await queueMutation(a.id, () => client.pull(opts));
      const out: ModelPullResult = { ok: r.ok, command: r.command, id: r.id, runner: r.runner };
      if (r.tag !== undefined) out.tag = r.tag;
      if (r.installed) out.installed = true;
      if (r.endpoint !== undefined) out.endpoint = r.endpoint;
      if (r.installable) out.installable = true;
      if (r.install !== undefined) out.install = r.install;
      if (r.error !== undefined) out.error = r.error;
      // The HOW, not just the NO. `toPullResult` spreads the sidecar envelope, so a RAM-fit
      // refusal arrives carrying `hint` ("pick a smaller model … or re-run with --force") and
      // per-quant `reasons[]`. Rebuilding the DTO field-by-field dropped both, leaving a
      // refusal the user could not act on — and the desktop exposes no force, so there was no
      // other route either. The terminal prints both; so does this now.
      const envelope = r as unknown as Record<string, unknown>;
      if (typeof envelope.hint === "string") out.hint = envelope.hint;
      if (Array.isArray(envelope.reasons)) {
        out.reasons = envelope.reasons.filter((x): x is string => typeof x === "string");
      }
      return out;
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── model:installRunner — auto-install ollama ON THE USER'S BEHALF (OS-aware) ─
  // Replaces the copy-paste command: the sidecar detects macOS vs Linux and runs
  // `brew install ollama` / `curl … install.sh | sh` itself, streaming the output.
  ipcMain.handle(
    IPC.modelInstallRunner,
    async (evt: unknown, arg: unknown): Promise<ModelInstallRunnerResult> => {
      const v = validateModelInstallRunner(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a = v.value;
      const sender = senderOf(evt);
      const blocked = await launchBlockReason();
      if (blocked) return { ok: false, blockedByResources: true, error: blocked };
      try {
        const opts: Parameters<typeof client.installRunner>[0] = { runner: a.runner };
        opts.onProgress = (p): void => {
          if (!sender) return;
          const event: ModelProgressEvent = {
            phase: "download",
            message: p.message ?? p.raw,
            raw: p.raw,
          };
          if (a.runId !== undefined) event.runId = a.runId;
          sender.send(IPC_EVENTS.modelProgress, event);
        };
        // serialize under a fixed key so two runner-installs can't race each other.
        const r = await queueMutation("__runner__", () => client.installRunner(opts));
        const out: ModelInstallRunnerResult = {
          ok: r.ok,
          runner: r.runner,
          installed: r.installed,
        };
        if (r.os !== undefined) out.os = r.os;
        if (r.command !== undefined) out.command = r.command;
        if (r.manual) out.manual = true;
        if (r.install !== undefined) out.install = r.install;
        if (r.url !== undefined) out.url = r.url;
        if (r.error !== undefined) out.error = r.error;
        return out;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── model:library — installed models (read-only) ──────────────────────────
  ipcMain.handle(IPC.modelLibrary, async (_evt, arg: unknown): Promise<ModelSearchResult> => {
    const v = validateModelLibrary(arg);
    if (!v.ok) return { ok: false, models: [], error: v.error.message };
    try {
      const models = await client.library(v.value.modality);
      return { ok: true, models: models as unknown as Record<string, unknown>[] };
    } catch (e) {
      return { ok: false, models: [], error: errString(e) };
    }
  });

  // ── model:remove — delete files (refuses if a ServeProfile references it) ──
  ipcMain.handle(IPC.modelRemove, async (_evt, arg: unknown): Promise<ModelMutationResult> => {
    const v = validateModelRemove(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const opts: { quant?: string; force?: boolean } = { force: v.value.force };
      if (v.value.quant !== undefined) opts.quant = v.value.quant;
      // serialize against any concurrent download/remove of the SAME model id.
      return toMutation(await queueMutation(v.value.id, () => client.remove(v.value.id, opts)));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── model:serve — build profile (sidecar) → SPAWN + POLL via C8 (this proc) ─
  ipcMain.handle(IPC.modelServe, async (_evt, arg: unknown): Promise<ModelServeResult> => {
    const v = validateModelServe(arg);
    if (!v.ok) return { ok: false, profiles: serve.list().map(toServeRow), error: v.error.message };
    const a = v.value;
    // Serving spins up a live inference process — hold it when the host is saturated.
    const blocked = await launchBlockReason();
    if (blocked) return { ok: false, profiles: serve.list().map(toServeRow), error: blocked };
    try {
      // 1) the sidecar builds the fit-derived ServeProfile (PURE — no spawn).
      const opts: Parameters<typeof client.serve>[0] = { id: a.id, autostart: a.autostart };
      if (a.quant !== undefined) opts.quant = a.quant;
      if (a.runner !== undefined) opts.runner = a.runner;
      if (a.gguf !== undefined) opts.gguf = a.gguf;
      if (a.ctx !== undefined) opts.ctx = a.ctx;
      if (a.port !== undefined) opts.port = a.port;
      const profile = await client.serve(opts);
      // 2) THIS process spawns it + polls /models (C8) — never the sidecar.
      serve.start(toRecipe(profile));
      return servingResult();
    } catch (e) {
      return { ok: false, profiles: serve.list().map(toServeRow), error: errString(e) };
    }
  });

  // ── model:unserve — stop the runner (SIGTERM via the supervisor) ──────────
  ipcMain.handle(IPC.modelUnserve, async (_evt, arg: unknown): Promise<ModelServeResult> => {
    const v = validateModelUnserve(arg);
    if (!v.ok) return { ok: false, profiles: serve.list().map(toServeRow), error: v.error.message };
    try {
      await serve.stop(v.value.profileId);
      return servingResult();
    } catch (e) {
      return { ok: false, profiles: serve.list().map(toServeRow), error: errString(e) };
    }
  });

  // ── model:kill — force-kill the runner (SIGKILL now, no SIGTERM grace wait) ─
  ipcMain.handle(IPC.modelKill, async (_evt, arg: unknown): Promise<ModelServeResult> => {
    const v = validateModelKill(arg);
    if (!v.ok) return { ok: false, profiles: serve.list().map(toServeRow), error: v.error.message };
    try {
      await serve.kill(v.value.profileId);
      return servingResult();
    } catch (e) {
      return { ok: false, profiles: serve.list().map(toServeRow), error: errString(e) };
    }
  });

  // ── model:serving — snapshot of every serve row + live status (§7) ────────
  ipcMain.handle(IPC.modelServing, async (): Promise<ModelServeResult> => {
    try {
      return servingResult();
    } catch (e) {
      return { ok: false, profiles: [], error: errString(e) };
    }
  });

  // ── model:endpoints — LIVE localai endpoints passthrough (read-only) ──────
  ipcMain.handle(IPC.modelEndpoints, async (): Promise<ModelEndpointsResult> => {
    try {
      const r = await client.endpoints();
      return {
        ok: r.ok,
        local: r.local,
        openApi: r.openApi,
        ...(r.engine !== undefined ? { engine: r.engine } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
      };
    } catch (e) {
      return { ok: false, local: [], openApi: [], error: errString(e) };
    }
  });

  // ── model:repoint — LIVE localai show passthrough (§6; non-secret only) ───
  ipcMain.handle(IPC.modelRepoint, async (_evt, arg: unknown): Promise<ModelRepointResult> => {
    const v = validateModelRepoint(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const r = await client.repoint({ tool: v.value.tool, baseUrl: v.value.baseUrl });
      const out: ModelRepointResult = { ok: r.ok };
      if (r.tool !== undefined) out.tool = r.tool;
      if (r.baseUrl !== undefined) out.baseUrl = r.baseUrl;
      if (r.patchable !== undefined) out.patchable = r.patchable;
      if (r.recipe !== undefined) out.recipe = r.recipe;
      if (r.proposedEnv !== undefined) out.proposedEnv = r.proposedEnv;
      if (r.referencedEnvVars !== undefined) out.referencedEnvVars = r.referencedEnvVars;
      if (r.secretPolicy !== undefined) out.secretPolicy = r.secretPolicy;
      if (r.engine !== undefined) out.engine = r.engine;
      if (r.error !== undefined) out.error = r.error;
      return out;
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── model:fetchHf — the ACTUAL raw-weights fetch (HF's own `hf` downloader) ─
  ipcMain.handle(
    IPC.modelFetchHf,
    async (evt: unknown, arg: unknown): Promise<ModelFetchHfResult> => {
      const v = validateModelFetchHf(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a = v.value;
      const sender = senderOf(evt);
      const blocked = await launchBlockReason();
      if (blocked) return { ok: false, error: blocked };
      try {
        const opts: Parameters<typeof client.fetchHf>[0] = { repo: a.repo };
        if (a.out !== undefined) opts.out = a.out;
        if (a.revision !== undefined) opts.revision = a.revision;
        const r = await queueMutation(a.repo, () => client.fetchHf(opts));
        if (sender && r.ok) {
          const event: ModelProgressEvent = {
            phase: "hug",
            message: `fetched ${a.repo}`,
            raw: r.path ?? "",
          };
          if (a.runId !== undefined) event.runId = a.runId;
          sender.send(IPC_EVENTS.modelProgress, event);
        }
        const out: ModelFetchHfResult = { ok: r.ok };
        if (r.repo !== undefined) out.repo = r.repo;
        if (r.path !== undefined) out.path = r.path;
        if (r.installable) out.installable = true;
        if (r.error !== undefined) out.error = r.error;
        return out;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── model:installHfCli — install HF's own `hf` CLI on the user's behalf ────
  ipcMain.handle(
    IPC.modelInstallHfCli,
    async (_evt, arg: unknown): Promise<ModelInstallHfCliResult> => {
      const v = validateModelInstallHfCli(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const blocked = await launchBlockReason();
      if (blocked) return { ok: false, error: blocked };
      try {
        const r = await queueMutation("__hfcli__", () => client.installHfCli());
        const out: ModelInstallHfCliResult = { ok: r.ok, installed: r.installed };
        if (r.manual) out.manual = true;
        if (r.install !== undefined) out.install = r.install;
        if (r.error !== undefined) out.error = r.error;
        return out;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── model:convert — HF dir → GGUF (+ quantize), ALWAYS via llama.cpp's tools ─
  ipcMain.handle(
    IPC.modelConvert,
    async (evt: unknown, arg: unknown): Promise<ModelConvertResult> => {
      const v = validateModelConvert(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a = v.value;
      const sender = senderOf(evt);
      const blocked = await launchBlockReason();
      if (blocked) return { ok: false, error: blocked };
      try {
        const opts: Parameters<typeof client.convert>[0] = { src: a.src };
        if (a.quant !== undefined) opts.quant = a.quant;
        if (a.id !== undefined) opts.id = a.id;
        if (a.out !== undefined) opts.out = a.out;
        const r = await queueMutation(a.id ?? a.src, () => client.convert(opts));
        if (sender) {
          const event: ModelProgressEvent = {
            phase: "hug",
            message: r.ok ? `converted → ${r.path ?? ""}` : (r.error ?? "conversion failed"),
            raw: r.path ?? "",
          };
          if (a.runId !== undefined) event.runId = a.runId;
          sender.send(IPC_EVENTS.modelProgress, event);
        }
        const out: ModelConvertResult = { ok: r.ok };
        if (r.id !== undefined) out.id = r.id;
        if (r.path !== undefined) out.path = r.path;
        if (r.canonicalPath !== undefined) out.canonicalPath = r.canonicalPath;
        if (r.quant !== undefined) out.quant = r.quant;
        if (r.sizeBytes !== undefined) out.sizeBytes = r.sizeBytes;
        if (r.sizeGb !== undefined) out.sizeGb = r.sizeGb;
        if (r.installable) out.installable = true;
        if (r.lowDisk) out.lowDisk = true;
        if (r.hint !== undefined) out.hint = r.hint;
        if (r.error !== undefined) out.error = r.error;
        return out;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── model:installConverter — fetch llama.cpp's OWN converter, once ─────────
  ipcMain.handle(
    IPC.modelInstallConverter,
    async (_evt, arg: unknown): Promise<ModelInstallConverterResult> => {
      const v = validateModelInstallConverter(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const blocked = await launchBlockReason();
      if (blocked) return { ok: false, error: blocked };
      try {
        const r = await queueMutation("__converter__", () => client.installConverter());
        const out: ModelInstallConverterResult = { ok: r.ok, installed: r.installed };
        if (r.path !== undefined) out.path = r.path;
        if (r.manual) out.manual = true;
        if (r.install !== undefined) out.install = r.install;
        if (r.error !== undefined) out.error = r.error;
        return out;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── model:installTarget — wire a converted/GGUF model into ONE runtime ─────
  ipcMain.handle(
    IPC.modelInstallTarget,
    async (_evt, arg: unknown): Promise<ModelInstallTargetResult> => {
      const v = validateModelInstallTarget(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a = v.value;
      try {
        const opts: Parameters<typeof client.installTarget>[0] = { target: a.target, id: a.id };
        if (a.gguf !== undefined) opts.gguf = a.gguf;
        if (a.src !== undefined) opts.src = a.src;
        if (a.quant !== undefined) opts.quant = a.quant;
        const r = await queueMutation(a.id, () => client.installTarget(opts));
        const out: ModelInstallTargetResult = { ok: r.ok };
        if (r.target !== undefined) out.target = r.target;
        if (r.id !== undefined) out.id = r.id;
        if (r.path !== undefined) out.path = r.path;
        if (r.endpoint !== undefined) out.endpoint = r.endpoint;
        if (r.method !== undefined) out.method = r.method;
        if (r.note !== undefined) out.note = r.note;
        if (r.error !== undefined) out.error = r.error;
        return out;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── disposer ─────────────────────────────────────────────────────────────
  return () => {
    serve.off("status", onServeStatus as (...a: unknown[]) => void);
    serve.off("evicted", onServeEviction as (...a: unknown[]) => void);
    for (const channel of [
      IPC.modelHardware,
      IPC.modelSearch,
      IPC.modelInfo,
      IPC.modelFit,
      IPC.modelDownload,
      IPC.modelPull,
      // was previously missing from this list (a pre-existing asymmetry — the handler
      // above registers it, so the disposer must remove it too, fixed in passing).
      IPC.modelInstallRunner,
      IPC.modelLibrary,
      IPC.modelRemove,
      IPC.modelServe,
      IPC.modelUnserve,
      IPC.modelKill,
      IPC.modelServing,
      IPC.modelEndpoints,
      IPC.modelRepoint,
      IPC.modelFetchHf,
      IPC.modelInstallHfCli,
      IPC.modelConvert,
      IPC.modelInstallConverter,
      IPC.modelInstallTarget,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
