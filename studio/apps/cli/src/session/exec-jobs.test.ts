/**
 * exec-jobs.test.ts — background + streaming modes (Phase 4).
 *
 * The acceptance criterion for this phase is that a long `pip install` behaves: it does not
 * block the turn, its output is readable while it runs, it can be stopped, and Ctrl-C does
 * not leave it running. The orphan half is covered by the tracking assertions here plus the
 * existing child-reaper suite; this file owns the job lifecycle.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  describeJob,
  getJob,
  killJob,
  listJobs,
  resetJobs,
  startJob,
} from "@prometheus/core/agent-system-host";
import { makeStreamSink } from "./exec-stream.js";
import { runSystemTool } from "./system-tools.js";

beforeEach(() => resetJobs());

/** A spawn fake whose child stays alive until `finish()` is called. */
function controllableSpawn() {
  const handles: {
    emit: (s: string) => void;
    finish: (code?: number) => void;
    killed: string[];
  }[] = [];
  const spawnImpl = (_c: string, _a: string[], _o: Record<string, unknown>) => {
    const outCbs: ((c: Buffer) => void)[] = [];
    const closeCbs: ((code?: unknown) => void)[] = [];
    const killed: string[] = [];
    handles.push({
      emit: (s) => {
        for (const cb of outCbs) cb(Buffer.from(s));
      },
      finish: (code = 0) => {
        for (const cb of closeCbs) cb(code);
      },
      killed,
    });
    return {
      pid: undefined,
      stdout: { on: (_e: "data", cb: (c: Buffer) => void) => outCbs.push(cb) },
      stderr: { on: () => {} },
      stdin: { end: () => {}, write: () => {} },
      on: (e: string, cb: (a?: unknown) => void) => {
        if (e === "close") closeCbs.push(cb);
      },
      kill: (sig?: string) => killed.push(sig ?? "SIGTERM"),
    };
  };
  return { spawnImpl, handles };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/* ── background mode ─────────────────────────────────────────────────────────*/

test("background mode returns a handle IMMEDIATELY instead of blocking the turn", async () => {
  const { spawnImpl, handles } = controllableSpawn();
  const out = await runSystemTool(
    "run_command",
    { command: "ls -la", mode: "background" },
    { cwd: "/repo", spawnImpl, gateMode: "off" },
  );
  assert.equal(out?.ok, true);
  assert.match(out?.summary ?? "", /started job-1 in the background/);
  assert.equal(out?.data?.jobId, "job-1");
  // the child is running — the tool returned without waiting for it
  assert.equal(handles.length, 1);
  assert.equal(getJob("job-1")?.state, "running");
  handles[0]?.finish(0);
});

test("job_status reports the lifecycle, and lists every job when given no id", async () => {
  const { spawnImpl, handles } = controllableSpawn();
  await runSystemTool(
    "run_command",
    { command: "ls", mode: "background" },
    { cwd: "/repo", spawnImpl, gateMode: "off" },
  );
  let st = await runSystemTool("job_status", { id: "job-1" }, { cwd: "/repo" });
  assert.match(st?.summary ?? "", /job-1 \[running/);

  handles[0]?.finish(0);
  await tick();
  st = await runSystemTool("job_status", { id: "job-1" }, { cwd: "/repo" });
  assert.match(st?.summary ?? "", /job-1 \[done · exit 0/);

  const all = await runSystemTool("job_status", {}, { cwd: "/repo" });
  assert.equal(all?.data?.count, 1);
});

test("job_output is readable WHILE the job runs", async () => {
  const { spawnImpl, handles } = controllableSpawn();
  await runSystemTool(
    "run_command",
    { command: "ls", mode: "background" },
    { cwd: "/repo", spawnImpl, gateMode: "off" },
  );
  handles[0]?.emit("first line\n");
  await tick();
  const out = await runSystemTool("job_output", { id: "job-1" }, { cwd: "/repo" });
  assert.match(out?.summary ?? "", /first line/, "output must be readable before the job ends");
  handles[0]?.finish(0);
});

test("a non-zero exit marks the job failed, and the output survives", async () => {
  const { spawnImpl, handles } = controllableSpawn();
  await runSystemTool(
    "run_command",
    { command: "ls", mode: "background" },
    { cwd: "/repo", spawnImpl, gateMode: "off" },
  );
  handles[0]?.emit("boom\n");
  handles[0]?.finish(2);
  await tick();
  const job = getJob("job-1");
  assert.equal(job?.state, "failed");
  assert.equal(job?.exitCode, 2);
  assert.match(job?.output ?? "", /boom/);
});

test("job_kill stops a running job; killing a finished one is a no-op, not an error", async () => {
  const { spawnImpl, handles } = controllableSpawn();
  await runSystemTool(
    "run_command",
    { command: "ls", mode: "background" },
    { cwd: "/repo", spawnImpl, gateMode: "off" },
  );
  const k = await runSystemTool("job_kill", { id: "job-1" }, { cwd: "/repo" });
  assert.equal(k?.ok, true);
  handles[0]?.finish(130);
  await tick();
  const again = await runSystemTool("job_kill", { id: "job-1" }, { cwd: "/repo" });
  assert.equal(again?.ok, true);
  assert.match(again?.summary ?? "", /already finished/);
});

test("an unknown job handle is refused with a reason, never silently empty", async () => {
  for (const tool of ["job_status", "job_output", "job_kill"]) {
    const out = await runSystemTool(tool, { id: "job-999" }, { cwd: "/repo" });
    assert.equal(out?.ok, false, `${tool} accepted an unknown handle`);
    assert.match(out?.summary ?? "", /no such job/);
  }
});

/* ── a background job is STILL gated ─────────────────────────────────────────*/

test("backgrounding does not bypass a single gate", async () => {
  let spawned = false;
  const spawnImpl = () => {
    spawned = true;
    throw new Error("must not spawn");
  };
  for (const command of ["sudo id", "echo $(whoami)", "git -c core.pager=sh status"]) {
    const out = await runSystemTool(
      "run_command",
      { command, mode: "background" },
      { cwd: "/repo", spawnImpl: spawnImpl as never, gateMode: "off" },
    );
    assert.equal(out?.ok, false, `"${command}" was backgrounded without being refused`);
    assert.equal(spawned, false);
  }
  assert.equal(listJobs().length, 0, "a refused command must not create a job");
});

test("a nemesis BLOCK stops a background command too", async () => {
  const { spawnImpl } = controllableSpawn();
  const out = await runSystemTool(
    "run_command",
    { command: "ls", mode: "background" },
    {
      cwd: "/repo",
      spawnImpl,
      authLevel: 7,
      gateImpl: async () => ({
        verdict: "block" as const,
        risk_score: 100,
        signed: false,
        findings: [],
        scannedAt: new Date().toISOString(),
        target: "command",
      }),
    },
  );
  assert.equal(out?.ok, false);
  assert.equal(listJobs().length, 0);
});

/* ── stream mode ─────────────────────────────────────────────────────────────*/

test("stream mode writes output live to the host's sink AND still returns it", async () => {
  const seen: string[] = [];
  const { spawnImpl, handles } = controllableSpawn();
  const p = runSystemTool(
    "run_command",
    { command: "ls", mode: "stream" },
    { cwd: "/repo", spawnImpl, gateMode: "off", onProgress: (c) => seen.push(c) },
  );
  await tick();
  handles[0]?.emit("live!\n");
  handles[0]?.finish(0);
  const out = await p;
  assert.deepEqual(seen, ["live!\n"], "the host sink must receive it as it arrives");
  assert.match(out?.summary ?? "", /live!/, "and the return value still carries it");
});

test("collect mode does NOT write to the live sink", async () => {
  const seen: string[] = [];
  const { spawnImpl, handles } = controllableSpawn();
  const p = runSystemTool(
    "run_command",
    { command: "ls" },
    { cwd: "/repo", spawnImpl, gateMode: "off", onProgress: (c) => seen.push(c) },
  );
  await tick();
  handles[0]?.emit("quiet\n");
  handles[0]?.finish(0);
  await p;
  assert.deepEqual(seen, [], "collect is the default and must stay silent");
});

/* ── bookkeeping ─────────────────────────────────────────────────────────────*/

test("describeJob is a single readable line", () => {
  const job = startJob({
    command: "pip install torch",
    tier: "install",
    run: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      durationMs: 1,
      argvExecuted: [],
    }),
  });
  assert.match(describeJob(job), /^job-1 \[running · \d+s · install\] pip install torch$/);
});

test("a job ended by its WATCHDOG reports timeout, never killed", async () => {
  // The runner's timer is per pipeline, so a multi-part `a && b` job can outlive the job
  // watchdog without either part timing out. The watchdog's abort then arrived through the
  // signal and was reported as "killed" — the state for a deliberate job_kill.
  const job = startJob({
    command: "make deps && make all",
    tier: "command",
    timeoutMs: 20,
    run: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () =>
          resolve({
            exitCode: 130,
            stdout: "",
            stderr: "",
            timedOut: false, // no single part hit ITS timeout
            truncated: false,
            durationMs: 20,
            argvExecuted: [],
          }),
        );
      }),
  });
  for (let i = 0; i < 100 && job.state === "running"; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(job.state, "timeout");
});

