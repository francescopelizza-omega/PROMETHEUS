/**
 * model-server.ts — starting, inspecting and stopping a LOCAL model server.
 *
 * The user's report was specific: they want to start the AI model server by hand, stop it, and
 * "kill it with brute force if something is not responding properly". That last one is the
 * interesting requirement, because a server that is not responding is exactly the one a polite
 * shutdown cannot reach.
 *
 * ## It must work on a server we did NOT start
 *
 * A supervisor that tracks its own children is easy and would fail the actual case: most of the
 * time `ollama serve` was launched from a terminal, or by the ollama app at login, long before
 * Prometheus opened. So the process is found by WHO IS LISTENING ON THE PORT, not by a handle we
 * kept — `lsof` on the listening socket, which is the one identifier that is true regardless of
 * how the server got there.
 *
 * ## Stop and kill are different operations, deliberately
 *
 * `SIGTERM` lets the runner flush and unload cleanly; `SIGKILL` does not, and a model mid-write
 * can leave a partial blob behind. So force is never an automatic escalation here — the caller
 * (and therefore the user) chooses it. That is the opposite of `ServerSupervisor.stop`, which
 * escalates on a timer, and the difference is intentional: this is a manual control panel.
 *
 * C5/SPINE: engine-bridge is the ONLY module allowed to touch child_process, so every spawn and
 * every signal in this feature funnels through here.
 */
import { spawn } from "node:child_process";

import { safeChildEnv } from "./safe-env.js";
import { execCapture, probeSystemCommand } from "./system-probe.js";

/** What is listening on the port, if anything. */
export interface ServerProcess {
  pid: number;
  /** the command name as the OS reports it (`ollama`, `LM Studio Helper`, …). */
  command: string;
}

/** A local model server's live state. */
export interface ModelServerStatus {
  /** the runner id this describes (`ollama`, `lmstudio`). */
  runnerId: string;
  /** something is listening on the port. */
  listening: boolean;
  /** the OpenAI-compatible endpoint answered `/models` with a 200. */
  healthy: boolean;
  /** models the runner is serving right now (empty when unhealthy). */
  models: string[];
  /** the listening processes, when they could be identified. */
  processes: ServerProcess[];
  /** set when the probe itself could not run (no lsof, permission denied). */
  note?: string;
}

/**
 * Who is LISTENING on `port`.
 *
 * `lsof -nP -iTCP:<port> -sTCP:LISTEN` is the portable-enough answer on macOS and Linux. A
 * failure returns an empty list with a note rather than throwing: not being able to see the
 * process is a much smaller problem than a panel that crashes, and the health probe below still
 * tells the user whether the server works.
 */
export async function listenersOnPort(port: number): Promise<{
  processes: ServerProcess[];
  note?: string;
}> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { processes: [], note: `not a port: ${port}` };
  }
  const out = await execCapture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"], {
    timeoutMs: 4000,
  });
  if (out.code === 127) return { processes: [], note: "lsof is not available on this machine" };
  // lsof exits 1 with no output when NOTHING matches — that is "no listener", not an error.
  if (out.code !== 0 && out.stdout.trim() === "") return { processes: [] };
  return { processes: parseLsofFields(out.stdout) };
}

/**
 * Parse `lsof -F pc` field output: `p<pid>` then `c<command>`, one per line.
 *
 * The field format is used rather than the default table because the default's COMMAND column is
 * truncated and space-separated — "LM Studio Helper" cannot survive a `split(/\s+/)`.
 */
export function parseLsofFields(stdout: string): ServerProcess[] {
  const out: ServerProcess[] = [];
  let pid: number | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("p")) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) && n > 0 ? n : undefined;
    } else if (line.startsWith("c") && pid !== undefined) {
      const command = line.slice(1);
      // one row per pid — lsof repeats the command line for every open FD
      if (!out.some((p) => p.pid === pid)) out.push({ pid, command });
    }
  }
  return out;
}

