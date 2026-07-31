/**
 * venv-label.test.ts — the status-bar venv fact projection (APP-009).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { EnvelopeResult } from "../../shared/ipc-contract.js";
import { venvStatusLabel } from "./venv-label.js";

test("active env renders as py<version> (<name>)", () => {
  const res: EnvelopeResult = {
    ok: true,
    data: {
      envs: [
        { id: "sys", name: "system", pythonVersion: "3.11", active: false },
        { id: "prom", name: "prom", pythonVersion: "3.12", active: true },
      ],
    },
  };
  assert.equal(venvStatusLabel(res), "py3.12 (prom)");
});

test("fallbacks: version-only, name-only, id fallback", () => {
  assert.equal(
    venvStatusLabel({ ok: true, data: { envs: [{ active: true, pythonVersion: "3.10" }] } }),
    "py3.10",
  );
  assert.equal(venvStatusLabel({ ok: true, data: { envs: [{ active: true, name: "ml" }] } }), "ml");
  assert.equal(
    venvStatusLabel({ ok: true, data: { envs: [{ active: true, id: "env-1" }] } }),
    "env-1",
  );
});

test("gracefully absent: no active env, ok:false, junk shapes → undefined", () => {
  assert.equal(
    venvStatusLabel({ ok: true, data: { envs: [{ active: false, name: "x" }] } }),
    undefined,
  );
  assert.equal(venvStatusLabel({ ok: false, error: "engine down" }), undefined);
  assert.equal(venvStatusLabel({ ok: true, data: { envs: "junk" } } as EnvelopeResult), undefined);
  assert.equal(venvStatusLabel({ ok: true, data: { envs: [null, 42] } } as never), undefined);
  assert.equal(venvStatusLabel(undefined), undefined);
  assert.equal(venvStatusLabel({ ok: true } as EnvelopeResult), undefined);
});