test("killJob on an unknown handle returns false rather than throwing", () => {
  assert.equal(killJob("nope"), false);
});

/* ── the stream sink: chunks are not lines (Phase 4) ─────────────────────────*/

test("makeStreamSink emits whole LINES, never the raw chunks", () => {
  // A `data` event can split a line in half. Writing chunks straight to the TUI shows
  // half-lines as their own rows and fights the spinner for the parked row.
  const lines: string[] = [];
  const sink = makeStreamSink((l) => lines.push(l));
  sink("Collecting to");
  sink("rch\nDownloading (1/3)\n");
  assert.deepEqual(lines, ["Collecting torch", "Downloading (1/3)"]);
});

test("makeStreamSink flushes a final line that arrived without a newline", () => {
  const lines: string[] = [];
  const sink = makeStreamSink((l) => lines.push(l));
  sink("no trailing newline");
  assert.deepEqual(lines, [], "an unterminated line is held, not guessed at");
  sink.flush();
  assert.deepEqual(lines, ["no trailing newline"]);
});

test("makeStreamSink strips ANSI so a command cannot repaint the TUI chrome", () => {
  const lines: string[] = [];
  const sink = makeStreamSink((l) => lines.push(l));
  // a colour code AND a cursor-move — the second is the dangerous one
  sink("\u001b[31mred\u001b[0m\u001b[2Kerased\n");
  assert.deepEqual(lines, ["rederased"]);
});

test("makeStreamSink drops blank lines", () => {
  const lines: string[] = [];
  const sink = makeStreamSink((l) => lines.push(l));
  sink("a\n\n\n   \nb\n");
  assert.deepEqual(lines, ["a", "b"]);
});
