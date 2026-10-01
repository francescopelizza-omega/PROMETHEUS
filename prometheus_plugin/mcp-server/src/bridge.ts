// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * bridge.ts — subprocess bridge to prometheus.py's `--json` surface.
 *
 * Every MCP tool routes through `runPrometheus(argv)`: it spawns the Python
 * engine with `--json` (so stdout is exactly one JSON object) and `--no-color`,
 * captures stdout, and parses it. Human/log text is on stderr and is surfaced
 * only when the run fails. No shell is used (`shell: false`) — argv is passed
 * verbatim, so plugin names etc. cannot inject shell syntax.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PrometheusResult {
  ok: boolean;
  command?: string;
  /** the parsed JSON object from prometheus.py (its full contract shape) */
  data: Record<string, unknown>;
  /** process exit code (0 ok · 1 findings/failures · 2 usage/error) */
  exitCode: number;
  /** human/log text the engine wrote to stderr (diagnostics only) */
  stderr: string;
}

export class BridgeError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "BridgeError";
  }
}

/** Resolve the python interpreter. Override with PROMETHEUS_PYTHON. */
function pythonBin(): string {
  return process.env.PROMETHEUS_PYTHON || "python3";
}

/**
 * Resolve prometheus.py. Order: PROMETHEUS_PY env → a few well-known sibling
 * locations relative to this package → fail with a clear message.
 */
/**
 * Where the engine lives, in precedence order.
 *
 * ── WHY THIS ORDER, AND WHY `~/ALPHA` IS LAST ───────────────────────────────────────────────
 *
 * This list used to end at `~/ALPHA/PROMETHEUS/prometheus.py` — the author's own directory
 * layout — and used it as the BEST-EFFORT DEFAULT when nothing else matched. On every other
 * machine that path does not exist, so the package's answer to "where is the engine" was a
 * guess about a filesystem it had never seen.
 *
 * Worse, the list never contained the one location the documented installer actually uses.
 * `install.sh` creates `$PROMETHEUS_HOME/engine/prometheus.py` and calls it "the documented
 * lookup lane"; `engine-bridge/locate.ts` resolves exactly that. So a user who installed the
 * supported way had the engine sitting in the supported place, and these three published
 * packages looked everywhere except there.
 *
 * The order now mirrors `engine-bridge/locate.ts`, which is the canonical resolver:
 *
 *   1. `PROMETHEUS_PY`            — an explicit answer always wins, and a wrong one is an ERROR
 *                                   rather than a silent fall-through to a guess.
 *   2. package-relative           — a source checkout being run in place.
 *   3. the working directory      — running from inside a clone.
 *   4. `$PROMETHEUS_HOME/engine`  — the documented lane the installer creates.
 *   5. `$PROMETHEUS_HOME/app`     — the checkout the installer clones.
 *   6. `~/.prometheus/{engine,app}` — the same two, for the default home.
 *   7. `~/ALPHA/PROMETHEUS`       — a legacy layout, kept so an existing install keeps working.
 *                                   It is LAST because it is one machine's convention, not a
 *                                   property of the software.
 *
 * `PROMETHEUS_HOME` is expanded for a leading `~`: the shell does not expand it inside a
 * variable, so `PROMETHEUS_HOME=~/prom` otherwise means a directory literally named `~`.
 */
function engineCandidates(cwdFirst: string[]): string[] {
  const rawHome = process.env.PROMETHEUS_HOME ?? "";
  const home = (process.env.HOME || homedir());
  const promHome = rawHome
    ? rawHome === "~"
      ? home
      : rawHome.startsWith("~/")
        ? join(home, rawHome.slice(2))
        : rawHome
    : "";
  const out = [...cwdFirst];
  for (const base of [promHome, join(home, ".prometheus")]) {
    if (!base) continue;
    out.push(join(base, "engine", "prometheus.py"));
    out.push(join(base, "app", "prometheus.py"));
  }
  out.push(join(home, "ALPHA", "PROMETHEUS", "prometheus.py"));
  return out;
}

