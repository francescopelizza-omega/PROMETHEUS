/**
 * scripts/capture-contract.mjs — snapshot the engine envelope contract (file 10 §6.4).
 *
 * Runs each read-only `--json` command through the REAL engine and records the
 * top-level envelope KEY SET (+ command/ok/exit) into
 * `packages/engine-bridge/contract/golden/<name>.json`. The committed goldens are the
 * canary: the contract test (contract-check.test.ts) re-runs the engine and fails
 * loudly if a documented key disappears (a rename like risk_score→score), catching
 * engine↔bridge drift in CI BEFORE it silently breaks the GUI.
 *
 * Engine resolution mirrors config.ts: PROMETHEUS_PY env, else the sibling repo root.
 * Run: node scripts/capture-contract.mjs   (regenerates the goldens; commit the diff).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const studio = resolve(here, "..");
const repoRoot = resolve(studio, "..");
const goldenDir = join(studio, "packages", "engine-bridge", "contract", "golden");

const PY = process.env.PROMETHEUS_PY || join(repoRoot, "prometheus.py");
const PYTHON = process.env.PROMETHEUS_PYTHON || process.env.PYTHON || "python3";

/** The read-only commands whose envelope contract we pin (file 10 §6.4). */
export const CONTRACT_COMMANDS = [
  { name: "list", argv: ["list"] },
  { name: "scan", argv: ["scan"] },
  { name: "matrix", argv: ["matrix"] },
  { name: "superscan", argv: ["superscan"] },
  { name: "vault-status", argv: ["vault", "status"] },
];

/** Recover the single JSON object from engine stdout (pure stdout under --json). */
export function parseEnvelope(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall back: take the largest {...} slice (defensive against stray output).
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function captureOne(cmd) {
  const res = spawnSync(PYTHON, [PY, "--json", "--no-color", ...cmd.argv], {
    encoding: "utf8",
    timeout: 180_000,
  });
  const obj = parseEnvelope(res.stdout ?? "");
  if (!obj || typeof obj !== "object") {
    return {
      command: cmd.name,
      argv: cmd.argv,
      error: "no JSON envelope",
      exitCode: res.status ?? -1,
    };
  }
  return {
    command: cmd.name,
    argv: cmd.argv,
    keys: Object.keys(obj).sort(),
    commandField: typeof obj.command === "string" ? obj.command : null,
    ok: obj.ok === true,
    exitCode: res.status ?? 0,
  };
}

if (process.argv[1]?.endsWith("capture-contract.mjs")) {
  if (!existsSync(PY)) {
    console.error(`capture-contract: engine not found at ${PY} (set PROMETHEUS_PY).`);
    process.exit(1);
  }
  mkdirSync(goldenDir, { recursive: true });
  for (const cmd of CONTRACT_COMMANDS) {
    const snapshot = captureOne(cmd);
    writeFileSync(join(goldenDir, `${cmd.name}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(
      `captured ${cmd.name}: ${snapshot.keys ? `${snapshot.keys.length} keys` : snapshot.error}`,
    );
  }
  console.log(`goldens → ${goldenDir}`);
}
