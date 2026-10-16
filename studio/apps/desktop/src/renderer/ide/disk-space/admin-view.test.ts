// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * admin-view.test.ts — what the Disk space panel says when an administrator session ends.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { adminEndMessage } from "./admin-view.js";

test("a session the human closed is a plain close, not an error", () => {
  assert.deepEqual(adminEndMessage({ ok: true, decision: "approved", exitCode: 143 }), {
    tone: "info",
    text: "disk-space (as administrator) closed.",
  });
});

test("not run: denied, timed out or refused each say why, and nothing ran", () => {
  assert.equal(
    adminEndMessage({ ok: false, decision: "denied" }).text,
    "Not opened — you denied it.",
  );
  assert.match(
    adminEndMessage({ ok: false, decision: "timeout", error: "no answer" }).text,
    /no answer.*nothing ran/i,
  );
  assert.match(
    adminEndMessage({ ok: false, decision: "refused", error: "no graphical password helper" }).text,
    /no graphical password helper/,
  );
});

test("the tool failing as root reports its code", () => {
  const m = adminEndMessage({
    ok: false,
    decision: "approved",
    exitCode: 1,
    error: "disk-space ended (exit 1)",
  });
  assert.equal(m.tone, "error");
  assert.match(m.text, /exit 1/);
});
