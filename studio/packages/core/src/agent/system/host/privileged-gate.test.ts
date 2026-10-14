// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * privileged-gate.test.ts — the only code that may start a privileged process.
 *
 * No test here runs sudo. Every spawn goes through a recording fake; every approval comes
 * from a stub approver. What is under test is the GATE's discipline: who is asked, when, how
 * often, what is shown, what is re-checked, what is recorded — and that nothing but a human
 * answer for that exact command ever reaches a spawn.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ApprovalAnswer,
  type ApprovalView,
  type GateDeps,
  type PrivilegedRequest,
  createPrivilegedGate,
  sudoAuditPath,
  trustedBinary,
} from "./privileged-gate.js";

/* ── fakes ─────────────────────────────────────────────────────────────────── */

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
}

/** A spawn that records its call and exits with `code` on the next tick, after `out`. */
function fakeSpawn(
  calls: SpawnCall[],
  behaviour: { code?: number; out?: string; error?: Error; hang?: boolean } = {},
) {
  return (cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: null;
      killed: string[];
      kill(sig?: string): void;
    };
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = null;
    child.killed = [];
    child.kill = (sig?: string) => {
      child.killed.push(sig ?? "SIGTERM");
      setImmediate(() => child.emit("close", null, sig ?? "SIGTERM"));
    };
    setImmediate(() => {
      if (behaviour.error) {
        child.emit("error", behaviour.error);
        return;
      }
      if (behaviour.hang) return;
      if (behaviour.out) child.stdout.emit("data", Buffer.from(behaviour.out));
      child.emit("close", behaviour.code ?? 0, null);
    });
    (calls as unknown as { last?: typeof child }).last = child;
    return child;
  };
}

function approveWith(answer: ApprovalAnswer, seen: ApprovalView[] = []) {
  return async (view: ApprovalView): Promise<ApprovalAnswer> => {
    seen.push(view);
    return answer;
  };
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "prom-gate-"));
}

function deps(extra: Partial<GateDeps> & { calls?: SpawnCall[] } = {}): GateDeps {
  const calls = extra.calls ?? [];
  return {
    passwordVia: "tty",
    home: extra.home ?? home(),
    userHome: "/Users/someone",
    resolveElevator: () => "/usr/bin/sudo",
    spawnImpl: fakeSpawn(calls),
    ...extra,
  };
}

const REQ: PrivilegedRequest = {
  argv: ["apt-get", "install", "-y", "ripgrep"],
  cwd: "/tmp",
  why: "install ripgrep system-wide for the glob tool",
  surface: "tui",
  requester: "agent",
};

function auditLines(h: string): Record<string, unknown>[] {
  return readFileSync(sudoAuditPath(h), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/* ── no human, no run ─────────────────────────────────────────────────────── */

test("with no approver attached (headless, MCP, CI) nothing runs: the result is a proposal", async () => {
  const calls: SpawnCall[] = [];
  const h = home();
  const r = await createPrivilegedGate(deps({ calls, home: h, approver: undefined })).requestAndRun(
    REQ,
  );
  assert.equal(r.ok, false);
  assert.equal(r.decision, "no-human");
  assert.match(r.proposal ?? "", /sudo apt-get install -y ripgrep/);
  assert.equal(calls.length, 0);
  assert.equal(auditLines(h)[0]?.decision, "no-human");
});

/* ── every request asks, every time ───────────────────────────────────────── */

test("the human is asked on EVERY request — two identical commands, two prompts, two runs", async () => {
  const calls: SpawnCall[] = [];
  const seen: ApprovalView[] = [];
  const gate = createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve" }, seen) }),
  );
  const a = await gate.requestAndRun(REQ);
  const b = await gate.requestAndRun(REQ);
  assert.equal(a.decision, "approved");
  assert.equal(b.decision, "approved");
  assert.equal(seen.length, 2);
  assert.equal(calls.length, 2);
  assert.notEqual(seen[0]?.id, seen[1]?.id);
});

test("the view shows the exact command, the exact spawn argv, the cwd, who asked and why", async () => {
  const seen: ApprovalView[] = [];
  const calls: SpawnCall[] = [];
  await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve" }, seen) }),
  ).requestAndRun(REQ);
  const v = seen[0] as ApprovalView;
  assert.equal(v.commandLine, "sudo apt-get install -y ripgrep");
  assert.deepEqual(v.argv, REQ.argv);
  assert.deepEqual(v.execArgv, [calls[0]?.cmd, ...(calls[0]?.args ?? [])]);
  assert.equal(v.cwd, "/tmp");
  assert.equal(v.surface, "tui");
  assert.equal(v.requester, "agent");
  assert.equal(v.why, REQ.why);
  assert.ok(v.timeoutMs > 0);
});

