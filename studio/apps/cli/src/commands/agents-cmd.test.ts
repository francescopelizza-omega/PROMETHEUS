/**
 * agents-cmd.test.ts — the background-run registry + `prometheus agents` surface (CLI-034):
 * register→list, the attach replay/live seam (the hard part), ring-buffer cap, kill-settles,
 * per-provider concurrency, and the command's list/kill/attach.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import type { RunRecord } from "../session/orchestrator.js";
import {
  RUN_BUFFER_CAP_BYTES,
  RunRegistry,
  detachedRunNote,
  runRegistry,
  setRunNotifyDeps,
  startBackgroundRun,
  startDetachedRun,
} from "../session/orchestrator.js";
import { type AgentsDeps, runAgentsCommand } from "./agents-cmd.js";

const ctxFor = (argv: string[]) => makeContext(parseArgs(argv));
const fixedNow = () => "2026-07-17T00:00:00.000Z";

/* ── RunRegistry ────────────────────────────────────────────────────────────── */

test("register → list snapshots the run (running)", () => {
  const reg = new RunRegistry({ now: fixedNow });
  reg.register({ id: "r1", model: "qwen", controller: new AbortController() });
  const runs = reg.list();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.id, "r1");
  assert.equal(runs[0]?.state, "running");
  assert.equal(runs[0]?.model, "qwen");
});

