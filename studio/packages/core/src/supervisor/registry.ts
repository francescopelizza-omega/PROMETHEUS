/**
 * supervisor/registry.ts — the ServerSupervisor (C8).
 *
 * Long-lived servers (model runners, embedding servers, kernels) are supervised
 * by the Studio MAIN process. The engine (prometheus.py / nemesis) is strictly
 * fire-and-forget and is NEVER managed here. This supervisor owns a child_process
 * registry, autostarts from serve-profiles.json, exposes start/stop/list/health,
 * and emits lifecycle events via EventEmitter.
 *
 * MAIN-PROCESS ONLY: it spawns real child processes (node:child_process) and so
 * must never be imported into the sandboxed Electron renderer (C5). The GUI talks
 * to it across the typed contextBridge IPC seam.
 *
 * Node built-ins only: node:child_process, node:events, node:fs/promises, node:os.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

import type { ServeProfile } from "../domain/models.js";

/** Lifecycle states a supervised server moves through. */
export type ServerState = "starting" | "running" | "stopping" | "stopped" | "errored";

/** A live (or dead) supervised server record. */
export interface SupervisedServer {
  id: string;
  profile: ServeProfile;
  state: ServerState;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  restarts: number;
  lastError?: string;
}

/** Public, serialisable snapshot (no live ChildProcess handle) for the GUI/IPC. */
export interface ServerStatus {
  id: string;
  label?: string;
  state: ServerState;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  restarts: number;
  lastError?: string;
}

/** Typed event map the supervisor emits. */
export interface SupervisorEvents {
  starting: [ServerStatus];
  running: [ServerStatus];
  stopping: [ServerStatus];
  stopped: [ServerStatus];
  errored: [ServerStatus];
  /** a line of the child's stderr (id, line). */
  log: [string, string];
  /** the child exited (status carries exitCode/signal). */
  exit: [ServerStatus];
}

interface Entry {
  server: SupervisedServer;
  child?: ChildProcess;
  /** Pending auto-restart backoff timer; cleared by stop() so a restart never
   *  fires for a server the caller has deliberately stopped (zombie restart). */
  restartTimer?: ReturnType<typeof setTimeout>;
}

const MAX_RESTARTS = 5;
const RESTART_BACKOFF_MS = 1_000;

/**
 * The ServerSupervisor. Construct ONE per Studio MAIN process. All spawns go
 * through node:child_process with shell:false. Health is process-liveness based;
 * a richer HTTP health probe can layer on `profile.healthUrl` from the GUI.
 */
export class ServerSupervisor extends EventEmitter {
  private readonly entries = new Map<string, Entry>();

