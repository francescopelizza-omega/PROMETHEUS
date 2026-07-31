/**
 * relay-scheduler.test.ts — the relay routine over scripted fake tmux: idle-gated delivery,
 * completion (sentinel + quiescence), deadlock, and loop-drop. No tmux, no real time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MessageBus } from "./bus.js";
import { type RelayEvent, runRelay } from "./relay-scheduler.js";
import type { AgentObservation, RelayClock, RelayTmux } from "./relay-seams.js";
import { type OrchestrationTopology, normalizeTopology } from "./topology.js";

const TOP: OrchestrationTopology = normalizeTopology({
  orchestrator: "lead",
  agents: [
    { name: "lead", backend: { kind: "fake" }, role: "o", children: ["api", "ui"] },
    { name: "api", backend: { kind: "fake" }, role: "b" },
    { name: "ui", backend: { kind: "fake" }, role: "f" },
  ],
});

/** A clock with no real delay; advances `now` by tickMs each sleep. */
function fakeClock(tickMs = 250): RelayClock {
  let t = 0;
  return {
    now: () => t,
    sleep: async () => {
      t += tickMs;
    },
  };
}

interface FakeTmuxOpts {
  live: string[];
  /** per-agent state per tick (cycles/holds the last). Default: always idle. */
  states?: Record<string, ("idle" | "busy" | "dead")[]>;
  /** CLI-075: respawn outcome per agent (true ⇒ it comes back). Default: no respawn (false). */
  respawn?: (agent: string) => boolean;
}

function fakeTmux(opts: FakeTmuxOpts) {
  const calls = new Map<string, number>();
  const delivered: { agent: string; line: string }[] = [];
  const respawnCalls: string[] = [];
  let tornDown = "";
  let seq = 0;
  const tmux: RelayTmux = {
    liveAgents: () => opts.live,
    observe: (agent): AgentObservation => {
      const n = calls.get(agent) ?? 0;
      calls.set(agent, n + 1);
      const arr = opts.states?.[agent];
      const state = arr ? (arr[Math.min(n, arr.length - 1)] ?? "idle") : "idle";
      // a stable digest while "idle" (so settleTicks accrues); changes while busy.
      return { state, digest: state === "idle" ? "stable" : `s${seq++}` };
    },
    deliver: (agent, line) => {
      delivered.push({ agent, line });
    },
    respawn: (agent) => {
      respawnCalls.push(agent);
      return opts.respawn ? opts.respawn(agent) : false;
    },
    teardown: (reason) => {
      tornDown = reason;
    },
  };
  return {
    tmux,
    delivered,
    respawnCalls,
    get tornDown() {
      return tornDown;
    },
  };
}

test("delivers a queued message ONLY once the agent is idle + settled", async () => {
  // api is busy for 2 ticks, then idle → must deliver only after settleTicks idle.
  const f = fakeTmux({
    live: ["lead", "api", "ui"],
    states: { api: ["busy", "busy", "idle", "idle", "idle"] },
  });
  const bus = new MessageBus({ now: () => 0 });
  bus.post({ from: "lead", to: "api", kind: "msg", content: "build the API" });
  const events: RelayEvent[] = [];
  const r = await runRelay({
    bus,
    topology: TOP,
    tmux: f.tmux,
    clock: fakeClock(),
    config: { settleTicks: 2, quiesceTicks: 3, deadlockTicks: 50, maxRunMs: 1e9 },
    onEvent: (e) => events.push(e),
    signal: { aborted: false } as AbortSignal,
  });
  const toApi = f.delivered.filter((d) => d.agent === "api");
  assert.equal(toApi.length, 1);
  assert.match(toApi[0]?.line ?? "", /\[from lead\] build the API/);
  assert.equal(r.reason, "complete"); // went quiescent after delivery
});

test("completes immediately when the orchestrator posts its final result to user", async () => {
  const f = fakeTmux({ live: ["lead", "api", "ui"] });
  const bus = new MessageBus({ now: () => 0 });
  bus.post({ from: "lead", to: "user", kind: "result", content: "shipped" }); // the `done` sentinel
  const r = await runRelay({
    bus,
    topology: TOP,
    tmux: f.tmux,
    clock: fakeClock(),
    config: { quiesceTicks: 99 }, // would never quiesce-complete; sentinel must win
  });
  assert.equal(r.reason, "complete");
  assert.equal(f.tornDown, "complete");
});

test("broadcast fans a message out to every other agent", async () => {
  const f = fakeTmux({ live: ["lead", "api", "ui"] });
  const bus = new MessageBus({ now: () => 0 });
  bus.post({ from: "lead", to: "broadcast", kind: "msg", content: "switching to v2" });
  await runRelay({
    bus,
    topology: TOP,
    tmux: f.tmux,
    clock: fakeClock(),
    config: { settleTicks: 1, quiesceTicks: 2 },
  });
  const agents = f.delivered.map((d) => d.agent).sort();
  assert.deepEqual(agents, ["api", "ui"]); // not back to the sender
});

