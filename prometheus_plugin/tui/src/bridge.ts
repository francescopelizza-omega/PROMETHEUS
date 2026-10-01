// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * bridge.ts — TUI ↔ prometheus.py --json bridge (subprocess, no shell).
 * Mirrors the MCP server's bridge: spawn the Python engine with --json/--no-color,
 * capture stdout, parse the single JSON object.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  const home = homedir();
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
  return join(homedir(), ".prometheus", "engine", "prometheus.py");
}

export function resolvePrometheus(): string {
  const env = process.env.PROMETHEUS_PY;
  if (env && existsSync(env)) return env;
  const cands = engineCandidates([
    join(__dirname, "..", "..", "..", "prometheus.py"),
    join(process.cwd(), "prometheus.py"),
  ]);
  for (const c of cands) if (existsSync(c)) return c;
  // Nothing found. Return what the user was TOLD to expect, so the failure names a path that
  // means something on their machine rather than one that only ever existed on the author's.
  return env || documentedDefault();
}

/** Recover the engine JSON envelope, robust to leaked text before/after it. */
function parseEngineObject(text: string): Record<string, unknown> | null {
  const ok = (o: unknown): o is Record<string, unknown> =>
    !!o && typeof o === "object" && !Array.isArray(o) &&
    ("ok" in o || "command" in o || "error" in o);
  try {
    const whole = JSON.parse(text);
    if (ok(whole)) return whole;
  } catch {
    /* fall through */
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (ok(o)) return o;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

export interface EngineResult<T = any> {
  ok: boolean;
  data: T;
  exitCode: number;
  stderr: string;
}

/**
 * Run prometheus.py once and resolve its single JSON object. argv already
 * includes any global flags + subcommand (e.g. ["--dry-run","install","x"]).
 */
export function runEngine<T = any>(argv: string[], timeoutSec = 600): Promise<EngineResult<T>> {
  const py = process.env.PROMETHEUS_PYTHON || "python3";
  const script = resolvePrometheus();
  const full = ["--json", "--no-color", ...argv];
  return new Promise((resolve, reject) => {
    const child = spawn(py, [script, ...full], { shell: false });
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(new Error(`engine timed out after ${timeoutSec}s`));
    }, timeoutSec * 1000);
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`failed to launch ${py}: ${e.message}`));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const trimmed = out.trim();
      if (!trimmed) {
        reject(new Error(err.trim().slice(-400) || "engine produced no JSON output"));
        return;
      }
      const data = parseEngineObject(trimmed);
      if (!data) {
        reject(new Error("engine stdout was not valid JSON"));
        return;
      }
      resolve({ ok: (data as any).ok !== false, data: data as any, exitCode: code ?? 1, stderr: err });
    });
  });
}
