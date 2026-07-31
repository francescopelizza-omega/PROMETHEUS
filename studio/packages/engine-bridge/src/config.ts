/**
 * config.ts — locate the Python engine + nemesis binary.
 *
 * resolveEngine honours env overrides first (PROMETHEUS_PY, PYTHON/PYTHON_BIN,
 * NEMESIS_BIN) then falls back to the sibling engine that ships next to this
 * monorepo: /Users/dev/ALPHA/PROMETHEUS/{prometheus.py,nemesis}.
 * prometheus.py lives next to nemesis, so a single PROMETHEUS root locates both.
 *
 * Resolution NEVER throws here — a missing binary is the spawn layer's concern,
 * where it becomes a fail-closed EngineError. This keeps config pure/testable.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EngineConfig {
  prometheusPy?: string;
  pythonBin?: string;
  nemesisBin?: string;
  defaultTimeoutMs?: number;
  cwd?: string;
}

export interface ResolvedEngine {
  prometheusPy: string;
  pythonBin: string;
  nemesisBin: string;
}

/** Default install root: prometheus.py and nemesis live side by side here. */
const SIBLING_ROOT = "/Users/dev/ALPHA/PROMETHEUS";

/** Default fail-closed subprocess timeout (C / bridge.ts: 600s). */
export const DEFAULT_TIMEOUT_MS = 600_000;

function firstExisting(...candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Best-effort guess at the sibling PROMETHEUS root, walking up from this module.
 * studio/packages/engine-bridge/(src|dist) -> … -> studio -> PROMETHEUS.
 * Falls back to the hard-coded SIBLING_ROOT.
 */
function siblingRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // …/studio/packages/engine-bridge/src  (or /dist) → up 4 = …/PROMETHEUS
    const guess = resolve(here, "..", "..", "..", "..");
    if (existsSync(join(guess, "prometheus.py"))) return guess;
  } catch {
    /* import.meta.url unavailable in some test harnesses — fall through */
  }
  return SIBLING_ROOT;
}

/**
 * Resolve engine paths. Env overrides win; otherwise default to the sibling
 * engine. The returned paths are NOT guaranteed to exist — the spawn layer
 * turns a missing file into a fail-closed EngineError.
 */
export function resolveEngine(config: EngineConfig = {}): ResolvedEngine {
  const root = siblingRoot();

  const prometheusPy =
    config.prometheusPy ||
    process.env.PROMETHEUS_PY ||
    firstExisting(join(root, "prometheus.py"), join(SIBLING_ROOT, "prometheus.py")) ||
    join(SIBLING_ROOT, "prometheus.py");

  const pythonBin = config.pythonBin || process.env.PYTHON || process.env.PYTHON_BIN || "python3";

  const nemesisBin =
    config.nemesisBin ||
    process.env.NEMESIS_BIN ||
    firstExisting(join(root, "nemesis"), join(SIBLING_ROOT, "nemesis")) ||
    join(SIBLING_ROOT, "nemesis");

  return { prometheusPy, pythonBin, nemesisBin };
}
