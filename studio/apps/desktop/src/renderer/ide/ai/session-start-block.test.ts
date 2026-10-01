// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session-start-block.test.ts — the SessionStart capture rule.
 *
 * The property that matters most here is NOT that the block is injected; it is that the hooks
 * run exactly once. A SessionStart hook is a user-authored command that SPAWNS A PROCESS, so a
 * per-turn re-run turns one configured hook into one spawn per message.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionStartBlock } from "./session-start-block.js";

test("the block is empty until the hooks have run", () => {
  const b = createSessionStartBlock({ run: async () => "x" });
  assert.equal(b.current(), "");
  assert.equal(b.captured(), false);
});

test("a successful capture is replayed, not re-run", async () => {
  let runs = 0;
  const b = createSessionStartBlock({
    run: async () => {
      runs += 1;
      return "<session-start-hooks>\nsprint: CLI-090\n</session-start-hooks>";
    },
  });
  await b.refresh();
  await b.refresh();
  await b.refresh();
  assert.equal(runs, 1, "a hook is a spawn — it must not run once per turn");
  assert.match(b.current(), /sprint: CLI-090/);
});

test("two turns racing the first refresh still spawn the hooks only once", async () => {
  // The real shape: two messages sent in quick succession both reach refresh() before either
  // resolves. Marking `done` after the await would run the user's command twice.
  let runs = 0;
  let release: (v: string) => void = () => {};
  const b = createSessionStartBlock({
    run: () => {
      runs += 1;
      return new Promise<string>((r) => {
        release = r;
      });
    },
  });
  const a = b.refresh();
  const c = b.refresh();
  release("block");
  await Promise.all([a, c]);
  assert.equal(runs, 1);
});

test("no hooks configured yields an empty block, never the string 'undefined'", async () => {
  const b = createSessionStartBlock({ run: async () => undefined });
  await b.refresh();
  assert.equal(b.current(), "");
});

test("a hook runner that REJECTS leaves the session usable", async () => {
  // Core's runSessionStartHooks is documented never to throw, but the IPC hop between the
  // renderer and main can reject on its own. Fail-soft: no block, no thrown turn.
  const b = createSessionStartBlock({
    run: async () => {
      throw new Error("ipc channel closed");
    },
  });
  await assert.doesNotReject(() => b.refresh());
  assert.equal(b.current(), "");
});

test("a rejected capture is NOT retried on the next turn", async () => {
  // Deliberate: a hook that fails once will fail the same way every turn, and retrying it per
  // message is the spawn-storm this module exists to prevent. `clear()` re-arms it.
  let runs = 0;
  const b = createSessionStartBlock({
    run: async () => {
      runs += 1;
      throw new Error("boom");
    },
  });
  await b.refresh();
  await b.refresh();
  assert.equal(runs, 1);
});

test("clear() re-arms the capture — a workspace change gets its own hook run", async () => {
  let runs = 0;
  const b = createSessionStartBlock({
    run: async () => {
      runs += 1;
      return `run-${runs}`;
    },
  });
  await b.refresh();
  assert.equal(b.current(), "run-1");
  b.clear();
  assert.equal(b.current(), "", "clear must drop the old workspace's block immediately");
  assert.equal(b.captured(), false);
  await b.refresh();
  assert.equal(b.current(), "run-2");
  assert.equal(runs, 2);
});
