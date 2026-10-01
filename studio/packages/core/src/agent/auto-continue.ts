// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/auto-continue.ts — PURE decision core for the run-to-done posture (WRAPPER Subsystem 3).
 *
 * `yolo` mode promises "runs to done — no prompts, no pauses". The turn loop still emits a
 * `capped` event when it hits maxRounds (a PAUSE, not a failure); normally the host offers
 * `/continue`. This module decides whether to auto-answer that continue and re-run the turn,
 * bounded by three simultaneous budgets and hard-stopped by safety:
 *
 *  - ORTHOGONAL to bypass: it only removes the per-TURN pause, never a per-tool confirm and never
 *    a safety verdict. A nemesis gate BLOCK (the typed `verdict` event, not a free-string) HARD
 *    STOPS the whole chain — autonomy never overrides safety (C5).
 *  - Budgeted: maxContinues AND wall-clock AND output-tokens, all enforced together.
 *  - No-progress guard: if a round's tool activity digest repeats, halt (a denied plan re-proposed
 *    forever would otherwise cap → resume → cap … indefinitely).
 *
 * PURE: no IO, no timers. The host feeds it `nowMs`, the cumulative token spend, and a digest of
 * the latest round; it returns resume/stop + the next state.
 */
import type { AgentEvent } from "./events.js";
import { type PermissionModeId, isRunToDoneMode } from "./permission-modes.js";

export interface AutoContinueBudget {
  /** hard cap on auto-resumes within one user turn. */
  maxContinues: number;
  /** wall-clock budget (ms) from the first submit. */
  maxWallMs: number;
  /** cumulative output-token budget for the whole run. */
  maxTokens: number;
}

/** Conservative defaults — generous enough to finish real tasks, bounded enough to never run away. */
export const DEFAULT_AUTO_CONTINUE_BUDGET: AutoContinueBudget = Object.freeze({
  maxContinues: 25,
  maxWallMs: 15 * 60_000,
  maxTokens: 400_000,
});

export interface AutoContinueState {
  continues: number;
  startMs: number;
  /** a nemesis gate BLOCK was observed this run → chain is hard-stopped. */
  blocked: boolean;
  /** the previous round's activity digest (no-progress guard). */
  lastDigest?: string;
}

export function initAutoContinue(nowMs: number): AutoContinueState {
  return { continues: 0, startMs: nowMs, blocked: false };
}

/**
 * Fold one AgentEvent into the state. A `verdict` of `block` (or a fail-closed scan `error`) trips
 * the hard stop — keyed on the TYPED verdict, never the free-string `blocked` reason (which cannot
 * distinguish a nemesis gate-block from an ordinary policy deny).
 */
export function observeEvent(state: AutoContinueState, event: AgentEvent): AutoContinueState {
  if (event.kind === "verdict" && (event.verdict === "block" || event.verdict === "error")) {
    return { ...state, blocked: true };
  }
  return state;
}

export type AutoDecision =
  | { resume: true; state: AutoContinueState }
  | { resume: false; reason: string; state: AutoContinueState };

export interface AutoContinueInput {
  mode: PermissionModeId;
  /** the turn ended on a `capped` event with canContinue=true. */
  capped: boolean;
  state: AutoContinueState;
  budget: AutoContinueBudget;
  nowMs: number;
  /** cumulative OUTPUT tokens spent this user turn. */
  tokensSpent: number;
  /** a digest of the latest round's tool activity (to detect a stalled, repeating plan). */
  progressDigest: string;
}

/**
 * Decide whether to auto-continue. Returns resume:true (+advanced state) only when the mode runs to
 * done, the turn actually capped, no BLOCK was seen, every budget still has room, and the round made
 * progress. Any stop carries a human-readable reason for the audit line.
 */
/**
 * A stable digest of one round's tool activity — an identical repeat means no progress was made,
 * which is what halts an auto-continue chain that has started spinning.
 *
 * This lived as a private closure inside the TUI's session bridge. When the readline host gained
 * run-to-done it needed the same function, and copying it would have recreated exactly the drift
 * that left the two hosts disagreeing about what `yolo` means in the first place: the policy
 * (`decideAutoContinue`) already lives here, so its input should too.
 */
export function progressDigest(events: readonly AgentEvent[]): string {
  const parts: string[] = [];
  for (const e of events) {
    if (e.kind === "tool_use") parts.push(`u:${e.call.name}`);
    else if (e.kind === "tool_result") parts.push(`r:${e.call.name}:${e.ok}`);
  }
  return parts.join("|").slice(0, 2000);
}

export function decideAutoContinue(input: AutoContinueInput): AutoDecision {
  const { mode, capped, state, budget, nowMs, tokensSpent, progressDigest } = input;
  if (!isRunToDoneMode(mode)) return { resume: false, reason: "not a run-to-done mode", state };
  if (!capped) return { resume: false, reason: "turn finished", state };
  if (state.blocked) return { resume: false, reason: "nemesis gate BLOCK — hard stop", state };
  if (state.continues >= budget.maxContinues) {
    return { resume: false, reason: `continue budget exhausted (${budget.maxContinues})`, state };
  }
  if (nowMs - state.startMs >= budget.maxWallMs) {
    return { resume: false, reason: "walltime budget exhausted", state };
  }
  if (tokensSpent >= budget.maxTokens) {
    return { resume: false, reason: "token budget exhausted", state };
  }
  if (state.lastDigest !== undefined && progressDigest === state.lastDigest) {
    return {
      resume: false,
      reason: "no progress since last round — halting to avoid a loop",
      state,
    };
  }
  return {
    resume: true,
    state: { ...state, continues: state.continues + 1, lastDigest: progressDigest },
  };
}
