/**
 * hook-runner.test.ts — the REAL, spawn-backed hook runner.
 *
 * These deliberately spawn actual `/bin/sh` children rather than a fake, because the whole
 * value of this module is the half that cannot be faked: does a nonzero `exit` really come
 * back as `exitCode`, does stdin really reach the script, does a `sleep 30` really get killed
 * instead of hanging the turn forever. This project has shipped "unit-tested but never
 * actually wired" more than once; a spawn seam tested only against a stub is exactly that.
 *
 * POSIX-only assertions are skipped on win32 (there is no `/bin/sh` there); the shell-choice
 * test covers the Windows branch without needing a Windows box.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_HOOK_TIMEOUT_MS } from "../../hooks.js";
import { createHookRunner, hookShell } from "./hook-runner.js";

const posix = process.platform !== "win32";

test("hookShell picks /bin/sh -c on posix and cmd.exe /d /s /c on win32", () => {
  assert.deepEqual(hookShell("darwin"), { shell: "/bin/sh", flag: "-c" });
  assert.deepEqual(hookShell("linux"), { shell: "/bin/sh", flag: "-c" });
  const win = hookShell("win32");
  assert.equal(win.flag, "/d /s /c");
  assert.match(win.shell, /cmd\.exe/i);
});

test(
  "a real hook exiting nonzero reports that exit code (this is the DENY signal)",
  { skip: !posix },
  async () => {
    const runner = createHookRunner();
    const out = await runner({
      event: "PreToolUse",
      command: "exit 3",
      stdin: "{}",
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    assert.equal(out.exitCode, 3);
    assert.equal(out.timedOut, undefined);
    assert.equal(out.error, undefined);
  },
);

test(
  "the payload really reaches the hook on stdin, and its stdout is captured",
  { skip: !posix },
  async () => {
    const runner = createHookRunner();
    const out = await runner({
      event: "PreToolUse",
      command: "cat",
      stdin: JSON.stringify({ tool: "write_file", args: { path: "a.ts" } }),
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    assert.equal(out.exitCode, 0);
    assert.deepEqual(JSON.parse(out.stdout), { tool: "write_file", args: { path: "a.ts" } });
  },
);

test(
  "a hook can decide from the ARGUMENTS on stdin — the end-to-end deny path",
  { skip: !posix },
  async () => {
    // The realistic guard: refuse a write outside src/. Proves stdin + exit code compose into a
    // usable policy, which is the actual product claim.
    const runner = createHookRunner();
    const guard = `grep -q '"path":"src/' && exit 0 || exit 1`;
    const allowed = await runner({
      event: "PreToolUse",
      command: guard,
      stdin: '{"tool":"write_file","args":{"path":"src/a.ts"}}',
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    const refused = await runner({
      event: "PreToolUse",
      command: guard,
      stdin: '{"tool":"write_file","args":{"path":"/etc/passwd"}}',
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    assert.equal(allowed.exitCode, 0);
    assert.notEqual(refused.exitCode, 0);
  },
);

test("a hook that ignores stdin (echo) does not fail with EPIPE", { skip: !posix }, async () => {
  // A child that exits before reading stdin makes the parent's write raise EPIPE. Unhandled,
  // that is an uncaught 'error' on the stream — i.e. a hook script as ordinary as `echo hi`
  // taking the whole session down.
  const runner = createHookRunner();
  const out = await runner({
    event: "SessionStart",
    command: "echo hi",
    stdin: "x".repeat(200_000),
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  });
  assert.equal(out.error, undefined);
  assert.match(out.stdout, /hi/);
});

test(
  "a hook that overruns its budget is KILLED and reported as timedOut, not as a deny",
  { skip: !posix },
  async () => {
    // `timedOut` is what keeps `runPreToolUseHooks` from reading the kill's nonzero code as a
    // refusal. Without it, one slow script would refuse every tool call on a busy machine.
    const runner = createHookRunner();
    const t0 = Date.now();
    const out = await runner({
      event: "PreToolUse",
      command: "sleep 30",
      stdin: "{}",
      timeoutMs: 150,
    });
    assert.equal(out.timedOut, true);
    assert.ok(Date.now() - t0 < 5_000, "the runner must not wait for the child's natural end");
  },
);

test(
  "a command that does not exist resolves a normal nonzero outcome (sh reports 127)",
  { skip: !posix },
  async () => {
    const runner = createHookRunner();
    const out = await runner({
      event: "PreToolUse",
      command: "definitely-not-a-real-binary-9f2a",
      stdin: "{}",
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    // The shell exists, so this is a clean nonzero exit — a hook pointed at a typo'd script
    // therefore DENIES, which is the fail-closed direction a user configuring a guard wants.
    assert.equal(out.exitCode, 127);
    assert.equal(out.error, undefined);
  },
);

test("a spawn that throws synchronously resolves with `error` instead of hanging the turn", async () => {
  // A sync throw emits no 'error' event, so without the try/catch the promise never settles
  // and the agent turn waits forever — the worst possible failure for a fail-soft feature.
  const runner = createHookRunner({
    spawnImpl: () => {
      throw new Error("EACCES");
    },
  });
  const out = await runner({
    event: "PreToolUse",
    command: "guard.sh",
    stdin: "{}",
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  });
  assert.equal(out.error, "EACCES");
  assert.equal(out.timedOut, undefined);
});

test(
  "hook stdout is byte-capped so a runaway `cat` cannot exhaust memory",
  { skip: !posix },
  async () => {
    const runner = createHookRunner();
    const out = await runner({
      event: "SessionStart",
      // ~2 MiB, well over the 64 KiB per-stream ceiling.
      command: "yes ABCDEFGHIJKLMNOPQRSTUVWXYZ | head -c 2000000",
      stdin: "",
      timeoutMs: 10_000,
    });
    assert.ok(
      out.stdout.length < 200_000,
      `stdout was ${out.stdout.length} bytes — cap not applied`,
    );
  },
);

test(
  "cwd is honoured, so a hook can inspect the repo it was configured for",
  { skip: !posix },
  async () => {
    const runner = createHookRunner({ cwd: "/tmp" });
    const out = await runner({
      event: "SessionStart",
      command: "pwd",
      stdin: "",
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    assert.match(out.stdout.trim(), /\/tmp$/);
  },
);
