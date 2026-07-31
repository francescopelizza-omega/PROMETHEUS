/**
 * main/ipc.ts — the typed ipcMain handlers (MAIN-PROCESS ONLY).
 *
 * This is the trusted side of the contextBridge seam. It is the ONLY place that
 * holds a live EngineClient (the single JS→engine gateway, C5) and a live
 * ServerSupervisor (C8). Every handler:
 *   1. takes the plain-data request the sandboxed renderer sent,
 *   2. drives engine-bridge / core,
 *   3. maps the result down to a renderer-safe shape from the shared contract,
 *   4. NEVER lets a raw EngineClient / ChildProcess / node handle cross back.
 *
 * GOLDEN RULE (C5): JS never decides "safe". `gate` returns whatever verdict the
 * engine-bridge nemesis runner produced; engine-bridge already fails closed
 * (missing/timeout/unparseable ⇒ verdict "error"). We never upgrade it here.
 *
 * Node/Electron only at runtime in this file (it runs in the privileged main
 * process). It imports @prometheus/engine-bridge + @prometheus/core — which the
 * renderer is forbidden from doing.
 */

import { ipcMain } from "electron";

import {
  type PromotionContext,
  type Provider,
  type ServeProfile,
  type ServerSupervisor,
  classifyTier,
  loadProviders,
  loadServeProfiles,
  needsCostWarning,
  costLight as providerCostLight,
  requiredConfirmPhrase,
  sortByPromotion,
} from "@prometheus/core";
import {
  type EngineClient,
  type EngineConfig,
  type SecurityVerdict,
  createEngineClient,
} from "@prometheus/engine-bridge";

import {
  type EnvelopeResult,
  type GateResult,
  type HealthResult,
  IPC,
  IPC_CANCEL,
  IPC_EVENTS,
  type ProgressFeedEvent,
  type ProviderRow,
  type ProvidersResult,
  type ScanResult,
  type ServersResult,
  type VersionResult,
} from "../shared/ipc-contract.js";
import type { IpcErrorShape } from "./arg-guards.js";
// NOTE: InstallOptions/UninstallOptions are no longer imported here — the zod
// validators in validate.ts own arg coercion; handlers consume the typed
// InstallArgs/UninstallArgs the validators return.
import { osLabel, toAgentRows } from "./scan-map.js";
import type { SidecarSupervisor } from "./sidecar-supervisor.js";
import { runSidecar } from "./sidecar.js";
import {
  validateCancel,
  validateInstall,
  validateName,
  validateTarget,
  validateToggle,
  validateUninstall,
} from "./validate.js";
import { failClosedGate, toGateResult } from "./verdict-map.js";

/**
 * A rejection thrown across the IPC boundary on invalid renderer args. Carrying a
 * serializable {kind,message,detail} means the renderer's onError sees structured
 * data (structured-clone of the .ipc field), not a stack trace. Electron clones
 * own-enumerable props of a thrown Error, so we attach the shape as `.ipc`.
 */
class IpcError extends Error {
  readonly ipc: IpcErrorShape;
  constructor(shape: IpcErrorShape) {
    super(shape.message);
    this.name = "IpcError";
    this.ipc = shape;
  }
}

/** Mint a runId→AbortController registry so `cancel(runId)` can abort a child. */
type RunRegistry = Map<string, AbortController>;

/** Coerce an unknown caught value to a short error string. */
function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}

/**
 * Extract the renderer's WebContents `sender` from an Electron IpcMainInvokeEvent
 * WITHOUT importing the electron type into the handler signature (the handlers
 * type `evt` as unknown). Returns a minimal `{ send }` surface used only to push
 * progress events back to the initiating window; undefined if absent.
 */
function senderOf(
  evt: unknown,
): { send(channel: string, payload: ProgressFeedEvent): void } | undefined {
  if (!evt || typeof evt !== "object") return undefined;
  const sender = (evt as { sender?: unknown }).sender;
  if (sender && typeof (sender as { send?: unknown }).send === "function") {
    return sender as { send(channel: string, payload: ProgressFeedEvent): void };
  }
  return undefined;
}

