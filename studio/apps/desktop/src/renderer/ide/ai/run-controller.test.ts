/**
 * run-controller.test.ts — node:test for the MODULE-LEVEL agent run controller (APP-056).
 *
 * The load-bearing property: a run keeps progressing to completion with ZERO React
 * components mounted (the controller drives `runAgentLoop` and writes the transcript
 * through the lifecycle-free `useAiSessionStore` actions). We drive the controller
 * DIRECTLY — no AgentPane, no render — with an INJECTED loop runner, and assert:
 *  - start() completes the loop into the store with no components,
 *  - cancel() aborts exactly one session, leaving others running,
 *  - a double-start on the same session SUPERSEDES (aborts) the prior run,
 *  - runningIds() + subscriber notifications track start/settle/cancel transitions.
 *
 * Pure/injected — runs under node --test (dev-register). The store is a shared singleton,
 * so each test uses a UNIQUE session id to stay independent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { useAiSessionStore } from "../state/stores.js";
import type { AgentLoopDeps, AgentLoopOutcome } from "./agent-loop.js";
import type { CommandResult } from "./agent-loop.js";
import { type StartParams, agentRuns, claimCardResult } from "./run-controller.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A minimal deps object (the injected runner ignores most of it; signal is injected). */
function makeDeps(): Omit<AgentLoopDeps, "signal"> {
  return {
    endpoint: { id: "local:test", baseUrl: "http://127.0.0.1:0", locality: "local" },
    neverSendToCloud: true,
    tools: {} as AgentLoopDeps["tools"],
    onText: () => {},
    onTurnComplete: () => {},
    onToolNote: () => {},
  };
}

/** Register a fresh session in the store and return its id. */
function openSession(id: string): string {
  return useAiSessionStore.getState().openSessionTab({ id, title: "T", turns: [] });
}

test("start() drives the loop into the store with ZERO components mounted", async () => {
  const sid = openSession("rc-complete");
  // the injected runner writes a turn through the store action (proving a store write lands
  // with no component) then settles done.
  const run: StartParams["run"] = async (_messages, deps) => {
    assert.equal(deps.signal.aborted, false); // start injected a live signal
    useAiSessionStore.getState().pushTurn(sid, { role: "assistant", content: "from-loop" });
    return { status: "done" };
  };
  await agentRuns.start(sid, {
    messages: [{ role: "user", content: "hi" }],
    deps: makeDeps(),
    run,
  });

  const s = useAiSessionStore.getState().sessions[sid];
  assert.equal(s?.turns.at(-1)?.content, "from-loop");
  assert.equal(s?.busy, false); // finalize cleared busy
  assert.equal(agentRuns.isRunning(sid), false); // AC retired on done
});

test("cancel() aborts exactly one session, others keep running", async () => {
  const a = openSession("rc-cancel-a");
  const b = openSession("rc-cancel-b");
  // a runner that only settles once its signal aborts (stays "running" until cancelled).
  const waitForAbort: StartParams["run"] = (_m, deps) =>
    new Promise<AgentLoopOutcome>((res) => {
      if (deps.signal.aborted) return res({ status: "done" });
      deps.signal.addEventListener("abort", () => res({ status: "done" }), { once: true });
    });
  const pa = agentRuns.start(a, { messages: [], deps: makeDeps(), run: waitForAbort });
  const pb = agentRuns.start(b, { messages: [], deps: makeDeps(), run: waitForAbort });
  await tick();
  assert.deepEqual(agentRuns.runningIds().sort(), [a, b].sort());

  agentRuns.cancel(a);
  await Promise.all([pa, tick()]);
  assert.equal(agentRuns.isRunning(a), false);
  assert.equal(agentRuns.isRunning(b), true);
  assert.deepEqual(agentRuns.runningIds(), [b]);

  agentRuns.cancel(b); // cleanup
  await pb;
});

test("double-start on one session SUPERSEDES (aborts) the prior run", async () => {
  const sid = openSession("rc-supersede");
  let signal1: AbortSignal | undefined;
  let signal2: AbortSignal | undefined;
  const waitForAbort: StartParams["run"] = (_m, deps) =>
    new Promise<AgentLoopOutcome>((res) => {
      deps.signal.addEventListener("abort", () => res({ status: "done" }), { once: true });
    });
  const p1 = agentRuns.start(sid, {
    messages: [],
    deps: makeDeps(),
    run: (m, deps) => {
      signal1 = deps.signal;
      return waitForAbort(m, deps);
    },
  });
  const p2 = agentRuns.start(sid, {
    messages: [],
    deps: makeDeps(),
    run: (m, deps) => {
      signal2 = deps.signal;
      return waitForAbort(m, deps);
    },
  });
  await tick();
  assert.equal(signal1?.aborted, true, "the prior run's signal was aborted by the supersede");
  assert.equal(signal2?.aborted, false, "the new run's signal is live");
  assert.equal(agentRuns.isRunning(sid), true); // exactly one run in flight (the new one)
  assert.deepEqual(agentRuns.runningIds(), [sid]);
  await p1; // the superseded run settles; its finalize must NOT reap the new run (identity guard)
  await tick();
  assert.equal(
    agentRuns.isRunning(sid),
    true,
    "the superseded run's late settle left the new run alone",
  );

  agentRuns.cancel(sid); // cleanup
  await p2;
});