/** The path named in an error when nothing was found — documented, never machine-specific. */
function documentedDefault(): string {
  return join((process.env.HOME || homedir()), ".prometheus", "engine", "prometheus.py");
}

export function resolvePrometheus(): string {
  const env = process.env.PROMETHEUS_PY;
  if (env) {
    if (!existsSync(env)) {
      throw new BridgeError(
        `PROMETHEUS_PY points at a missing file: ${env}`,
        "Set PROMETHEUS_PY to the absolute path of prometheus.py.",
      );
    }
    return env;
  }
  const candidates = engineCandidates([
    join(__dirname, "..", "..", "..", "prometheus.py"), // dist/ → mcp-server/ → prometheus_plugin/ → PROMETHEUS/
    join(process.cwd(), "prometheus.py"),
  ]);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new BridgeError(
    "could not locate prometheus.py",
    `Set PROMETHEUS_PY to its absolute path, or PROMETHEUS_HOME to your Prometheus home (the installer's default is ${documentedDefault()}).`,
  );
}

/**
 * Recover the engine's JSON envelope from stdout. Tries whole-string parse
 * first, then scans lines from last to first for one that parses to an object
 * with an `ok`/`command`/`error` key (our contract shape) — so leaked human
 * text before OR after the object cannot defeat parsing.
 */
export function parseEngineObject(text: string): Record<string, unknown> | null {
  const looksLikeEnvelope = (o: unknown): o is Record<string, unknown> =>
    !!o && typeof o === "object" && !Array.isArray(o) &&
    ("ok" in o || "command" in o || "error" in o);
  try {
    const whole = JSON.parse(text);
    if (looksLikeEnvelope(whole)) return whole;
  } catch {
    /* fall through to line scan */
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (looksLikeEnvelope(o)) return o;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

export interface RunOptions {
  /** seconds before the subprocess is killed (fail-closed). Default 600. */
  timeoutSec?: number;
  /** stdin to pass to the process (unused today; reserved). */
  input?: string;
}

/**
 * Run `python prometheus.py [globalFlags] <argv...> --json` and parse the one
 * JSON object it prints. `argv` is the FULL command line AFTER the program name,
 * i.e. it already includes any global flags (e.g. ["--dry-run","install","x"]).
 * `--json` and `--no-color` are prepended here so callers never forget them.
 */
export function runPrometheus(argv: string[], opts: RunOptions = {}): Promise<PrometheusResult> {
  const script = resolvePrometheus();
  const py = pythonBin();
  // global flags must precede the subcommand; prepend ours so they always do.
  const fullArgv = ["--json", "--no-color", ...argv];
  const timeoutMs = (opts.timeoutSec ?? 600) * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn(py, [script, ...fullArgv], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new BridgeError(`prometheus.py timed out after ${opts.timeoutSec ?? 600}s`, stderr.slice(-2000)));
    }, timeoutMs);

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BridgeError(`failed to launch ${py}: ${err.message}`,
        "Is Python installed and on PATH? Override with PROMETHEUS_PYTHON."));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new BridgeError(
          "prometheus.py produced no JSON on stdout (crashed before emitting)",
          stderr.slice(-2000) || `exit code ${exitCode}`));
        return;
      }
      // stdout is contractually ONE json object. If stray lines slipped in
      // (a leak bug, or a future regression), recover the engine object by
      // scanning ALL lines for the last one that parses to an object carrying
      // our envelope keys — robust to both prefix AND suffix corruption.
      const parsed = parseEngineObject(trimmed);
      if (!parsed) {
        reject(new BridgeError("prometheus.py stdout was not valid JSON", trimmed.slice(0, 500)));
        return;
      }
      resolve({
        ok: parsed.ok !== false,
        command: typeof parsed.command === "string" ? parsed.command : undefined,
        data: parsed,
        exitCode,
        stderr,
      });
    });
  });
}
