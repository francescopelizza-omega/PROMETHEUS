// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ext-host.ts — the Electron-FREE extension host (APP-059, file 09 §5).
 *
 * Three concerns, all decoupled from Electron so the whole host is node:test-coverable
 * (only main/index.ts touches utilityProcess/safeStorage — injected here as seams):
 *
 *  1. installExtension() — the `.promext` pipeline: unzip → validate manifest → planInstall
 *     → nemesis-gate the plan target through an INJECTED gate fn → move into the extensions
 *     dir. Any failure (bad zip / bad manifest / incompatible / RED verdict) throws a typed
 *     ExtInstallError and leaves NO staging residue.
 *  2. ExtHostManager — implements the lifecycle (activate/deactivate/active) over the exact
 *     worker-host pattern (injected spawn fn, id-correlated request/response, per-request
 *     timeout, crash → reject in-flight + respawn on next activate).
 *  3. dispatchWebviewRpc() — the panel↔host RPC gate: an inbound WebviewMessage's METHOD is
 *     validated against the manifest's declared permissions (DEFAULT-DENY: an undeclared
 *     method rejects) before it is dispatched to a host backend.
 *
 * Reuses core `ext` for every decision (manifest/planInstall/permissions) so the host logic
 * never re-implements policy. node:fs/path/crypto only — no electron import.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { ext as coreExt } from "@prometheus/core";

import { extractZip } from "./ext-zip.js";

// the ext types live under core's `ext` namespace (`export * as ext`) — alias for brevity.
type ExtensionManifest = coreExt.ExtensionManifest;
type ExtensionBackends = coreExt.ExtensionBackends;
type WebviewMessage = coreExt.WebviewMessage;
import type { WorkerHandle } from "./worker-host.js";

/** The manifest file inside a `.promext` archive. */
export const MANIFEST_FILE = "prometheus.extension.json";

/* ── install pipeline ─────────────────────────────────────────────────────── */

/** A typed install failure — the `code` lets the UI phrase the rejection precisely. */
export type ExtInstallErrorCode = "bad-zip" | "bad-manifest" | "incompatible" | "blocked" | "io";
export class ExtInstallError extends Error {
  readonly code: ExtInstallErrorCode;
  constructor(code: ExtInstallErrorCode, message: string) {
    super(message);
    this.name = "ExtInstallError";
    this.code = code;
  }
}

/** The nemesis verdict shape (a subset of engine-bridge's SecurityVerdict). */
export interface ExtGateVerdict {
  verdict: "allow" | "warn" | "block" | "error";
  reason?: string;
}
/** Injected nemesis gate (engine-bridge is the sole JS→engine gateway). */
export type ExtGateFn = (target: string) => Promise<ExtGateVerdict>;

export interface InstallExtensionOptions {
  /** the extensions root, e.g. `<userData>/extensions`. */
  extensionsDir: string;
  /** a scratch root for the unzip staging dir (a unique subdir is created + cleaned). */
  stagingRoot: string;
  /** the running Studio version, for the engines.studio compat gate. */
  studioVersion?: string;
  /** the nemesis gate (engine-bridge). A block/error verdict aborts install (no force). */
  gate: ExtGateFn;
}

export interface InstalledExtension {
  id: string;
  installPath: string;
  manifest: ExtensionManifest;
}

/** A block/error verdict is fail-closed RED — install is refused unconditionally. */
function isBlocked(v: ExtGateVerdict): boolean {
  return v.verdict === "block" || v.verdict === "error";
}

/**
 * Install a `.promext`: unzip → validate → plan → gate → move. Throws ExtInstallError on any
 * failure and ALWAYS removes the staging dir (no residue), mirroring the §5.3 pipeline.
 */
