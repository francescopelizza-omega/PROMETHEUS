// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * packaged-engine.ts — point a PACKAGED Studio at the engine it ships.
 *
 * `stage-engine.mjs` stages the repo's layout verbatim under `<Resources>/engine/`
 * (`prometheus.py`, `nemesis`, `studio/config/`, `studio/python/{sidecar,tools}`), and
 * `fetch-pyruntime.mjs` ships a relocatable CPython under `<Resources>/pyruntime/`. Nothing used
 * to tell the main process: `resolveEngine` and `resolveSidecarDir` walk up from the asar looking
 * for a checkout, find none, and every sidecar-backed panel — tests, repo map, linters, coverage,
 * modelhub, disk space — failed with "sidecar not found" from the DMG while working from source.
 *
 * Main resolves these once, at startup, and only for what is (a) unset and (b) really on disk, so
 * a dev run (Electron's own Resources holds no engine) and a user's explicit override are both
 * untouched — then hands them to engine-bridge as in-process overrides (`toEngineOverrides`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const PACKAGED_ENGINE_KEYS = [
  "PROMETHEUS_PY",
  "NEMESIS_BIN",
  "PROMETHEUS_SIDECAR_DIR",
  "PROMETHEUS_PYTHON",
] as const;

export type PackagedEngineKey = (typeof PACKAGED_ENGINE_KEYS)[number];

export function packagedEngineEnv(opts: {
  resourcesPath: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}): Partial<Record<PackagedEngineKey, string>> {
  const res = opts.resourcesPath;
  if (!res) return {};
  const exists = opts.exists ?? existsSync;
  const win = (opts.platform ?? process.platform) === "win32";
  const engine = join(res, "engine");
  const candidates: Record<PackagedEngineKey, string> = {
    PROMETHEUS_PY: join(engine, "prometheus.py"),
    NEMESIS_BIN: join(engine, "nemesis"),
    PROMETHEUS_SIDECAR_DIR: join(engine, "studio", "python", "sidecar"),
    PROMETHEUS_PYTHON: join(res, "pyruntime", win ? "python.exe" : join("bin", "python3")),
  };
  const out: Partial<Record<PackagedEngineKey, string>> = {};
  for (const key of PACKAGED_ENGINE_KEYS) {
    if (opts.env[key]) continue;
    const path = candidates[key];
    if (exists(path)) out[key] = path;
  }
  return out;
}

/**
 * The same paths as engine-bridge overrides (`setEngineOverrides`): they steer this process's
 * resolvers and are NEVER exported to `process.env`, so the user's own terminal and the agent's
 * commands do not inherit the app bundle's engine. Python children of the engine never write
 * bytecode: a `__pycache__` written inside a signed app bundle breaks its seal.
 */
export function toEngineOverrides(p: Partial<Record<PackagedEngineKey, string>>): {
  prometheusPy?: string;
  nemesisBin?: string;
  sidecarDir?: string;
  pythonBin?: string;
  childEnv: Record<string, string>;
} {
  return {
    ...(p.PROMETHEUS_PY ? { prometheusPy: p.PROMETHEUS_PY } : {}),
    ...(p.NEMESIS_BIN ? { nemesisBin: p.NEMESIS_BIN } : {}),
    ...(p.PROMETHEUS_SIDECAR_DIR ? { sidecarDir: p.PROMETHEUS_SIDECAR_DIR } : {}),
    ...(p.PROMETHEUS_PYTHON ? { pythonBin: p.PROMETHEUS_PYTHON } : {}),
    childEnv: { PYTHONDONTWRITEBYTECODE: "1" },
  };
}

/**
 * A file from `studio/config/`: the staged copy (`<Resources>/engine/studio/config/`) in a
 * packaged build, else the dev tree. It used to look for `<Resources>/config/`, which nothing
 * ever staged, so a packaged build silently ran without its providers table.
 */
export function bundledConfigPath(
  file: string,
  resourcesPath: string | undefined,
  devConfigDir: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (resourcesPath) {
    for (const dir of [
      join(resourcesPath, "engine", "studio", "config"),
      join(resourcesPath, "config"),
    ]) {
      const p = join(dir, file);
      if (exists(p)) return p;
    }
  }
  return join(devConfigDir, file);
}
