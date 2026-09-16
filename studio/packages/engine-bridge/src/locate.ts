/**
 * locate.ts — resolve the bundled-or-dev engine paths (file 10 §1).
 *
 * Extends config.ts's resolveEngine fallback chain (env → sibling → PATH) by
 * PREPENDING the packaged-app location: when the app is packaged, prometheus.py +
 * nemesis ride as `extraResources` under `process.resourcesPath/engine/`, and a
 * relocatable CPython lives under `process.resourcesPath/pyruntime/` (§1/§3). asar
 * is read-only and a child python can't exec a file inside it — so these are REAL
 * files on disk, resolved here.
 *
 * Precedence per path: explicit env (PROMETHEUS_PY / NEMESIS_BIN / PROMETHEUS_PYTHON)
 * → bundled resource (only if it actually exists) → the dev sibling chain
 * (resolveEngine). Never throws — a missing file is the spawn layer's fail-closed
 * concern. Pure + testable: `resourcesPath` is injectable (process.resourcesPath
 * is undefined outside Electron, so tests + dev fall straight through to the chain).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type EngineConfig, resolveEngine } from "./config.js";
import { expandHomeValue } from "./prom-home.js";

export interface EnginePaths {
  py: string;
  nemesis: string;
  python: string;
}

export interface EnginePathsOptions extends EngineConfig {
  /** override process.resourcesPath (Electron sets it; tests inject a fake dir). */
  resourcesPath?: string;
  /**
   * SEA / portable-binary engine hint (CLI-099): a single-file `prometheus` binary has NO
   * `resourcesPath` and no sibling checkout, so it resolves the engine from `$PROMETHEUS_HOME/engine/`
   * as a documented lane BELOW explicit env (PROMETHEUS_PY/NEMESIS_BIN) and ABOVE the dev sibling/PATH.
   * Defaults to `process.env.PROMETHEUS_HOME`. Electron's `resourcesPath` still wins when present.
   */
  promHome?: string;
}

/** Which lane resolved an engine path (for `doctor --bridge` to print). */
export type EngineLane = "env" | "resources" | "prom-home" | "sibling-or-path";

const isWin = process.platform === "win32";

function electronResourcesPath(): string | undefined {
  return (process as unknown as { resourcesPath?: string }).resourcesPath;
}

/** env value (if set) → bundled path (if it exists) → dev fallback. */
function pick(envValue: string | undefined, bundled: string | undefined, fallback: string): string {
  if (envValue) return envValue;
  if (bundled && existsSync(bundled)) return bundled;
  return fallback;
}

/**
 * The `{py, nemesis, python}` "bundled" paths (or undefined when neither an Electron `resourcesPath`
 * nor a SEA `$PROMETHEUS_HOME` is present). Electron's `resourcesPath` wins (byte-identical to before);
 * a portable/SEA binary falls to `$PROMETHEUS_HOME/engine/` (no pyruntime lane — python stays PATH).
 */
function bundledPaths(
  res: string | undefined,
  home: string | undefined,
): { py: string; nemesis: string; python?: string } | undefined {
  if (res) {
    return {
      py: join(res, "engine", "prometheus.py"),
      nemesis: join(res, "engine", "nemesis"),
      python: join(res, "pyruntime", isWin ? "python.exe" : join("bin", "python3")),
    };
  }
  if (home) {
    return { py: join(home, "engine", "prometheus.py"), nemesis: join(home, "engine", "nemesis") };
  }
  return undefined;
}

/**
 * Resolve the engine + interpreter paths for the current process. Packaged (Electron) bundled
 * resources win when present; a SEA binary falls to `$PROMETHEUS_HOME/engine/`; in dev neither
 * exists, so this returns exactly resolveEngine's env→sibling→PATH chain.
 */
export function enginePaths(opts: EnginePathsOptions = {}): EnginePaths {
  const res = opts.resourcesPath ?? electronResourcesPath();
  // Through the shared resolver: a `~`-prefixed or relative value used to be passed through
  // verbatim here, so `PROMETHEUS_HOME=~/prom` looked for the engine under a directory literally
  // named `~`. `expandHomeValue` keeps "unset" as undefined, which this lane needs — no home
  // means fall through to the sibling checkout / PATH, not to `~/.prometheus`.
  const home = expandHomeValue(opts.promHome ?? process.env.PROMETHEUS_HOME);
  const bundled = bundledPaths(res, home);

  const fallback = resolveEngine(opts);
  return {
    py: pick(opts.prometheusPy || process.env.PROMETHEUS_PY, bundled?.py, fallback.prometheusPy),
    nemesis: pick(
      opts.nemesisBin || process.env.NEMESIS_BIN,
      bundled?.nemesis,
      fallback.nemesisBin,
    ),
    python: pick(
      opts.pythonBin || process.env.PROMETHEUS_PYTHON,
      bundled?.python,
      fallback.pythonBin,
    ),
  };
}

/** The lane (env / resources / prom-home / sibling-or-path) that resolved each engine path — mirrors
 *  `enginePaths` precedence so `doctor --bridge` can PRINT how the engine was found (CLI-099). Pure. */
export function engineLanes(opts: EnginePathsOptions = {}): {
  py: EngineLane;
  nemesis: EngineLane;
  python: EngineLane;
} {
  const res = opts.resourcesPath ?? electronResourcesPath();
  // Through the shared resolver: a `~`-prefixed or relative value used to be passed through
  // verbatim here, so `PROMETHEUS_HOME=~/prom` looked for the engine under a directory literally
  // named `~`. `expandHomeValue` keeps "unset" as undefined, which this lane needs — no home
  // means fall through to the sibling checkout / PATH, not to `~/.prometheus`.
  const home = expandHomeValue(opts.promHome ?? process.env.PROMETHEUS_HOME);
  const bundled = bundledPaths(res, home);
  const bundledLane: EngineLane = res ? "resources" : "prom-home";
  const laneOf = (envValue: string | undefined, bundledPath: string | undefined): EngineLane => {
    if (envValue) return "env";
    if (bundledPath && existsSync(bundledPath)) return bundledLane;
    return "sibling-or-path";
  };
  return {
    py: laneOf(opts.prometheusPy || process.env.PROMETHEUS_PY, bundled?.py),
    nemesis: laneOf(opts.nemesisBin || process.env.NEMESIS_BIN, bundled?.nemesis),
    python: laneOf(opts.pythonBin || process.env.PROMETHEUS_PYTHON, bundled?.python),
  };
}
