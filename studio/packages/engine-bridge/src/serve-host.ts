/**
 * serve-host.ts — the CLI-owned local model-runner supervisor (CLI-022).
 *
 * The desktop C8 ServerSupervisor (core/supervisor/registry.ts) owns GUI-launched
 * servers in the long-lived MAIN process. A one-shot `prometheus` process can't hold that
 * registry in memory, so the CLI needs its OWN durable supervisor: it spawns the
 * fit-derived runner argv (built PURELY by serve.py), records the pid in a state file
 * SEPARATE from serve-profiles.json, and later finds/kills ONLY the pids it recorded —
 * it never touches a pid the GUI supervisor owns.
 *
 * Everything is seam-injectable (spawn / port-probe / liveness / kill / clock / state
 * path) so the whole surface is unit-testable with a fake spawn and a tmp state dir —
 * no real runner binary, no real network. The real spawn is detached + unref'd so the
 * CLI can exit leaving a daemonized runner whose pid is on record (no silent orphan).
 */
import { execFileSync } from "node:child_process";
import { type ChildProcess, spawn as realSpawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Socket, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { safeChildEnv } from "./safe-env.js";

/** A durable record of one CLI-spawned runner (the shape persisted to serve-state.json). */
export interface ServeRecord {
  profileId: string;
  model: string;
  runner: string;
  port: number;
  pid: number;
  startedAt: string; // ISO
  baseUrl?: string;
}

/** A liveness-verified status row (pid alive AND port answering). */
export interface ServeLiveStatus extends ServeRecord {
  uptimeSec: number;
}

/** The minimal profile the host needs to spawn a runner (built by serve.py, via the sidecar). */
export interface ServeSpec {
  profileId: string;
  model: string;
  runner: string;
  port: number;
  argv: string[]; // fixed, shell-free: [binary, ...args]
  baseUrl?: string;
}

export type ServeStartResult =
  | { ok: true; record: ServeRecord }
  | { ok: false; error: string; heldByPid?: number };

export interface ServeStopResult {
  ok: boolean;
  found: boolean;
  killed?: boolean;
  wasStale?: boolean;
  error?: string;
}

/** Injectable seams — defaults do the real thing; tests pass fakes. */
export interface ServeHostDeps {
  /** state file path (tests point this at a tmp dir). */
  stateFile?: string;
  /** spawn a detached child; must return an object exposing `pid` + `unref`. */
  spawn?: (cmd: string, args: string[]) => { pid?: number; unref?: () => void };
  /** port pre-bind probe: is the port free, and who holds it if not? */
  probePort?: (port: number) => Promise<{ free: boolean; pid?: number }>;
  /** liveness of a pid (signal-0 semantics). */
  isAlive?: (pid: number) => boolean;
  /** does the runner answer on its port (TCP connect)? */
  portAnswering?: (port: number) => Promise<boolean>;
  /** send a signal to a pid. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** bounded async sleep (grace between SIGTERM and SIGKILL). */
  sleep?: (ms: number) => Promise<void>;
  /** wall clock (ms) — for uptime. */
  now?: () => number;
  /** SIGTERM→SIGKILL grace window. */
  graceMs?: number;
}

export interface ServeHostApi {
  start(spec: ServeSpec): Promise<ServeStartResult>;
  stop(profileId: string): Promise<ServeStopResult>;
  status(): Promise<ServeLiveStatus[]>;
  /** the resolved state file path (for messages/tests). */
  stateFile: string;
}

/** The CLI serve-state file lives next to serve-profiles.json (same models dir). */
export function serveStatePath(): string {
  const dir = process.env.PROMETHEUS_MODELS_DIR
    ? process.env.PROMETHEUS_MODELS_DIR.replace(/^~(?=$|\/)/, homedir())
    : join(homedir(), ".cache", "prometheus", "models");
  return join(dir, "serve-state.json");
}

function defaultSpawn(cmd: string, args: string[]): { pid?: number; unref?: () => void } {
  const child: ChildProcess = realSpawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    env: safeChildEnv(),
  });
  return child;
}

/** Real port-free probe: bind briefly; EADDRINUSE ⇒ occupied (with best-effort holder pid). */
function defaultProbePort(port: number): Promise<{ free: boolean; pid?: number }> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve({ free: false, pid: pidOnPort(port) });
      else resolve({ free: true }); // a non-conflict error: let the runner surface it
    });
    srv.once("listening", () => srv.close(() => resolve({ free: true })));
    srv.listen(port, "127.0.0.1");
  });
}