test("deny means no spawn", async () => {
  const calls: SpawnCall[] = [];
  const r = await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "deny" }) }),
  ).requestAndRun(REQ);
  assert.equal(r.decision, "denied");
  assert.equal(calls.length, 0);
});

test("no answer in time is a deny, and a late approval is ignored", async () => {
  const calls: SpawnCall[] = [];
  let late: ((a: ApprovalAnswer) => void) | undefined;
  let aborted = false;
  const approver = (_v: ApprovalView, signal: AbortSignal) =>
    new Promise<ApprovalAnswer>((resolve) => {
      late = resolve;
      signal.addEventListener("abort", () => {
        aborted = true;
      });
    });
  const r = await createPrivilegedGate(
    deps({ calls, approver, approvalTimeoutMs: 20 }),
  ).requestAndRun(REQ);
  assert.equal(r.decision, "timeout");
  assert.equal(aborted, true);
  late?.({ decision: "approve" });
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(calls.length, 0);
});

/* ── what was approved is what runs ───────────────────────────────────────── */

test("an argv changed after approval is refused", async () => {
  const calls: SpawnCall[] = [];
  const req = { ...REQ, argv: [...REQ.argv] };
  const approver = async (): Promise<ApprovalAnswer> => {
    req.argv.push("--allow-downgrades"); // the request object mutates under the prompt
    return { decision: "approve" };
  };
  const r = await createPrivilegedGate(deps({ calls, approver })).requestAndRun(req);
  assert.equal(r.decision, "refused");
  assert.match(r.reason ?? "", /changed after approval/);
  assert.equal(calls.length, 0);
});

test("a cwd changed after approval is refused", async () => {
  const calls: SpawnCall[] = [];
  const req = { ...REQ };
  const approver = async (): Promise<ApprovalAnswer> => {
    req.cwd = "/etc";
    return { decision: "approve" };
  };
  const r = await createPrivilegedGate(deps({ calls, approver })).requestAndRun(req);
  assert.equal(r.decision, "refused");
  assert.equal(calls.length, 0);
});

test("a script is shown with path, size, sha256 and first lines — and re-hashed before it runs", async () => {
  const dir = home();
  const script = join(dir, "fix.sh");
  writeFileSync(script, "#!/bin/sh\necho fixing\n");
  chmodSync(script, 0o755);
  const seen: ApprovalView[] = [];
  const calls: SpawnCall[] = [];
  const ok = await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve" }, seen) }),
  ).requestAndRun({ ...REQ, argv: ["./fix.sh"], cwd: dir });
  assert.equal(ok.decision, "approved");
  const s = seen[0]?.script;
  assert.equal(s?.path, script);
  assert.equal(s?.size, 22);
  assert.match(s?.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(s?.head, ["#!/bin/sh", "echo fixing"]);

  // the same script, edited while the human reads the prompt
  const calls2: SpawnCall[] = [];
  const approver = async (): Promise<ApprovalAnswer> => {
    writeFileSync(script, "#!/bin/sh\nrm -rf /\n");
    return { decision: "approve" };
  };
  const r = await createPrivilegedGate(deps({ calls: calls2, approver })).requestAndRun({
    ...REQ,
    argv: ["./fix.sh"],
    cwd: dir,
  });
  assert.equal(r.decision, "refused");
  assert.match(r.reason ?? "", /changed after approval/);
  assert.equal(calls2.length, 0);
});

test("an interpreter's script operand is hashed too (python3 tool.py)", async () => {
  const dir = home();
  writeFileSync(join(dir, "tool.py"), "print('hi')\n");
  const seen: ApprovalView[] = [];
  await createPrivilegedGate(
    deps({ approver: approveWith({ decision: "approve" }, seen) }),
  ).requestAndRun({
    ...REQ,
    argv: ["/usr/bin/python3", "tool.py", "--no-sudo"],
    cwd: dir,
  });
  assert.equal(seen[0]?.script?.path, join(dir, "tool.py"));
});

