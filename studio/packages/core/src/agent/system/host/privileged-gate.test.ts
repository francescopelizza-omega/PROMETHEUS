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
import { createHash } from "node:crypto";
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
  formatApprovalView,
  sudoAuditPath,
  trustedBinary,
} from "./privileged-gate.js";
import { PY_LOADER } from "./privileged-verify.js";

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

test("tty mode: sudo -k -p <prompt> -- argv, stdin inherited, no askpass in the env", async () => {
  const calls: SpawnCall[] = [];
  await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve" }) }),
  ).requestAndRun(REQ);
  const c = calls[0] as SpawnCall;
  assert.equal(c.cmd, "/usr/bin/sudo");
  // -k: a cached sudo credential is never used, so every approval asks for the password
  assert.deepEqual(c.args, ["-k", "-p", "[PROMETHEUS] password for %u: ", "--", ...REQ.argv]);
  assert.equal(c.opts.shell, false);
  assert.equal(c.opts.cwd, "/tmp");
  assert.deepEqual(c.opts.stdio, ["inherit", "pipe", "pipe"]);
  assert.equal((c.opts.env as Record<string, string>).SUDO_ASKPASS, undefined);
});

test("askpass mode: sudo -k -A, SUDO_ASKPASS set, stdin ignored", async () => {
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
  assert.deepEqual(c.args.slice(0, 5), ["-k", "-p", "[PROMETHEUS] password for %u: ", "-A", "--"]);
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

test("formatApprovalView: control, bidi and zero-width characters are shown as escapes, never sent raw", async () => {
  const { formatApprovalView, visibleText } = await import("./privileged-gate.js");
  // ESC/CR in an argument could redraw the lines above it; a bidi override reorders what is read
  const evil = "x\r\u001b[2K\u001b[1A  sudo ls\u202e";
  const lines = formatApprovalView({
    id: "x",
    commandLine: `sudo rm -rf '${evil}'`,
    execArgv: ["/usr/bin/sudo", "--", "rm", "-rf", evil],
    elevator: "sudo",
    argv: ["rm", "-rf", evil],
    cwd: `/tmp/${evil}`,
    surface: "tui",
    requester: "agent",
    why: "cleanup\u001b[2Jok\u200b",
    script: { path: `/tmp/${evil}.sh`, size: 1, sha256: "a".repeat(64), head: ["\u202eecho"] },
    phrase: evil,
    timeoutMs: 120_000,
    passwordVia: "tty",
  });
  for (const l of lines) {
    assert.doesNotMatch(
      l,
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/,
      l,
    );
  }
  const text = lines.join("\n");
  assert.match(text, /x\\x0d\\x1b\[2K\\x1b\[1A {2}sudo ls\\u202e/);
  assert.match(text, /why: +cleanup\\x1b\[2Jok\\u200b/);
  assert.equal(visibleText("plain sudo ls /etc"), "plain sudo ls /etc");
  assert.equal(visibleText("tab\there"), "tab\\x09here");
});

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

/* ── terminal mode: an interactive root program in a GUI's terminal view ─── */

function relayDir(): { dir: string; ptyHost: string; tool: string } {
  const dir = home();
  const ptyHost = join(dir, "pty_host.py");
  const tool = join(dir, "disk_space.py");
  writeFileSync(ptyHost, "# relay\n");
  writeFileSync(tool, "# tool\n");
  return { dir, ptyHost, tool };
}

/** a child with a writable stdin and a control pipe on fd 3, ending when told to */
function terminalSpawn(calls: SpawnCall[], typed: string[], ctl: string[]) {
  return (cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    const child = Object.assign(new EventEmitter(), {
      pid: 77,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: (d: string) => typed.push(String(d)) },
      stdio: [null, null, null, { write: (s: string) => ctl.push(s) }],
      kill: (sig?: string) => setImmediate(() => child.emit("close", 143, sig)),
    });
    setImmediate(() => child.stdout.emit("data", Buffer.from("\x1b[?1049hSCREEN")));
    return child;
  };
}

test("terminal mode: the APPROVED sudo command runs on a pseudo-terminal through pty_host, with the native password dialog", async () => {
  const { dir, ptyHost, tool } = relayDir();
  const calls: SpawnCall[] = [];
  const typed: string[] = [];
  const ctl: string[] = [];
  const seen: ApprovalView[] = [];
  const ac = new AbortController();
  const out: string[] = [];
  const run = createPrivilegedGate(
    deps({
      calls,
      passwordVia: "askpass",
      askpass: async () => "/tmp/prom-askpass/askpass.sh",
      approver: approveWith({ decision: "approve" }, seen),
      spawnImpl: terminalSpawn(calls, typed, ctl) as never,
      timeoutMs: 3000, // a gate that never calls onStart must not hang the suite
    }),
  ).requestAndRun(
    { ...REQ, argv: ["/usr/bin/python3", "-I", tool, "--no-sudo"], cwd: dir },
    {
      signal: ac.signal,
      onOutput: (s) => out.push(s),
      terminal: {
        python: "/usr/bin/python3",
        ptyHost,
        cols: 100,
        rows: 30,
        onStart: (h) => {
          h.write("j");
          h.resize(120, 40);
          setImmediate(() => ac.abort());
        },
      },
    },
  );
  const r = await run;
  const c = calls[0] as SpawnCall;
  assert.equal(c.cmd, "/usr/bin/python3");
  // the relay runs from its verified bytes too (a swap after the check cannot pick the command)
  const relaySha = createHash("sha256").update(readFileSync(ptyHost)).digest("hex");
  const toolSha = createHash("sha256").update(readFileSync(tool)).digest("hex");
  assert.deepEqual(c.args.slice(0, 9), [
    "-I",
    "-c",
    PY_LOADER,
    relaySha,
    ptyHost,
    "100",
    "30",
    "--",
    "/usr/bin/sudo",
  ]);
  assert.deepEqual(c.args.slice(9, 14), ["-k", "-p", "[PROMETHEUS] password for %u: ", "-A", "--"]);
  assert.deepEqual(c.args.slice(14), [
    "/usr/bin/python3",
    "-I",
    "-c",
    PY_LOADER,
    toolSha,
    tool,
    "--no-sudo",
  ]);
  assert.equal((c.opts.env as Record<string, string>).SUDO_ASKPASS, "/tmp/prom-askpass/askpass.sh");
  assert.equal((c.opts.stdio as unknown[]).length, 4);
  assert.deepEqual(typed, ["j"]);
  assert.deepEqual(ctl, ["resize 120 40\n"]);
  assert.ok(out.join("").includes("SCREEN"));
  assert.equal(r.decision, "approved");
  assert.equal(seen[0]?.terminal, true, "the human is told it opens in a terminal view");
});

test("terminal mode needs the native password dialog: a password typed into the view would pass through Prometheus", async () => {
  const { dir, ptyHost, tool } = relayDir();
  const calls: SpawnCall[] = [];
  const r = await createPrivilegedGate(
    deps({ calls, passwordVia: "tty", approver: approveWith({ decision: "approve" }) }),
  ).requestAndRun(
    { ...REQ, argv: ["/usr/bin/python3", "-I", tool], cwd: dir },
    { terminal: { python: "/usr/bin/python3", ptyHost, cols: 80, rows: 24, onStart: () => {} } },
  );
  assert.equal(r.decision, "refused");
  assert.match(r.reason ?? "", /password dialog/);
  assert.equal(calls.length, 0);
});

test("terminal mode: a relay edited after approval is refused (it would choose what sudo runs)", async () => {
  const { dir, ptyHost, tool } = relayDir();
  const calls: SpawnCall[] = [];
  const approver = async (): Promise<ApprovalAnswer> => {
    writeFileSync(ptyHost, "import os; os.execvp('sudo', ['sudo', '-A', 'evil'])\n");
    return { decision: "approve" };
  };
  const r = await createPrivilegedGate(
    deps({
      calls,
      passwordVia: "askpass",
      askpass: async () => "/tmp/a.sh",
      approver,
    }),
  ).requestAndRun(
    { ...REQ, argv: ["/usr/bin/python3", "-I", tool], cwd: dir },
    { terminal: { python: "/usr/bin/python3", ptyHost, cols: 80, rows: 24, onStart: () => {} } },
  );
  assert.equal(r.decision, "refused");
  assert.match(r.reason ?? "", /changed after approval/);
  assert.equal(calls.length, 0);
});

test("formatApprovalView: a terminal-mode run says it opens an interactive view and how it ends", async () => {
  const { formatApprovalView } = await import("./privileged-gate.js");
  const base = {
    id: "t",
    commandLine: "sudo /usr/bin/python3 -I /a/disk_space.py --no-sudo",
    execArgv: ["/usr/bin/sudo", "-k", "-A", "--", "/usr/bin/python3"],
    elevator: "sudo" as const,
    argv: ["/usr/bin/python3", "-I", "/a/disk_space.py", "--no-sudo"],
    cwd: "/",
    surface: "studio" as const,
    requester: "Studio: Disk space as administrator",
    why: "explore the whole disk as root",
    timeoutMs: 120_000,
    passwordVia: "askpass" as const,
  };
  assert.ok(
    formatApprovalView({ ...base, terminal: true }).some((l) =>
      /its own window.*only your keyboard.*Ctrl\+D/.test(l),
    ),
  );
  assert.ok(!formatApprovalView(base).some((l) => /its own window/.test(l)));
});

/* ── final-review fixes ───────────────────────────────────────────────────── */

test("a caller that cancelled before the approval came back gets nothing run", async () => {
  // The Studio panel was closed (or Stop pressed) while the dialog waited. An abort listener
  // added to an already-aborted signal never fires, so the session used to start anyway — as
  // root, with no view, and with nothing left that could stop it.
  const calls: SpawnCall[] = [];
  const ac = new AbortController();
  const approver = async (): Promise<ApprovalAnswer> => {
    ac.abort();
    return { decision: "approve" };
  };
  const r = await createPrivilegedGate(deps({ calls, approver })).requestAndRun(REQ, {
    signal: ac.signal,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /cancel/);
  assert.equal(calls.length, 0);
  const pre = new AbortController();
  pre.abort();
  const calls2: SpawnCall[] = [];
  const seen: ApprovalView[] = [];
  const r2 = await createPrivilegedGate(
    deps({ calls: calls2, approver: approveWith({ decision: "approve" }, seen) }),
  ).requestAndRun(REQ, { signal: pre.signal });
  assert.equal(calls2.length, 0);
  assert.equal(seen.length, 0, "nobody is asked about a request already cancelled");
  assert.equal(r2.ok, false);
});

test("an interactive session can carry its own time limit (a root explorer is not a 30-minute job)", async () => {
  const { dir, ptyHost, tool } = relayDir();
  const calls: SpawnCall[] = [];
  const typed: string[] = [];
  const ctl: string[] = [];
  const started = Date.now();
  const r = await createPrivilegedGate(
    deps({
      calls,
      passwordVia: "askpass",
      askpass: async () => "/tmp/a.sh",
      approver: approveWith({ decision: "approve" }),
      spawnImpl: terminalSpawn(calls, typed, ctl) as never,
      timeoutMs: 50,
    }),
  ).requestAndRun(
    { ...REQ, argv: ["/usr/bin/python3", "-I", tool], cwd: dir },
    {
      timeoutMs: 400,
      terminal: { python: "/usr/bin/python3", ptyHost, cols: 80, rows: 24, onStart: () => {} },
    },
  );
  assert.ok(Date.now() - started >= 350, "the per-call limit replaced the gate default");
  assert.equal(r.timedOut, true);
});

test("terminal mode: keys sent after the program ended do not crash the host (EPIPE)", async () => {
  const { dir, ptyHost, tool } = relayDir();
  const calls: SpawnCall[] = [];
  let handle: { write(d: string): void } | undefined;
  const spawnImpl = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    const stdin = new EventEmitter() as EventEmitter & { write(d: string): boolean };
    stdin.write = () => {
      setImmediate(() =>
        stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
      );
      return false;
    };
    const child = Object.assign(new EventEmitter(), {
      pid: 78,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin,
      stdio: [null, null, null, new EventEmitter()],
      kill: () => {},
    });
    setImmediate(() => {
      handle?.write("late key");
      setImmediate(() => setImmediate(() => child.emit("close", 0, null)));
    });
    return child;
  };
  const r = await createPrivilegedGate(
    deps({
      calls,
      passwordVia: "askpass",
      askpass: async () => "/tmp/a.sh",
      approver: approveWith({ decision: "approve" }),
      spawnImpl: spawnImpl as never,
    }),
  ).requestAndRun(
    { ...REQ, argv: ["/usr/bin/python3", "-I", tool], cwd: dir },
    {
      terminal: {
        python: "/usr/bin/python3",
        ptyHost,
        cols: 80,
        rows: 24,
        onStart: (h) => {
          handle = h;
        },
      },
    },
  );
  assert.equal(r.decision, "approved");
});

test("terminal mode: a relative relay or interpreter path is refused (hashed here, opened from /)", async () => {
  const { dir, tool } = relayDir();
  const calls: SpawnCall[] = [];
  for (const bad of [
    { python: "/usr/bin/python3", ptyHost: "studio/python/tools/pty_host.py" },
    { python: "python3", ptyHost: join(dir, "pty_host.py") },
  ]) {
    const r = await createPrivilegedGate(
      deps({
        calls,
        passwordVia: "askpass",
        askpass: async () => "/tmp/a.sh",
        approver: approveWith({ decision: "approve" }),
      }),
    ).requestAndRun(
      { ...REQ, argv: ["/usr/bin/python3", "-I", tool], cwd: dir },
      { terminal: { ...bad, cols: 80, rows: 24, onStart: () => {} } },
    );
    assert.equal(r.decision, "refused", JSON.stringify(bad));
    assert.match(r.reason ?? "", /absolute/);
  }
  assert.equal(calls.length, 0);
});

/* ── root runs exactly the approved bytes ─────────────────────────────────── */

test("a python script runs through the verifying loader, and the human is told", async () => {
  const dir = home();
  const tool = join(dir, "tool.py");
  writeFileSync(tool, "print('hi')\n");
  const sha = createHash("sha256").update("print('hi')\n").digest("hex");
  const calls: SpawnCall[] = [];
  const seen: ApprovalView[] = [];
  await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve" }, seen) }),
  ).requestAndRun({ ...REQ, argv: ["/usr/bin/python3", "-I", tool, "--no-sudo"], cwd: dir });
  const c = calls[0] as SpawnCall;
  assert.deepEqual(c.args.slice(4), [
    "/usr/bin/python3",
    "-I",
    "-c",
    PY_LOADER,
    sha,
    tool,
    "--no-sudo",
  ]);
  assert.equal(seen[0]?.verified, "python-loader");
  assert.deepEqual(seen[0]?.execArgv.slice(5), c.args.slice(4), "the view shows what really runs");
  const lines = formatApprovalView(seen[0] as ApprovalView);
  const text = lines.join("\n");
  assert.match(text, /root runs exactly the bytes you approved/);
  // the loader runs as root too: shown verbatim, line by line — not as one escaped blob
  const runs = lines.find((l) => l.startsWith("runs:")) ?? "";
  assert.ok(!runs.includes("\\x0a") && !runs.includes("import sys"), runs);
  assert.match(runs, /<the verifying loader below>/);
  for (const l of PY_LOADER.split("\n")) {
    assert.ok(lines.includes(`  │ ${l}`), `loader line shown: ${l}`);
  }
});

test("a shell script's approved bytes are passed inline; the view names them instead of dumping them", async () => {
  const dir = home();
  const script = join(dir, "fix.sh");
  const body = "#!/bin/sh\necho fixing\n";
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  const calls: SpawnCall[] = [];
  const seen: ApprovalView[] = [];
  await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve" }, seen) }),
  ).requestAndRun({ ...REQ, argv: ["./fix.sh"], cwd: dir });
  assert.deepEqual((calls[0] as SpawnCall).args.slice(4), ["/bin/sh", "-c", body, script]);
  const runs = formatApprovalView(seen[0] as ApprovalView).find((l) => l.startsWith("runs:")) ?? "";
  assert.ok(!runs.includes("echo fixing"), runs);
  assert.match(runs, /approved bytes of .*fix\.sh/);
});

test("a script root cannot verify is refused before anyone is asked", async () => {
  const dir = home();
  const pl = join(dir, "x.pl");
  writeFileSync(pl, "print 1;\n");
  const calls: SpawnCall[] = [];
  const seen: ApprovalView[] = [];
  const r = await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve" }, seen) }),
  ).requestAndRun({ ...REQ, argv: ["/usr/bin/perl", pl], cwd: dir });
  assert.equal(r.decision, "refused");
  assert.match(r.reason ?? "", /only root can write/);
  assert.equal(seen.length, 0);
  assert.equal(calls.length, 0);
});

test("a script only root can change runs as it is", async () => {
  const dir = home();
  const tool = join(dir, "tool.py");
  writeFileSync(tool, "print('hi')\n");
  const calls: SpawnCall[] = [];
  await createPrivilegedGate(
    deps({ calls, approver: approveWith({ decision: "approve" }), rootControlled: () => true }),
  ).requestAndRun({ ...REQ, argv: ["/usr/bin/python3", tool], cwd: dir });
  assert.deepEqual((calls[0] as SpawnCall).args.slice(4), ["/usr/bin/python3", tool]);
});
