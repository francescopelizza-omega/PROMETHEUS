/**
 * sidecar-runner.ts — the canonical runner for the Studio Python helper sidecars
 * (python/sidecar/envmgr.py, modelhub.py, locate_engine.py, …). These are NOT
 * prometheus.py subcommands; per C7 each is its own Python program that emits
 * EXACTLY ONE JSON object on stdout and logs on stderr.
 *
 * It lives HERE (engine-bridge) so that — per C5 / file 02 §1.1 — `node:child_process`
 * is imported by exactly ONE package. engine-bridge is the sole spawner of python3
 * (the engine `prometheus.py`/`nemesis` AND these helper sidecars). The CLI and the
 * desktop main process call this through @prometheus/engine-bridge and never import
 * child_process themselves.
 *
 * Discipline mirrors run.ts: shell:false, argv verbatim (no injection), recover the
 * ONE JSON object by scanning stdout LAST-TO-FIRST, fail-closed timeout (SIGKILL) →
 * an ok:false envelope (never a silent success).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findRootFrom } from "./config.js";
import { safeChildEnv } from "./safe-env.js";

/** A sidecar envelope: ok + command + per-verb fields (mirror C7). */
export interface SidecarEnvelope {
  ok: boolean;
  command: string;
  error?: string;
  _exit?: number;
  [k: string]: unknown;
}

export interface SidecarOptions {
  pythonBin?: string;
  /** absolute path to the sidecar dir; defaults to studio/python/sidecar. */
  sidecarDir?: string;
  timeoutMs?: number;
  cwd?: string;
  /**
   * abort the run early (SIGKILL the child → fail-closed `{ok:false, error:"aborted"}`).
   * Used by the profiler's `ide:profile.stop` (APP-046) to cancel an in-flight run.
   */
  signal?: AbortSignal;
  /**
   * extra environment variables overlaid onto the SAFE child env (safeChildEnv strips
   * the dangerous vars first, then applies these). APP-085 passes a forge auth TOKEN
   * this way — via env consumed once at spawn, NEVER argv (invisible in `ps`).
   */
  env?: Record<string, string>;
  /**
   * optional stdin body written to the child once, then closed. Lets a verb receive a
   * large payload (e.g. APP-089 snapshot samples JSON) OFF the argv — never in `ps`, and
   * not subject to the OS arg-length cap. Absent → stdin is simply closed (unchanged).
   */
  input?: string;
  /**
   * optional per-line sink for the STREAMING sidecars (e.g. `testmgr.py run` emits
   * `{"event":"test",…}` JSON-lines before the terminal envelope, CLI-007). Fires
   * once per complete stdout line that parses to a JSON object carrying an `event`
   * field; the terminal envelope (no `event` field) is still returned as normal.
   * Absent → no line parsing (unchanged one-shot behavior).
   */
  onEvent?: (event: Record<string, unknown>) => void;
  /**
   * optional per-line sink for the sidecar's STDERR.
   *
   * The long-running fetches (`modelhub download`, an `ollama pull`) stream their progress
   * as JSON-lines on stderr. There was no hook for it, so the client tried to read a
   * `_stderr` blob off the envelope — a field nothing in this repo ever sets — and the
   * Models pull bar and the chat's "Live download %" could not move at all, for any download,
   * ever. Line-buffered like `onEvent`, so a chunk boundary never splits a progress record.
   */
  onStderr?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard ceiling on sidecar stdout — abort fail-closed before a runaway OOMs the host. */
const MAX_SIDECAR_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * Locate `studio/python/sidecar`. Honors PROMETHEUS_SIDECAR_DIR, else finds the PROMETHEUS root
 * by looking for it, else a relative last-resort guess.
 *
 * The walk used to be a FIXED three levels up — correct only for
 * `…/studio/packages/engine-bridge/{src,dist}`. This module is bundled, and a bundle lives
 * somewhere else: in the Electron build it is inlined into `studio/apps/desktop/out/main`, where
 * three up is `studio/apps` and the guess became `studio/apps/python/sidecar`, which does not
 * exist. Every sidecar-backed surface in the desktop app — test discovery, the @codebase repo
 * map, the linter fan-in, structural search, coverage, the profiler, modelhub and metadata —
 * therefore failed with "sidecar not found". Verified by running the shipped bundle's own walk
 * from `apps/desktop/out/main`.
 *
 * `findRootFrom` searches for the directory that actually holds the engine, so every layout
 * (source, dist, CLI bundle, Electron asar) lands on the same real path.
 */
export function resolveSidecarDir(override?: string): string {
  if (override) return override;
  const env = process.env.PROMETHEUS_SIDECAR_DIR;
  if (env) return env;
  let here: string | undefined;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    /* import.meta.url unavailable in some test harnesses — fall through */
  }
  for (const start of [here, process.cwd()]) {
    if (!start) continue;
    const root = findRootFrom(start);
    if (root) {
      const guess = join(root, "studio", "python", "sidecar");
      if (existsSync(guess)) return guess;
    }
  }
  // RELATIVE to the caller, never an absolute developer path: this string is compiled
  // into the published CLI bundle and the Electron asar, so a hard-coded home directory
  // here is shipped to every user (and resolves on exactly one machine anyway).
  if (here) return join(here, "..", "..", "..", "python", "sidecar");
  return join(process.cwd(), "studio", "python", "sidecar");
}

