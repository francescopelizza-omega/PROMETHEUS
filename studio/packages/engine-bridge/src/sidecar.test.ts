import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
/**
 * sidecar.test.ts — PythonSidecar lifecycle tests (file 02 §4.2/§4.4):
 *   1) MUTATION-QUEUE SERIALIZATION: two `install` (op:"mutation") calls fired
 *      concurrently must NOT interleave — the second starts only after the first
 *      ENDs. Proven with a fake engine that brackets START/END into a shared log.
 *   2) READ-ONLY CONCURRENCY: two read-only ops DO overlap (interleave) — the
 *      queue only serialises mutations.
 *   3) cancelAll(): a long in-flight op is aborted and rejects fail-closed.
 *   4) health(): against the REAL engine, contractOk:true + a SCRIPT_VERSION
 *      (skips gracefully when the engine is not present on this host).
 */
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveEngine } from "./config.js";
import { isEngineError } from "./errors.js";
import { PythonSidecar } from "./sidecar.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = join(HERE, "__fixtures__", "fake-engine.mjs");

/** A sidecar whose "python" is `node` and whose "prometheus.py" is the fake. */
function fakeSidecar(logPath: string, sleepMs: number): PythonSidecar {
  // pythonBin = the node binary; the fake-engine is passed as prometheusPy (it
  // exists, so run.ts's existsSync pre-flight passes), and `node <fake> ...args`
  // executes the fake. Env carries the shared log + sleep for the fixture.
  return new PythonSidecar({
    pythonBin: process.execPath,
    prometheusPy: FAKE_ENGINE,
    // run.ts spawns with env:process.env, so set the fixture knobs there.
  });
}

test("MUTATION QUEUE: two installs do NOT interleave (serialized)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-mut-"));
  const log = join(dir, "order.log");
  writeFileSync(log, "");
  process.env.FAKE_ENGINE_LOG = log;
  process.env.FAKE_ENGINE_SLEEP_MS = "120";
  try {
    const sc = fakeSidecar(log, 120);
    // fire two mutations "at once" — the queue must run them one after another.
    const a = sc.exec(["install", "alpha"], { op: "mutation" });
    const b = sc.exec(["install", "bravo"], { op: "mutation" });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);

    const lines = readFileSync(log, "utf8").trim().split("\n");
    // A clean serialized run is START/END/START/END with NO nesting.
    // Assert every START is immediately followed by its matching END.
    assert.equal(lines.length, 4, `expected 4 bracket lines, got: ${lines.join(" | ")}`);
    assert.match(lines[0]!, /^START /);
    assert.match(lines[1]!, /^END /);
    assert.match(lines[2]!, /^START /);
    assert.match(lines[3]!, /^END /);
    // the first END's tag must match the first START's tag (no interleave).
    assert.equal(
      lines[0]?.slice(6),
      lines[1]?.slice(4),
      "first op must END before the second STARTs",
    );
  } finally {
    process.env.FAKE_ENGINE_LOG = undefined;
    process.env.FAKE_ENGINE_SLEEP_MS = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("READ-ONLY CONCURRENCY: two read-only ops DO overlap (interleave)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-ro-"));
  const log = join(dir, "order.log");
  writeFileSync(log, "");
  process.env.FAKE_ENGINE_LOG = log;
  process.env.FAKE_ENGINE_SLEEP_MS = "120";
  try {
    const sc = fakeSidecar(log, 120);
    const a = sc.exec(["scan"], { op: "readonly" });
    const b = sc.exec(["list"], { op: "readonly" });
    await Promise.all([a, b]);

    const lines = readFileSync(log, "utf8").trim().split("\n");
    // Overlapping ops produce START a / START b / END .. / END .. — the two
    // STARTs come before either END.
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, /^START /);
    assert.match(lines[1]!, /^START /, "second read-only op should START before the first ENDs");
  } finally {
    process.env.FAKE_ENGINE_LOG = undefined;
    process.env.FAKE_ENGINE_SLEEP_MS = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelAll(): aborts an in-flight op (rejects fail-closed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-cancel-"));
  const log = join(dir, "order.log");
  writeFileSync(log, "");
  process.env.FAKE_ENGINE_LOG = log;
  process.env.FAKE_ENGINE_SLEEP_MS = "5000"; // long enough to cancel mid-flight
  try {
    const sc = fakeSidecar(log, 5000);
    const p = sc.exec(["install", "slowpoke"], { op: "mutation" });
    // let the child actually spawn before cancelling.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sc.pending, 1, "one op should be in flight");
    sc.cancelAll();
    await assert.rejects(
      () => p,
      (e: unknown) => {
        assert.ok(isEngineError(e), "abort should surface as an EngineError");
        return true;
      },
    );
    assert.equal(sc.pending, 0, "in-flight set should be drained after cancel");
  } finally {
    process.env.FAKE_ENGINE_LOG = undefined;
    process.env.FAKE_ENGINE_SLEEP_MS = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health(): REAL engine reports contractOk + a SCRIPT_VERSION", async (t) => {
  const { prometheusPy } = resolveEngine();
  if (!existsSync(prometheusPy)) {
    t.skip(`engine not present at ${prometheusPy}`);
    return;
  }
  const sc = new PythonSidecar();
  const h = await sc.health({ timeoutMs: 120_000 });
  assert.equal(h.contractOk, true, `contract should hold; problems: ${h.problems.join("; ")}`);
  assert.ok(h.prometheus, "prometheus path+version should resolve");
  assert.match(h.prometheus?.version, /^\d+\.\d+\.\d+/, "version is a semver");
  assert.ok(h.python, "python should be resolvable when the contract probe ran");
  // nemesis presence is environment-dependent; just assert the field is well-formed.
  assert.equal(typeof h.nemesis.present, "boolean");
  assert.equal(typeof h.nemesis.path, "string");
});

test("health(): MISSING engine degrades (never throws) — contractOk:false + problems", async () => {
  const sc = new PythonSidecar({ prometheusPy: "/nonexistent/prometheus.py" });
  const h = await sc.health({ timeoutMs: 5_000 });
  assert.equal(h.contractOk, false);
  assert.equal(h.prometheus, null);
  assert.ok(h.problems.length > 0, "should record a setup hint");
  assert.match(h.problems.join(" "), /prometheus\.py not found/);
});
