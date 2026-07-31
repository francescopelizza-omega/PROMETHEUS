/**
 * run.ts — the ONLY place that spawns python3/prometheus.py (C5).
 *
 * runPrometheus(argv) launches `python3 prometheus.py --json --no-color <argv...>`
 * with shell:false (argv passed verbatim — no shell injection), collects stdout,
 * and recovers the ONE contract JSON object by scanning lines LAST-TO-FIRST so a
 * stray human log line before OR after the object cannot defeat parsing.
 *
 * Fail-closed (C5): spawn failure, missing interpreter, timeout, or unparseable
 * stdout => a typed EngineError (never a silent success). ok:false / forced_danger
 * envelopes are RETURNED (the caller renders them) — they are valid engine output,
 * not a transport failure.
 *
 * Ported from prometheus_plugin/mcp-server/src/bridge.ts (resolve chain, the
 * last-to-first parseEngineObject, the 600s timeout).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { Commands } from "./commands.js";
import { DEFAULT_TIMEOUT_MS, type EngineConfig, resolveEngine } from "./config.js";
import { EngineError } from "./errors.js";
import { safeChildEnv } from "./safe-env.js";
import type { ForcedDanger } from "./security/verdict.js";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStderr?: (line: string) => void;
  /** maps to install --force; carried so callers can thread it through. */
  forced?: boolean;
}

/**
 * The shape every prometheus.py command shares. Subcommand payloads add their
 * own fields (agents[], catalog[], …) accessible via the index signature.
 */
export interface EngineEnvelope {
  command: string;
  ok: boolean;
  error?: string;
  _exit?: number;
  forced_danger?: ForcedDanger[];
  [k: string]: unknown;
}

/** Hard ceiling on accumulated child stdout — a runaway engine is aborted
 *  fail-closed before it can OOM the host (the JSON envelope is always tiny). */
const MAX_ENGINE_STDOUT_BYTES = 64 * 1024 * 1024;

const looksLikeEnvelope = (o: unknown): o is Record<string, unknown> =>
  !!o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  ("ok" in o || "command" in o || "error" in o);

/**
 * Recover the engine's JSON envelope from stdout. Whole-string parse first,
 * then scan lines LAST-TO-FIRST for one that parses to an object carrying our
 * envelope keys — robust to prefix AND suffix corruption.
 */
export function parseEngineObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const whole = JSON.parse(trimmed);
    if (looksLikeEnvelope(whole)) return whole;
  } catch {
    /* fall through to line scan */
  }
  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line);
      if (looksLikeEnvelope(o)) return o;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/** Stream a buffer split on newlines into a line callback, returning the remainder. */
function pumpLines(buf: string, onLine: (line: string) => void): string {
  let rest = buf;
  let nl = rest.indexOf("\n");
  while (nl !== -1) {
    const line = rest.slice(0, nl).replace(/\r$/, "");
    if (line.length) onLine(line);
    rest = rest.slice(nl + 1);
    nl = rest.indexOf("\n");
  }
  return rest;
}

/**
 * Low-level spawn of prometheus.py. `argv` is everything AFTER the global flags;
 * `--json --no-color` are prepended here so callers can never forget them.
 */
export function runPrometheus<T extends EngineEnvelope = EngineEnvelope>(
  argv: string[],
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<T> {
  const { prometheusPy, pythonBin } = resolveEngine(config);
  const timeoutMs = opts.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fullArgv = ["--json", "--no-color", ...argv];

  // Pre-flight: a missing script is a fail-closed spawn failure, not a crash.
  if (!existsSync(prometheusPy)) {
    return Promise.reject(
      new EngineError(`prometheus.py not found at ${prometheusPy}`, {
        code: "spawn_failed",
        stderrTail: "Set PROMETHEUS_PY to its absolute path.",
      }),
    );
  }

  return new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new EngineError("aborted before spawn", { code: "spawn_failed" }));
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pythonBin, [prometheusPy, ...fullArgv], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: opts.cwd ?? config.cwd,
        env: safeChildEnv(),
      });
    } catch (err) {
      reject(
        new EngineError(`failed to launch ${pythonBin}: ${(err as Error).message}`, {
          code: "spawn_failed",
          cause: err,
        }),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let stderrLineBuf = "";
    let settled = false;

    const onAbort = () => finishReject(new EngineError("run aborted", { code: "spawn_failed" }));

    const cleanup = () => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    const finishReject = (e: EngineError) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      reject(e);
    };

    const timer = setTimeout(() => {
      finishReject(
        new EngineError(`prometheus.py timed out after ${Math.round(timeoutMs / 1000)}s`, {
          code: "timeout",
          stderrTail: stderr.slice(-2000),
        }),
      );
    }, timeoutMs);
    // Do not keep the event loop alive solely for this timer.
    if (typeof timer.unref === "function") timer.unref();

    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString();
      // bound the buffer: a runaway engine must not OOM the host before the timeout.
      if (stdout.length > MAX_ENGINE_STDOUT_BYTES) {
        finishReject(
          new EngineError(
            `prometheus.py emitted more than ${Math.round(MAX_ENGINE_STDOUT_BYTES / 1e6)}MB — aborted (fail-closed)`,
            { code: "engine_error", stderrTail: stderr.slice(-2000) },
          ),
        );
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      const chunk = b.toString();
      stderr += chunk;
      if (opts.onStderr) {
        stderrLineBuf = pumpLines(stderrLineBuf + chunk, opts.onStderr);
      }
    });

    child.stdin?.end();

    child.on("error", (err: Error) => {
      finishReject(
        new EngineError(`failed to launch ${pythonBin}: ${err.message}`, {
          code: "spawn_failed",
          stderrTail: "Is Python installed and on PATH? Override with PYTHON/PYTHON_BIN.",
          cause: err,
        }),
      );
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      // flush any trailing stderr line
      if (opts.onStderr && stderrLineBuf.trim()) opts.onStderr(stderrLineBuf.trim());

      const exitCode = code ?? 1;
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new EngineError("prometheus.py produced no JSON on stdout (crashed before emitting)", {
            code: "bad_json",
            exitCode,
            stderrTail: stderr.slice(-2000) || `exit code ${exitCode}`,
          }),
        );
        return;
      }
      const parsed = parseEngineObject(trimmed);
      if (!parsed) {
        reject(
          new EngineError("prometheus.py stdout was not valid JSON", {
            code: "bad_json",
            exitCode,
            stderrTail: trimmed.slice(0, 500),
          }),
        );
        return;
      }

      // Build the typed envelope. ok:false / forced_danger are VALID engine
      // output (the caller renders the block) — NOT a transport error here.
      const envelope = {
        ...(parsed as Record<string, unknown>),
        command: typeof parsed.command === "string" ? parsed.command : (argv[0] ?? "unknown"),
        ok: parsed.ok !== false,
        _exit: exitCode,
      } as T;
      resolve(envelope);
    });
  });
}

/** Convenience: run a built command line (Commands.*) through runPrometheus. */
export function runCommand<T extends EngineEnvelope = EngineEnvelope>(
  argv: string[],
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<T> {
  return runPrometheus<T>(argv, opts, config);
}

export { Commands };
