/**
 * version.test.ts — VERSION.json parse + reconcile + About string (file 10 §5).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatAbout, parseEngineVersion, reconcileVersions } from "./version.js";

test("parseEngineVersion: fail-soft on bad JSON / missing engine", () => {
  const ok = parseEngineVersion(
    '{"engine":"0.15.0","studioBuilt":"abc123","builtAt":"2026-06-19T00:00:00Z"}',
  );
  assert.equal(ok?.engine, "0.15.0");
  assert.equal(ok?.studioBuilt, "abc123");
  assert.equal(parseEngineVersion("{not json"), null);
  assert.equal(parseEngineVersion("{}"), null); // no engine
  assert.equal(parseEngineVersion('{"engine":42}'), null); // wrong type
});

test("reconcileVersions + formatAbout", () => {
  const info = reconcileVersions({
    studio: "0.4.2",
    engineFile: { engine: "0.15.0", studioBuilt: "abc", builtAt: "x" },
    nemesisDbSeeded: "2026-06-14",
  });
  assert.equal(info.studio, "0.4.2");
  assert.equal(info.engine, "0.15.0");
  assert.equal(info.nemesisDbSeeded, "2026-06-14");
  assert.equal(formatAbout(info), "Studio 0.4.2 · Engine 0.15.0 · Nemesis DB seeded 2026-06-14");

  // engine absent → "unknown"; no DB seeded → omitted from the string
  const noEngine = reconcileVersions({ studio: "0.4.2", engineFile: null });
  assert.equal(noEngine.engine, "unknown");
  assert.equal(formatAbout(noEngine), "Studio 0.4.2 · Engine unknown");
});
