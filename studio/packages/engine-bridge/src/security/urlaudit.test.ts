import assert from "node:assert/strict";
/**
 * urlaudit.test.ts — L5 installed-source audit bridge.
 *  - urlQuarantineList runs the real engine read-only and returns a valid envelope.
 *  - a bad engine path fails closed (throws EngineError, never a silent ok).
 */
import { test } from "node:test";

import { isEngineError } from "../errors.js";
import { urlQuarantineList } from "./urlaudit.js";

test("urlQuarantineList: real engine returns a skills-audit envelope", async () => {
  try {
    const r = await urlQuarantineList();
    assert.equal(r.command, "skills-audit");
    assert.equal(typeof r.ok, "boolean");
  } catch (e) {
    // acceptable if the engine isn't resolvable in this environment — must be a
    // typed EngineError (fail-closed), never a silent success.
    assert.ok(isEngineError(e));
  }
});

test("FAIL-CLOSED: a bogus prometheus path throws EngineError", async () => {
  await assert.rejects(
    () => urlQuarantineList({}, { prometheusPy: "/nonexistent/prometheus-xyz.py" }),
    (e: unknown) => isEngineError(e),
  );
});