/* ── catastrophic commands need their target typed ───────────────────────── */

test("a catastrophic command needs its target typed: missing or wrong phrase refuses", async () => {
  const req = { ...REQ, argv: ["dd", "if=x.img", "of=/dev/disk4"] };
  for (const answer of [
    { decision: "approve" } as const,
    { decision: "approve", phrase: "disk4" } as const,
  ]) {
    const calls: SpawnCall[] = [];
    const seen: ApprovalView[] = [];
    const r = await createPrivilegedGate(
      deps({ calls, approver: approveWith(answer, seen) }),
    ).requestAndRun(req);
    assert.equal(seen[0]?.phrase, "/dev/disk4");
    assert.equal(r.decision, "refused");
    assert.equal(calls.length, 0);
  }
  const calls: SpawnCall[] = [];
  const r = await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve", phrase: "/dev/disk4" }) }),
  ).requestAndRun(req);
  assert.equal(r.decision, "approved");
  assert.equal(calls.length, 1);
});

/* ── refusals that never reach a human ────────────────────────────────────── */

test("a nemesis block refuses before anyone is asked", async () => {
  const seen: ApprovalView[] = [];
  const calls: SpawnCall[] = [];
  const r = await createPrivilegedGate(
    deps({
      calls,
      approver: approveWith({ decision: "approve" }, seen),
      scan: async () => ({ blocked: true, reason: "R3.sudo: curl piped to a root shell" }),
    }),
  ).requestAndRun(REQ);
  assert.equal(r.decision, "blocked");
  assert.match(r.reason ?? "", /R3\.sudo/);
  assert.equal(seen.length, 0);
  assert.equal(calls.length, 0);
});

test("argv that is not the canonical shape is refused before anyone is asked", async () => {
  for (const argv of [["sudo", "id"], ["sh", "-c", "id"], ["env", "X=1", "id"], ["-rf", "/"], []]) {
    const seen: ApprovalView[] = [];
    const calls: SpawnCall[] = [];
    const r = await createPrivilegedGate(
      deps({ calls, approver: approveWith({ decision: "approve" }, seen) }),
    ).requestAndRun({ ...REQ, argv });
    assert.equal(r.decision, "refused", JSON.stringify(argv));
    assert.equal(seen.length, 0);
    assert.equal(calls.length, 0);
  }
});

test("no trusted elevator binary means refused, not a PATH lookup", async () => {
  const calls: SpawnCall[] = [];
  const r = await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve" }), resolveElevator: () => null }),
  ).requestAndRun(REQ);
  assert.equal(r.decision, "refused");
  assert.equal(calls.length, 0);
});

test("trustedBinary refuses a binary the user owns (a fake sudo would harvest the password)", () => {
  const f = join(home(), "sudo");
  writeFileSync(f, "#!/bin/sh\n");
  chmodSync(f, 0o755);
  assert.equal(trustedBinary(f), false);
  assert.equal(trustedBinary("/nonexistent/sudo"), false);
});

/* ── execution ────────────────────────────────────────────────────────────── */

test("tty mode: sudo -p <prompt> -- argv, stdin inherited, no askpass in the env", async () => {
  const calls: SpawnCall[] = [];
  await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve" }) }),
  ).requestAndRun(REQ);
  const c = calls[0] as SpawnCall;
  assert.equal(c.cmd, "/usr/bin/sudo");
  assert.deepEqual(c.args, ["-p", "[PROMETHEUS] password for %u: ", "--", ...REQ.argv]);
  assert.equal(c.opts.shell, false);
  assert.equal(c.opts.cwd, "/tmp");
  assert.deepEqual(c.opts.stdio, ["inherit", "pipe", "pipe"]);
  assert.equal((c.opts.env as Record<string, string>).SUDO_ASKPASS, undefined);
});

