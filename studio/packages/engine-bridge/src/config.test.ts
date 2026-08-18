/**
 * config.test.ts — the engine-path resolver's env precedence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEngine } from "./config.js";

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
