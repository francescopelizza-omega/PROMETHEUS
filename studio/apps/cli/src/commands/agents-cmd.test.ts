/**
 * agents-cmd.test.ts — the background-run registry + `prom agents` surface (CLI-034):
 * register→list, the attach replay/live seam (the hard part), ring-buffer cap, kill-settles,
 * per-provider concurrency, and the command's list/kill/attach.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { RUN_BUFFER_CAP_BYTES, RunRegistry, startBackgroundRun } from "../session/orchestrator.js";
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

/* ── prom agents command ──────────────────────────────────────────────────── */

function agentsDeps(reg: RunRegistry, out: string[]): AgentsDeps {
  return {
    registry: reg,
    now: () => Date.parse("2026-07-17T00:00:05.000Z"),
    write: (t) => out.push(t),
  };
}

test("prom agents list: id/state/model/elapsed table + stable --json", async () => {
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

test("prom agents kill <id>: settles killed; unknown → exit 2", async () => {
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

test("prom agents attach <finished>: replays the buffer in order + final state", async () => {
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

test("prom agents attach: unknown run → exit 2", async () => {
  const reg = new RunRegistry({ now: fixedNow });
  const out: string[] = [];
  const res = await runAgentsCommand(ctxFor(["agents", "attach", "nope"]), agentsDeps(reg, out));
  assert.equal(res.exitCode, 2);
});
