/**
 * home-servers-view.test.ts — Home server-row derivation (APP-008).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ServersResult } from "../../shared/ipc-contract.js";
import { nextServerOp, serverPill, serverRowViews } from "./home-servers-view.js";

test("nextServerOp: start on stopped/errored, stop on running/starting, none mid-stop", () => {
  assert.equal(nextServerOp("stopped"), "start");
  assert.equal(nextServerOp("errored"), "start");
  assert.equal(nextServerOp("running"), "stop");
  assert.equal(nextServerOp("starting"), "stop");
  assert.equal(nextServerOp("stopping"), null);
  assert.equal(nextServerOp("junk"), null);
});

test("serverPill: running=ok, transitions=degraded, errored=down, stopped=unknown", () => {
  assert.equal(serverPill("running"), "ok");
  assert.equal(serverPill("starting"), "degraded");
  assert.equal(serverPill("stopping"), "degraded");
  assert.equal(serverPill("errored"), "down");
  assert.equal(serverPill("stopped"), "unknown");
  assert.equal(serverPill(""), "unknown");
});

test("serverRowViews: projects rows with label fallback + lastError passthrough", () => {
  const rows = serverRowViews({
    ok: true,
    servers: [
      { id: "s1", label: "Ollama", state: "running", restarts: 0 },
      { id: "s2", state: "errored", restarts: 2, lastError: "launch guard: RAM > 90%" },
    ],
  } as ServersResult);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "s1",
    label: "Ollama",
    state: "running",
    pill: "ok",
    op: "stop",
    lastError: null,
  });
  assert.equal(rows[1]?.label, "s2"); // id fallback
  assert.equal(rows[1]?.op, "start");
  assert.equal(rows[1]?.lastError, "launch guard: RAM > 90%");
});

test("serverRowViews: ok:false / missing / junk envelopes yield [] and never throw", () => {
  assert.deepEqual(serverRowViews(undefined), []);
  assert.deepEqual(serverRowViews(null), []);
  assert.deepEqual(serverRowViews({ ok: false, servers: [] } as ServersResult), []);
  assert.deepEqual(serverRowViews({ ok: true } as ServersResult), []);
  const junk = serverRowViews({
    ok: true,
    servers: [null, { id: "" }, { id: "good", state: 42 }] as never,
  } as ServersResult);
  assert.equal(junk.length, 1);
  assert.equal(junk[0]?.state, "unknown");
  assert.equal(junk[0]?.op, null); // unknown state gets NO action — never guessed
});