test("subscribe() fires on start + settle; unsubscribe stops notifications", async () => {
  const sid = openSession("rc-notify");
  let notes = 0;
  const unsub = agentRuns.subscribe(() => {
    notes += 1;
  });
  const run: StartParams["run"] = async () => ({ status: "done" });
  await agentRuns.start(sid, { messages: [], deps: makeDeps(), run });
  assert.ok(notes >= 2, "at least start(beginRun) + settle(finalize) notified"); // >=2

  unsub();
  const before = notes;
  await agentRuns.start(sid, { messages: [], deps: makeDeps(), run });
  assert.equal(notes, before, "no notifications after unsubscribe");
});

test("recordUsage() accumulates per-session; usageFor is empty for an unknown session", () => {
  const sid = "rc-usage";
  assert.equal(agentRuns.usageFor(sid).totalTokens, 0);
  agentRuns.recordUsage(sid, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  agentRuns.recordUsage(sid, { inputTokens: 2, outputTokens: 1, totalTokens: 3 });
  const u = agentRuns.usageFor(sid);
  assert.equal(u.totalTokens, 17);
  assert.equal(u.turns, 2);
  assert.equal(u.costUsd, null); // local (null price) → tokens only, never invented $
  agentRuns.clearUsage(sid);
  assert.equal(agentRuns.usageFor(sid).totalTokens, 0);
});

/* ── the card already ran it: replay, never re-dispatch ─────────────────────*/

/**
 * The defect these pin: when the broker routes a call to a human, the task card runs the tool
 * while the turn is suspended in `confirm`. The runner then ran it AGAIN, because the replay
 * short-circuit was narrowed to `run_command` — correct only while that was the one tool a
 * human could be asked about. `propose_elevated` and `job_kill` carry no annotations, so no
 * authorisation level auto-approves them and they ALWAYS take the card path; at level 0 so does
 * every read. Running an elevated proposal twice is not a cosmetic problem.
 */

const CARD = (over: Partial<CommandResult> = {}): CommandResult => ({
  command: "git status",
  stdout: "clean",
  exit: 0,
  ...over,
});

test("a result the card already produced is REPLAYED, not run a second time", () => {
  const out = claimCardResult({ tool: "job_kill", result: CARD() }, "job_kill");
  assert.ok(out, "the card's result was not claimed — the tool would run twice");
  assert.equal(out?.ok, true);
  assert.equal(out?.summary, "clean");
});

test("EVERY tool replays, not just run_command", () => {
  // The narrowing was the bug. These three are the ones that always reach a human.
  for (const tool of ["run_command", "propose_elevated", "job_kill", "read_file"]) {
    assert.ok(claimCardResult({ tool, result: CARD() }, tool), `${tool} would have run twice`);
  }
});

test("a STALE entry from another tool is never claimed", () => {
  // Handing one tool's output back as another tool's result is a fabricated observation, and
  // the model builds on it. Falling through to a real dispatch is the only honest option.
  assert.equal(claimCardResult({ tool: "read_file", result: CARD() }, "git_status"), null);
});

test("with no card result at all, the tool dispatches for real", () => {
  // The auto-approved path: no human was asked, so nothing ran yet.
  assert.equal(claimCardResult(undefined, "read_file"), null);
});

test("the gate VERDICT survives the replay", () => {
  // Load-bearing: core's loop aborts the turn on a `block` (agent/loop.ts). Reconstructing the
  // result from stdout/stderr loses the verdict, so a blocked command would read as an
  // ordinary failure and the turn would carry on.
  const raw = {
    ok: false,
    summary: "refused",
    verdict: { verdict: "block" as const, riskScore: 90 },
  };
  const out = claimCardResult(
    { tool: "run_command", result: CARD({ raw, exit: 126 }) },
    "run_command",
  );
  assert.deepEqual(out?.verdict, { verdict: "block", riskScore: 90 });
  assert.equal(out?.ok, false);
});

test("without a raw result it falls back to the flattened stdout/stderr", () => {
  // A card that failed before main answered has no raw result; the reconstruction is the
  // fallback, and it must still carry the exit code the model reasons about.
  const out = claimCardResult(
    {
      tool: "run_command",
      result: CARD({ stdout: "out", stderr: "err", exit: 2, raw: undefined }),
    },
    "run_command",
  );
  assert.equal(out?.summary, "out\nerr");
  assert.equal(out?.ok, false);
  assert.deepEqual(out?.data, { exitCode: 2 });
});
