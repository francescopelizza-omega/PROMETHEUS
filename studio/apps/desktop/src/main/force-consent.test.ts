// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import { test } from "node:test";

import { consentToForce, consentToWarn, setForceConsentForTests } from "./force-consent.js";

test("no force flag → untouched, and nobody is asked", async () => {
  let asked = 0;
  setForceConsentForTests(async () => {
    asked += 1;
    return true;
  });
  const arg = { id: "x" };
  assert.equal(await consentToForce({}, "c", arg), arg);
  assert.equal(asked, 0);
  setForceConsentForTests(null);
});

test("declined → every force flag cleared; approved → unchanged", async () => {
  setForceConsentForTests(async () => false);
  assert.deepEqual(await consentToForce({}, "c", { id: "x", force: true, confirmForce: true }), {
    id: "x",
    force: false,
    confirmForce: false,
  });
  setForceConsentForTests(async () => true);
  const arg = { id: "x", forced: true };
  assert.equal(await consentToForce({}, "c", arg), arg);
  setForceConsentForTests(null);
});

test("a nemesis WARN is accepted only by the person, shown its findings, invisibles spelled out", async () => {
  let seen = "";
  setForceConsentForTests(async (_s, _m, detail) => {
    seen = detail;
    return false;
  });
  assert.equal(
    await consentToWarn({}, "org/repo/m.gguf", ["chat template runs code", "x\u202ey"]),
    false,
  );
  assert.match(seen, /chat template runs code/);
  assert.doesNotMatch(seen, /\u202e/);
  setForceConsentForTests(async () => true);
  assert.equal(await consentToWarn({}, "m", []), true);
  setForceConsentForTests(null);
});