test("askpass mode: sudo -A, SUDO_ASKPASS set, stdin ignored", async () => {
  const calls: SpawnCall[] = [];
  await createPrivilegedGate(
    deps({
      calls,
      passwordVia: "askpass",
      askpass: async () => "/tmp/prom-askpass/askpass.sh",
      approver: approveWith({ decision: "approve" }),
    }),
  ).requestAndRun(REQ);
  const c = calls[0] as SpawnCall;
  assert.deepEqual(c.args.slice(0, 4), ["-p", "[PROMETHEUS] password for %u: ", "-A", "--"]);
  assert.equal((c.opts.env as Record<string, string>).SUDO_ASKPASS, "/tmp/prom-askpass/askpass.sh");
  assert.deepEqual(c.opts.stdio, ["ignore", "pipe", "pipe"]);
});

test("askpass mode with no helper available refuses (it never falls back to a hidden prompt)", async () => {
  const calls: SpawnCall[] = [];
  const r = await createPrivilegedGate(
    deps({
      calls,
      passwordVia: "askpass",
      askpass: async () => null,
      approver: approveWith({ decision: "approve" }),
    }),
  ).requestAndRun(REQ);
  assert.equal(r.decision, "refused");
  assert.match(r.reason ?? "", /terminal/);
  assert.equal(calls.length, 0);
});

test("output and exit code come back; the terminal is suspended before spawn and resumed after", async () => {
  const order: string[] = [];
  const calls: SpawnCall[] = [];
  const chunks: string[] = [];
  const r = await createPrivilegedGate(
    deps({
      calls,
      spawnImpl: (cmd, args, opts) => {
        order.push("spawn");
        return fakeSpawn(calls, { code: 3, out: "done\n" })(cmd, args, opts);
      },
      suspendTerminal: () => {
        order.push("suspend");
      },
      resumeTerminal: () => {
        order.push("resume");
      },
      approver: approveWith({ decision: "approve" }),
    }),
  ).requestAndRun(REQ, { onOutput: (c) => chunks.push(c) });
  assert.deepEqual(order, ["suspend", "spawn", "resume"]);
  assert.equal(r.exitCode, 3);
  assert.equal(r.ok, false);
  assert.equal(r.stdout, "done\n");
  assert.deepEqual(chunks, ["done\n"]);
});

test("the terminal is resumed even when the spawn fails", async () => {
  const order: string[] = [];
  const r = await createPrivilegedGate(
    deps({
      spawnImpl: fakeSpawn([], { error: new Error("ENOENT") }),
      suspendTerminal: () => {
        order.push("suspend");
      },
      resumeTerminal: () => {
        order.push("resume");
      },
      approver: approveWith({ decision: "approve" }),
    }),
  ).requestAndRun(REQ);
  assert.deepEqual(order, ["suspend", "resume"]);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /ENOENT/);
});

