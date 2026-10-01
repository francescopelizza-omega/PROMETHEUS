// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/guards.ts — the runaway / cost / cycle safety guards.
 *
 * A swarm of agents that can spawn agents that can spawn agents is a recipe for an
 * unbounded fan-out (and, with paid CLIs, an unbounded bill). Every spawn + dispatch in
 * the coordinator must clear these guards: tree depth, per-turn fan-out, total agent
 * count, wall-clock timeout, optional metered-spend ceiling, and the no-ancestor-cycle
 * rule. PURE check fns + a tiny mutable `RunBudget` the coordinator threads through.
 */
import type { RunLimits } from "./topology.js";

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

const OK: GuardVerdict = { ok: true };
const deny = (reason: string): GuardVerdict => ({ ok: false, reason });

/** A child at `depth` (root = 0) must stay within maxDepth. */
export function checkDepth(depth: number, limits: RunLimits): GuardVerdict {
  return depth > limits.maxDepth
    ? deny(`max depth ${limits.maxDepth} reached (at depth ${depth})`)
    : OK;
}

/** One agent may dispatch/spawn at most maxFanout children in a single turn. */
export function checkFanout(count: number, limits: RunLimits): GuardVerdict {
  return count > limits.maxFanout
    ? deny(`max fan-out ${limits.maxFanout} exceeded (${count} this turn)`)
    : OK;
}

/** `childName` must not already be one of its ancestors (no genealogy cycle). */
export function checkCycle(childName: string, ancestry: readonly string[]): GuardVerdict {
  return ancestry.includes(childName)
    ? deny(`cycle: "${childName}" is already in the run genealogy [${ancestry.join(" → ")}]`)
    : OK;
}

/**
 * The mutable per-run budget the coordinator threads: total agent invocations, accrued
 * metered spend, and the start time for the timeout. Injected clock for determinism.
 */
export class RunBudget {
  private readonly limits: RunLimits;
  private readonly startedAt: number;
  private readonly clock: () => number;
  private agents = 0;
  private costUsd = 0;

  constructor(limits: RunLimits, clock: () => number) {
    this.limits = limits;
    this.startedAt = clock();
    this.clock = clock;
  }

  /** Account ONE agent invocation (+ an optional cost); returns the running totals. */
  charge(costUsd = 0): { agents: number; costUsd: number } {
    this.agents += 1;
    this.costUsd += costUsd;
    return { agents: this.agents, costUsd: this.costUsd };
  }

  /** Add metered cost WITHOUT counting another invocation (cost known after the call). */
  addCost(costUsd: number): void {
    this.costUsd += costUsd;
  }

  get invocations(): number {
    return this.agents;
  }
  get spentUsd(): number {
    return this.costUsd;
  }
  get elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  /** Has the total agent count hit the ceiling? (check BEFORE the next invocation). */
  agentsExhausted(): GuardVerdict {
    return this.agents >= this.limits.maxAgents
      ? deny(`max agents ${this.limits.maxAgents} reached`)
      : OK;
  }

  /** Has the wall-clock budget elapsed? */
  timedOut(): GuardVerdict {
    return this.elapsedMs > this.limits.timeoutMs
      ? deny(`run timed out after ${Math.round(this.elapsedMs / 1000)}s`)
      : OK;
  }

  /** Has the optional metered-spend ceiling been crossed? */
  overBudget(): GuardVerdict {
    if (this.limits.maxCostUsd === undefined) return OK;
    return this.costUsd >= this.limits.maxCostUsd
      ? deny(`spend ceiling $${this.limits.maxCostUsd} reached ($${this.costUsd.toFixed(2)})`)
      : OK;
  }

  /**
   * The combined gate the coordinator calls before dispatching/spawning a child at
   * `depth` with `ancestry`. Returns the FIRST failing guard, or ok.
   */
  canProceed(depth: number, ancestry: readonly string[], childName?: string): GuardVerdict {
    for (const v of [
      this.agentsExhausted(),
      this.timedOut(),
      this.overBudget(),
      checkDepth(depth, this.limits),
      childName ? checkCycle(childName, ancestry) : OK,
    ]) {
      if (!v.ok) return v;
    }
    return OK;
  }
}