  // --- typed EventEmitter overrides ------------------------------------- //
  override on<K extends keyof SupervisorEvents>(
    event: K,
    listener: (...args: SupervisorEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override once<K extends keyof SupervisorEvents>(
    event: K,
    listener: (...args: SupervisorEvents[K]) => void,
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof SupervisorEvents>(event: K, ...args: SupervisorEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  /** Serialisable status of one server (or undefined if unknown). */
  status(id: string): ServerStatus | undefined {
    const e = this.entries.get(id);
    return e ? toStatus(e.server) : undefined;
  }

  /** Serialisable status of every server the supervisor knows about. */
  list(): ServerStatus[] {
    return [...this.entries.values()].map((e) => toStatus(e.server));
  }

  /** Liveness health: is this server currently running with a live process? */
  health(id: string): { id: string; healthy: boolean; state: ServerState } {
    const e = this.entries.get(id);
    const state = e?.server.state ?? "stopped";
    const healthy = !!e && e.server.state === "running" && !!e.child && e.child.exitCode === null;
    return { id, healthy, state };
  }

  /**
   * Start (or restart) a server from its profile. Idempotent: starting an
   * already-running id is a no-op that returns the current status. Returns the
   * status after the spawn attempt.
   */
  start(profile: ServeProfile): ServerStatus {
    const existing = this.entries.get(profile.id);
    if (existing && (existing.server.state === "running" || existing.server.state === "starting")) {
      return toStatus(existing.server);
    }

    const server: SupervisedServer = existing?.server ?? {
      id: profile.id,
      profile,
      state: "stopped",
      restarts: 0,
    };
    server.profile = profile;
    server.state = "starting";
    server.lastError = undefined;
    server.stoppedAt = undefined;
    server.exitCode = undefined;
    server.signal = undefined;

    // We are (re)starting now: cancel any pending restart timer from the prior
    // entry and drop the dead old child's listeners so they can't fire against the
    // new generation (the old process has already exited to reach this path).
    if (existing?.restartTimer !== undefined) clearTimeout(existing.restartTimer);
    existing?.child?.removeAllListeners?.();
    const entry: Entry = { server };
    this.entries.set(profile.id, entry);
    this.emit("starting", toStatus(server));

    let child: ChildProcess;
    try {
      child = spawn(profile.command, profile.args ?? [], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: profile.cwd,
        env: profile.env ? { ...process.env, ...profile.env } : process.env,
      });
    } catch (err) {
      server.state = "errored";
      server.lastError = (err as Error).message;
      this.emit("errored", toStatus(server));
      return toStatus(server);
    }

    entry.child = child;
    server.pid = child.pid;
    server.startedAt = new Date().toISOString();
    server.state = "running";
    this.emit("running", toStatus(server));

    child.stdout?.on("data", (b: Buffer) => this.emit("log", profile.id, b.toString()));
    child.stderr?.on("data", (b: Buffer) => this.emit("log", profile.id, b.toString()));

    child.on("error", (err: Error) => {
      server.state = "errored";
      server.lastError = err.message;
      this.emit("errored", toStatus(server));
    });

    child.on("exit", (code, signal) => {
      entry.child = undefined;
      server.exitCode = code;
      server.signal = signal;
      server.stoppedAt = new Date().toISOString();
      // A clean stop() set state to "stopping"; preserve "stopped" intent.
      const wasStopping = server.state === "stopping";
      server.state = code === 0 || wasStopping ? "stopped" : "errored";
      if (server.state === "errored" && code !== null) {
        server.lastError = `exited with code ${code}`;
      }
      this.emit("exit", toStatus(server));
      this.emit(server.state === "errored" ? "errored" : "stopped", toStatus(server));

      // Auto-restart on a non-clean exit if requested and under the cap.
      if (
        !wasStopping &&
        server.state === "errored" &&
        profile.restartOnExit &&
        server.restarts < MAX_RESTARTS
      ) {
        server.restarts += 1;
        const timer = setTimeout(() => {
          entry.restartTimer = undefined;
          this.start(profile);
        }, RESTART_BACKOFF_MS * server.restarts);
        if (typeof timer.unref === "function") timer.unref();
        entry.restartTimer = timer;
      }
    });

    return toStatus(server);
  }

  /**
   * Stop a server. Sends SIGTERM, then SIGKILL after `graceMs` if still alive.
   * Resolves once the child has exited (or immediately if already stopped).
   */
  stop(id: string, graceMs = 5_000): Promise<ServerStatus> {
    const entry = this.entries.get(id);
    if (!entry) {
      return Promise.resolve({ id, state: "stopped", restarts: 0 });
    }
    // Cancel any pending auto-restart FIRST — a deliberate stop() during the backoff
    // window must not be undone by a restart that was scheduled by the prior exit.
    if (entry.restartTimer !== undefined) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    const { server, child } = entry;
    if (!child || child.exitCode !== null || server.state === "stopped") {
      server.state = "stopped";
      return Promise.resolve(toStatus(server));
    }

    server.state = "stopping";
    this.emit("stopping", toStatus(server));

    return new Promise<ServerStatus>((resolve) => {
      const onExit = () => {
        clearTimeout(killTimer);
        resolve(toStatus(server));
      };
      child.once("exit", onExit);

      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
        onExit();
        return;
      }

      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, graceMs);
      if (typeof killTimer.unref === "function") killTimer.unref();
    });
  }

  /** Stop every supervised server (parallel). Used on app shutdown. */
  async stopAll(graceMs = 5_000): Promise<ServerStatus[]> {
    return Promise.all([...this.entries.keys()].map((id) => this.stop(id, graceMs)));
  }

  /**
   * Load serve-profiles.json and start every profile flagged `autostart` (C8).
   * Returns the status of each autostarted server. A malformed/missing file is
   * a no-op (returns []) — the supervisor is resilient at boot.
   */
  async autostart(serveProfilesPath: string): Promise<ServerStatus[]> {
    const profiles = await loadServeProfiles(serveProfilesPath);
    const out: ServerStatus[] = [];
    for (const p of profiles) {
      if (p.autostart) out.push(this.start(p));
    }
    return out;
  }
}

function toStatus(s: SupervisedServer): ServerStatus {
  return {
    id: s.id,
    label: s.profile.label,
    state: s.state,
    pid: s.pid,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    exitCode: s.exitCode,
    restarts: s.restarts,
    lastError: s.lastError,
  };
}

/** Coerce one raw JSON entry into a ServeProfile (dropping invalid entries). */
function parseProfile(raw: unknown): ServeProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.command !== "string") return null;
  const args = Array.isArray(o.args)
    ? o.args.filter((a): a is string => typeof a === "string")
    : undefined;
  const env =
    o.env && typeof o.env === "object" && !Array.isArray(o.env)
      ? Object.fromEntries(
          Object.entries(o.env as Record<string, unknown>).filter(
            (kv): kv is [string, string] => typeof kv[1] === "string",
          ),
        )
      : undefined;
  return {
    id: o.id,
    label: typeof o.label === "string" ? o.label : undefined,
    command: o.command,
    args,
    env,
    cwd: typeof o.cwd === "string" ? o.cwd : undefined,
    autostart: o.autostart === true,
    restartOnExit: o.restartOnExit === true,
    healthUrl: typeof o.healthUrl === "string" ? o.healthUrl : undefined,
  };
}

/**
 * Read + parse serve-profiles.json. Accepts either a bare array of profiles or
 * an object with a `profiles` array. A missing/unparseable file yields [].
 */
export async function loadServeProfiles(path: string): Promise<ServeProfile[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).profiles)
      ? ((data as Record<string, unknown>).profiles as unknown[])
      : [];
  const out: ServeProfile[] = [];
  for (const raw of arr) {
    const p = parseProfile(raw);
    if (p) out.push(p);
  }
  return out;
}
