/**
 * locate.test.ts — enginePaths precedence (env → bundled → dev sibling chain).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { engineLanes, enginePaths } from "./locate.js";

test("dev fallback: no resourcesPath, no env → the sibling engine chain", () => {
  const p = enginePaths({ resourcesPath: undefined });
  assert.ok(p.py.endsWith("prometheus.py"));
  assert.ok(p.nemesis.endsWith("nemesis"));
  assert.ok(p.python.length > 0); // "python3" or an env interpreter
});

test("explicit overrides win over everything", () => {
  const p = enginePaths({
    prometheusPy: "/x/prometheus.py",
    nemesisBin: "/x/nemesis",
    pythonBin: "/x/python3",
    resourcesPath: "/ignored",
  });
  assert.equal(p.py, "/x/prometheus.py");
  assert.equal(p.nemesis, "/x/nemesis");
  assert.equal(p.python, "/x/python3");
});

test("bundled resources are used when present under resourcesPath", () => {
  const res = mkdtempSync(join(tmpdir(), "prom-res-"));
  mkdirSync(join(res, "engine"), { recursive: true });
  mkdirSync(join(res, "pyruntime", "bin"), { recursive: true });
  writeFileSync(join(res, "engine", "prometheus.py"), "#\n");
  writeFileSync(join(res, "engine", "nemesis"), "#\n");
  writeFileSync(join(res, "pyruntime", "bin", "python3"), "#\n");

  const p = enginePaths({ resourcesPath: res });
  assert.equal(p.py, join(res, "engine", "prometheus.py"));
  assert.equal(p.nemesis, join(res, "engine", "nemesis"));
  // python path is platform-specific; on posix it is pyruntime/bin/python3.
  if (process.platform !== "win32") {
    assert.equal(p.python, join(res, "pyruntime", "bin", "python3"));
  }
});

test("bundled is skipped when the file is absent → dev fallback", () => {
  const res = mkdtempSync(join(tmpdir(), "prom-empty-"));
  const p = enginePaths({ resourcesPath: res });
  assert.ok(p.py.endsWith("prometheus.py"));
  assert.ok(!p.py.startsWith(join(res, "engine"))); // bundled absent → not used
});

/* ── CLI-099: SEA / portable-binary engine discovery ────────────────────────────── */

test("CLI-099 SEA context: no resourcesPath, PROMETHEUS_HOME engine dir resolves py + nemesis", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-home-"));
  mkdirSync(join(home, "engine"), { recursive: true });
  writeFileSync(join(home, "engine", "prometheus.py"), "#\n");
  writeFileSync(join(home, "engine", "nemesis"), "#\n");
  // a SEA-like context: resourcesPath undefined (no Electron), promHome injected.
  const p = enginePaths({ resourcesPath: undefined, promHome: home });
  assert.equal(p.py, join(home, "engine", "prometheus.py"));
  assert.equal(p.nemesis, join(home, "engine", "nemesis"));
  const lanes = engineLanes({ resourcesPath: undefined, promHome: home });
  assert.equal(lanes.py, "prom-home");
  assert.equal(lanes.nemesis, "prom-home");
});

test("CLI-099 lane precedence: explicit env beats PROMETHEUS_HOME; absent home → sibling/path", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-home2-"));
  mkdirSync(join(home, "engine"), { recursive: true });
  writeFileSync(join(home, "engine", "prometheus.py"), "#\n");
  // explicit PROMETHEUS_PY wins over the PROMETHEUS_HOME hint.
  const withEnv = enginePaths({
    resourcesPath: undefined,
    promHome: home,
    prometheusPy: "/e/prometheus.py",
  });
  assert.equal(withEnv.py, "/e/prometheus.py");
  assert.equal(
    engineLanes({ resourcesPath: undefined, promHome: home, prometheusPy: "/e/prometheus.py" }).py,
    "env",
  );
  // no home + no env → the dev sibling/PATH fallback (unchanged behavior).
  const bare = engineLanes({ resourcesPath: undefined, promHome: undefined });
  assert.equal(bare.py, "sibling-or-path");
  assert.equal(bare.python, "sibling-or-path");
});

test("CLI-099 Electron resourcesPath still wins over PROMETHEUS_HOME (byte-identical behavior)", () => {
  const res = mkdtempSync(join(tmpdir(), "prom-res2-"));
  const home = mkdtempSync(join(tmpdir(), "prom-home3-"));
  mkdirSync(join(res, "engine"), { recursive: true });
  writeFileSync(join(res, "engine", "prometheus.py"), "#\n");
  mkdirSync(join(home, "engine"), { recursive: true });
  writeFileSync(join(home, "engine", "prometheus.py"), "#\n");
  const p = enginePaths({ resourcesPath: res, promHome: home });
  assert.equal(p.py, join(res, "engine", "prometheus.py")); // resources wins
  assert.equal(engineLanes({ resourcesPath: res, promHome: home }).py, "resources");
});