test("attach: replay ends at seq N, live starts at N+1 — no gap, no dup (the seam)", () => {
  const reg = new RunRegistry({ now: fixedNow });
  const id = reg.register({ id: "r1", model: "m", controller: new AbortController() });
  reg.append(id, "a");
  reg.append(id, "b");
  reg.append(id, "c");
  const live: number[] = [];
  const h = reg.attach(id, (ev) => live.push(ev.seq));
  assert.ok(h);
  assert.deepEqual(
    h?.replay.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(h?.lastSeq, 3);
  reg.append(id, "d");
  reg.append(id, "e");
  assert.deepEqual(
    live,
    [4, 5],
    "live subscriber sees ONLY seq 4,5 (N+1..) — no gap/dup at the seam",
  );
});

test("run keeps appending AFTER detach (unsubscribe leaves the run running)", () => {
  const reg = new RunRegistry({ now: fixedNow });
  const id = reg.register({ id: "r1", model: "m", controller: new AbortController() });
  reg.append(id, "x");
  const h = reg.attach(id, () => {});
  h?.unsubscribe(); // detach (Ctrl-C) — the run continues
  reg.append(id, "y");
  reg.append(id, "z");
  // a fresh attach replays everything the run buffered while detached.
  const h2 = reg.attach(id, () => {});
  assert.deepEqual(
    h2?.replay.map((e) => e.text),
    ["x", "y", "z"],
  );
});

test("ring buffer caps at 256 KiB, dropping the head + tracking droppedBytes", () => {
  const reg = new RunRegistry({ now: fixedNow });
  const id = reg.register({ id: "r1", model: "m", controller: new AbortController() });
  const chunk = "A".repeat(64 * 1024); // 64 KiB
  for (let i = 0; i < 6; i++) reg.append(id, chunk); // 384 KiB > 256 KiB cap
  const rec = reg.get(id);
  assert.ok((rec?.droppedBytes ?? 0) > 0, "oldest chunks dropped");
  const h = reg.attach(id, () => {});
  const bufBytes = (h?.replay ?? []).reduce((n, e) => n + Buffer.byteLength(e.text), 0);
  assert.ok(bufBytes <= RUN_BUFFER_CAP_BYTES, "buffer stays under the cap");
});

test("kill: fires the AbortController + settles state to killed within the call", () => {
  const reg = new RunRegistry({ now: fixedNow });
  const ctl = new AbortController();
  const id = reg.register({ id: "r1", model: "m", controller: ctl });
  assert.equal(reg.kill(id), true);
  assert.equal(reg.get(id)?.state, "killed");
  assert.equal(ctl.signal.aborted, true, "the CLI-002 turn signal was aborted");
  assert.equal(reg.kill("nope"), false); // unknown run
});

test("onSettle fires once when a run reaches a terminal state (TUI notice seam)", () => {
  const reg = new RunRegistry({ now: fixedNow });
  const id = reg.register({ id: "r1", model: "m", controller: new AbortController() });
  const settled: string[] = [];
  reg.onSettle(id, (r) => settled.push(r.state));
  reg.setState(id, "done", "ok");
  assert.deepEqual(settled, ["done"]);
});

/* ── startBackgroundRun: per-provider concurrency + settle ─────────────────── */

test("startBackgroundRun: acquires per provider, runs body, settles done", async () => {
  const reg = new RunRegistry({ now: fixedNow });
  const acquired: string[] = [];
  const acquire = async (provider: string, fn: () => Promise<void>) => {
    acquired.push(provider);
    await fn();
  };
  const { id, done } = startBackgroundRun(
    reg,
    acquire,
    { model: "m", provider: "claude" },
    async (rc) => {
      rc.append("working…");
      return { ok: true, summary: "finished" };
    },
  );
  await done;
  assert.deepEqual(acquired, ["claude"], "acquired the claude bulkhead slot");
  assert.equal(reg.get(id)?.state, "done");
  assert.equal(reg.get(id)?.exitSummary, "finished");
});

test("startBackgroundRun: a throwing body settles failed (slot still released)", async () => {
  const reg = new RunRegistry({ now: fixedNow });
  const acquire = async (_p: string, fn: () => Promise<void>) => fn();
  const { id, done } = startBackgroundRun(reg, acquire, { model: "m", provider: "x" }, async () => {
    throw new Error("boom");
  });
  await done;
  assert.equal(reg.get(id)?.state, "failed");
  assert.match(reg.get(id)?.exitSummary ?? "", /boom/);
});

/* ── prometheus agents command ──────────────────────────────────────────────────── */

function agentsDeps(reg: RunRegistry, out: string[]): AgentsDeps {
  return {
    registry: reg,
    now: () => Date.parse("2026-07-17T00:00:05.000Z"),
    write: (t) => out.push(t),
  };
}

test("prometheus agents list: id/state/model/elapsed table + stable --json", async () => {
  const reg = new RunRegistry({ now: fixedNow });
  reg.register({ id: "r1", model: "qwen", controller: new AbortController() });
  const out: string[] = [];
  const list = await runAgentsCommand(ctxFor(["agents", "list"]), agentsDeps(reg, out));
  assert.equal(list.exitCode, 0);
  assert.match(list.text ?? "", /r1/);
  assert.match(list.text ?? "", /5s/); // elapsed from 00:00:00 to 00:00:05
  const j = await runAgentsCommand(ctxFor(["agents", "list", "--json"]), agentsDeps(reg, out));
  const env = j.json as { ok: boolean; runs: { id: string; state: string }[] };
  assert.equal(env.ok, true);
  assert.equal(env.runs[0]?.id, "r1");
});

test("prometheus agents kill <id>: settles killed; unknown → exit 2", async () => {
  const reg = new RunRegistry({ now: fixedNow });
  const ctl = new AbortController();
  reg.register({ id: "r1", model: "m", controller: ctl });
  const out: string[] = [];
  const ok = await runAgentsCommand(ctxFor(["agents", "kill", "r1"]), agentsDeps(reg, out));
  assert.equal(ok.exitCode, 0);
  assert.equal(reg.get("r1")?.state, "killed");
  assert.equal(ctl.signal.aborted, true);
  const miss = await runAgentsCommand(ctxFor(["agents", "kill", "nope"]), agentsDeps(reg, out));
  assert.equal(miss.exitCode, 2);
});

test("prometheus agents attach <finished>: replays the buffer in order + final state", async () => {
  const reg = new RunRegistry({ now: fixedNow });
  const id = reg.register({ id: "r1", model: "m", controller: new AbortController() });
  reg.append(id, "line-1");
  reg.append(id, "line-2");
  reg.setState(id, "done", "ok");
  const out: string[] = [];
  const res = await runAgentsCommand(ctxFor(["agents", "attach", "r1"]), agentsDeps(reg, out));
  assert.equal(res.exitCode, 0);
  assert.deepEqual(out, ["line-1", "line-2"], "buffered output replayed in order");
  assert.match(res.text ?? "", /done/);
});

test("prometheus agents attach: unknown run → exit 2", async () => {
  const reg = new RunRegistry({ now: fixedNow });
  const out: string[] = [];
  const res = await runAgentsCommand(ctxFor(["agents", "attach", "nope"]), agentsDeps(reg, out));
  assert.equal(res.exitCode, 2);
});

/* ── the TRIGGER: startDetachedRun writes to the table `agents` reads ─────────*/

/**
 * These pin the seam that did not exist.
 *
 * `RunRegistry`, `startBackgroundRun` and `runAgentsCommand` were all complete and covered by
 * the tests above, and NOTHING called `startBackgroundRun` in production — so `prometheus
 * agents list` was a correct renderer of a permanently empty table. Coverage over a function
 * with no caller is exactly the failure this repo has hit before, so what is asserted here is
 * the round trip: start a run, then read it back through the REAL command surface.
 */

test("startDetachedRun: a launched run is visible through the real `agents list` surface", async () => {
  let released = false;
  const { id, done } = startDetachedRun({
    model: "qwen3",
    provider: "ollama",
    task: "say hello",
    run: async (rc) => {
      rc.append("thinking…");
      released = true;
      return { ok: true, summary: "hello" };
    },
  });
  await done;
  assert.equal(released, true, "the body actually ran");

  // Read it back the way the user does — through runAgentsCommand over the SHARED registry,
  // not over a fixture. A test that built its own registry would pass while production stayed
  // empty, which is precisely the bug.
  const out = await runAgentsCommand(
    { args: { command: ["agents", "list"], positionals: [], flags: {} }, json: true } as never,
    { registry: runRegistry, now: () => Date.now(), write: () => {} },
  );
  const runs = (out.json as { runs: RunRecord[] }).runs;
  const mine = runs.find((r) => r.id === id);
  assert.ok(mine, "the launched run must appear in `agents list`");
  assert.equal(mine?.state, "done");
  assert.equal(mine?.exitSummary, "hello");
  assert.match(detachedRunNote(id), new RegExp(id));
});

test("detachedRunNote points at `agents list`, NOT the unrelated `/agents` slash command", () => {
  // `/agents` sets the orchestrator's subagent COUNT. Naming it here would send every user who
  // follows the hint to a surface that cannot show them their run.
  const note = detachedRunNote("run-9");
  assert.match(note, /agents list/);
  assert.doesNotMatch(note, /\/agents\b/);
});

test("startDetachedRun: a THROWING body settles failed and still lands in the table", async () => {
  const { id, done } = startDetachedRun({
    model: "m",
    provider: "ollama",
    task: "boom",
    run: async () => {
      throw new Error("model unreachable");
    },
  });
  await done;
  const rec = runRegistry.get(id);
  assert.equal(rec?.state, "failed");
  assert.match(rec?.exitSummary ?? "", /model unreachable/);
});

/* ── the completion NOTIFICATION (the "walk away" half of /background) ────────*/

/**
 * Round-trip assertions, deliberately, for the same reason the ones above are: `run-notify.ts`
 * tested in isolation would prove only that a pure function builds an argv. What matters is
 * that starting a REAL detached run through the REAL registry actually reaches it — the
 * "unit-tested but never wired" shape this repo keeps being bitten by.
 */

test("startDetachedRun: a completed run posts exactly ONE OS notification", async () => {
  const calls: { bin: string; args: string[] }[] = [];
  setRunNotifyDeps({
    platform: "darwin",
    env: {},
    spawnImpl: (bin, args) => {
      calls.push({ bin, args: [...args] });
      return { unref: () => {}, on: () => {} };
    },
  });
  try {
    const { id, done } = startDetachedRun({
      model: "qwen3",
      provider: "ollama",
      task: "notify me",
      run: async () => ({ ok: true, summary: "all good" }),
    });
    await done;
    assert.equal(calls.length, 1, "exactly one notification per settle, not one per poll");
    assert.equal(calls[0]?.bin, "osascript");
    assert.match(calls[0]?.args[1] ?? "", new RegExp(`${id}: all good`));
    assert.match(calls[0]?.args[1] ?? "", /background run finished/);

    // A SECOND terminal transition on the same run must not post again. `setState` has no
    // idempotency guard of its own, so the latch in `startDetachedRun` is what holds this.
    runRegistry.setState(id, "done", "all good again");
    assert.equal(calls.length, 1, "a repeated settle must not duplicate the notification");
  } finally {
    setRunNotifyDeps({});
  }
});

test("startDetachedRun: a FAILED run notifies too, with the failure title", async () => {
  const calls: string[] = [];
  setRunNotifyDeps({
    platform: "darwin",
    env: {},
    spawnImpl: (_bin, args) => {
      calls.push(args[1] ?? "");
      return { unref: () => {}, on: () => {} };
    },
  });
  try {
    const { done } = startDetachedRun({
      model: "m",
      provider: "ollama",
      task: "boom",
      run: async () => {
        throw new Error("model unreachable");
      },
    });
    await done;
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /FAILED/);
    assert.match(calls[0] ?? "", /model unreachable/);
  } finally {
    setRunNotifyDeps({});
  }
});

test("startDetachedRun: a notifier that throws does not break the run or its other subscribers", async () => {
  // onSettle callbacks run synchronously in a `for` loop, so a throw would skip `agents
  // attach`'s finish handler and hang a terminal on a run that had already completed.
  const settled: string[] = [];
  setRunNotifyDeps({
    platform: "darwin",
    env: {},
    spawnImpl: () => {
      throw new Error("EACCES");
    },
  });
  try {
    const { id, done } = startDetachedRun({
      model: "m",
      provider: "ollama",
      task: "t",
      run: async () => ({ ok: true, summary: "fine" }),
    });
    runRegistry.onSettle(id, (r) => settled.push(r.state));
    await done;
    assert.deepEqual(settled, ["done"], "a later subscriber must still have fired");
    assert.equal(runRegistry.get(id)?.state, "done");
  } finally {
    setRunNotifyDeps({});
  }
});
