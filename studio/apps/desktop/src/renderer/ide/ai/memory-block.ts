// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * memory-block.ts — the durable memory block the agent pane prepends to its system prompt.
 *
 * Extracted from `AgentPane.tsx` so the rule is testable: `.tsx` cannot be loaded by node:test,
 * which is why this defect survived — the pane read `memory_read` ONCE per workspace root into a
 * ref and never again. The agent can call `memory_write` mid-session (that is the whole point of
 * durable memory), and the newly recorded fact was then invisible for the rest of the session:
 * the model would re-ask something it had just been told to remember, and only an app restart or
 * a workspace switch brought it back. Verified against the real tool host that `memory_read`
 * DOES reflect a preceding `memory_write` — so the data layer was fine and the cache was the bug.
 *
 * Refreshed after every turn rather than only when a memory tool is spotted: one read is cheap
 * next to a model round-trip, and it cannot miss a write however the tool was named or routed.
 */

/** The one call this needs — `memory_read` over the host's system-tool channel. */
export interface MemoryIo {
  read(): Promise<{ ok: boolean; summary: string; data?: { count?: number } } | undefined>;
}

export interface MemoryBlock {
  /** The current block, or "" when there is nothing recorded. Never throws. */
  current(): string;
  /** Re-read from the store. Call after every turn. */
  refresh(): Promise<void>;
  /** Forget everything (a workspace change). */
  clear(): void;
}

export function createMemoryBlock(io: MemoryIo): MemoryBlock {
  let block = "";
  return {
    current: () => block,
    async refresh() {
      const r = await io.read().catch(() => undefined);
      // `count === 0` means "nothing ever recorded for this project" — treated exactly like no
      // rules at all, so nothing is injected rather than an empty index header.
      if (!r?.ok || r.data?.count === 0) {
        block = "";
        return;
      }
      block = r.summary;
    },
    clear() {
      block = "";
    },
  };
}
