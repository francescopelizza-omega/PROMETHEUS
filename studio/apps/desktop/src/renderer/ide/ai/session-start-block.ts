// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session-start-block.ts — the SessionStart hook output the agent pane prepends to its prompt.
 *
 * ## The defect this closes
 *
 * Studio let the user CREATE, EDIT and DELETE SessionStart hooks — full CRUD, in Settings
 * (`renderer/settings/HooksPage.tsx`) — and then never ran them. `runSessionStartHooks`
 * (`core/agent/hooks.ts:301`) had zero callers anywhere under `apps/desktop`. Both CLI hosts
 * have always run them (`apps/cli/src/session/host.ts:1180`,
 * `apps/cli/src/tui/session-bridge.ts:857`).
 *
 * A UI that accepts a setting and silently ignores it is worse than one that omits the feature:
 * the user writes a hook to inject "current sprint: CLI-090", sees it listed, and reasonably
 * concludes the model has been told. It has not.
 *
 * PreToolUse and PostToolUse were never affected — those ride `AgentTuning` into core's loop,
 * which both surfaces share (`core-agent.ts:899`). SessionStart is different in kind: it is not
 * a loop hook. It runs ONCE, outside any turn, and its stdout becomes a system block. That is
 * exactly why it fell through — there was no loop seam to carry it.
 *
 * ## Why a separate module
 *
 * The same reason `memory-block.ts` is one, and its header says so plainly: `.tsx` cannot be
 * loaded by `node:test`, which is why the defect it describes survived. Logic that lives in
 * `AgentPane.tsx` is logic nothing tests. This file holds the rule; the pane holds a ref.
 *
 * ## Captured once, replayed thereafter
 *
 * The CLI captures the block at session start and replays it from a getter on every turn
 * (`agent-runtime.ts:266`, the `session-start-hooks` preamble block). Same here, and the reason
 * is not caching: a SessionStart hook SPAWNS A PROCESS, and re-running it per turn would turn
 * one user-authored command into one spawn per message. `refresh()` is therefore idempotent
 * after the first success, and only `clear()` (a workspace change) re-arms it.
 */

/** The hook-running slice this needs. Structural, so a test supplies a plain object. */
export interface SessionStartIo {
  /**
   * Run every SessionStart hook and return the assembled system block, or `undefined` when
   * there are no hooks, no runner, or none of them produced output.
   *
   * Must never throw — core's `runSessionStartHooks` documents that contract and this module
   * relies on it, plus a `.catch` of its own because the IPC hop in between can reject.
   */
  run(): Promise<string | undefined>;
}

export interface SessionStartBlock {
  /** The captured block, or "" when there is nothing. Never throws. */
  current(): string;
  /** Run the hooks ONCE. A second call after a successful capture is a no-op — see the header. */
  refresh(): Promise<void>;
  /** Forget the capture and re-arm (a workspace change). */
  clear(): void;
  /** Have the hooks already run this session? Exposed for the pane's effect guard and tests. */
  captured(): boolean;
}

export function createSessionStartBlock(io: SessionStartIo): SessionStartBlock {
  let block = "";
  let done = false;
  return {
    current: () => block,
    captured: () => done,
    async refresh() {
      // Idempotent by design: see the header. A hook is a spawn, not a read.
      if (done) return;
      // Marked BEFORE the await, not after. Two turns fired in quick succession both reach
      // `refresh()` before either resolves, and without this the user's hook runs twice —
      // the exact per-turn spawning this module exists to avoid.
      done = true;
      const text = await io.run().catch(() => undefined);
      block = typeof text === "string" ? text : "";
    },
    clear() {
      block = "";
      done = false;
    },
  };
}
