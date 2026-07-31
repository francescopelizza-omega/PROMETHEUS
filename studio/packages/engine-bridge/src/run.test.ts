import assert from "node:assert/strict";
import { existsSync } from "node:fs";
/**
 * run.test.ts — two complementary tests:
 *  1) CONTRACT TEST: actually shell the REAL prometheus.py --json scan and assert
 *     a parsed envelope with command:"scan", ok:true, agents[]. Skips gracefully
 *     (does not fail) if the engine is not present on this host.
 *  2) FAIL-CLOSED TEST: a bad python bin / missing script => EngineError.
 * Also unit-tests parseEngineObject's last-to-first recovery.
 */
import { test } from "node:test";

import { createEngineClient } from "./client.js";
import { resolveEngine } from "./config.js";
import { type EngineError, isEngineError } from "./errors.js";
import { parseEngineObject, runPrometheus } from "./run.js";

test("parseEngineObject recovers the envelope last-to-first", () => {
  // leading + trailing human noise around the one JSON object
  const text =
    "loading rules...\n" + '{"command":"scan","ok":true,"agents":[]}\n' + "done in 0.3s\n";
  const o = parseEngineObject(text);
  assert.ok(o, "should recover an object");
  assert.equal(o?.command, "scan");
  assert.equal(o?.ok, true);
});

test("parseEngineObject returns null on no-envelope input", () => {
  assert.equal(parseEngineObject(""), null);
  assert.equal(parseEngineObject("not json at all\nstill not"), null);
  // a JSON object WITHOUT envelope keys is rejected
  assert.equal(parseEngineObject('{"hello":"world"}'), null);
});

test("CONTRACT: real prometheus.py --json scan returns command:scan ok:true agents[]", async (t) => {
  const { prometheusPy } = resolveEngine();
  if (!existsSync(prometheusPy)) {
    t.skip(`engine not present at ${prometheusPy}`);
    return;
  }
  const client = createEngineClient();
  const env = await client.scan({ timeoutMs: 120_000 });
  assert.equal(env.command, "scan");
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.agents), "agents[] must be present");
  // each agent carries name/present/where per the contract
  const agents = env.agents as Array<Record<string, unknown>>;
  if (agents.length) {
    const a = agents[0]!;
    assert.equal(typeof a.name, "string");
    assert.equal(typeof a.present, "boolean");
  }
});

test("FAIL-CLOSED: missing/bad prometheus.py path => EngineError(spawn_failed)", async () => {
  await assert.rejects(
    () => runPrometheus(["scan"], {}, { prometheusPy: "/nonexistent/prometheus.py" }),
    (e: unknown) => {
      assert.ok(isEngineError(e), "should be an EngineError");
      assert.equal((e as EngineError).code, "spawn_failed");
      assert.equal((e as EngineError).failClosed, true);
      return true;
    },
  );
});

test("FAIL-CLOSED: bad python interpreter => EngineError(spawn_failed)", async (t) => {
  const { prometheusPy } = resolveEngine();
  if (!existsSync(prometheusPy)) {
    t.skip("engine not present; cannot exercise bad-interpreter path");
    return;
  }
  await assert.rejects(
    () =>
      runPrometheus(["scan"], {}, { prometheusPy, pythonBin: "/nonexistent/python-binary-xyz" }),
    (e: unknown) => {
      assert.ok(isEngineError(e));
      assert.equal((e as EngineError).code, "spawn_failed");
      return true;
    },
  );
});