export async function installExtension(
  archivePath: string,
  opts: InstallExtensionOptions,
): Promise<InstalledExtension> {
  const stagingDir = join(opts.stagingRoot, `.promext-staging-${randomUUID()}`);
  try {
    await mkdir(stagingDir, { recursive: true });
    // 1) unzip (hand-rolled reader; zip-slip guarded) — a malformed archive is fatal.
    let bytes: Buffer;
    try {
      bytes = await readFile(archivePath);
    } catch (e) {
      throw new ExtInstallError("io", `cannot read archive: ${errMsg(e)}`);
    }
    try {
      await extractZip(bytes, stagingDir);
    } catch (e) {
      throw new ExtInstallError("bad-zip", `malformed .promext: ${errMsg(e)}`);
    }
    // 2) parse + validate the manifest (fail-soft → null).
    let manifestText: string;
    try {
      manifestText = await readFile(join(stagingDir, MANIFEST_FILE), "utf8");
    } catch {
      throw new ExtInstallError("bad-manifest", `missing ${MANIFEST_FILE}`);
    }
    const manifest = coreExt.parseManifest(manifestText);
    if (!manifest) throw new ExtInstallError("bad-manifest", `invalid ${MANIFEST_FILE}`);
    // 3) plan the install (errors, not throws, on a version incompatibility).
    const plan = coreExt.planInstall(manifest, {
      extensionsDir: opts.extensionsDir,
      stagingDir,
      ...(opts.studioVersion ? { studioVersion: opts.studioVersion } : {}),
    });
    if (coreExt.isPlanError(plan)) throw new ExtInstallError("incompatible", plan.error);
    // 4) nemesis-gate the target (repo wins over staging via gateTargetFor). RED ⇒ refuse.
    const verdict = await opts.gate(plan.gateTarget);
    if (isBlocked(verdict)) {
      throw new ExtInstallError(
        "blocked",
        `nemesis gate blocked "${manifest.id}" (${verdict.verdict})${verdict.reason ? `: ${verdict.reason}` : ""}`,
      );
    }
    // 5) move into place (replace any prior install of this id atomically-ish).
    try {
      await rm(plan.installPath, { recursive: true, force: true });
      await mkdir(join(plan.installPath, ".."), { recursive: true });
      // rename across the same filesystem is atomic; a cross-device rename falls back to copy.
      await moveDir(stagingDir, plan.installPath);
    } catch (e) {
      throw new ExtInstallError("io", `install move failed: ${errMsg(e)}`);
    }
    return { id: manifest.id, installPath: plan.installPath, manifest };
  } finally {
    // never leave staging residue — whether we moved it or bailed out.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Move a directory: try rename (atomic, same FS), else recursive copy + remove. */
async function moveDir(from: string, to: string): Promise<void> {
  const { rename, cp } = await import("node:fs/promises");
  try {
    await rename(from, to);
  } catch {
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

/* ── webview RPC gate (default-deny) ──────────────────────────────────────── */

/** Host-capability methods a panel webview may invoke, and the permission each requires.
 *  Methods NOT in this table are undeclared → rejected (default-deny). */
type CapCheck = (m: ExtensionManifest) => boolean;
const has = (a: readonly unknown[] | undefined): boolean => !!a && a.length > 0;
const RPC_METHODS: Record<string, CapCheck> = {
  // always-safe capabilities (no sensitive resource) — allowed for any extension.
  "ui.notify": () => true,
  "ui.showPanel": () => true,
  "commands.execute": () => true,
  "commands.register": () => true,
  "workspace.rootUri": () => true,
  // resource capabilities — gated by the matching declared permission.
  "workspace.readFile": (m) => has(m.permissions?.fs?.read),
  "engine.run": (m) => has(m.permissions?.engine),
  "secrets.get": (m) => has(m.permissions?.secrets),
  "secrets.store": (m) => has(m.permissions?.secrets),
  "mcp.listServers": (m) =>
    m.permissions?.network !== undefined && m.permissions.network !== "none",
  "mcp.callTool": (m) => m.permissions?.network !== undefined && m.permissions.network !== "none",
};

/**
 * Is `method` permitted for this manifest? DEFAULT-DENY: an unknown method (not in the
 * capability table) OR a known method whose permission is undeclared → false. The method
 * NAME is validated (never the params — the extension controls those, plan gotcha).
 */
export function rpcMethodAllowed(manifest: ExtensionManifest, method: string): boolean {
  const check = RPC_METHODS[method];
  return check ? check(manifest) : false;
}

/**
 * Dispatch one inbound webview RPC to the host backends, gated by the manifest. Returns a
 * response WebviewMessage (payload on success, `error` on rejection/failure) carrying the
 * original correlation id. An undeclared method rejects BEFORE touching any backend.
 */
export async function dispatchWebviewRpc(
  manifest: ExtensionManifest,
  msg: WebviewMessage,
  backends: ExtensionBackends,
): Promise<WebviewMessage> {
  const reply = (extra: Partial<WebviewMessage>): WebviewMessage => ({
    type: msg.type,
    ...(msg.id ? { id: msg.id } : {}),
    ...extra,
  });
  if (!rpcMethodAllowed(manifest, msg.type)) {
    return reply({ error: `method not permitted (undeclared): ${msg.type}` });
  }
  try {
    const params = (msg.payload ?? {}) as Record<string, unknown>;
    const result = await invokeBackend(msg.type, params, backends);
    return reply({ payload: result });
  } catch (e) {
    return reply({ error: errMsg(e) });
  }
}

/** Route a permitted method to its backend. (Gating already happened in the caller.) */
async function invokeBackend(
  method: string,
  params: Record<string, unknown>,
  b: ExtensionBackends,
): Promise<unknown> {
  switch (method) {
    case "ui.notify":
      b.ui.notify((params.level as "info" | "warn" | "error") ?? "info", String(params.msg ?? ""));
      return { ok: true };
    case "ui.showPanel":
      b.ui.showPanel(String(params.id ?? ""));
      return { ok: true };
    case "commands.execute":
      return b.commands.execute(String(params.id ?? ""), ...((params.args as unknown[]) ?? []));
    case "workspace.rootUri":
      return b.workspace.rootUri;
    case "workspace.readFile":
      return b.workspace.readFile(String(params.path ?? ""));
    case "engine.run":
      return b.engine.run((params.argv as string[]) ?? []);
    case "secrets.get":
      return b.secrets.get(String(params.key ?? ""));
    case "secrets.store":
      await b.secrets.store(String(params.key ?? ""), String(params.val ?? ""));
      return { ok: true };
    case "mcp.listServers":
      return b.mcp.listServers();
    case "mcp.callTool":
      return b.mcp.callTool(String(params.ref ?? ""), params.args);
    default:
      throw new Error(`no backend for method: ${method}`);
  }
}

/* ── the utility-process host manager (lifecycle) ─────────────────────────── */

/** The forked ext-runner handle (same duck-type as the worker's). */
export type SpawnRunner = () => WorkerHandle;

/** One host→runner request (activate / deactivate an installed extension). */
export interface ExtRunnerRequest {
  reqId: string;
  op: "activate" | "deactivate";
  id: string;
  /** absolute path to the extension's main module (activate only). */
  mainPath?: string;
  /** the validated manifest (activate only) — the runner builds permission-bound caps from it. */
  manifest?: ExtensionManifest;
}
/** One runner→host response, correlated by reqId. */
export interface ExtRunnerResponse {
  reqId: string;
  ok: boolean;
  error?: string;
}

/** A reverse RPC frame FROM the runner: an extension is calling a host capability. */
export interface HostRpcFrame {
  hostRpc: true;
  rpcId: string;
  extId: string;
  msg: WebviewMessage;
}
function isHostRpcFrame(v: unknown): v is HostRpcFrame {
  return !!v && typeof v === "object" && (v as { hostRpc?: unknown }).hostRpc === true;
}

export interface ExtHostManagerOptions {
  spawn: SpawnRunner;
  requestTimeoutMs?: number;
  idSource?: () => string;
  now?: () => number;
  /** service an extension's host-capability call (gated via dispatchWebviewRpc in main). */
  onHostRpc?: (extId: string, msg: WebviewMessage) => Promise<WebviewMessage>;
}

export interface ExtHostEvents {
  spawned: [];
  crashed: [{ code: number | null; inFlight: number; active: string[] }];
  error: [Error];
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 5_000;

interface RunnerPending {
  resolve: (res: ExtRunnerResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Drives the single ext-runner utility process: activate/deactivate installed extensions,
 * report which are active, and self-heal on a crash. Mirrors WorkerHost semantics (a crash
 * rejects every in-flight request and drops the active set; the next activate respawns).
 */
export class ExtHostManager extends EventEmitter {
  private readonly spawn: SpawnRunner;
  private readonly requestTimeoutMs: number;
  private readonly nextId: () => string;
  private readonly now: () => number;
  private readonly onHostRpc?: (extId: string, msg: WebviewMessage) => Promise<WebviewMessage>;

  private runner: WorkerHandle | null = null;
  private readonly pending = new Map<string, RunnerPending>();
  private readonly activeIds = new Set<string>();
  private seq = 0;
  private disposed = false;
  private consecutiveCrashes = 0;
  private lastCrashAt = 0;

  constructor(opts: ExtHostManagerOptions) {
    super();
    this.spawn = opts.spawn;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.nextId = opts.idSource ?? (() => `x${++this.seq}`);
    this.now = opts.now ?? Date.now;
    this.onHostRpc = opts.onHostRpc;
  }

  override on<K extends keyof ExtHostEvents>(
    event: K,
    listener: (...args: ExtHostEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof ExtHostEvents>(event: K, ...args: ExtHostEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  get isRunning(): boolean {
    return this.runner !== null;
  }
  get inFlight(): number {
    return this.pending.size;
  }
  /** Which extensions are currently active (ExtensionHost §5.2). */
  active(): string[] {
    return [...this.activeIds];
  }

  /** Activate an installed extension: fork the runner if needed, load + run its ActivateFn. */
  async activate(manifest: ExtensionManifest, mainPath: string): Promise<void> {
    const res = await this.request({ op: "activate", id: manifest.id, mainPath, manifest });
    if (!res.ok) throw new Error(res.error ?? `activate failed: ${manifest.id}`);
    this.activeIds.add(manifest.id);
  }

  /** Deactivate + dispose an extension's subscriptions in the runner. */
  async deactivate(id: string): Promise<void> {
    if (!this.activeIds.has(id)) return;
    const res = await this.request({ op: "deactivate", id });
    this.activeIds.delete(id);
    if (!res.ok) throw new Error(res.error ?? `deactivate failed: ${id}`);
  }

  private ensureRunner(): WorkerHandle {
    if (this.runner) return this.runner;
    if (this.consecutiveCrashes > 1) {
      const backoff = Math.min(
        BACKOFF_BASE_MS * 2 ** (this.consecutiveCrashes - 2),
        BACKOFF_MAX_MS,
      );
      const waited = this.now() - this.lastCrashAt;
      if (waited < backoff) {
        throw new Error(
          `ext-runner in crash-loop backoff (${this.consecutiveCrashes} crashes) — retry in ${backoff - waited}ms`,
        );
      }
    }
    const r = this.spawn();
    this.runner = r;
    r.on("message", (msg: unknown) => this.onMessage(msg));
    r.on("exit", (code: number | null) => this.onExit(code));
    r.on("error", (err: Error) => {
      this.emit("error", err);
      this.onExit(null);
    });
    this.emit("spawned");
    return r;
  }

  private onMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    // a reverse host-capability call from an extension → service it (gated) + reply.
    if (isHostRpcFrame(msg)) {
      void this.serviceHostRpc(msg);
      return;
    }
    const res = msg as Partial<ExtRunnerResponse>;
    if (typeof res.reqId !== "string") return;
    const p = this.pending.get(res.reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(res.reqId);
    this.consecutiveCrashes = 0; // a reply proves health → clear the backoff
    p.resolve(res as ExtRunnerResponse);
  }

  /** Service a runner's host-capability call via the injected (gated) handler, then reply. */
  private async serviceHostRpc(frame: HostRpcFrame): Promise<void> {
    let reply: WebviewMessage;
    if (this.onHostRpc) {
      try {
        reply = await this.onHostRpc(frame.extId, frame.msg);
      } catch (e) {
        reply = {
          type: frame.msg.type,
          ...(frame.msg.id ? { id: frame.msg.id } : {}),
          error: errMsg(e),
        };
      }
    } else {
      reply = { type: frame.msg.type, error: "host RPC not available" };
    }
    try {
      this.runner?.postMessage({ hostRpcReply: true, rpcId: frame.rpcId, msg: reply });
    } catch {
      /* runner died mid-reply — the runner's own timeout handles it */
    }
  }

  /** A runner exit: fail EVERY in-flight request (fail-closed) + drop the active set. */
  private onExit(code: number | null): void {
    const inFlight = this.pending.size;
    const active = [...this.activeIds];
    this.runner = null;
    if (!this.disposed) {
      this.consecutiveCrashes += 1;
      this.lastCrashAt = this.now();
    }
    // the extensions died with the process — they are no longer active.
    this.activeIds.clear();
    if (inFlight > 0 || active.length > 0) this.emit("crashed", { code, inFlight, active });
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`ext-runner exited (code ${code ?? "null"}) with a request in flight`));
    }
    this.pending.clear();
  }

  private request(req: Omit<ExtRunnerRequest, "reqId">): Promise<ExtRunnerResponse> {
    if (this.disposed) return Promise.reject(new Error("ExtHostManager is disposed"));
    const reqId = this.nextId();
    const full: ExtRunnerRequest = { ...req, reqId };
    let runner: WorkerHandle;
    try {
      runner = this.ensureRunner();
    } catch (e) {
      return Promise.reject(new Error(`failed to spawn ext-runner: ${errMsg(e)}`));
    }
    return new Promise<ExtRunnerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(reqId)) return;
        this.pending.delete(reqId);
        reject(
          new Error(`ext-runner ${full.op} (${reqId}) timed out after ${this.requestTimeoutMs}ms`),
        );
      }, this.requestTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        runner.postMessage(full);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new Error(`failed to post to ext-runner: ${errMsg(e)}`));
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    const r = this.runner;
    this.runner = null;
    this.activeIds.clear();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("ExtHostManager disposed"));
    }
    this.pending.clear();
    if (r) {
      try {
        if (typeof r.terminate === "function") r.terminate();
        else if (typeof r.kill === "function") r.kill();
      } catch {
        /* already dead */
      }
    }
  }
}
