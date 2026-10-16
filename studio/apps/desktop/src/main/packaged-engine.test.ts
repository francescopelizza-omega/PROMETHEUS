// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * packaged-engine.test.ts — a packaged Studio finds the engine, the Python sidecars,
 * disk_space.py and the bundled interpreter that `stage-engine.mjs` put under `<Resources>`.
 *
 * The staging half is exercised for real: the actual script stages into a temp dir, and the
 * env this module derives from that dir must point at files that exist and run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundledConfigPath, packagedEngineEnv, toEngineOverrides } from "./packaged-engine.js";

const STUDIO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function fakeResources(withPython = true): string {
  const res = mkdtempSync(join(tmpdir(), "prom-res-"));
  for (const f of [
    "engine/prometheus.py",
    "engine/nemesis",
    "engine/studio/python/sidecar/disk_map.py",
    ...(withPython ? ["pyruntime/bin/python3"] : []),
  ]) {
    mkdirSync(dirname(join(res, f)), { recursive: true });
    writeFileSync(join(res, f), "");
  }
  return res;
}

test("packaged: every engine path points into Resources", () => {
  const res = fakeResources();
  try {
    assert.deepEqual(packagedEngineEnv({ resourcesPath: res, env: {}, platform: "darwin" }), {
      PROMETHEUS_PY: join(res, "engine", "prometheus.py"),
      NEMESIS_BIN: join(res, "engine", "nemesis"),
      PROMETHEUS_SIDECAR_DIR: join(res, "engine", "studio", "python", "sidecar"),
      PROMETHEUS_PYTHON: join(res, "pyruntime", "bin", "python3"),
    });
  } finally {
    rmSync(res, { recursive: true, force: true });
  }
});

test("a value the user already set is never overridden", () => {
  const res = fakeResources();
  try {
    const out = packagedEngineEnv({
      resourcesPath: res,
      env: { PROMETHEUS_PYTHON: "/opt/py/bin/python3", PROMETHEUS_SIDECAR_DIR: "/x" },
      platform: "darwin",
    });
    assert.equal(out.PROMETHEUS_PYTHON, undefined);
    assert.equal(out.PROMETHEUS_SIDECAR_DIR, undefined);
    assert.ok(out.PROMETHEUS_PY);
  } finally {
    rmSync(res, { recursive: true, force: true });
  }
});

test("a missing file sets nothing for it (dev run: Electron's own Resources has no engine)", () => {
  const res = fakeResources(false);
  try {
    const out = packagedEngineEnv({ resourcesPath: res, env: {}, platform: "darwin" });
    assert.equal(out.PROMETHEUS_PYTHON, undefined);
  } finally {
    rmSync(res, { recursive: true, force: true });
  }
  assert.deepEqual(packagedEngineEnv({ resourcesPath: undefined, env: {} }), {});
});

test("Windows: the relocatable CPython is pyruntime/python.exe", () => {
  const res = mkdtempSync(join(tmpdir(), "prom-res-"));
  try {
    mkdirSync(join(res, "pyruntime"), { recursive: true });
    writeFileSync(join(res, "pyruntime", "python.exe"), "");
    const out = packagedEngineEnv({ resourcesPath: res, env: {}, platform: "win32" });
    assert.equal(out.PROMETHEUS_PYTHON, join(res, "pyruntime", "python.exe"));
  } finally {
    rmSync(res, { recursive: true, force: true });
  }
});

test("bundled config: the staged copy under engine/studio/config wins, else the dev tree", () => {
  const res = mkdtempSync(join(tmpdir(), "prom-res-"));
  try {
    const staged = join(res, "engine", "studio", "config", "providers.config.json");
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, "{}");
    assert.equal(bundledConfigPath("providers.config.json", res, "/dev/config"), staged);
    assert.equal(
      bundledConfigPath("serve-profiles.json", res, "/dev/config"),
      join("/dev/config", "serve-profiles.json"),
    );
    assert.equal(
      bundledConfigPath("x.json", undefined, "/dev/config"),
      join("/dev/config", "x.json"),
    );
  } finally {
    rmSync(res, { recursive: true, force: true });
  }
});

test("stage-engine.mjs stages the sidecars + disk_space.py where packagedEngineEnv and prometheus.py look", () => {
  const res = mkdtempSync(join(tmpdir(), "prom-stage-"));
  try {
    const r = spawnSync(
      process.execPath,
      [join(STUDIO, "scripts", "stage-engine.mjs"), "--out", join(res, "engine")],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const env = packagedEngineEnv({ resourcesPath: res, env: {}, platform: process.platform });
    const sidecar = env.PROMETHEUS_SIDECAR_DIR;
    assert.ok(sidecar, "the staged sidecar dir resolves");
    const names = readdirSync(sidecar);
    for (const want of ["disk_map.py", "_envelope.py", "testmgr.py", "repomap.py", "envmgr.py"]) {
      assert.ok(names.includes(want), `${want} staged`);
    }
    assert.ok(!names.some((n) => n.startsWith("test_")), "no test files shipped");
    assert.ok(!names.includes("__pycache__"), "no bytecode caches shipped");
    const tools = readdirSync(join(sidecar, "..", "tools")).sort();
    assert.deepEqual(tools, ["disk_space.py", "pty_host.py"]);
    // prometheus.py's cmd_disk_space resolves the sidecar relative to its own path
    const source = readFileSync(join(STUDIO, "..", "prometheus.py"), "utf8");
    assert.ok(source.includes('parent / "studio" / "python" / "sidecar" / "disk_map.py"'));
    const engine = join(res, "engine", "prometheus.py");
    assert.equal(env.PROMETHEUS_PY, engine);
    assert.ok(existsSync(join(dirname(engine), "studio", "python", "sidecar", "disk_map.py")));
    // and the staged copy RUNS from the staged layout (it finds ../tools/disk_space.py)
    const run = spawnSync("python3", [join(sidecar, "disk_map.py"), "mounts"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).ok, true);
  } finally {
    rmSync(res, { recursive: true, force: true });
  }
});

test("toEngineOverrides: the resolved paths become in-process overrides, and bytecode stays out of the bundle", () => {
  assert.deepEqual(
    toEngineOverrides({
      PROMETHEUS_PY: "/R/engine/prometheus.py",
      NEMESIS_BIN: "/R/engine/nemesis",
      PROMETHEUS_SIDECAR_DIR: "/R/engine/studio/python/sidecar",
      PROMETHEUS_PYTHON: "/R/pyruntime/bin/python3",
    }),
    {
      prometheusPy: "/R/engine/prometheus.py",
      nemesisBin: "/R/engine/nemesis",
      sidecarDir: "/R/engine/studio/python/sidecar",
      pythonBin: "/R/pyruntime/bin/python3",
      // a sidecar importing a module would otherwise write __pycache__ into the signed bundle
      childEnv: { PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  assert.deepEqual(toEngineOverrides({}), { childEnv: { PYTHONDONTWRITEBYTECODE: "1" } });
});
