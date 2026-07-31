/**
 * bridge.test.ts — the engine-JSON envelope parser (CLI-035). Fixtures = recorded
 * `--json` envelopes; no live engine spawn. Ensures leaked human text before/after the
 * object never defeats parsing (the MCP bridge contract).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseEngineObject } from "./bridge.js";

test("parses a clean single JSON envelope", () => {
  const o = parseEngineObject('{"command":"doctor","ok":true,"os":"darwin"}');
  assert.equal(o?.command, "doctor");
  assert.equal(o?.ok, true);
});

test("recovers the envelope from leaked human text before/after it", () => {
  const stdout = [
    "nemesis: preparing…",
    "some human log line",
    '{"command":"secure","ok":true,"findings":0}',
    "OK done",
  ].join("\n");
  const o = parseEngineObject(stdout);
  assert.equal(o?.command, "secure");
  assert.equal(o?.findings, 0);
});

test("returns null when there is no envelope-shaped object", () => {
  assert.equal(parseEngineObject("just human text, no json"), null);
  assert.equal(parseEngineObject('{"random":"object"}'), null); // no ok/command/error key
});
