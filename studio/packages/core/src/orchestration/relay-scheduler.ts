// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/relay-scheduler.ts — the Prometheus relay ROUTINE (pure, seams injected).
 *
 * One in-process loop that bridges agents living in real tmux windows: it ingests the
 * messages they emit (which the unix-socket relay has already MessageBus.post()ed into the
 * shared in-RAM bus), routes each to its target's inbox, and DELIVERS it by typing into
 * that window — but ONLY when the window is idle (never mid-generation). It detects loops,
 * deadlock, and completion, then tears down. Every machine touch (tmux/clock) is an
 * injected seam, so the whole routine unit-tests with scripted fakes. The bus is the single
 * source of truth (no new message type) — this is routing + delivery timing, not a 2nd bus.
 */
import type { Message, MessageBus } from "./bus.js";
import {
  type AgentObservation,
  DEFAULT_RELAY_CONFIG,
  type RelayClock,
  type RelayConfig,
  type RelayTmux,
} from "./relay-seams.js";
import { type OrchestrationTopology, parentOf } from "./topology.js";

export type RelayReason = "complete" | "deadlock" | "timeout" | "all-dead" | "aborted";

export type RelayEvent =
  | { type: "deliver"; agent: string; from: string; content: string }
  | { type: "loop"; from: string; to: string }
  | { type: "drop"; agent: string; reason: string }
  | { type: "dead"; agent: string }
  // CLI-075: a crashed agent was re-launched (attempt N; ok ⇒ it came back).
  | { type: "respawn"; agent: string; attempt: number; ok: boolean }
  // CLI-075: an agent exhausted its respawn cap and is dropped from the swarm.
  | { type: "excluded"; agent: string; attempts: number }
  // CLI-075: a message meant for an excluded agent has no valid target (NOT silently dropped).
  | { type: "undelivered"; agent: string; from: string; content: string }
  | { type: "done"; reason: RelayReason };

export interface RelaySchedulerDeps {
  bus: MessageBus;
  topology: OrchestrationTopology;
  tmux: RelayTmux;
  clock: RelayClock;
  config?: Partial<RelayConfig>;
  onEvent?: (e: RelayEvent) => void;
  signal?: AbortSignal;
  /** format a bus message as the input line typed into a window (apps/cli injects the real one). */
  format?: (from: string, content: string, broadcast: boolean) => string;
}

export interface RelayResult {
  reason: RelayReason;
  ticks: number;
  delivered: number;
}

/** Kinds that are DELIVERED into a window (peer/orchestrator traffic) — not relay-internal. */
const DELIVERABLE = new Set(["msg", "result", "question", "answer"]);

const defaultFormat = (from: string, content: string, broadcast: boolean): string =>
  `[from ${from}]${broadcast ? " (broadcast)" : ""} ${content}`;

/**
 * Run the relay until the swarm completes (the orchestrator emits its final `done`, or the
 * tree goes quiescent), deadlocks, all windows die, or the safety ceiling trips.
 */
