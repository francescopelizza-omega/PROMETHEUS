/**
 * exec-runner.test.ts — `run_command` end to end (Phase 2).
 *
 * The spawn is INJECTED, so this suite never starts a real process. What it pins is that the
 * runner does what the confirm dialog promised: the exact argv, no shell anywhere, the
 * pipeline's exit code, and `&&` / `||` evaluated by us rather than by something we did not
 * validate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCommand } from "@prometheus/core/agent-exec";

import { runParsedCommand } from "@prometheus/core/agent-system-host";
import { runSystemTool } from "./system-tools.js";

/** A fake `spawn`: records argv, replays a scripted result per program. */
function fakeSpawn(script: Record<string, { code?: number; out?: string; err?: string }> = {}) {
  const spawned: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const spawnImpl = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawned.push({ cmd, args, opts });
    const plan = script[cmd] ?? {};
    const outCbs: ((c: Buffer) => void)[] = [];
    const errCbs: ((c: Buffer) => void)[] = [];
    const closeCbs: ((code?: unknown) => void)[] = [];
    queueMicrotask(() => {
      if (plan.out) for (const cb of outCbs) cb(Buffer.from(plan.out));
      if (plan.err) for (const cb of errCbs) cb(Buffer.from(plan.err));
      for (const cb of closeCbs) cb(plan.code ?? 0);
    });
    return {
      pid: undefined, // no pid ⇒ nothing is tracked, nothing to reap in a test
      stdout: { on: (_e: "data", cb: (c: Buffer) => void) => outCbs.push(cb) },
      stderr: { on: (_e: "data", cb: (c: Buffer) => void) => errCbs.push(cb) },
      stdin: { end: () => {}, write: () => {} },
      on: (e: string, cb: (a?: unknown) => void) => {
        if (e === "close") closeCbs.push(cb);
      },
      kill: () => {},
    };
  };
  return { spawnImpl, spawned };
}

const CWD = "/repo";

function parsed(line: string) {
  const r = parseCommand(line, { vars: {} });
  assert.equal(r.ok, true, `parse failed: ${line}`);
  if (!r.ok) throw new Error("unreachable");
  return r.command;
}

/* ── no shell, ever ──────────────────────────────────────────────────────────*/

test("each stage spawns its OWN program — no shell is in the process list", async () => {
  const { spawnImpl, spawned } = fakeSpawn({ ps: { out: "1 node\n" } });
  await runParsedCommand(parsed("ps aux | grep node | wc -l"), { cwd: CWD, spawnImpl });
  assert.deepEqual(
    spawned.map((s) => s.cmd),
    ["ps", "grep", "wc"],
  );
  for (const s of spawned) {
    assert.equal(s.opts.shell, false, "shell:false is the whole design");
    assert.equal(s.opts.cwd, CWD);
    assert.ok(!["sh", "bash", "zsh"].includes(s.cmd));
  }
});

test("argv reaches spawn already split — nothing re-parses a string", async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  await runParsedCommand(parsed(`grep "a b" file.txt`), { cwd: CWD, spawnImpl });
  assert.deepEqual(spawned[0]?.args, ["a b", "file.txt"], "the quoted arg stays ONE argument");
});

test("children get their own process group so a timeout can reach grandchildren", async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  await runParsedCommand(parsed("ls"), { cwd: CWD, spawnImpl });
  assert.equal(spawned[0]?.opts.detached, true);
});

/* ── exit codes + sequencing ─────────────────────────────────────────────────*/

test("the pipeline's exit code is the LAST stage's, as a shell would report", async () => {
  const { spawnImpl } = fakeSpawn({ ls: { code: 1 }, wc: { code: 0 } });
  const r = await runParsedCommand(parsed("ls | wc -l"), { cwd: CWD, spawnImpl });
  assert.equal(r.exitCode, 0);
});

test("`&&` skips the rest when the left side fails", async () => {
  const { spawnImpl, spawned } = fakeSpawn({ ls: { code: 1 } });
  const r = await runParsedCommand(parsed("ls && wc -l"), { cwd: CWD, spawnImpl });
  assert.deepEqual(
    spawned.map((s) => s.cmd),
    ["ls"],
    "wc must not run",
  );
  assert.equal(r.exitCode, 1);
});

