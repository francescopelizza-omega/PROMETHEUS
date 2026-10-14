// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import test from "node:test";
import { createHandover } from "./terminal-handover.js";

function fake() {
  const log: string[] = [];
  let live = true;
  const t = {
    log,
    kill: () => {
      live = false;
    },
    term: {
      isLive: () => live,
      giveAway: () => log.push("giveAway"),
      takeBack: () => log.push("takeBack"),
    },
  };
  return t;
}

test("suspend gives the terminal away once; resume takes it back once", () => {
  const f = fake();
  const h = createHandover(f.term);
  h.suspend();
  h.suspend();
  assert.equal(h.suspended, true);
  h.resume();
  h.resume();
  assert.equal(h.suspended, false);
  assert.deepEqual(f.log, ["giveAway", "takeBack"]);
});

test("a session that ended while the terminal was away is NOT re-taken (Ctrl+C during a root command)", () => {
  // Ctrl+C in cooked mode is SIGINT to the whole group: the app restores the terminal and
  // finishes, and THEN the killed child's close resumes. Re-entering raw mode and re-listening
  // on stdin at that point kept a dead session alive with a raw, cursor-less terminal.
  const f = fake();
  const h = createHandover(f.term);
  h.suspend();
  f.kill();
  h.resume();
  assert.deepEqual(f.log, ["giveAway"]);
  assert.equal(h.suspended, false);
});

test("resume without a suspend does nothing", () => {
  const f = fake();
  createHandover(f.term).resume();
  assert.deepEqual(f.log, []);
});
