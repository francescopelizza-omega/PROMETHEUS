/**
 * run-notify.test.ts — the OS notification posted when a detached run settles.
 *
 * Two classes of failure are pinned here:
 *
 *  - SILENCE. The whole point of `/background` is walking away, so a notification that never
 *    fires (wrong platform branch, un-probed binary, a throw swallowed upstream) makes the
 *    feature indistinguishable from not having it.
 *  - INJECTION. On macOS the body is embedded in an AppleScript literal, and the body carries
 *    the run's own summary — model-authored text. An unescaped quote there is arbitrary
 *    AppleScript execution, which is the single worst thing this file could get wrong.
 *
 * Nothing here spawns: every test injects a fake spawn, so no suite ever posts a real toast.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type NotifyCommand,
  clampNotificationText,
  escapeAppleScript,
  notifyCommand,
  notifyRunSettled,
} from "./run-notify.js";

/** A fake spawn that records every launch. */
function fakeSpawn(): {
  impl: (
    b: string,
    a: readonly string[],
    o: Record<string, unknown>,
  ) => {
    unref(): void;
    on(): void;
  };
  calls: { bin: string; args: string[]; opts: Record<string, unknown> }[];
} {
  const calls: { bin: string; args: string[]; opts: Record<string, unknown> }[] = [];
  return {
    calls,
    impl: (bin, args, opts) => {
      calls.push({ bin, args: [...args], opts });
      return { unref: () => {}, on: () => {} };
    },
  };
}

/* ── AppleScript escaping ────────────────────────────────────────────────────*/

test("a double quote in the task cannot break out of the AppleScript literal", () => {
  // Without this, a run whose summary contained `" & (do shell script "…") & "` would be
  // EXECUTED by osascript. The body is model-authored text; treat it as hostile.
  const escaped = escapeAppleScript('done " & (do shell script "id") & "');
  assert.ok(!/(^|[^\\])"/.test(escaped), `unescaped quote survived: ${escaped}`);
});

test("backslashes are escaped BEFORE quotes (order matters, and getting it wrong is silent)", () => {
  assert.equal(escapeAppleScript('a\\"b'), 'a\\\\\\"b');
});

test("a newline is folded to a space — a raw newline makes the script fail to COMPILE", () => {
  // The failure mode is not a mangled notification, it is NO notification: osascript exits
  // nonzero and, since this is fire-and-forget, nobody ever learns why.
  assert.equal(escapeAppleScript("line1\nline2\ttab"), "line1 line2 tab");
});

test("clampNotificationText collapses whitespace and truncates long summaries", () => {
  assert.equal(clampNotificationText("  a\n\n  b  "), "a b");
  const long = clampNotificationText("x".repeat(500));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith("…"));
});

/* ── platform selection ──────────────────────────────────────────────────────*/

test("macOS posts through osascript with ONE -e argument (no shell anywhere)", () => {
  const cmd = notifyCommand("darwin", "Prometheus", "run-1: ok") as NotifyCommand;
  assert.equal(cmd.bin, "osascript");
  assert.equal(cmd.args.length, 2);
  assert.equal(cmd.args[0], "-e");
  assert.match(cmd.args[1] ?? "", /^display notification "run-1: ok" with title "Prometheus"$/);
});

test("Linux posts through notify-send, and `--` guards a body that starts with a dash", () => {
  const cmd = notifyCommand("linux", "Prometheus", "--help me", {
    hasBin: () => true,
  }) as NotifyCommand;
  assert.deepEqual(cmd, { bin: "notify-send", args: ["--", "Prometheus", "--help me"] });
});

test("Linux without libnotify posts NOTHING rather than spawning a missing binary", () => {
  assert.equal(notifyCommand("linux", "t", "b", { hasBin: () => false }), null);
});

test("Windows is a documented NO-OP — nothing is faked and nothing is spawned", () => {
  // There is no clean Windows equivalent that does not mean building a PowerShell toast script
  // out of user text. Returning null is the honest answer; pretending otherwise would ship a
  // notification path nobody could see fail.
  assert.equal(notifyCommand("win32", "t", "b"), null);
  assert.equal(notifyCommand("aix", "t", "b"), null);
});

/* ── the settle → notification path ──────────────────────────────────────────*/

test("a run that reaches `done` posts a notification naming the run and its summary", () => {
  const spawn = fakeSpawn();
  const cmd = notifyRunSettled(
    { id: "run-3", state: "done", model: "qwen3:8b", exitSummary: "wrote 4 files" },
    { platform: "darwin", spawnImpl: spawn.impl, env: {} },
  );
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0]?.bin, "osascript");
  assert.match(cmd?.args[1] ?? "", /run-3: wrote 4 files/);
  assert.match(cmd?.args[1] ?? "", /background run finished/);
});

test("`failed` and `killed` post their own titles — a failure must not read as a success", () => {
  const spawn = fakeSpawn();
  const failed = notifyRunSettled(
    { id: "run-4", state: "failed", exitSummary: "engine down" },
    { platform: "darwin", spawnImpl: spawn.impl, env: {} },
  );
  const killed = notifyRunSettled(
    { id: "run-5", state: "killed" },
    { platform: "darwin", spawnImpl: spawn.impl, env: {} },
  );
  assert.match(failed?.args[1] ?? "", /FAILED/);
  assert.match(killed?.args[1] ?? "", /killed/);
});

test("a non-terminal state posts nothing (a notification mid-run is a bug, not a feature)", () => {
  const spawn = fakeSpawn();
  assert.equal(
    notifyRunSettled(
      { id: "run-6", state: "running" },
      { platform: "darwin", spawnImpl: spawn.impl, env: {} },
    ),
    null,
  );
  assert.deepEqual(spawn.calls, []);
});

test("PROMETHEUS_NO_NOTIFY silences notifications entirely", () => {
  const spawn = fakeSpawn();
  assert.equal(
    notifyRunSettled(
      { id: "run-7", state: "done" },
      { platform: "darwin", spawnImpl: spawn.impl, env: { PROMETHEUS_NO_NOTIFY: "1" } },
    ),
    null,
  );
  assert.deepEqual(spawn.calls, []);
  // …but an explicitly-off value does NOT silence it (so `=0` is not a footgun).
  notifyRunSettled(
    { id: "run-7", state: "done" },
    { platform: "darwin", spawnImpl: spawn.impl, env: { PROMETHEUS_NO_NOTIFY: "0" } },
  );
  assert.equal(spawn.calls.length, 1);
});

test("the child is detached with ignored stdio — a toast must not keep the CLI alive", () => {
  const spawn = fakeSpawn();
  notifyRunSettled(
    { id: "run-8", state: "done" },
    { platform: "darwin", spawnImpl: spawn.impl, env: {} },
  );
  assert.equal(spawn.calls[0]?.opts.detached, true);
  assert.equal(spawn.calls[0]?.opts.stdio, "ignore");
  assert.equal(spawn.calls[0]?.opts.shell, false);
});

test("a spawn that THROWS is swallowed — onSettle runs synchronously, a throw skips subscribers", () => {
  // `RunRegistry.setState` does `for (const cb of e.onSettle) cb(...)`. A throw here would
  // abort that loop and silently skip every later subscriber, including `agents attach`'s
  // finish handler — so the user's terminal would hang on a run that had actually completed.
  assert.equal(
    notifyRunSettled(
      { id: "run-9", state: "done" },
      {
        platform: "darwin",
        env: {},
        spawnImpl: () => {
          throw new Error("EACCES");
        },
      },
    ),
    null,
  );
});
