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

/**
 * Grace between SIGINT and SIGKILL on the abort/timeout path. Long enough for CPython to
 * unwind a `KeyboardInterrupt` through `Popen.__exit__` and a `shutil.rmtree`, short enough
 * that a wedged interpreter is still reaped promptly. Matches sidecar-runner.ts's kernel grace.
 */
const KILL_GRACE_MS = 3_000;

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
      /**
       * SIGINT first, SIGKILL only if that is ignored.
       *
       * A bare SIGKILL here leaked real state. prometheus.py runs blocking subprocesses — the
       * hardened `git clone` into a `.<name>.staging-XXXX` tree, the `_adapt_shell` steps — and
       * it cleans up after itself in an `except BaseException: shutil.rmtree(staging)`. SIGKILL
       * cannot be caught, so that cleanup never ran: an UNSCANNED, never-gated staging tree was
       * left on disk with an orphaned `git` still writing into it and still holding the network
       * connection. This is the everyday path, not an edge case — every in-flight op's
       * controller fires on cancel.
       *
       * SIGINT raises KeyboardInterrupt instead. CPython's `Popen.__exit__` kills the blocking
       * grandchild while unwinding, and the engine's own `except BaseException` removes the
       * staging tree. So signalling the direct pid is sufficient — Python propagates for us.
       *
       * Deliberately NOT `detached: true` + `process.kill(-pid, …)`, the pattern
       * sidecar-runner.ts uses for the kernel: the CLI passes no AbortSignal, so a terminal
       * Ctrl-C reaches python3 today ONLY because it shares the CLI's foreground process group.
       * Owning a separate group would trade this leak for a Ctrl-C leak.
       */
      try {
        child.kill("SIGINT");
      } catch {
        /* already dead */
      }
      const hard = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, KILL_GRACE_MS);
      // never keep the event loop alive for the escalation, and never outlive the child
      if (typeof hard.unref === "function") hard.unref();
      child.once("close", () => clearTimeout(hard));
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

    // `setEncoding`, not per-chunk `Buffer.toString()`: prometheus.py's `--json` payload is
    // not ASCII-escaped, so a multi-byte character straddling a chunk boundary would decode as
    // two U+FFFD halves and break `parseEngineObject` on an otherwise valid envelope.
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      /**
       * The bound is ENFORCED, not advisory.
       *
       * It used to be backed by an immediate SIGKILL; `finishReject` now sends SIGINT and only
       * escalates after a 3 s grace, and nothing here stopped appending — so past the bound the
       * string kept growing for the whole window, and a flood from one of prometheus.py's
       * grandchildren (which inherit this same pipe) survives both signals and keeps filling it
       * until that grandchild exits.
       *
       * So: stop ACCUMULATING once settled, but keep DRAINING — the child must never block on a
       * full pipe, and `close` has to fire so the SIGKILL escalation timer gets cleared.
       * Destroying the stream instead would hand prometheus.py `BrokenPipeError` on its next
       * write, including inside its `except BaseException: shutil.rmtree(staging)` handler — which
       * would skip the cleanup that the SIGINT grace was added to make possible.
       */
      if (settled) return;
      stdout += chunk;
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
    child.stderr?.setEncoding("utf8"); // same StringDecoder reason as stdout above
    child.stderr?.on("data", (chunk: string) => {
      // Progress forwarding continues past a settle — it is what the operator is watching during
      // the SIGINT grace, and destroying stderr would silence it.
      if (opts.onStderr) {
        stderrLineBuf = pumpLines(stderrLineBuf + chunk, opts.onStderr);
      }
      // …but the accumulation is bounded, same shape as stdout above. stderr had no bound at all.
      if (settled) return;
      if (stderr.length > MAX_ENGINE_STDOUT_BYTES) return;
      stderr += chunk;
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