test("CLI-075: a dead agent is excluded (msg surfaced undelivered) + the swarm continues → complete", async () => {
  // api is dead the whole time; a message for it can't land. Old behavior = whole-run deadlock;
  // new behavior = respawn once (fails, no seam) → exclude api, surface the msg undelivered, and
  // lead+ui go quiescent → complete (the swarm is NOT held hostage by one dead agent).
  const f = fakeTmux({ live: ["lead", "api", "ui"], states: { api: ["dead"] } });
  const bus = new MessageBus({ now: () => 0 });
  bus.post({ from: "lead", to: "api", kind: "msg", content: "x" });
  const events: RelayEvent[] = [];
  const r = await runRelay({
    bus,
    topology: TOP,
    tmux: f.tmux,
    clock: fakeClock(),
    config: { settleTicks: 1, deadlockTicks: 4, quiesceTicks: 3, respawnCap: 1, maxRunMs: 1e9 },
    onEvent: (e) => events.push(e),
  });
  assert.equal(f.respawnCalls.filter((a) => a === "api").length, 1, "exactly one respawn attempt");
  assert.ok(events.some((e) => e.type === "respawn" && e.agent === "api" && !e.ok));
  assert.ok(events.some((e) => e.type === "excluded" && e.agent === "api" && e.attempts === 1));
  assert.ok(
    events.some((e) => e.type === "undelivered" && e.agent === "api" && e.content === "x"),
    "the stuck message is surfaced, not silently dropped",
  );
  assert.equal(r.reason, "complete"); // continued with lead+ui
});

test("CLI-075: a successful respawn brings the agent back — no exclusion, run completes", async () => {
  // api crashes on the first observe, respawn succeeds, then it's idle → participates normally.
  const f = fakeTmux({
    live: ["lead", "api", "ui"],
    states: { api: ["dead", "idle", "idle", "idle"] },
    respawn: () => true,
  });
  const bus = new MessageBus({ now: () => 0 });
  const events: RelayEvent[] = [];
  const r = await runRelay({
    bus,
    topology: TOP,
    tmux: f.tmux,
    clock: fakeClock(),
    config: { settleTicks: 1, quiesceTicks: 3, respawnCap: 1, maxRunMs: 1e9 },
    onEvent: (e) => events.push(e),
  });
  assert.equal(f.respawnCalls.filter((a) => a === "api").length, 1, "exactly one respawn attempt");
  assert.ok(events.some((e) => e.type === "respawn" && e.agent === "api" && e.ok));
  assert.ok(!events.some((e) => e.type === "excluded"), "a recovered agent is never excluded");
  assert.equal(r.reason, "complete");
});

test("CLI-075: agent B dies mid-run in a 3-agent swarm → 1 respawn, exclude, run completes with A+C", async () => {
  // lead+ui healthy; api (=B) dead throughout, respawn fails. Exactly ONE respawn attempt, ONE
  // exclusion, then the swarm finishes `complete` (NOT all-dead) with the other two intact.
  const f = fakeTmux({
    live: ["lead", "api", "ui"],
    states: { api: ["dead"] },
    respawn: () => false,
  });
  const bus = new MessageBus({ now: () => 0 });
  const events: RelayEvent[] = [];
  const r = await runRelay({
    bus,
    topology: TOP,
    tmux: f.tmux,
    clock: fakeClock(),
    config: { settleTicks: 1, quiesceTicks: 3, respawnCap: 1, maxRunMs: 1e9 },
    onEvent: (e) => events.push(e),
  });
  assert.equal(events.filter((e) => e.type === "respawn" && e.agent === "api").length, 1);
  assert.equal(events.filter((e) => e.type === "excluded" && e.agent === "api").length, 1);
  assert.equal(r.reason, "complete"); // distinct from all-dead — N-1 continued
});

test("loop guard drops an identical message re-sent past the threshold", async () => {
  const f = fakeTmux({ live: ["lead", "api", "ui"] });
  const bus = new MessageBus({ now: () => 0 });
  for (let i = 0; i < 8; i++)
    bus.post({ from: "ui", to: "api", kind: "msg", content: "same loop msg" });
  const events: RelayEvent[] = [];
  await runRelay({
    bus,
    topology: TOP,
    tmux: f.tmux,
    clock: fakeClock(),
    config: { settleTicks: 1, loopThreshold: 5, quiesceTicks: 2, maxRunMs: 1e9 },
    onEvent: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.type === "loop" && e.from === "ui" && e.to === "api"));
  // delivered fewer than the 8 posted (the repeats past threshold were dropped)
  assert.ok(f.delivered.filter((d) => d.agent === "api").length <= 5);
});

test("CLI-075: all-dead fires only when EVERY agent has exhausted its respawns", async () => {
  // all three crash + respawn fails → each gets exactly one attempt, then all-dead (not on the
  // first detection — every agent must exhaust its cap first).
  const f = fakeTmux({
    live: ["lead", "api", "ui"],
    states: { lead: ["dead"], api: ["dead"], ui: ["dead"] },
    respawn: () => false,
  });
  const bus = new MessageBus({ now: () => 0 });
  const events: RelayEvent[] = [];
  const r = await runRelay({
    bus,
    topology: TOP,
    tmux: f.tmux,
    clock: fakeClock(),
    config: { settleTicks: 1, respawnCap: 1, maxRunMs: 1e9 },
    onEvent: (e) => events.push(e),
  });
  assert.equal(events.filter((e) => e.type === "respawn").length, 3, "one attempt per agent");
  assert.equal(events.filter((e) => e.type === "excluded").length, 3);
  assert.equal(r.reason, "all-dead");
});

test("all windows dead → all-dead", async () => {
  const f = fakeTmux({ live: [] });
  const bus = new MessageBus({ now: () => 0 });
  const r = await runRelay({
    bus,
    topology: TOP,
    tmux: f.tmux,
    clock: fakeClock(),
    config: { maxRunMs: 1e9 },
  });
  assert.equal(r.reason, "all-dead");
});

test("respects the maxRunMs safety ceiling", async () => {
  const f = fakeTmux({ live: ["lead"], states: { lead: ["busy"] } }); // never idle → never completes
  const bus = new MessageBus({ now: () => 0 });
  const r = await runRelay({
    bus,
    topology: TOP,
    tmux: f.tmux,
    clock: fakeClock(1000),
    config: { maxRunMs: 5000 },
  });
  assert.equal(r.reason, "timeout");
});