/** `GET {baseUrl}/models` — the same 200-means-ready contract the serve supervisor uses. */
export async function probeModels(
  baseUrl: string,
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<{ ok: boolean; models: string[] }> {
  const doFetch = opts.fetchFn ?? fetch;
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    if (!res.ok) return { ok: false, models: [] };
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(data?.data)
      ? data.data.map((m) => String(m?.id ?? "")).filter((s) => s.length > 0)
      : [];
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}

/**
 * The full status of one runner.
 *
 * `listening` and `healthy` are reported SEPARATELY and that is the point. A server that holds
 * the port but never answers `/models` is precisely the "not responding properly" state the
 * force-kill exists for, and collapsing the two into one boolean would hide it — the panel would
 * say "stopped" while a wedged process sat on the port refusing every new one.
 */
export async function modelServerStatus(
  runner: { id: string; port: number; baseUrl: string },
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<ModelServerStatus> {
  const [listeners, health] = await Promise.all([
    listenersOnPort(runner.port),
    probeModels(runner.baseUrl, opts),
  ]);
  return {
    runnerId: runner.id,
    listening: listeners.processes.length > 0,
    healthy: health.ok,
    models: health.models,
    processes: listeners.processes,
    ...(listeners.note ? { note: listeners.note } : {}),
  };
}

/** Whether a runner's start command exists on this machine. */
export async function canStart(argv: readonly string[] | undefined): Promise<boolean> {
  const bin = argv?.[0];
  if (!bin) return false;
  const out = await probeSystemCommand("command", ["-v", bin], { timeoutMs: 2000 });
  if (out !== null) return out.trim().length > 0;
  // `command` is a shell builtin and execFile cannot run it; fall back to `which`.
  const which = await probeSystemCommand("which", [bin], { timeoutMs: 2000 });
  return which !== null && which.trim().length > 0;
}

export interface StartResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

/**
 * Start a runner, DETACHED.
 *
 * Detached and `unref`'d on purpose: the model server must outlive the Prometheus window that
 * happened to start it. A user who starts the server, gets a chat answer, and closes the app
 * should not have the server torn down under a second window that is still using it — and this
 * is the same machine-wide resource the fleet bar reports, not a per-window child.
 *
 * stdio is ignored rather than piped for the same reason: an un-drained pipe fills its buffer and
 * blocks the child, which would wedge the very server this is meant to launch.
 */
/**
 * Memory caps applied to an ollama daemon THIS PROCESS starts.
 *
 * Scope is deliberate and narrow: these are Prometheus's caps on Prometheus's own daemon. They
 * are passed in the child's environment at spawn time, so they bind the server we launch and
 * nothing else. An `ollama serve` the user types in their own terminal is untouched, and no
 * machine-wide state (launchd, the LaunchAgent plist, a shell rc) is modified to achieve this.
 *
 * Why they exist: the KV cache scales with context length, and an unbounded request is what took
 * a loaded model from ~8 GB to ~17 GB in two seconds on the maintainer's 64 GB Apple Silicon
 * box — fast enough that the display starved and the machine needed a hard power-off. One model,
 * one request at a time, a bounded context and a quantised KV cache remove that failure mode
 * from anything Prometheus starts.
 *
 * An explicit value already in the environment WINS: if the user exported
 * `OLLAMA_CONTEXT_LENGTH=16384`, that is a deliberate choice and we do not overrule it.
 */
export const PROMETHEUS_OLLAMA_CAPS: Readonly<Record<string, string>> = {
  OLLAMA_MAX_LOADED_MODELS: "1",
  OLLAMA_NUM_PARALLEL: "1",
  OLLAMA_KEEP_ALIVE: "60s",
  OLLAMA_CONTEXT_LENGTH: "8192",
  OLLAMA_FLASH_ATTENTION: "1",
  OLLAMA_KV_CACHE_TYPE: "q8_0",
  OLLAMA_MAX_QUEUE: "8",
};

/** The caps to hand a child, or undefined when the binary is not ollama (e.g. LM Studio). */
export function ollamaCapsFor(bin: string): NodeJS.ProcessEnv | undefined {
  const name = bin.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (name !== "ollama" && name !== "ollama.exe") return undefined;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(PROMETHEUS_OLLAMA_CAPS)) out[k] = process.env[k] ?? v;
  return out;
}

export function startModelServer(argv: readonly string[]): StartResult {
  const [bin, ...args] = argv;
  if (!bin) return { ok: false, error: "no start command for this runner" };
  try {
    const child = spawn(bin, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      env: safeChildEnv(ollamaCapsFor(bin)),
      windowsHide: true,
    });
    child.unref();
    return child.pid === undefined
      ? { ok: false, error: `${bin} did not start` }
      : { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: `${bin}: ${(err as Error).message}` };
  }
}

export interface SignalResult {
  pid: number;
  ok: boolean;
  error?: string;
}

/**
 * Signal a listening process.
 *
 * `SIGTERM` for a graceful stop, `SIGKILL` for the force path. Never escalates on its own — see
 * the module docstring: forcing is the user's decision here, not a timer's.
 *
 * ## The pid is validated FIRST, and that is not a formality
 *
 * `process.kill` inherits raw `kill(2)` semantics, where a non-positive pid is not a process at
 * all but a BROADCAST:
 *
 *     pid  -1   every process this uid is permitted to signal
 *     pid   0   every process in the CALLER's process group
 *     pid < -1  every process in process group |pid|
 *
 * With `SIGKILL`, the first of those ends the entire logged-in session — Dock, Finder, the
 * window server's clients, the terminal running this code — in one syscall, and to the person
 * sitting in front of it that is indistinguishable from a machine crash.
 *
 * This is not hypothetical. It happened four times on the development machine between
 * 2026-09-05 and 2026-09-06 (19:48:54, 23:13:22, 08:22:16, 12:09:53), killing 64 to 211
 * processes each time. The kernel recorded every victim as
 * `exited due to SIGKILL | sent by node[...]`, with Sandbox denials on the protected daemons it
 * could not reach, and it was misdiagnosed for days as a memory-starvation lockup. The caller
 * was this module's own unit test, which passed -1 to prove the function "never throws". It
 * never did throw. It killed the desktop instead, including the terminal that would have shown
 * the failure — which is precisely why it went unnoticed.
 *
 * The production path is exposed too, not just the test: `pid` always originates from parsing
 * `lsof` output, so one malformed line is enough. Refusing the broadcast forms is therefore the
 * function's behaviour and not a debug assertion — no legitimate caller wants one, and the price
 * of allowing one is the user's whole session.
 */
export function signalPid(pid: number, signal: "SIGTERM" | "SIGKILL"): SignalResult {
  // A single, real process only. `> 1` rather than `> 0`: pid 1 is launchd/init, which is alive,
  // never ours, and never a model server. Non-integers (including NaN) fail `Number.isInteger`.
  if (!Number.isInteger(pid) || pid <= 1) {
    return { pid, ok: false, error: `pid ${pid} is not a single process — refusing to signal it` };
  }
  try {
    process.kill(pid, signal);
    return { pid, ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { pid, ok: true }; // already gone — the goal, reached
    return {
      pid,
      ok: false,
      error:
        code === "EPERM"
          ? `pid ${pid} belongs to another user — Prometheus cannot signal it`
          : `pid ${pid}: ${(err as Error).message}`,
    };
  }
}
