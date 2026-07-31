/**
 * mcp/host/e2e-harness.ts — opt-in REAL reference-MCP-server e2e harness (CLI-038). NODE-ONLY.
 *
 * Every MCP test to date runs against FakeTransport / an in-repo fixture — no third-party server
 * has ever actually been connected. This harness closes that honest gap: it arms a spawn of the
 * PINNED reference server (`@modelcontextprotocol/server-everything`, run via `npx -y` at TEST
 * time only — NOT a package.json dependency; the pinned-version-behind-an-env-flag npx spawn is
 * the documented exception to the no-new-deps rule) and drives the handshake through the GENUINE
 * core stdio transport + McpHostManager.
 *
 * The spawn is injected into `StdioMcpTransport` (`StdioTransportDeps.spawn`) so this harness gets
 * three things the plain transport spawn can't give a test: (1) a further-sanitized child env
 * (PROM_*, token, secret vars stripped — the child is a third-party binary), (2) a DETACHED POSIX
 * process group so `kill(-pid)` reaps the `npx`→`node` grandchild instead of orphaning it, and
 * (3) a retained child handle for a deterministic SIGTERM→SIGKILL teardown that awaits real exit.
 *
 * The command + version are hard-coded consts (no user-controlled argv, shell:false) — the only
 * variable is the pinned version string, satisfying the no-injection invariant.
 */
// biome-ignore lint/nursery/noRestrictedImports: deliberate Node-only mcp-node subpath (CLI-038 e2e harness), never in the renderer barrel.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";

import type { StdioSpawn, StdioTransportDeps } from "./stdio-transport.js";
import type { McpServerConfig } from "./types.js";

/** The EXACT pinned reference-server version — never `@latest` (a floating tag makes e2e non-reproducible). */
export const REFERENCE_SERVER_VERSION = "2026.7.4";
/** The full pinned npx target (`@modelcontextprotocol/server-everything@<pinned>`). */
export const REFERENCE_SERVER_PKG = `@modelcontextprotocol/server-everything@${REFERENCE_SERVER_VERSION}`;
/** A substring unique to the reference server, used by the pgrep orphan-reaper. */
const SERVER_MATCH = "server-everything";

const isWindows = process.platform === "win32";
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A stdio McpServerConfig that launches the pinned reference server via `npx -y` (shell:false). */
export function referenceServerConfig(): McpServerConfig {
  return {
    id: "e2e-everything",
    label: "Everything (e2e)",
    // Windows npx is `npx.cmd` (shell:false needs the extension); CI targets macOS/Linux.
    transport: {
      kind: "stdio",
      command: isWindows ? "npx.cmd" : "npx",
      args: ["-y", REFERENCE_SERVER_PKG],
    },
    enabled: true,
    scope: "global",
    autoApprove: ["echo"],
    source: "manual",
    health: "unknown",
  };
}

/** Strip PROM_*, token, secret, api-key vars from a child env — a third-party binary gets none of ours. */
function sanitizeChildEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    if (
      up.startsWith("PROM_") ||
      up.includes("TOKEN") ||
      up.includes("SECRET") ||
      up.includes("API_KEY")
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** True while `pid` exists (EPERM = alive but not ours; ESRCH = gone). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every live `server-everything` pid on the host (POSIX pgrep; empty on no-match / Windows). */
export function referenceServerPids(): number[] {
  if (isWindows) return [];
  try {
    const out = execFileSync("pgrep", ["-f", SERVER_MATCH], { encoding: "utf8" });
    return out
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** SIGKILL any leaked reference-server process still matching the pgrep pattern (final safety net). */
function reapOrphans(): void {
  for (const p of referenceServerPids()) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Pre-populate the npm cache so the real `initialize` measured by the test is a STEADY-STATE
 * handshake, not a cold `npx` download racing the transport's 15s per-request timeout. Spawns the
 * server once, waits until it emits its first byte (installed + running), then kills it. Bounded
 * by `timeoutMs` so a wedged network can never hang the suite. Best-effort — errors are swallowed.
 */
export function prewarmReferenceServer(timeoutMs = 90_000): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (p?: ChildProcess): void => {
      if (settled) return;
      settled = true;
      try {
        const pid = p?.pid;
        if (pid !== undefined) {
          if (isWindows)
            execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
          else process.kill(-pid, "SIGKILL");
        }
      } catch {
        /* already gone */
      }
      reapOrphans();
      resolve();
    };
    try {
      const cfg = referenceServerConfig();
      const t = cfg.transport;
      if (t.kind !== "stdio") return finish();
      const p = spawn(t.command, [...t.args], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWindows,
        env: sanitizeChildEnv(process.env),
      });
      const timer = setTimeout(() => finish(p), timeoutMs);
      const ready = (): void => {
        clearTimeout(timer);
        finish(p);
      };
      p.stdout?.once("data", ready); // first byte ⇒ installed + running ⇒ cache is warm
      p.stderr?.once("data", ready);
      p.once("error", () => {
        clearTimeout(timer);
        finish();
      });
      p.once("exit", () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      finish();
    }
  });
}

export interface ReferenceHarness {
  /** The stdio config to hand `McpHostManager.addServer`. */
  readonly cfg: McpServerConfig;
  /** Feed to `createStdioTransportFactory(deps)` so the manager spawns via this harness. */
  readonly transportDeps: StdioTransportDeps;
  /** The `npx` child pid once connected (the process-group leader), else undefined. */
  pid(): number | undefined;
  /** True if any `server-everything` process is currently alive on the host (leak check). */
  isRunning(): boolean;
  /** SIGTERM→(grace)→SIGKILL the whole process group, await real exit, then reap any orphan. */
  kill(): Promise<void>;
}

/**
 * Arm a reference-server harness. It does NOT spawn eagerly — the spawn fires when the injected
 * transport factory's `connect()` runs, so a skipped (env-guarded) suite launches nothing. Callers
 * MUST `await harness.kill()` in teardown.
 */
export function createReferenceHarness(): ReferenceHarness {
  let child: ChildProcess | undefined;
  const spawnFn: StdioSpawn = (command, args, options) => {
    child = spawn(command, [...args], {
      ...options,
      env: sanitizeChildEnv(options.env as NodeJS.ProcessEnv),
      detached: !isWindows, // POSIX: new process group so kill(-pid) reaps the npx→node grandchild
    });
    return child;
  };

  const signalGroup = (sig: NodeJS.Signals): void => {
    const pid = child?.pid;
    if (pid === undefined) return;
    try {
      if (isWindows)
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-pid, sig); // negative pid → the whole group
    } catch {
      /* already exited / ESRCH */
    }
  };

  return {
    cfg: referenceServerConfig(),
    transportDeps: { spawn: spawnFn },
    pid: () => child?.pid,
    isRunning: () => referenceServerPids().length > 0,
    async kill(): Promise<void> {
      const pid = child?.pid;
      if (pid !== undefined) {
        signalGroup("SIGTERM");
        const graceUntil = Date.now() + 3000;
        while (pidAlive(pid) && Date.now() < graceUntil) await delay(50);
        if (pidAlive(pid)) {
          signalGroup("SIGKILL");
          const killUntil = Date.now() + 2000;
          while (pidAlive(pid) && Date.now() < killUntil) await delay(50);
        }
      }
      reapOrphans(); // catch any grandchild the group signal missed
    },
  };
}