test("`||` runs the right side only when the left one fails", async () => {
  const a = fakeSpawn({ ls: { code: 0 } });
  await runParsedCommand(parsed("ls || wc -l"), { cwd: CWD, spawnImpl: a.spawnImpl });
  assert.deepEqual(
    a.spawned.map((s) => s.cmd),
    ["ls"],
  );

  const b = fakeSpawn({ ls: { code: 2 } });
  await runParsedCommand(parsed("ls || wc -l"), { cwd: CWD, spawnImpl: b.spawnImpl });
  assert.deepEqual(
    b.spawned.map((s) => s.cmd),
    ["ls", "wc"],
  );
});

test("`;` runs both regardless of the first one's outcome", async () => {
  const { spawnImpl, spawned } = fakeSpawn({ ls: { code: 3 } });
  await runParsedCommand(parsed("ls; wc -l"), { cwd: CWD, spawnImpl });
  assert.deepEqual(
    spawned.map((s) => s.cmd),
    ["ls", "wc"],
  );
});

test("argvExecuted records what actually ran — the audit line", async () => {
  const { spawnImpl } = fakeSpawn();
  const r = await runParsedCommand(parsed("ps aux | wc -l"), { cwd: CWD, spawnImpl });
  assert.deepEqual(r.argvExecuted, [
    ["ps", "aux"],
    ["wc", "-l"],
  ]);
});

/* ── through the tool ────────────────────────────────────────────────────────*/

test("run_command reports the command, the tier and the exit code", async () => {
  const { spawnImpl } = fakeSpawn({ ps: { out: "1 node\n" }, wc: { out: "1\n" } });
  const out = await runSystemTool(
    "run_command",
    { command: "ps aux | wc -l" },
    { cwd: CWD, spawnImpl },
  );
  assert.equal(out?.ok, true);
  assert.match(out?.summary ?? "", /\$ ps aux \| wc -l\s+\[read\]/);
  assert.match(out?.summary ?? "", /exit 0/);
  assert.equal(out?.data?.tier, "read");
});

test("a non-zero exit is ok:false but still returns the output", async () => {
  const { spawnImpl } = fakeSpawn({ ls: { code: 2, err: "No such file\n" } });
  const out = await runSystemTool("run_command", { command: "ls nope" }, { cwd: CWD, spawnImpl });
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /exit 2/);
  assert.match(out?.summary ?? "", /No such file/);
});

test("a parse refusal NEVER spawns, and carries the hint", async () => {
  let spawned = false;
  const spawnImpl = () => {
    spawned = true;
    throw new Error("must not spawn");
  };
  const out = await runSystemTool(
    "run_command",
    { command: "echo $(whoami)" },
    { cwd: CWD, spawnImpl: spawnImpl as never },
  );
  assert.equal(out?.ok, false);
  assert.equal(spawned, false);
  assert.match(out?.summary ?? "", /command substitution/);
  assert.match(out?.summary ?? "", /own tool call/, "the hint must reach the model");
});

test("a classification refusal NEVER spawns", async () => {
  let spawned = false;
  const spawnImpl = () => {
    spawned = true;
    throw new Error("must not spawn");
  };
  for (const line of ["sudo id", "git -c core.pager=sh status", "ls | xargs rm"]) {
    const out = await runSystemTool(
      "run_command",
      { command: line },
      { cwd: CWD, spawnImpl: spawnImpl as never },
    );
    assert.equal(out?.ok, false, `"${line}" was not refused`);
    assert.equal(spawned, false, `"${line}" spawned`);
  }
});

test("run_command output is redacted like every other tool's", async () => {
  const { spawnImpl } = fakeSpawn({
    cat: { out: "OPENAI_API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n" },
  });
  const out = await runSystemTool(
    "run_command",
    { command: "cat .config" },
    { cwd: CWD, spawnImpl },
  );
  assert.ok(!out?.summary.includes("sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), "a key leaked");
  assert.match(out?.summary ?? "", /redacted/);
});

test("an empty command is refused before anything else happens", async () => {
  const out = await runSystemTool("run_command", { command: "   " }, { cwd: CWD });
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /no command given/);
});

/* ── redirect targets are paths, and paths are guarded (Phase 4) ─────────────*/

test("a redirect target outside the working set is REFUSED before any spawn", async () => {
  // `pathArgsOf` guards tool ARGUMENTS; a `>` target lives inside the command string, so
  // without an explicit check this reached `openSync` with nothing having looked at it.
  let spawned = false;
  const spawnImpl = () => {
    spawned = true;
    throw new Error("must not spawn");
  };
  const out = await runSystemTool(
    "run_command",
    { command: "echo pwned > /etc/hosts" },
    { cwd: "/repo", roots: ["/repo"], spawnImpl: spawnImpl as never },
  );
  assert.equal(out?.ok, false);
  assert.equal(spawned, false);
  assert.match(out?.summary ?? "", /outside the working set/);
});

test("a redirect INSIDE the working set is allowed", async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  const out = await runSystemTool(
    "run_command",
    { command: "echo hi > notes.txt" },
    { cwd: process.cwd(), roots: [process.cwd()], spawnImpl },
  );
  assert.equal(out?.ok, true, out?.summary);
  assert.equal(spawned.length, 1);
});

