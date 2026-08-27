import assert from "node:assert/strict";
import test from "node:test";

import { newSessionId } from "./session-id.js";

test("newSessionId: five dash-joined 10-hex-digit groups", () => {
  const id = newSessionId();
  assert.match(id, /^[0-9a-f]{10}(-[0-9a-f]{10}){4}$/);
});

test("newSessionId: distinct on every call", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
  assert.equal(ids.size, 50);
});
