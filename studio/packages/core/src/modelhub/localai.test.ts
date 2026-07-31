/**
 * localai.test.ts — the PURE typed view over the engine's `localai` v1 envelope (CLI-026).
 * Feeds the SAME golden envelope shape the engine emits + the engine-bridge client consumes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCALAI_ENVELOPE_VERSION,
  isNewerLocalaiEnvelope,
  parseLocalaiEnvelope,
} from "./localai.js";

test("parseLocalaiEnvelope: accepts a well-formed v1 audit envelope", () => {
  const env = parseLocalaiEnvelope({
    command: "localai",
    version: 1,
    action: "audit",
    ok: true,
    tools: [
      {
        tool: "ollama",
        name: "Ollama",
        track: "apps",
        mode: "local",
        patchable: false,
        recipe: "",
        note: "",
      },
    ],
    local_endpoints: { ollama: "http://127.0.0.1:11434/v1" },
    summary: { total: 1, paid: 0, patchable: 0 },
  });
  assert.ok(env);
  assert.equal(env?.action, "audit");
  assert.equal(env?.tools?.[0]?.tool, "ollama");
  assert.equal(env?.summary?.total, 1);
});

test("parseLocalaiEnvelope: rejects non-localai / version-less objects", () => {
  assert.equal(parseLocalaiEnvelope(null), null);
  assert.equal(parseLocalaiEnvelope({ command: "vault", version: 1, action: "x" }), null);
  assert.equal(parseLocalaiEnvelope({ command: "localai", action: "audit" }), null); // no version
  assert.equal(parseLocalaiEnvelope("not an object"), null);
});

test("isNewerLocalaiEnvelope: flags a version beyond this view", () => {
  const v1 = parseLocalaiEnvelope({ command: "localai", version: 1, action: "audit", ok: true });
  const v2 = parseLocalaiEnvelope({ command: "localai", version: 2, action: "audit", ok: true });
  assert.ok(v1 && !isNewerLocalaiEnvelope(v1));
  assert.ok(v2 && isNewerLocalaiEnvelope(v2));
  assert.equal(LOCALAI_ENVELOPE_VERSION, 1);
});
