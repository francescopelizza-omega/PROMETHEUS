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

export function resolvePrometheus(): string {
  const env = process.env.PROMETHEUS_PY;
  if (env && existsSync(env)) return env;
  const cands = [
    join(__dirname, "..", "..", "..", "prometheus.py"),
    join(process.cwd(), "prometheus.py"),
    join(homedir(), "ALPHA", "PROMETHEUS", "prometheus.py"),
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return env || join(homedir(), "ALPHA", "PROMETHEUS", "prometheus.py");
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