function pythonBin(opts: SidecarOptions): string {
  return opts.pythonBin || process.env.PYTHON || process.env.PYTHON_BIN || "python3";
}

const looksLikeSidecarObject = (o: unknown): o is Record<string, unknown> =>
  !!o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  ("ok" in o || "command" in o || "verb" in o || "error" in o);

/** Recover the ONE sidecar JSON object, scanning lines LAST-TO-FIRST (C7). */
export function parseSidecarObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const whole = JSON.parse(trimmed);
    if (looksLikeSidecarObject(whole)) return whole;
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
      if (looksLikeSidecarObject(o)) return o;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/**
 * Run a sidecar verb and return its envelope. FAIL-CLOSED: a missing script, spawn
 * failure, timeout, or unparseable stdout resolves to an ok:false envelope (with an
 * `error` string) — never a silent success. The caller renders the error.
 */
export function runSidecar<T extends SidecarEnvelope = SidecarEnvelope>(
  // file 14 §3.19/§3.8/§3.17 add the pure-stdlib testmgr/refactor/diagram sidecars.
  script:
    | "envmgr.py"
    | "modelhub.py"
    | "locate_engine.py"
    | "repo.py"
    | "testmgr.py"
    | "refactor.py"
    | "diagram.py"
    // file 14 §3.26: the SQL console backend (connect/query/schema, APP-041).
    | "sqlrunner.py"
    // file 0C: atomic file-metadata control (read/scrub/edit/timestomp) for privacy.
    | "metadata.py"
    // MDS parity 06: structural search-and-replace over Python ASTs (APP-076).
    | "structsearch.py"
    // MDS parity 15: coverage.py runner → CoverageReport + merge/import (APP-086).
    | "coverage.py"
    // URL-injection safeguard L6: the safe-fetch proxy (SSRF-guard + strip + IPI).
    | "fetchproxy.py"
    // URL-injection safeguard L4: behavioural malice/IPI classifier (no agency).
    | "urlclassifier.py"
    // file 14 §3.28: the Python profiler backend (cProfile → flame folds, APP-046).
    | "profile.py"
    // MDS parity 39: the tree-sitter/stdlib repo-map for @codebase grounding (APP-053).
    | "repomap.py"
    // JetBrains parity 03/28: the ruff/flake8/mypy/pylint fan-in for Problems (APP-062).
    | "linters.py",
  argv: string[],
  opts: SidecarOptions = {},
): Promise<T> {
  const dir = resolveSidecarDir(opts.sidecarDir);
  const scriptPath = join(dir, script);
  const bin = pythonBin(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const verb = argv[0] ?? script;

  const fail = (error: string, exit = 2): T =>
    ({ ok: false, command: verb, error, _exit: exit }) as T;

  if (!existsSync(scriptPath)) {
    return Promise.resolve(fail(`sidecar not found: ${scriptPath}`));
  }

  return new Promise<T>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [scriptPath, ...argv], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: opts.cwd,
        env: safeChildEnv(opts.env),
      });
    } catch (err) {
      resolve(fail(`failed to launch ${bin}: ${(err as Error).message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let lineBuf = ""; // line-assembly buffer for opts.onEvent streaming
    let settled = false;

    const done = (env: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(env);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      done(fail(`sidecar timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    // Cancellation: an aborted signal SIGKILLs the child and fails closed (APP-046 stop).
    const onAbort = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      done(fail("sidecar aborted", 130));
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // `setEncoding`, NOT `b.toString()` per chunk. The sidecars emit `ensure_ascii=False`
    // JSON, so a single UTF-8 character (a model name with a CJK glyph, an em dash in an
    // error string) can straddle a chunk boundary — `Buffer.toString()` then decodes each
    // half independently and yields U+FFFD on both sides, corrupting the JSON line before
    // `JSON.parse` ever sees it. `setEncoding` routes the stream through a StringDecoder,
    // which holds the incomplete sequence back until its continuation bytes arrive.
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      // streaming: hand each COMPLETE `{"event":…}` line to the sink as it arrives.
      if (opts.onEvent) {
        lineBuf += chunk;
        let nl = lineBuf.indexOf("\n");
        while (nl !== -1) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (line.startsWith("{")) {
            try {
              const o = JSON.parse(line) as Record<string, unknown>;
              if (o && typeof o === "object" && "event" in o) opts.onEvent(o);
            } catch {
              /* a partial / non-JSON line — ignore, the envelope scan still runs at close */
            }
          }
          nl = lineBuf.indexOf("\n");
        }
      }
      if (stdout.length > MAX_SIDECAR_STDOUT_BYTES) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        done(
          fail(
            `sidecar emitted more than ${Math.round(MAX_SIDECAR_STDOUT_BYTES / 1e6)}MB — aborted (fail-closed)`,
          ),
        );
      }
    });
    // same StringDecoder reason as stdout above — this tail is shown to the user verbatim
    // when the sidecar produces no JSON object.
    child.stderr?.setEncoding("utf8");
    let stderrLineBuf = "";
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (opts.onStderr) {
        stderrLineBuf += chunk;
        let nl = stderrLineBuf.indexOf("\n");
        while (nl !== -1) {
          const line = stderrLineBuf.slice(0, nl).replace(/\r$/, "");
          stderrLineBuf = stderrLineBuf.slice(nl + 1);
          if (line) {
            // A throwing sink (a progress callback sending to a closed window) must not escape
            // this 'data' listener as an uncaughtException, nor strand the rest of the chunk.
            try {
              opts.onStderr(line);
            } catch {
              /* the sink's failure is its own; keep pumping */
            }
          }
          nl = stderrLineBuf.indexOf("\n");
        }
      }
    });

    if (opts.input !== undefined) {
      try {
        child.stdin?.write(opts.input);
      } catch {
        /* a closed/broken pipe surfaces as the child's own no-JSON failure */
      }
    }
    child.stdin?.end();

    child.on("error", (err: Error) => {
      done(fail(`failed to launch ${bin}: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      const exit = code ?? 1;
      const parsed = parseSidecarObject(stdout);
      if (!parsed) {
        const tail = (stderr.trim() || stdout.trim() || `exit ${exit}`).slice(-300);
        done(fail(`sidecar produced no JSON object (${tail})`, exit || 2));
        return;
      }
      const envelope = {
        ...(parsed as Record<string, unknown>),
        command: typeof parsed.command === "string" ? parsed.command : verb,
        ok: parsed.ok !== false,
      } as T;
      done(envelope);
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * spawnKernelSidecar — the PERSISTENT-process variant for kernel.py serve (APP-044).
 *
 * Unlike runSidecar (one-shot, one JSON object, SIGKILL timeout), the live Jupyter
 * kernel is a LONG-LIVED child that speaks an NDJSON *event stream* on stdout (one
 * JSON object per line) and reads one JSON request per stdin line. This DELIBERATELY
 * deviates from C7's one-object rule (documented in CONTRACT.md ## kernel.py), so we
 * MUST NOT reuse parseSidecarObject's last-object scanner — it would misparse the
 * stream. We line-buffer instead and hand each event to subscribers.
 *
 * Fail-closed: if the process dies with cells in flight, we synthesize a terminal
 * done{status:"error"} for each so a caller waiting on a cell never hangs. dispose()
 * kills the whole process TREE (the child ipykernel is a separate grandchild) via the
 * detached process group, so no orphan kernel survives the app.
 * ────────────────────────────────────────────────────────────────────────── */

/** One NDJSON event off kernel.py serve (ready/status/stream/…/done/error/vars/inspect). */
export interface KernelEvent {
  event: string;
  id?: string | null;
  [k: string]: unknown;
}

/** One request written to kernel.py serve (one JSON object per stdin line). */
export interface KernelRequest {
  op: "execute" | "interrupt" | "restart" | "shutdown" | "vars" | "inspect" | "dataframe";
  id?: string;
  code?: string;
  name?: string;
  /** APP-088 dataframe paging window. */
  offset?: number;
  limit?: number;
}

export interface KernelSidecarOptions {
  pythonBin?: string;
  sidecarDir?: string;
  /** Absolute override for the script path (tests point this at a fake NDJSON emitter). */
  scriptPath?: string;
  /** Extra `serve` args appended verbatim, e.g. ["--kernel", "python3"]. */
  args?: string[];
  cwd?: string;
  /** Extra env merged on top of safeChildEnv (used by tests to pass fixture knobs). */
  env?: NodeJS.ProcessEnv;
}

export interface KernelSidecar {
  readonly pid: number | undefined;
  /** Subscribe to events; returns an unsubscribe fn. */
  on(listener: (e: KernelEvent) => void): () => void;
  send(req: KernelRequest): void;
  execute(id: string, code: string): void;
  interrupt(): void;
  restart(): void;
  vars(): void;
  inspect(name: string): void;
  /** APP-088: request a paged view of a DataFrame-like variable → a `dataframe` event. */
  dataframe(name: string, offset: number, limit: number): void;
  /** Kill the process tree (SIGTERM → SIGKILL grace); resolves `exited`. */
  dispose(): void;
  readonly exited: Promise<number | null>;
}

/** Hard ceiling on a single NDJSON line — a runaway line without a newline is fail-closed. */
const MAX_KERNEL_LINE_BYTES = 24 * 1024 * 1024;

/**
 * How much of the kernel's stderr to keep for diagnostics. The stream itself is ALWAYS
 * drained in full (see the wiring below — that is the point); only what we retain is capped,
 * because the volume is unbounded and the diagnostic value is in the last few KiB.
 */
const MAX_KERNEL_STDERR_TAIL = 8 * 1024;

export function spawnKernelSidecar(opts: KernelSidecarOptions = {}): KernelSidecar {
  const dir = resolveSidecarDir(opts.sidecarDir);
  const scriptPath = opts.scriptPath ?? join(dir, "kernel.py");
  const bin = opts.pythonBin || process.env.PYTHON || process.env.PYTHON_BIN || "python3";

  const listeners = new Set<(e: KernelEvent) => void>();
  /** Cells whose execute has been sent but whose terminal `done` has not yet arrived. */
  const inFlight = new Set<string>();
  let disposed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  let resolveExit: (code: number | null) => void;
  const exited = new Promise<number | null>((r) => {
    resolveExit = r;
  });

  // Replay buffer: a single stdout chunk can carry ready+stream+done at once, and a
  // consumer may subscribe a beat late (or re-subscribe between events). Events emitted
  // while there are ZERO listeners are retained (capped) and flushed to the next
  // subscriber, so no early event is ever silently dropped.
  const pending: KernelEvent[] = [];
  const MAX_PENDING = 4096;

  const emit = (e: KernelEvent): void => {
    if (listeners.size === 0) {
      pending.push(e);
      if (pending.length > MAX_PENDING) pending.shift();
      return;
    }
    for (const l of listeners) {
      try {
        l(e);
      } catch {
        /* a bad subscriber must not break the stream */
      }
    }
  };

  let child: ChildProcess | undefined;
  if (!existsSync(scriptPath)) {
    // Fail-closed WITHOUT a child: report a fatal error and a resolved exit.
    queueMicrotask(() => {
      emit({
        event: "error",
        id: null,
        fatal: true,
        error: `kernel script not found: ${scriptPath}`,
      });
      resolveExit(null);
    });
  } else {
    try {
      child = spawn(bin, [scriptPath, "serve", ...(opts.args ?? [])], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: opts.cwd,
        env: safeChildEnv(opts.env),
        // Own the process GROUP so dispose() can kill the ipykernel grandchild too.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      queueMicrotask(() => {
        emit({
          event: "error",
          id: null,
          fatal: true,
          error: `failed to launch ${bin}: ${(err as Error).message}`,
        });
        resolveExit(null);
      });
    }
  }

  if (child) {
    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_KERNEL_LINE_BYTES) {
        emit({
          event: "error",
          id: null,
          fatal: true,
          error: "kernel emitted an oversized NDJSON line — aborted",
        });
        buf = "";
        dispose();
        return;
      }
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt: KernelEvent | null = null;
        try {
          const o = JSON.parse(line);
          if (o && typeof o === "object" && typeof o.event === "string") evt = o as KernelEvent;
        } catch {
          /* a non-JSON line on stdout is noise (kernel banners); ignore it */
        }
        if (!evt) continue;
        if (evt.event === "done" && typeof evt.id === "string") inFlight.delete(evt.id);
        emit(evt);
      }
    });

    // stderr MUST be drained. A Node stdio stream with no `data` listener never starts
    // flowing, so the OS pipe buffer (~64 KiB) fills and the WRITER blocks in write(2)
    // forever. kernel.py's own log() writes here, and — worse — KernelManager.start_kernel()
    // passes no stdout/stderr to jupyter_client, so the ipykernel GRANDCHILD inherits this
    // very fd, as does anything a notebook cell shells out to. Unlike runSidecar there is no
    // timeout on this path, so that hang is permanent, silent, and only escapable by killing
    // the app. The sibling `child.stdout` wiring above was always correct; this was an
    // omission, not a design choice.
    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-MAX_KERNEL_STDERR_TAIL);
    });
    child.stderr?.on("error", () => {
      /* the pipe closed under us — `close` below still fail-closes every in-flight cell */
    });

    // An async EPIPE/ECONNRESET on stdin is an unhandled 'error' event, which is FATAL to the
    // whole process by default. `write()`'s try/catch only covers the synchronous throw.
    child.stdin?.on("error", () => {
      /* the kernel went away mid-write — `close` reports it through the normal path */
    });

    child.on("error", (err: Error) => {
      emit({
        event: "error",
        id: null,
        fatal: true,
        error: `kernel process error: ${err.message}`,
      });
    });

    child.on("close", (code: number | null) => {
      if (killTimer) clearTimeout(killTimer);
      // Fail-closed: any cell still in flight gets a synthetic terminal error.
      // Carry the stderr tail: a kernel that dies mid-cell used to be diagnostically blind.
      const tail = stderrTail.trim().slice(-1024);
      for (const id of inFlight) {
        emit({
          event: "done",
          id,
          status: "error",
          error: tail
            ? `kernel exited before the cell finished: ${tail}`
            : "kernel exited before the cell finished",
          execution_count: null,
        });
      }
      inFlight.clear();
      emit({ event: "exit", id: null, code, ...(tail ? { stderr: tail } : {}) });
      resolveExit(code);
    });
  }

  const write = (req: KernelRequest): void => {
    if (disposed || !child?.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify(req)}\n`);
    } catch {
      /* the pipe closed under us — the close handler will fail-close in-flight cells */
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    // Ask the kernel to shut its own ipykernel down cleanly first. This MUST precede the
    // latch: `write` itself early-returns on `disposed`, so setting the flag first made the
    // graceful shutdown a no-op and every kernel was killed by signal instead.
    write({ op: "shutdown" });
    disposed = true;
    const pid = child?.pid;
    const killGroup = (signal: NodeJS.Signals): void => {
      // `pid > 1`, not just non-null: `process.kill(-1, …)` is kill(2)'s broadcast — every process
      // this uid owns — and `-0` is the caller's own group. A ChildProcess pid can never be either,
      // so this is a no-op guard; it matches what exec-runner/child-reaper/orphan-guard-boot already
      // do, and the one signalling primitive in this repo that lacked it wiped the desktop four
      // times (see signalPid in ./model-server.ts).
      if (pid == null || !Number.isInteger(pid) || pid <= 1) return;
      try {
        // Negative pid → the whole detached group (kernel.py + its ipykernel child).
        if (process.platform !== "win32") process.kill(-pid, signal);
        else child?.kill(signal);
      } catch {
        try {
          child?.kill(signal);
        } catch {
          /* already dead */
        }
      }
    };
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), 2000);
    if (typeof killTimer.unref === "function") killTimer.unref();
  };

  const api: KernelSidecar = {
    get pid() {
      return child?.pid;
    },
    on(listener) {
      listeners.add(listener);
      // Flush any events buffered while no one was listening, in arrival order.
      if (pending.length) {
        const drain = pending.splice(0, pending.length);
        for (const e of drain) {
          try {
            listener(e);
          } catch {
            /* a bad subscriber must not break the stream */
          }
        }
      }
      return () => listeners.delete(listener);
    },
    send: write,
    execute(id, code) {
      if (id) inFlight.add(id);
      write({ op: "execute", id, code });
    },
    interrupt() {
      write({ op: "interrupt" });
    },
    restart() {
      inFlight.clear();
      write({ op: "restart" });
    },
    vars() {
      write({ op: "vars" });
    },
    inspect(name) {
      write({ op: "inspect", name });
    },
    dataframe(name, offset, limit) {
      write({ op: "dataframe", name, offset, limit });
    },
    dispose,
    exited,
  };
  return api;
}