test("an execution timeout signals the sudo process (never a process group)", async () => {
  const calls: SpawnCall[] = [];
  const r = await createPrivilegedGate(
    deps({
      calls,
      spawnImpl: fakeSpawn(calls, { hang: true }),
      timeoutMs: 20,
      approver: approveWith({ decision: "approve" }),
    }),
  ).requestAndRun(REQ);
  assert.equal(r.timedOut, true);
  const child = (calls as unknown as { last: { killed: string[] } }).last;
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

/* ── the audit log ────────────────────────────────────────────────────────── */

test("every request leaves one JSON line: no environment, no phrase, no output; file is 0600", async () => {
  const h = home();
  process.env.PROM_GATE_TEST_SECRET = "hunter2-should-never-be-logged";
  try {
    await createPrivilegedGate(
      deps({ home: h, approver: approveWith({ decision: "approve", phrase: "/dev/disk4" }) }),
    ).requestAndRun({ ...REQ, argv: ["dd", "if=x.img", "of=/dev/disk4"] });
    await createPrivilegedGate(
      deps({ home: h, approver: approveWith({ decision: "deny" }) }),
    ).requestAndRun(REQ);
  } finally {
    Reflect.deleteProperty(process.env, "PROM_GATE_TEST_SECRET");
  }
  const raw = readFileSync(sudoAuditPath(h), "utf8");
  assert.ok(!raw.includes("hunter2"));
  const [first, second] = auditLines(h);
  assert.equal(first?.decision, "approved");
  assert.equal(first?.phraseRequired, true);
  assert.ok(!JSON.stringify(first).includes('"phrase":'));
  assert.equal(first?.exitCode, 0);
  assert.equal(typeof first?.durationMs, "number");
  for (const k of ["time", "surface", "requester", "why", "argv", "cwd", "elevator", "decision"]) {
    assert.ok(k in (first as object), k);
  }
  assert.equal(second?.decision, "denied");
  assert.ok(!("stdout" in (first as object)));
  assert.equal(statSync(sudoAuditPath(h)).mode & 0o777, 0o600);
});

/* ── what every host prints ───────────────────────────────────────────────── */

test("formatApprovalView: the command first, then folder, requester, reason, password route, rules", async () => {
  const { formatApprovalView } = await import("./privileged-gate.js");
  const lines = formatApprovalView({
    id: "x",
    commandLine: "sudo dd if=x.img of=/dev/disk4",
    execArgv: [
      "/usr/bin/sudo",
      "-p",
      "[PROMETHEUS] password for %u: ",
      "--",
      "dd",
      "if=x.img",
      "of=/dev/disk4",
    ],
    elevator: "sudo",
    argv: ["dd", "if=x.img", "of=/dev/disk4"],
    cwd: "/tmp",
    surface: "tui",
    requester: "agent",
    why: "flash the installer image",
    script: {
      path: "/tmp/fix.sh",
      size: 22,
      sha256: "a".repeat(64),
      head: ["#!/bin/sh", "echo fixing"],
    },
    phrase: "/dev/disk4",
    timeoutMs: 120_000,
    passwordVia: "tty",
  });
  const text = lines.join("\n");
  assert.match(lines[0] ?? "", /PRIVILEGED COMMAND/);
  assert.equal(lines[1], "  sudo dd if=x.img of=/dev/disk4");
  assert.match(text, /runs: \/usr\/bin\/sudo -p '\[PROMETHEUS\] password for %u: ' -- dd/);
  assert.match(text, /in: +\/tmp/);
  assert.match(text, /asked by: agent \(tui\)/);
  assert.match(text, /why: +flash the installer image/);
  assert.match(text, /script: \/tmp\/fix\.sh \(22 bytes, sha256 a{64}\)/);
  assert.match(text, /│ echo fixing/);
  assert.match(text, /type \/dev\/disk4/);
  assert.match(text, /your terminal asks for the password/);
  assert.match(text, /no "always"/);
  assert.match(text, /120 s/);
});

test("output past the capture limit is cut and SAID to be cut; a caller can ask for more", async () => {
  const big = "x".repeat(5000);
  const small = await createPrivilegedGate(
    deps({
      spawnImpl: fakeSpawn([], { out: big }),
      approver: approveWith({ decision: "approve" }),
    }),
  ).requestAndRun(REQ, { captureBytes: 1000 });
  assert.equal(small.outputTruncated, true);
  assert.ok((small.stdout ?? "").length <= 1000);
  const whole = await createPrivilegedGate(
    deps({
      spawnImpl: fakeSpawn([], { out: big }),
      approver: approveWith({ decision: "approve" }),
    }),
  ).requestAndRun(REQ, { captureBytes: 64 * 1024 * 1024 });
  assert.equal(whole.outputTruncated, undefined);
  assert.equal(whole.stdout, big);
});

test("sudo exiting while a root grandchild still holds its output open does not hang the gate", async () => {
  // `close` waits for every holder of the pipes; a root child that ignored SIGTERM (a stuck
  // installer) keeps them open forever. The gate settles shortly after `exit` instead, and
  // says the command may still be running.
  const order: string[] = [];
  const spawnImpl = ((_cmd: string, _args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4343,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill() {},
    });
    setImmediate(() => child.emit("exit", 0, null)); // ...and never "close"
    return child;
  }) as never;
  const r = await createPrivilegedGate(
    deps({
      spawnImpl,
      exitGraceMs: 20,
      approver: approveWith({ decision: "approve" }),
      resumeTerminal: () => {
        order.push("resume");
      },
    }),
  ).requestAndRun(REQ);
  assert.equal(r.decision, "approved");
  assert.equal(r.exitCode, 0);
  assert.match(r.reason ?? "", /may still be running/);
  assert.deepEqual(order, ["resume"]);
});
