/**
 * sidecar.ts — PythonSidecar (file 02 §4.2 / §4.4).
 *
 * The engine is STATELESS across invocations, so the sidecar is one spawned
 * process per command (no daemon). This object owns the cross-cutting lifecycle
 * concerns the raw run.ts layer does not:
 *
 *   - health()      resolve python/prometheus/nemesis + a read-only contract probe.
 *   - exec<T>()     wrap runPrometheus, threading the captured EngineConfig and the
 *                   per-op-class DEFAULT TIMEOUT, while tracking the in-flight child.
 *   - cancelAll()   abort every in-flight op (SIGTERM the children via AbortSignal;
 *                   run.ts hard-kills with SIGKILL on abort) — used on app-quit.
 *   - a SERIALIZED mutation queue so state-changing commands (install/uninstall/
 *     enable/disable) never race the same trust.json/config files, while read-only
 *     commands run concurrently (file 02 §4.4).
 *
 * GOLDEN RULE (C5): the sidecar decides NOTHING about safety. It only resolves,
 * spawns, times out (fail-closed), and serialises. Verdicts come from the engine.
 *
 * HEALTH CONTRACT NOTE (probed @ 0.15.0): `--json doctor` emits HUMAN TEXT, not a
 * JSON object. So the contract check uses `scan` (a real JSON read-only command),
 * NOT doctor. doctor is captured only as a raw human diagnostic. `--version`
 * yields the engine SCRIPT_VERSION for the health pill.
 */
import { existsSync } from "node:fs";

import { type EngineConfig, resolveEngine } from "./config.js";
import { EngineError } from "./errors.js";
import { type EngineEnvelope, type RunOptions, runPrometheus } from "./run.js";
import { detectEngineVersion } from "./version.js";

// --- per-op-class default timeouts (file 02 §4.2) --------------------------- //
/** read-only inventory/query ops (scan-as-probe excepted, see SCAN_TIMEOUT_MS). */
export const READONLY_TIMEOUT_MS = 60_000;
/** audit/scan/superscan — heavier read-only ops (gate fetches, re-clones). */
export const SCAN_TIMEOUT_MS = 120_000;
/** install/uninstall — the existing bridge default (catalog-wide ceiling). */
export const MUTATION_TIMEOUT_MS = 600_000;

/** The op class drives the default timeout AND whether the op is serialized. */
export type OpClass = "readonly" | "scan" | "mutation";

const TIMEOUT_BY_CLASS: Record<OpClass, number> = {
  readonly: READONLY_TIMEOUT_MS,
  scan: SCAN_TIMEOUT_MS,
  mutation: MUTATION_TIMEOUT_MS,
};

/** Options for one exec call. `op` selects the default timeout + serialization. */
export interface ExecOptions extends RunOptions {
  /** op class: "readonly" (default) | "scan" | "mutation". */
  op?: OpClass;
}

/** Resolved engine health, surfaced to the UI as a status pill (file 02 §4.2). */
export interface SidecarHealth {
  python: { bin: string; version: string } | null;
  prometheus: { path: string; version: string } | null;
  /** present:false => installs fail-closed; the GUI warns loudly. */
  nemesis: { path: string; present: boolean };
  /** does the --json contract behave (a real JSON envelope came back)? */
  contractOk: boolean;
  /** human-readable setup hints for the GUI (empty when fully green). */
  problems: string[];
}

/**
 * PythonSidecar — owns resolution, health, in-flight tracking, the mutation
 * queue, and cancellation for one engine target (captured EngineConfig).
 */
export class PythonSidecar {
  private readonly config: EngineConfig;

  /** every in-flight op's abort controller, for cancelAll(). */
  private readonly inFlight = new Set<AbortController>();

  /** tail of the serialized mutation chain; mutations await the previous one. */
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(config: EngineConfig = {}) {
    this.config = config;
  }

  /** Number of currently in-flight ops (test/diagnostic visibility). */
  get pending(): number {
    return this.inFlight.size;
  }