export async function runRelay(deps: RelaySchedulerDeps): Promise<RelayResult> {
  const cfg: RelayConfig = { ...DEFAULT_RELAY_CONFIG, ...deps.config };
  const emit = deps.onEvent ?? (() => {});
  const fmt = deps.format ?? defaultFormat;
  const orchestrator = deps.topology.orchestrator;
  const agentNames = new Set(deps.topology.agents.map((a) => a.name));

  const inbox = new Map<string, Message[]>();
  const idleStreak = new Map<string, number>();
  const prevDigest = new Map<string, string>();
  const loopState = new Map<string, { content: string; count: number }>();
  // ── CLI-075 crash/respawn state ──
  const respawnCap = Math.max(0, cfg.respawnCap ?? 0);
  const respawnAttempts = new Map<string, number>(); // per-agent respawn attempts used
  const excluded = new Set<string>(); // agents permanently dropped after exhausting the cap
  const everLive = new Set<string>(); // agents ever seen alive (so a NEVER-spawned agent ≠ "vanished")
  const queue = (agent: string): Message[] => {
    let q = inbox.get(agent);
    if (!q) {
      q = [];
      inbox.set(agent, q);
    }
    return q;
  };

  const targetsOf = (m: Message): string[] => {
    if (m.to === "broadcast") return [...agentNames].filter((n) => n !== m.from);
    return agentNames.has(m.to) ? [m.to] : [];
  };

  let cursor = 0;
  let ticks = 0;
  let delivered = 0;
  let noDeliveryTicks = 0;
  let quiescentTicks = 0;
  let sentinelDone = false;
  const startedAt = deps.clock.now();

  // Teardown is idempotent (a flag) so the normal `finish()` exit and the
  // exception safety-net below can't double-tear-down the same windows.
  let tornDown = false;
  const teardown = async (reason: RelayReason): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    try {
      await deps.tmux.teardown(reason);
    } catch {
      /* teardown is best-effort */
    }
  };
  const finish = async (reason: RelayReason): Promise<RelayResult> => {
    emit({ type: "done", reason });
    await teardown(reason);
    return { reason, ticks, delivered };
  };

  try {
    return await runRelayLoop();
  } catch (err) {
    // an injected seam (tmux/clock/bus) threw mid-loop — the for(;;) would otherwise
    // exit WITHOUT tearing down, leaking real tmux windows. Tear down, then rethrow.
    emit({ type: "done", reason: "aborted" });
    await teardown("aborted");
    throw err;
  }

  // The relay loop proper; declared as a closure so the try/catch above wraps every
  // exit path (the multiple `return finish(...)` and any thrown seam alike).
  async function runRelayLoop(): Promise<RelayResult> {
    for (;;) {
      if (deps.signal?.aborted) return finish("aborted");
      if (deps.clock.now() - startedAt > cfg.maxRunMs) return finish("timeout");
      await deps.clock.sleep(cfg.tickMs);
      ticks += 1;

      // ── INGEST: route newly-posted bus messages into per-target inbox queues ──
      const all = deps.bus.all();
      for (; cursor < all.length; cursor++) {
        const m = all[cursor] as Message;
        // the orchestrator's final result to "user" ends the run.
        if (m.from === orchestrator && m.to === "user" && m.kind === "result") sentinelDone = true;
        if (!DELIVERABLE.has(m.kind)) continue;
        for (const target of targetsOf(m)) {
          // CLI-075: a directed message to an already-excluded agent has no valid target — surface
          // it as undelivered (a broadcast simply skips that recipient), never silently drop it.
          if (excluded.has(target)) {
            if (m.to !== "broadcast")
              emit({ type: "undelivered", agent: target, from: m.from, content: m.content });
            continue;
          }
          // loop guard: identical (from→to) content repeated past the threshold = a livelock edge.
          const key = `${m.from}>${target}`;
          const ls = loopState.get(key);
          if (ls && ls.content === m.content) {
            ls.count += 1;
            if (ls.count > cfg.loopThreshold) {
              emit({ type: "loop", from: m.from, to: target });
              continue; // drop the repeat
            }
          } else {
            loopState.set(key, { content: m.content, count: 1 });
          }
          const q = queue(target);
          q.push(m);
          // backpressure: over cap, drop the OLDEST low-priority (msg) line, keep results/questions.
          if (q.length > cfg.inboxCap) {
            const dropIdx = q.findIndex((x) => x.kind === "msg");
            if (dropIdx >= 0) {
              q.splice(dropIdx, 1);
              emit({ type: "drop", agent: target, reason: "inbox overflow" });
            }
          }
        }
      }

      // ── OBSERVE every live window ──
      const live = await deps.tmux.liveAgents();
      const liveSet = new Set(live);
      for (const a of live) everLive.add(a);
      const dead = new Set<string>(); // agents dead THIS tick (crashed/excluded — won't deliver)
      const respawnedThisTick = new Set<string>();
      const deadCandidates: string[] = [];
      for (const agent of live) {
        const obs: AgentObservation = await deps.tmux.observe(agent);
        if (obs.state === "dead") {
          deadCandidates.push(agent);
          continue;
        }
        const stable = prevDigest.get(agent) === obs.digest;
        prevDigest.set(agent, obs.digest);
        idleStreak.set(
          agent,
          obs.state === "idle" && stable ? (idleStreak.get(agent) ?? 0) + 1 : 0,
        );
      }
      // remain-on-exit OFF drops a crashed pane from the window list entirely — a KNOWN-live agent
      // that has vanished is ALSO a dead candidate (CLI-075). A never-spawned agent (not in everLive)
      // is NOT treated as dead, so a slow-to-start swarm isn't excluded prematurely.
      for (const a of everLive) {
        if (!liveSet.has(a) && !excluded.has(a)) deadCandidates.push(a);
      }

      // ── CLI-075: RESPAWN a crashed agent ONCE (bounded by respawnCap), else EXCLUDE it ──
      for (const agent of deadCandidates) {
        idleStreak.set(agent, 0);
        if (excluded.has(agent)) {
          dead.add(agent); // already handled — stay dead this tick, no repeat events
          continue;
        }
        emit({ type: "dead", agent });
        const used = respawnAttempts.get(agent) ?? 0;
        if (used < respawnCap) {
          respawnAttempts.set(agent, used + 1);
          let ok = false;
          try {
            ok = deps.tmux.respawn ? await deps.tmux.respawn(agent) : false;
          } catch {
            ok = false;
          }
          emit({ type: "respawn", agent, attempt: used + 1, ok });
          if (ok) {
            // it came back — fresh settle window, NOT counted dead this tick.
            respawnedThisTick.add(agent);
            prevDigest.delete(agent);
            idleStreak.set(agent, 0);
            continue;
          }
        }
        // no attempts left (cap 0, or the respawn failed and the cap is now spent) → exclude it.
        if ((respawnAttempts.get(agent) ?? 0) >= respawnCap) {
          excluded.add(agent);
          emit({ type: "excluded", agent, attempts: respawnAttempts.get(agent) ?? 0 });
          // re-route its pending inbox — surface each as undelivered, never silently drop.
          const q = inbox.get(agent);
          if (q && q.length > 0) {
            for (const m of q)
              emit({ type: "undelivered", agent, from: m.from, content: m.content });
            inbox.set(agent, []);
          }
        }
        dead.add(agent);
      }
      // a window whose CLI exited (dead) or that is excluded won't progress — treat it as "settled"
      // for termination (else a message stuck for a dead agent never triggers deadlock).
      const settledOrDead = (a: string): boolean =>
        dead.has(a) || excluded.has(a) || (idleStreak.get(a) ?? 0) >= cfg.settleTicks;

      // ── DELIVER: one head message per idle-settled agent ──
      let deliveredThisTick = 0;
      for (const agent of live) {
        const q = inbox.get(agent);
        if (!q || q.length === 0) continue;
        if ((idleStreak.get(agent) ?? 0) < cfg.settleTicks) continue;
        const m = q.shift() as Message;
        await deps.tmux.deliver(agent, fmt(m.from, m.content, m.to === "broadcast"));
        emit({ type: "deliver", agent, from: m.from, content: m.content });
        delivered += 1;
        deliveredThisTick += 1;
        idleStreak.set(agent, 0); // it'll be busy processing now
      }

      // ── TERMINATION ──
      if (sentinelDone) return finish("complete");
      // CLI-075: all-dead means EVERY agent has EXHAUSTED its respawns, not "detected dead once".
      // Two shapes: every roster agent excluded (dead panes may still be listed), OR no windows
      // remain AND nothing is left to respawn (covers a swarm that never came up / all excluded).
      const allExcluded = agentNames.size > 0 && [...agentNames].every((a) => excluded.has(a));
      const noneLeft =
        live.length === 0 &&
        respawnedThisTick.size === 0 &&
        [...everLive].every((a) => excluded.has(a));
      if (allExcluded || noneLeft) return finish("all-dead");

      const allSettled = live.every(settledOrDead);
      const anyQueued = live.some((a) => (inbox.get(a)?.length ?? 0) > 0);

      // a respawn was just issued — pause deadlock accounting so the re-launch's own cold-start
      // latency doesn't trip finish("deadlock") before the respawned agent can post (CLI-075).
      if (deliveredThisTick > 0 || respawnedThisTick.size > 0) {
        noDeliveryTicks = 0;
      } else if (anyQueued && allSettled) {
        // nothing moved, everyone is parked, yet work is queued (e.g. stuck on a dead agent
        // or a mutual wait) → after the hysteresis window, declare deadlock.
        noDeliveryTicks += 1;
        if (noDeliveryTicks >= cfg.deadlockTicks) return finish("deadlock");
      } else {
        noDeliveryTicks = 0;
      }

      if (allSettled && !anyQueued) {
        quiescentTicks += 1;
        if (quiescentTicks >= cfg.quiesceTicks) return finish("complete");
      } else {
        quiescentTicks = 0;
      }
    }
  }
}