/** Best-effort holder pid via `lsof` (macOS/Linux); undefined on Windows/absent lsof. */
function pidOnPort(port: number): number | undefined {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`], {
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const pid = Number.parseInt(out.split(/\s+/)[0] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe (ESRCH ⇒ gone)
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it → still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultPortAnswering(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new Socket();
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(600);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, "127.0.0.1");
  });
}

export function createServeHost(deps: ServeHostDeps = {}): ServeHostApi {
  const stateFile = deps.stateFile ?? serveStatePath();
  const spawnFn = deps.spawn ?? defaultSpawn;
  const probePort = deps.probePort ?? defaultProbePort;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const portAnswering = deps.portAnswering ?? defaultPortAnswering;
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const graceMs = deps.graceMs ?? 5000;

  const load = (): ServeRecord[] => {
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf8"));
      const arr = Array.isArray(raw?.servers) ? raw.servers : [];
      return arr.filter((r: unknown): r is ServeRecord => {
        const rec = r as ServeRecord;
        return rec != null && typeof rec.profileId === "string" && typeof rec.pid === "number";
      });
    } catch {
      return []; // absent/corrupt ⇒ nothing recorded (idempotent)
    }
  };

  const save = (servers: ServeRecord[]): void => {
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ servers }, null, 2));
    renameSync(tmp, stateFile); // atomic replace
  };

  const start = async (spec: ServeSpec): Promise<ServeStartResult> => {
    if (!spec.argv.length) return { ok: false, error: "empty runner argv" };
    // pre-bind conflict check — fail fast, never hang on an occupied port.
    const probe = await probePort(spec.port);
    if (!probe.free) {
      return {
        ok: false,
        error: `port ${spec.port} in use${probe.pid ? ` (pid ${probe.pid})` : ""} — try --port or prometheus model stop`,
        ...(probe.pid ? { heldByPid: probe.pid } : {}),
      };
    }
    const [cmd, ...args] = spec.argv;
    const child = spawnFn(cmd as string, args);
    if (typeof child.pid !== "number") {
      return { ok: false, error: `failed to spawn ${cmd} (no pid)` };
    }
    const record: ServeRecord = {
      profileId: spec.profileId,
      model: spec.model,
      runner: spec.runner,
      port: spec.port,
      pid: child.pid,
      startedAt: new Date(now()).toISOString(),
      ...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
    };
    // RECORD FIRST (so a crash between spawn and unref can't orphan), THEN detach.
    const servers = load().filter((r) => r.profileId !== spec.profileId);
    servers.push(record);
    save(servers);
    child.unref?.();
    return { ok: true, record };
  };

  const stop = async (profileId: string): Promise<ServeStopResult> => {
    const servers = load();
    const rec = servers.find((r) => r.profileId === profileId);
    if (!rec) return { ok: true, found: false }; // not CLI-recorded ⇒ nothing we own to kill
    const prune = () => save(servers.filter((r) => r.profileId !== profileId));
    if (!isAlive(rec.pid)) {
      prune(); // stale/dead pid ⇒ self-heal, honest success
      return { ok: true, found: true, wasStale: true };
    }
    try {
      kill(rec.pid, "SIGTERM");
    } catch (e) {
      return { ok: false, found: true, error: (e as Error).message };
    }
    // bounded grace: poll liveness, then SIGKILL if still up.
    const deadline = now() + graceMs;
    while (now() < deadline && isAlive(rec.pid)) await sleep(Math.min(100, graceMs));
    let killed = false;
    if (isAlive(rec.pid)) {
      try {
        kill(rec.pid, "SIGKILL");
        killed = true;
      } catch {
        /* raced to exit between the poll and the kill — treat as stopped */
      }
    }
    prune();
    return { ok: true, found: true, killed };
  };

  const status = async (): Promise<ServeLiveStatus[]> => {
    const servers = load();
    const live: ServeLiveStatus[] = [];
    const survivors: ServeRecord[] = [];
    for (const rec of servers) {
      // liveness = pid alive AND port answering (never the state file alone).
      const alive = isAlive(rec.pid) && (await portAnswering(rec.port));
      if (!alive) continue; // dead/unresponsive ⇒ dropped (self-heal below)
      survivors.push(rec);
      live.push({
        ...rec,
        uptimeSec: Math.max(0, Math.round((now() - Date.parse(rec.startedAt)) / 1000)),
      });
    }
    if (survivors.length !== servers.length) save(survivors); // prune stale
    return live;
  };

  return { start, stop, status, stateFile };
}