  /**
   * health() — resolve paths + probe the engine with READ-ONLY commands only.
   *
   * Uses `--version` for the engine SCRIPT_VERSION and a `scan` run to verify the
   * --json CONTRACT (doctor is NOT machine-readable, see file note). NEVER mutates
   * state. Never throws — every failure becomes a `problems[]` entry + a null/false
   * field, so the GUI can render amber/red instead of crashing.
   */
  async health(opts: { timeoutMs?: number } = {}): Promise<SidecarHealth> {
    const { prometheusPy, pythonBin, nemesisBin } = resolveEngine(this.config);
    const problems: string[] = [];
    const timeoutMs = opts.timeoutMs ?? READONLY_TIMEOUT_MS;

    // --- nemesis presence (resolvable file?) -------------------------------- //
    const nemesisPresent = existsSync(nemesisBin);
    if (!nemesisPresent) {
      problems.push(
        `nemesis not found at ${nemesisBin} — installs will fail-closed (set NEMESIS_BIN).`,
      );
    }

    // --- prometheus.py present? --------------------------------------------- //
    const promPresent = existsSync(prometheusPy);
    if (!promPresent) {
      problems.push(
        `prometheus.py not found at ${prometheusPy} — set PROMETHEUS_PY to its absolute path.`,
      );
      // Without the script there is nothing else to probe.
      return {
        python: null,
        prometheus: null,
        nemesis: { path: nemesisBin, present: nemesisPresent },
        contractOk: false,
        problems,
      };
    }

    // --- engine SCRIPT_VERSION (raw --version, fail-soft) ------------------- //
    const version = await detectEngineVersion(this.config, { timeoutMs });
    const prometheus = version.scriptVersion
      ? { path: prometheusPy, version: version.scriptVersion }
      : null;
    if (!version.scriptVersion) {
      problems.push(
        `could not read prometheus.py --version (got: ${version.raw.slice(0, 80) || "<empty>"}).`,
      );
    }

    // --- python + --json CONTRACT probe via a read-only `scan` -------------- //
    let contractOk = false;
    let python: { bin: string; version: string } | null = null;
    try {
      const env = await this.execReadonlyProbe(timeoutMs);
      contractOk = env.command === "scan" && env.ok === true && Array.isArray(env.agents);
      if (!contractOk) {
        problems.push("engine --json scan did not return the expected contract shape.");
      }
      // python ran => mark it resolvable. We do not have its version from scan;
      // the version pill uses the engine SCRIPT_VERSION above. Python "version"
      // mirrors the resolved interpreter token (a real version probe is a
      // future nicety; not needed for the pill).
      python = { bin: pythonBin, version: version.scriptVersion ? "ok" : "unknown" };
    } catch (e) {
      contractOk = false;
      const msg = e instanceof Error ? e.message : String(e);
      problems.push(`engine probe failed: ${msg}`);
      if (e instanceof EngineError && e.code === "spawn_failed") {
        problems.push(
          `is Python installed and on PATH (${pythonBin})? override with PYTHON/PYTHON_BIN.`,
        );
      } else {
        // python launched but the command failed: still resolvable.
        python = { bin: pythonBin, version: "unknown" };
      }
    }

    return {
      python,
      prometheus,
      nemesis: { path: nemesisBin, present: nemesisPresent },
      contractOk,
      problems,
    };
  }

  /** The read-only contract probe used by health(): a plain `scan`. */
  private execReadonlyProbe(timeoutMs: number): Promise<EngineEnvelope> {
    return runPrometheus<EngineEnvelope>(["scan"], { timeoutMs }, this.config);
  }

  /**
   * exec<T>(argv, opts) — run one engine command through run.ts.
   *
   * - Threads the captured EngineConfig so every op targets the same engine.
   * - Applies the per-op-class DEFAULT TIMEOUT unless the caller overrides timeoutMs.
   * - Tracks the in-flight child via an AbortController (linked to any caller signal)
   *   so cancelAll() can abort it; run.ts SIGKILLs the process on abort.
   * - SERIALIZES mutation-class ops through a single in-process queue (file 02 §4.4)
   *   so two installs can't race the same config files. Read-only ops run concurrently.
   */
  exec<T extends EngineEnvelope = EngineEnvelope>(
    argv: string[],
    opts: ExecOptions = {},
  ): Promise<T> {
    const op: OpClass = opts.op ?? "readonly";
    if (op === "mutation") {
      // Chain after the current tail; swallow the tail's outcome so one failing
      // mutation does not poison the queue for the next.
      const result = this.mutationTail.then(
        () => this.spawnTracked<T>(argv, opts),
        () => this.spawnTracked<T>(argv, opts),
      );
      // The tail advances regardless of THIS op's success/failure.
      this.mutationTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }
    return this.spawnTracked<T>(argv, opts);
  }

  /** Spawn one op with in-flight tracking + the per-class default timeout. */
  private spawnTracked<T extends EngineEnvelope>(argv: string[], opts: ExecOptions): Promise<T> {
    const op: OpClass = opts.op ?? "readonly";
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_BY_CLASS[op];

    const controller = new AbortController();
    // If the caller passed their own signal, abort ours when theirs fires.
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    this.inFlight.add(controller);

    const runOpts: RunOptions = {
      cwd: opts.cwd ?? this.config.cwd,
      timeoutMs,
      signal: controller.signal,
      onStderr: opts.onStderr,
      forced: opts.forced,
    };

    return runPrometheus<T>(argv, runOpts, this.config).finally(() => {
      this.inFlight.delete(controller);
    });
  }

  /**
   * cancelAll() — abort every in-flight op. Each op's AbortController fires;
   * run.ts handles the abort by SIGKILLing the child (after the OS-level SIGTERM
   * implied by kill). Used on app `before-quit` so a half-finished scan never
   * orphans a process.
   */
  cancelAll(): void {
    for (const c of this.inFlight) {
      try {
        c.abort();
      } catch {
        /* already aborted */
      }
    }
    this.inFlight.clear();
  }
}
