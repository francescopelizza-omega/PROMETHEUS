import assert from "node:assert/strict";
/**
 * errors-kind.test.ts — the §3.5 EngineErrorKind alignment.
 *
 * Asserts every EngineError carries BOTH the established `.code` and the file-02
 * `.kind`, that the derivation is correct, that fromKind() round-trips, and that
 * failClosed matches the §3.5 semantics (forced-danger is NOT fail-closed).
 * Existing `.code`-based behaviour stays intact (the old tests still pass).
 */
import { test } from "node:test";

import {
  ENGINE_ERROR_KINDS,
  EngineError,
  type EngineErrorCode,
  type EngineErrorKind,
} from "./errors.js";

test("code -> kind derivation is correct for every legacy code", () => {
  const cases: Array<[EngineErrorCode, EngineErrorKind]> = [
    ["spawn_failed", "spawn-failed"],
    ["timeout", "timeout"],
    ["bad_json", "unparseable"],
    ["engine_error", "engine-error"],
    ["blocked", "gate-blocked"],
    ["nemesis_unavailable", "nemesis-unavailable"],
  ];
  for (const [code, kind] of cases) {
    const e = new EngineError("x", { code });
    assert.equal(e.kind, kind, `${code} should derive kind ${kind}`);
  }
});

test("explicit kind overrides the derived one (no-output vs unparseable share bad_json)", () => {
  const e = new EngineError("empty", { code: "bad_json", kind: "no-output" });
  assert.equal(e.kind, "no-output");
  assert.equal(e.code, "bad_json");
  assert.equal(e.failClosed, true);
});

test("fromKind() derives the legacy code and round-trips", () => {
  const e = EngineError.fromKind("gate-blocked", "blocked install", { exitCode: 2 });
  assert.equal(e.kind, "gate-blocked");
  assert.equal(e.code, "blocked");
  assert.equal(e.exitCode, 2);

  const fd = EngineError.fromKind("forced-danger", "override");
  assert.equal(fd.kind, "forced-danger");
  assert.equal(fd.code, "engine_error");
});

test("failClosed semantics: forced-danger and engine/gate are NOT fail-closed", () => {
  assert.equal(EngineError.fromKind("spawn-failed", "x").failClosed, true);
  assert.equal(EngineError.fromKind("timeout", "x").failClosed, true);
  assert.equal(EngineError.fromKind("no-output", "x").failClosed, true);
  assert.equal(EngineError.fromKind("unparseable", "x").failClosed, true);
  assert.equal(EngineError.fromKind("nemesis-unavailable", "x").failClosed, true);

  assert.equal(EngineError.fromKind("engine-error", "x").failClosed, false);
  assert.equal(EngineError.fromKind("gate-blocked", "x").failClosed, false);
  assert.equal(EngineError.fromKind("forced-danger", "x").failClosed, false);
});

test("ENGINE_ERROR_KINDS lists all 8 §3.5 kinds", () => {
  assert.equal(ENGINE_ERROR_KINDS.length, 8);
  assert.ok(ENGINE_ERROR_KINDS.includes("forced-danger"));
  assert.ok(ENGINE_ERROR_KINDS.includes("no-output"));
});
