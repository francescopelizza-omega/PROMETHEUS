/**
 * config.test.ts — the engine-path resolver's env precedence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPythonBin, engineChildEnv, resolveEngine, setEngineOverrides } from "./config.js";
import { resolveSidecarDir } from "./sidecar-runner.js";

test("resolveEngine honours PROMETHEUS_ENGINE as an alias for PROMETHEUS_PY", () => {
  // `doctor --bridge` told users to set $PROMETHEUS_ENGINE and nothing read it. Both names
  // work now, and PROMETHEUS_PY still wins when they disagree.
  const prev = { py: process.env.PROMETHEUS_PY, engine: process.env.PROMETHEUS_ENGINE };
  try {
    process.env.PROMETHEUS_PY = undefined as unknown as string;
    // biome-ignore lint/performance/noDelete: the resolver reads presence, not emptiness
    delete process.env.PROMETHEUS_PY;
    process.env.PROMETHEUS_ENGINE = "/opt/engine/prometheus.py";
    assert.equal(resolveEngine().prometheusPy, "/opt/engine/prometheus.py");

    process.env.PROMETHEUS_PY = "/explicit/prometheus.py";
    assert.equal(
      resolveEngine().prometheusPy,
      "/explicit/prometheus.py",
      "PROMETHEUS_PY must win over its alias",
    );
  } finally {
    // biome-ignore lint/performance/noDelete: restore absence, not emptiness
    if (prev.py === undefined) delete process.env.PROMETHEUS_PY;
    else process.env.PROMETHEUS_PY = prev.py;
    // biome-ignore lint/performance/noDelete: restore absence, not emptiness
    if (prev.engine === undefined) delete process.env.PROMETHEUS_ENGINE;
    else process.env.PROMETHEUS_ENGINE = prev.engine;
  }
});

test("defaultPythonBin: PROMETHEUS_PYTHON (the engine's own interpreter) wins, then PYTHON, PYTHON_BIN, python3", () => {
  // A packaged Studio sets PROMETHEUS_PYTHON to the CPython it ships; before, the sidecars and
  // the engine spawned a bare `python3` — on a Mac without the developer tools, a shim that
  // opens an install dialog instead of running anything.
  assert.equal(
    defaultPythonBin({ PROMETHEUS_PYTHON: "/R/pyruntime/bin/python3", PYTHON: "/p" }),
    "/R/pyruntime/bin/python3",
  );
  assert.equal(defaultPythonBin({ PYTHON: "/p", PYTHON_BIN: "/b" }), "/p");
  assert.equal(defaultPythonBin({ PYTHON_BIN: "/b" }), "/b");
  assert.equal(defaultPythonBin({}), "python3");
});

test("engine overrides: a packaged app points the resolvers at Resources WITHOUT exporting env", () => {
  // Studio used to Object.assign these into process.env, so every child — the user's own
  // terminal, the agent's commands — inherited them, and `prometheus` typed in Studio's
  // terminal drove the app bundle's engine. Overrides live in this process only.
  const keys = [
    "PROMETHEUS_PY",
    "PROMETHEUS_ENGINE",
    "PROMETHEUS_SIDECAR_DIR",
    "PROMETHEUS_PYTHON",
    "NEMESIS_BIN",
  ];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    // biome-ignore lint/performance/noDelete: the resolvers read presence, not emptiness
    for (const k of keys) delete process.env[k];
    setEngineOverrides({
      prometheusPy: "/R/engine/prometheus.py",
      nemesisBin: "/R/engine/nemesis",
      sidecarDir: "/R/engine/studio/python/sidecar",
      pythonBin: "/R/pyruntime/bin/python3",
      childEnv: { PYTHONDONTWRITEBYTECODE: "1" },
    });
    const e = resolveEngine();
    assert.equal(e.prometheusPy, "/R/engine/prometheus.py");
    assert.equal(e.nemesisBin, "/R/engine/nemesis");
    assert.equal(e.pythonBin, "/R/pyruntime/bin/python3");
    assert.equal(resolveSidecarDir(), "/R/engine/studio/python/sidecar");
    assert.equal(defaultPythonBin({}), "/R/pyruntime/bin/python3");
    assert.equal(process.env.PROMETHEUS_PY, undefined, "nothing was exported");
    // a python child never writes bytecode into the (signed) app bundle
    assert.equal(engineChildEnv().PYTHONDONTWRITEBYTECODE, "1");
    // an explicit env value still wins
    process.env.PROMETHEUS_PY = "/mine/prometheus.py";
    assert.equal(resolveEngine().prometheusPy, "/mine/prometheus.py");
    assert.equal(defaultPythonBin({ PROMETHEUS_PYTHON: "/mine/py" }), "/mine/py");
  } finally {
    setEngineOverrides({});
    for (const k of keys) {
      // biome-ignore lint/performance/noDelete: restore absence, not emptiness
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
  assert.equal(engineChildEnv().PYTHONDONTWRITEBYTECODE, process.env.PYTHONDONTWRITEBYTECODE);
});
