/**
 * memory-block.test.ts — a fact the agent records must be visible to the rest of the session.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createMemoryBlock } from "./memory-block.js";

test("a memory_write during the session is visible on the next turn", async () => {
  /**
   * The pane read `memory_read` ONCE per workspace root into a ref and never again, so a fact the
   * agent recorded mid-session stayed invisible until an app restart or a workspace switch — the
   * model would re-ask something it had just been told to remember. Verified against the real
   * tool host that `memory_read` DOES reflect a preceding `memory_write` (count 0 → 1), so the
   * data layer was fine and the cache was the bug.
   */
  let stored = {
    ok: true,
    summary: "# Project memory index\n- setup: use pnpm",
    data: { count: 1 },
  };
  let reads = 0;
  const block = createMemoryBlock({
    read: async () => {
      reads++;
      return stored;
    },
  });

  await block.refresh();
  assert.match(block.current(), /use pnpm/);

  // the agent records a SECOND fact mid-session
  stored = {
    ok: true,
    summary: "# Project memory index\n- setup: use pnpm\n- build: pnpm build",
    data: { count: 2 },
  };
  await block.refresh();
  assert.match(block.current(), /pnpm build/, "the newly recorded fact was not picked up");
  assert.equal(reads, 2, "the store must be re-read, not cached from the first load");
});

test("an empty index injects nothing", async () => {
  const block = createMemoryBlock({
    read: async () => ({ ok: true, summary: "# Project memory index (empty)", data: { count: 0 } }),
  });
  await block.refresh();
  assert.equal(block.current(), "", "an empty index must inject nothing");
});

test("a failed or unreadable memory store injects nothing rather than throwing", async () => {
  const failing = createMemoryBlock({ read: async () => ({ ok: false, summary: "boom" }) });
  await failing.refresh();
  assert.equal(failing.current(), "");

  const throwing = createMemoryBlock({
    read: async () => {
      throw new Error("ipc down");
    },
  });
  await throwing.refresh();
  assert.equal(throwing.current(), "");
});

test("clear() forgets the previous workspace's memory", async () => {
  const block = createMemoryBlock({
    read: async () => ({ ok: true, summary: "old project facts", data: { count: 2 } }),
  });
  await block.refresh();
  assert.match(block.current(), /old project facts/);
  block.clear();
  assert.equal(block.current(), "", "a workspace switch must not leak the old project's memory");
});
