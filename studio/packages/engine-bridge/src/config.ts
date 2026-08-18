/**
 * config.ts — locate the Python engine + nemesis binary.
 *
 * resolveEngine honours env overrides first (PROMETHEUS_PY — or its PROMETHEUS_ENGINE
 * alias — PYTHON/PYTHON_BIN,
 * NEMESIS_BIN) then falls back to the sibling engine that ships next to this
 * monorepo: `<repo>/{prometheus.py,nemesis}`, found by walking up from this module.
 * prometheus.py lives next to nemesis, so a single PROMETHEUS root locates both.
 *
 * The last-resort root is a RELATIVE walk, never an absolute path. An absolute
 * developer path baked in here does not just fail to resolve on anyone else's
 * machine — it is compiled verbatim into the published CLI bundle and into the
 * Electron app.asar, where it publishes the author's username and home layout to
 * everyone who downloads a release.
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

/** How far up from this module the PROMETHEUS root sits: …/studio/packages/engine-bridge/(src|dist). */
const UP_TO_ROOT = 4;

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
 *
 * When the walk finds no engine (a bundled CLI whose `import.meta.url` is a synthetic
 * path, a SEA binary, an installed npm package), it returns the walked directory anyway:
 * a wrong RELATIVE guess simply fails `existsSync` upstream and the caller falls through
 * to the env / PATH lanes, whereas a wrong ABSOLUTE guess would ship someone's home
 * directory to every user. `process.cwd()` is the final fallback — local to whoever runs it.
 */
function siblingRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const guess = resolve(here, ...Array<string>(UP_TO_ROOT).fill(".."));
    if (existsSync(join(guess, "prometheus.py"))) return guess;
    return guess;
  } catch {
    /* import.meta.url unavailable in some test harnesses — fall through */
  }
  return process.cwd();
}

/**
 * Resolve engine paths. Env overrides win; otherwise default to the sibling
 * engine. The returned paths are NOT guaranteed to exist — the spawn layer
 * turns a missing file into a fail-closed EngineError.
 */
export function resolveEngine(config: EngineConfig = {}): ResolvedEngine {
  const root = siblingRoot();

  /**
   * `PROMETHEUS_ENGINE` is honoured as an alias for `PROMETHEUS_PY`.
   *
   * Not a nicety: `doctor --bridge` told users to "set $PROMETHEUS_ENGINE" when it could not
   * find the engine, and NOTHING in the codebase ever read that variable. A user following the
   * remedy exactly got the identical failure back, with no way to tell whether they had
   * mistyped the path or the advice. The remedy now names the real variable — and the name it
   * used to name keeps working, because someone out there has it exported.
   */
  const prometheusPy =
    config.prometheusPy ||
    process.env.PROMETHEUS_PY ||
    process.env.PROMETHEUS_ENGINE ||
    firstExisting(join(root, "prometheus.py")) ||
    join(root, "prometheus.py");

  const pythonBin = config.pythonBin || process.env.PYTHON || process.env.PYTHON_BIN || "python3";

  const nemesisBin =
    config.nemesisBin ||
    process.env.NEMESIS_BIN ||
    firstExisting(join(root, "nemesis")) ||
    join(root, "nemesis");

  return { prometheusPy, pythonBin, nemesisBin };
}