test("a redirect onto a CREDENTIAL path is refused even inside the working set", async () => {
  let spawned = false;
  const spawnImpl = () => {
    spawned = true;
    throw new Error("must not spawn");
  };
  const out = await runSystemTool(
    "run_command",
    { command: "echo x > .env" },
    { cwd: process.cwd(), roots: [process.cwd()], spawnImpl: spawnImpl as never },
  );
  assert.equal(out?.ok, false);
  assert.equal(spawned, false);
  assert.match(out?.summary ?? "", /refused to read|environment file/);
});

/* ══ REGRESSIONS — each of these was a live defect found by adversarial review ═══════════
 * Written after the fact, which is the wrong order. They exist so the fixes cannot silently
 * come undone: all three were introduced by code that read as obviously correct.
 */

/** A spawn whose children close only when told — the timing is the thing under test. */
function scriptedSpawn() {
  const procs: { close: (code?: number) => void; killed: string[] }[] = [];
  const spawnImpl = (_c: string, _a: string[], _o: Record<string, unknown>) => {
    const closeCbs: ((code?: unknown) => void)[] = [];
    const killed: string[] = [];
    procs.push({
      close: (code = 0) => {
        for (const cb of closeCbs) cb(code);
      },
      killed,
    });
    return {
      pid: undefined,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: { end: () => {}, write: () => {} },
      on: (e: string, cb: (a?: unknown) => void) => {
        if (e === "close") closeCbs.push(cb);
      },
      kill: (sig?: string) => killed.push(sig ?? "SIGTERM"),
    };
  };
  return { spawnImpl, procs };
}

test("REGRESSION: a fast first stage does NOT disarm the pipeline's timeout", async () => {
  // The timer was cleared on EVERY stage's `close`, so the first stage to exit cancelled the
  // whole wall-clock budget. Any pipeline with a quick head — `cat f | slow`, `git log | slow`
  // — was effectively unbounded, and reported `timedOut: false` while overrunning.
  const { spawnImpl, procs } = scriptedSpawn();
  const p = runParsedCommand(parsed("echo hi | sleep"), {
    cwd: CWD,
    spawnImpl,
    timeoutMs: 40,
  });
  await new Promise((r) => setTimeout(r, 5));
  procs[0]?.close(0); // the head finishes immediately — this must not clear the timer
  const res = await p;
  assert.equal(res.timedOut, true, "the timeout was disarmed by the first stage to exit");
  assert.ok(procs[1]?.killed.length, "the still-running tail stage must actually be killed");
});

test("REGRESSION: a relative redirect resolves against the SESSION cwd, not the host's", async () => {
  // The guard validated `resolve(opts.cwd, target)` while the runner called
  // `openSync(target)` — which resolves against the HOST process cwd. With `--cwd` set, the
  // check and the write examined two different files.
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "prom-redir-"));
  const { spawnImpl, procs } = scriptedSpawn();
  const p = runParsedCommand(parsed("echo hi > out.txt"), { cwd: dir, spawnImpl });
  await new Promise((r) => setTimeout(r, 5));
  procs[0]?.close(0);
  await p;
  assert.ok(existsSync(join(dir, "out.txt")), "the redirect was written outside the session cwd");
  assert.ok(!existsSync(join(process.cwd(), "out.txt")), "it leaked into the host cwd");
});

test("REGRESSION: `cat .env` is refused exactly like `read_file('.env')`", async () => {
  // `read_file` ran `guardSecretPath`; `run_command` guarded only REDIRECT targets, so a
  // credential file was one `cat` away — and at tier `read`, which A1 auto-approves.
  const { spawnImpl, procs } = scriptedSpawn();
  for (const command of ["cat .env", "grep -r x .env", "head ~/.aws/credentials"]) {
    const out = await runSystemTool(
      "run_command",
      { command },
      { cwd: CWD, spawnImpl, gateMode: "off" },
    );
    assert.equal(out?.ok, false, `"${command}" was allowed to read a credential file`);
  }
  assert.equal(procs.length, 0, "a refused command must never reach a spawn");
});