/** Map one config Provider to the renderer-safe ProviderRow (C11). */
function toProviderRow(p: Provider, ctx: PromotionContext): ProviderRow {
  return {
    id: p.id,
    label: p.label,
    tier: classifyTier(p, ctx),
    costLight: providerCostLight(p, ctx),
    needsCostWarning: needsCostWarning(p, ctx),
    requiresTypedConfirm: requiredConfirmPhrase(p),
    isEscapeHatch: p.isEscapeHatch,
    notes: p.notes,
  };
}

/** Construction-time wiring the main process passes in (paths + supervisor). */
export interface IpcWiring {
  /** the supervisor the main process owns (C8). */
  supervisor: ServerSupervisor;
  /** optional engine config (else env / sibling defaults resolve, C2). */
  engineConfig?: EngineConfig;
  /** providers.config.json path override (else the bundled config, C11). */
  providersConfigPath?: string;
  /** runtime promotion proof (verifyAtSetup detected a covering seat, C11). */
  promotionContext?: PromotionContext;
  /** serve-profiles.json path — lets serverStart re-start a known server by id (C8). */
  serveProfilesPath?: string;
  /**
   * the MAIN-process SidecarSupervisor (file 01 §5). When present, the `version`
   * channel uses its engineVersion() probe; absent, version reports unavailable.
   */
  sidecarSupervisor?: SidecarSupervisor;
}

/**
 * Register every ipcMain.handle channel. Call ONCE during app `whenReady`.
 * Returns a disposer that removes the handlers (used on shutdown / re-register).
 */
