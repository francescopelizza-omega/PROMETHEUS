import assert from "node:assert/strict";
/**
 * version.test.ts — file 01 §Open-Q7 version-skew negotiation coverage.
 *
 * Pure-logic tables (compareSemver / parseSemver / parseVersionLine /
 * negotiateCapabilities) run with zero I/O. The CONTRACT test spawns the REAL
 * prometheus.py to read its actual SCRIPT_VERSION and asserts a parsed semver,
 * so the probe stays grounded against the binary it must talk to.
 *
 * stdlib only: node:test + node:assert. No vitest, no third-party.
 */
import { existsSync } from "node:fs";
import test from "node:test";

import { resolveEngine } from "./config.js";
import {
  type EngineVersion,
  MIN_ENGINE,
  compareSemver,
  detectEngineVersion,
  negotiateCapabilities,
  parseSemver,
  parseVersionLine,
} from "./version.js";

// --- parseSemver ----------------------------------------------------------- //

test("parseSemver accepts x.y.z, a leading v, and pre-release/build suffixes", () => {
  assert.deepEqual(parseSemver("0.15.0"), { major: 0, minor: 15, patch: 0 });
  assert.deepEqual(parseSemver("v1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseSemver("2.0.0-rc.1"), { major: 2, minor: 0, patch: 0 });
  assert.deepEqual(parseSemver("2.0.0+build.9"), { major: 2, minor: 0, patch: 0 });
  assert.deepEqual(parseSemver("10.20.30"), { major: 10, minor: 20, patch: 30 });
});

test("parseSemver rejects garbage / partial / non-strings", () => {
  for (const bad of ["", "1", "1.2", "x.y.z", "1.2.3.4", "abc", null, undefined, 42, {}]) {
    assert.equal(parseSemver(bad as unknown), null, `expected null for ${String(bad)}`);
  }
});

// --- compareSemver table --------------------------------------------------- //

test("compareSemver orders by major, then minor, then patch", () => {
  const cases: Array<[string, string, -1 | 0 | 1]> = [
    ["0.15.0", "0.15.0", 0],
    ["0.15.0", "0.14.9", 1],
    ["0.14.9", "0.15.0", -1],
    ["1.0.0", "0.99.99", 1],
    ["0.99.99", "1.0.0", -1],
    ["0.15.1", "0.15.0", 1],
    ["0.15.0", "0.15.1", -1],
    ["2.3.4", "2.3.4", 0],
    ["10.0.0", "9.99.99", 1],
    ["v1.2.3", "1.2.3", 0], // leading v tolerated on both sides
    ["1.2.3-rc.1", "1.2.3", 0], // pre-release ignored for core compare
  ];
  for (const [a, b, want] of cases) {
    assert.equal(compareSemver(a, b), want, `compareSemver(${a}, ${b})`);
  }
});

test("compareSemver returns null when EITHER side is unparseable (fail closed)", () => {
  assert.equal(compareSemver("garbage", "0.15.0"), null);
  assert.equal(compareSemver("0.15.0", "nope"), null);
  assert.equal(compareSemver("", ""), null);
  assert.equal(compareSemver(null, undefined), null);
});

// --- parseVersionLine (argparse `<prog> <version>` line) ------------------- //

test("parseVersionLine pulls the trailing semver from a --version line", () => {
  assert.equal(parseVersionLine("prometheus.py 0.15.0"), "0.15.0");
  assert.equal(parseVersionLine("  prometheus.py   0.15.0  \n"), "0.15.0");
  assert.equal(parseVersionLine("prometheus v1.2.3"), "1.2.3"); // strips leading v
  // a prog name containing digits must not fool the right-to-left scan:
  assert.equal(parseVersionLine("tool2000 3.4.5"), "3.4.5");
});

test("parseVersionLine returns null when no semver token is present", () => {
  assert.equal(parseVersionLine(""), null);
  assert.equal(parseVersionLine("no version here"), null);
  assert.equal(parseVersionLine("prometheus.py"), null);
});

// --- negotiateCapabilities: older / newer / equal / garbage ---------------- //

test("negotiateCapabilities: engine EQUAL to MIN_ENGINE -> all flags on", () => {
  const caps = negotiateCapabilities({ scriptVersion: MIN_ENGINE, raw: "", parts: null });
  assert.equal(caps.compare, 0);
  assert.equal(caps.jsonContract, true);
  assert.equal(caps.supportsForcedDanger, true);
  assert.equal(caps.supportsVaultJson, true);
  assert.equal(caps.supportsWorldsim, true);
  assert.equal(caps.scriptVersion, MIN_ENGINE);
  assert.equal(caps.minEngine, MIN_ENGINE);
});

test("negotiateCapabilities: engine NEWER than MIN_ENGINE -> all flags on", () => {
  const caps = negotiateCapabilities("99.0.0");
  assert.equal(caps.compare, 1);
  assert.equal(caps.jsonContract, true);
  assert.equal(caps.supportsForcedDanger, true);
  assert.equal(caps.supportsVaultJson, true);
  assert.equal(caps.supportsWorldsim, true);
});

test("negotiateCapabilities: engine OLDER than MIN_ENGINE -> degrade, flags off", () => {
  const caps = negotiateCapabilities("0.0.1");
  assert.equal(caps.compare, -1);
  assert.equal(caps.jsonContract, false);
  assert.equal(caps.supportsForcedDanger, false);
  assert.equal(caps.supportsVaultJson, false);
  assert.equal(caps.supportsWorldsim, false);
});

test("negotiateCapabilities: GARBAGE / null version -> compare null, every flag off", () => {
  for (const bad of [
    "not-a-version",
    null,
    undefined,
    { scriptVersion: null, raw: "x", parts: null },
  ]) {
    const caps = negotiateCapabilities(bad as EngineVersion | string | null);
    assert.equal(caps.compare, null, `compare null for ${JSON.stringify(bad)}`);
    assert.equal(caps.jsonContract, false);
    assert.equal(caps.supportsForcedDanger, false);
    assert.equal(caps.supportsVaultJson, false);
    assert.equal(caps.supportsWorldsim, false);
  }
});

// --- degrade-gracefully: missing engine never throws ----------------------- //

test("detectEngineVersion on a MISSING engine resolves (never throws) scriptVersion:null", async () => {
  const v = await detectEngineVersion(
    { config: { prometheusPy: "/nonexistent/path/prometheus.py" } },
    { timeoutMs: 5_000 },
  );
  assert.equal(v.scriptVersion, null);
  assert.equal(v.parts, null);
  // and the capability map degrades, never crashes:
  const caps = negotiateCapabilities(v);
  assert.equal(caps.compare, null);
  assert.equal(caps.jsonContract, false);
});

// --- CONTRACT: read the REAL engine's SCRIPT_VERSION ----------------------- //

test("CONTRACT: real prometheus.py reports a parseable SCRIPT_VERSION", async (t) => {
  const { prometheusPy } = resolveEngine({});
  if (!existsSync(prometheusPy)) {
    t.skip(`prometheus.py not found at ${prometheusPy}`);
    return;
  }
  const v = await detectEngineVersion(undefined, { timeoutMs: 30_000 });
  assert.equal(typeof v.scriptVersion, "string", `raw probe was: ${JSON.stringify(v.raw)}`);
  assert.notEqual(v.scriptVersion, null);
  // the parsed value must itself be a valid semver triple:
  const parts = parseSemver(v.scriptVersion);
  assert.notEqual(parts, null, `SCRIPT_VERSION ${v.scriptVersion} is not a semver`);
  assert.equal(typeof parts?.major, "number");
  assert.equal(typeof parts?.minor, "number");
  assert.equal(typeof parts?.patch, "number");

  // negotiating against MIN_ENGINE must yield a concrete (non-null) decision.
  const caps = negotiateCapabilities(v);
  assert.notEqual(caps.compare, null);
  assert.ok([-1, 0, 1].includes(caps.compare as number));
});