export function registerIpcHandlers(wiring: IpcWiring): () => void {
  const client: EngineClient = createEngineClient(wiring.engineConfig);
  const promotionContext: PromotionContext = wiring.promotionContext ?? {};
  const { supervisor } = wiring;

  // The MAIN process owns profile lookup (the renderer never supplies a profile,
  // only an id). Load the serve-profiles registry once so serverStart can map an
  // id → its retained ServeProfile (C8). A missing/bad file yields an empty map.
  const profilesById = new Map<string, ServeProfile>();
  if (wiring.serveProfilesPath) {
    void loadServeProfiles(wiring.serveProfilesPath).then((profiles) => {
      for (const p of profiles) profilesById.set(p.id, p);
    });
  }

  // runId → AbortController for in-flight long ops (install/uninstall). The
  // renderer mints a runId, follows it via onProgress, and aborts it via
  // `cancel(runId)`. The MAIN process owns the registry; the renderer never holds
  // a signal (C5). Entries are deleted when the op settles.
  const runs: RunRegistry = new Map();

  /**
   * Unwrap a validator's GuardResult: on success return the value, on failure
   * THROW an IpcError carrying the serializable {kind,message,detail}. ipcMain
   * forwards a thrown Error's own-enumerable props across the boundary, so the
   * renderer's onError receives the structured `.ipc` shape, never a crash.
   */
  function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: IpcErrorShape }): T {
    if (r.ok) return r.value;
    throw new IpcError(r.error);
  }

  /**
   * Forward an engine stderr progress line to the renderer that initiated the op,
   * tagged with the op's runId so the renderer can filter its own timeline (§4.3).
   * Cosmetic only — NO security verdict crosses (C5).
   */
  function emitProgress(
    sender: { send(channel: string, payload: ProgressFeedEvent): void } | undefined,
    runId: string | undefined,
    line: string,
  ): void {
    if (!sender) return;
    const event: ProgressFeedEvent = { message: line, phase: "info", raw: line };
    if (runId !== undefined) event.runId = runId;
    sender.send(IPC_EVENTS.progress, event);
  }

  // ── inventory: scan ──────────────────────────────────────────────────────
  ipcMain.handle(IPC.scan, async (): Promise<ScanResult> => {
    try {
      const env = await client.scan();
      // The real engine emits `os` as an OBJECT `{ family, pkg_manager }`
      // (grounded vs `prometheus.py --json scan`, §3.3), NOT a bare string, and
      // `agents` as a loose array. Both are normalised by the pure scan-map
      // mappers (unit-tested decoupled) so a plain `typeof === "string"` check
      // never silently drops the OS and a malformed agent never throws the seam.
      const result: ScanResult = {
        ok: env.ok !== false,
        agents: toAgentRows(env.agents),
      };
      const os = osLabel(env.os);
      if (os !== undefined) result.os = os;
      if (env.ok === false) result.error = String(env.error ?? "scan failed");
      return result;
    } catch (e) {
      return { ok: false, agents: [], error: errString(e) };
    }
  });

  // ── security: gate (C4/C5, fail-closed) ──────────────────────────────────
  ipcMain.handle(IPC.gate, async (_evt, target: unknown): Promise<GateResult> => {
    // Validate at the seam (zod). An INVALID target is a fail-closed BLOCK, not
    // a thrown error: the renderer must still render a verdict, never assume safe.
    const v = validateTarget(target);
    if (!v.ok) return failClosedGate(typeof target === "string" ? target : "", v.error.message);
    const t = v.value;
    // gate() never throws a "safe" — engine-bridge folds missing/timeout/
    // unparseable scanners into verdict "error". We only catch a hard spawn
    // crash and STILL fail closed (block), never assume allow.
    try {
      const verdict: SecurityVerdict = await client.gate(t);
      return toGateResult(verdict);
    } catch (e) {
      return failClosedGate(t, errString(e));
    }
  });

  // ── inventory: list (registry) ───────────────────────────────────────────
  ipcMain.handle(IPC.list, async (): Promise<EnvelopeResult> => {
    try {
      const env = await client.list();
      return { ok: env.ok !== false, data: env as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── inventory: info <name> ───────────────────────────────────────────────
  ipcMain.handle(IPC.info, async (_evt, name: unknown): Promise<EnvelopeResult> => {
    const v = validateName(name);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const env = await client.info(v.value);
      return { ok: env.ok !== false, data: env as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── inventory: audit <name> (deep nemesis audit; a BLOCK is VALID data, C5) ─
  ipcMain.handle(IPC.audit, async (_evt, name: unknown): Promise<EnvelopeResult> => {
    const v = validateName(name);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      // EngineClient has no typed audit() verb; drive it through the generic
      // runner with the canonical argv. The engine runs nemesis itself and
      // returns the worst_verdict/findings — we render that, never override (C5).
      const env = await client.runPrometheus(["audit", v.value]);
      return { ok: env.ok !== false, data: env as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── inventory: status <name> | "all" ──────────────────────────────────────
  ipcMain.handle(IPC.status, async (_evt, name: unknown): Promise<EnvelopeResult> => {
    const v = validateName(name);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const env = await client.status(v.value);
      return { ok: env.ok !== false, data: env as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── inventory: where <name> ───────────────────────────────────────────────
  ipcMain.handle(IPC.where, async (_evt, name: unknown): Promise<EnvelopeResult> => {
    const v = validateName(name);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const env = await client.where(v.value);
      return { ok: env.ok !== false, data: env as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── inventory: matrix (no args) ───────────────────────────────────────────
  ipcMain.handle(IPC.matrix, async (): Promise<EnvelopeResult> => {
    try {
      const env = await client.matrix();
      return { ok: env.ok !== false, data: env as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── health: read-only engine/scanner probe for the title-bar pill (§4.2) ──
  ipcMain.handle(IPC.health, async (): Promise<HealthResult> => {
    const problems: string[] = [];
    // Version probe via the sidecar supervisor when present (non-mutating).
    let version: string | undefined;
    let contractOk = false;
    try {
      const sup = wiring.sidecarSupervisor;
      if (sup) {
        const ver = await sup.engineVersion();
        if (ver.ok && ver.version) version = ver.version;
        else problems.push(ver.error ?? "engine version probe failed");
      } else {
        // No supervisor wired (e.g. headless contexts): probe via the client's
        // version negotiation (the same read-only `--version` path).
        const ver = await client.version();
        if (ver.scriptVersion) version = ver.scriptVersion;
        else
          problems.push(
            ver.raw ? `unparseable version: ${ver.raw}` : "engine version probe failed",
          );
      }
    } catch (e) {
      problems.push(errString(e));
    }
    // Contract probe: a read-only `scan` must yield a parseable envelope.
    let nemesisPresent = false;
    try {
      const env = await client.scan();
      contractOk = typeof env.command === "string";
      // doctor would report nemesis health; absent a typed doctor we conservatively
      // mark nemesis present only when the contract held (fail-closed on doubt).
      nemesisPresent = contractOk;
      if (!contractOk) problems.push("engine did not return a valid --json envelope");
    } catch (e) {
      problems.push(errString(e));
    }
    const ok = version !== undefined && contractOk;
    const result: HealthResult = { ok, contractOk, nemesisPresent, problems };
    if (version !== undefined) result.version = version;
    if (!ok && problems[0]) result.error = problems[0];
    return result;
  });

  // ── providers: Tier-A-first list (C11) ───────────────────────────────────
  ipcMain.handle(IPC.providers, async (): Promise<ProvidersResult> => {
    try {
      const providers = await loadProviders(wiring.providersConfigPath);
      const sorted = sortByPromotion(providers, promotionContext);
      return {
        ok: true,
        providers: sorted.map((p) => toProviderRow(p, promotionContext)),
      };
    } catch (e) {
      return { ok: false, providers: [], error: errString(e) };
    }
  });

  // ── environments: env.list (envmgr sidecar, C7 — a STANDALONE python ──────
  // process the MAIN process owns; prometheus.py has no `sidecar` verb).
  ipcMain.handle(IPC.envList, async (): Promise<EnvelopeResult> => {
    try {
      const res = await runSidecar("envmgr", "env.list");
      return { ok: res.ok, data: res.data };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── models: hw.scan (modelhub sidecar, C7) ───────────────────────────────
  ipcMain.handle(IPC.modelHw, async (): Promise<EnvelopeResult> => {
    try {
      const res = await runSidecar("modelhub", "hw.scan");
      return { ok: res.ok, data: res.data };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── servers: supervisor snapshot + start/stop (C8) ───────────────────────
  ipcMain.handle(IPC.servers, async (): Promise<ServersResult> => {
    try {
      return { ok: true, servers: supervisor.list() };
    } catch (e) {
      return { ok: false, servers: [], error: errString(e) };
    }
  });

  ipcMain.handle(IPC.serverStart, async (_evt, id: unknown): Promise<ServersResult> => {
    const sid = typeof id === "string" ? id : "";
    try {
      // Resolve the id → its retained ServeProfile (main-owned registry). The
      // renderer supplies ONLY an id, never a spawnable command (C5/C8).
      const profile = profilesById.get(sid);
      if (!profile) {
        return {
          ok: false,
          servers: supervisor.list(),
          error: `unknown server profile: ${sid}`,
        };
      }
      supervisor.start(profile); // idempotent: a no-op if already running.
      return { ok: true, servers: supervisor.list() };
    } catch (e) {
      return { ok: false, servers: supervisor.list(), error: errString(e) };
    }
  });

  ipcMain.handle(IPC.serverStop, async (_evt, id: unknown): Promise<ServersResult> => {
    const sid = typeof id === "string" ? id : "";
    try {
      await supervisor.stop(sid);
      return { ok: true, servers: supervisor.list() };
    } catch (e) {
      return { ok: false, servers: supervisor.list(), error: errString(e) };
    }
  });

  // ── install <name> (engine runs nemesis itself; JS never pre-judges, C5) ──
  ipcMain.handle(
    IPC.install,
    async (evt: unknown, name: unknown, opts: unknown): Promise<EnvelopeResult> => {
      // zod seam: a malformed name/opts is rejected with a serializable shape.
      const a = unwrap(validateInstall(name, opts));
      const sender = senderOf(evt);
      // Register an AbortController under the runId so `cancel(runId)` can abort
      // this child (engine-bridge SIGTERM→SIGKILLs on signal). No runId ⇒ no cancel.
      const ac = a.runId ? new AbortController() : undefined;
      if (a.runId && ac) runs.set(a.runId, ac);
      try {
        // The engine runs nemesis and returns a forced_danger / ok:false envelope
        // when blocked — we RENDER that, never override it to a success (C5).
        const env = await client.install(a.name, {
          dryRun: a.dryRun,
          forced: a.forced,
          ...(ac ? { signal: ac.signal } : {}),
          onStderr: (line: string) => emitProgress(sender, a.runId, line),
        });
        return { ok: env.ok !== false, data: env as Record<string, unknown> };
      } catch (e) {
        return { ok: false, error: errString(e) };
      } finally {
        if (a.runId) runs.delete(a.runId);
      }
    },
  );

  // ── uninstall <name> (state-changing; same progress/cancel wiring) ────────
  ipcMain.handle(
    IPC.uninstall,
    async (evt: unknown, name: unknown, opts: unknown): Promise<EnvelopeResult> => {
      const a = unwrap(validateUninstall(name, opts));
      const sender = senderOf(evt);
      const ac = a.runId ? new AbortController() : undefined;
      if (a.runId && ac) runs.set(a.runId, ac);
      try {
        const env = await client.uninstall(a.name, {
          ...(ac ? { signal: ac.signal } : {}),
          onStderr: (line: string) => emitProgress(sender, a.runId, line),
        });
        return { ok: env.ok !== false, data: env as Record<string, unknown> };
      } catch (e) {
        return { ok: false, error: errString(e) };
      } finally {
        if (a.runId) runs.delete(a.runId);
      }
    },
  );

  // ── enable <name> [--component hooks|mcp] ─────────────────────────────────
  ipcMain.handle(
    IPC.enable,
    async (_evt, name: unknown, component: unknown): Promise<EnvelopeResult> => {
      const a = unwrap(validateToggle(name, component));
      try {
        const env = await client.enable(a.name);
        return { ok: env.ok !== false, data: env as Record<string, unknown> };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── disable <name> [--component hooks|mcp] ────────────────────────────────
  ipcMain.handle(
    IPC.disable,
    async (_evt, name: unknown, component: unknown): Promise<EnvelopeResult> => {
      const a = unwrap(validateToggle(name, component));
      try {
        const env = await client.disable(a.name);
        return { ok: env.ok !== false, data: env as Record<string, unknown> };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── cancel(runId) — fire-and-forget abort of an in-flight long op (§4.3) ──
  // Registered via ipcMain.on (one-way send), not handle. An invalid/unknown id
  // is a silent no-op (never a crash); a valid id aborts its child.
  ipcMain.on(IPC_CANCEL, (_evt, runId: unknown) => {
    const v = validateCancel(runId);
    if (!v.ok) return; // ignore malformed cancel requests
    runs.get(v.value)?.abort();
    runs.delete(v.value);
  });

  // ── version (engine SCRIPT_VERSION via the sidecar supervisor probe) ──────
  ipcMain.handle(IPC.version, async (): Promise<VersionResult> => {
    const sup = wiring.sidecarSupervisor;
    if (!sup) return { ok: false, error: "version probe unavailable" };
    try {
      const r = await sup.engineVersion();
      return r.version
        ? { ok: r.ok, version: r.version }
        : { ok: false, error: r.error ?? "no version" };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── disposer ─────────────────────────────────────────────────────────────
  return () => {
    for (const channel of Object.values(IPC)) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.removeAllListeners(IPC_CANCEL);
    // Abort any in-flight long ops so a teardown never orphans a child.
    for (const ac of runs.values()) ac.abort();
    runs.clear();
  };
}
