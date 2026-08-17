/**
 * orphan-guard.test.ts — the layers that survive SIGKILL.
 *
 * The sharp edge here is NOT "did we kill the orphan" — it is "did we kill something else".
 * A recorded pid outlives its process, and the OS reuses pid numbers, so a post-mortem sweep
 * that trusts a stale pid will eventually SIGTERM a stranger. Most of these tests are about
 * that, not about the happy path.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SENTINEL_SCRIPT,
  __resetForTests,
  closeRegistry,
  forgetChild,
  openRegistry,
  parseRegistry,
  recordChild,
  registryDir,
  stillSameProcess,
  sweepOrphans,
} from "./orphan-guard.js";

const home = (): string => mkdtempSync(join(tmpdir(), "prom-guard-"));

test("the registry round-trips and is line-oriented (POSIX sh must read it)", () => {
  __resetForTests();
  const h = home();
  const file = openRegistry(h, 4242);
  recordChild({
    pid: 100,
    group: true,
    startedAt: "Mon Aug 10 16:00:0100 2026",
    command: "claude -p hello",
  });
  recordChild({
    pid: 101,
    group: false,
    startedAt: "Mon Aug 10 16:00:0101 2026",
    command: "sh -c x",
  });

  const text = readFileSync(file, "utf8");
  assert.equal(text.split("\n").filter(Boolean).length, 2, "one line per child");
  assert.ok(text.includes("\t"), "TAB-separated so `IFS=\\t read` works in sh");

  const parsed = parseRegistry(text);
  assert.deepEqual(parsed, [
    { pid: 100, group: true, startedAt: "Mon Aug 10 16:00:0100 2026", command: "claude -p hello" },
    { pid: 101, group: false, startedAt: "Mon Aug 10 16:00:0101 2026", command: "sh -c x" },
  ]);

  forgetChild(100);
  assert.deepEqual(
    parseRegistry(readFileSync(file, "utf8")).map((r) => r.pid),
    [101],
  );
});

test("a command containing tabs/newlines cannot split a registry line", () => {
  __resetForTests();
  const h = home();
  const file = openRegistry(h, 4243);
  recordChild({
    pid: 200,
    group: false,
    startedAt: "Mon Aug 10 16:00:0200 2026",
    command: "weird\targ\nsecond line",
  });
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "still exactly one record");
  assert.equal(parseRegistry(lines.join("\n"))[0]?.pid, 200);
});

test("closeRegistry removes the file — the sentinel reads that as 'stand down'", () => {
  __resetForTests();
  const h = home();
  const file = openRegistry(h, 4244);
  recordChild({ pid: 300, group: false, startedAt: "Mon Aug 10 16:00:0300 2026", command: "x" });
  closeRegistry();
  assert.throws(() => readFileSync(file, "utf8"), "registry is gone after a clean shutdown");
});

test("stillSameProcess: the pid-reuse guard", () => {
  const ps = (pid: number): string | null => (pid === 500 ? "claude -p hello" : null);
  assert.equal(stillSameProcess(500, "claude -p hello", ps), true);
  assert.equal(stillSameProcess(500, "something-else --now", ps), false, "pid reused ⇒ no kill");
  assert.equal(stillSameProcess(501, "claude -p hello", ps), false, "process gone ⇒ no kill");
  assert.equal(
    stillSameProcess(0, "x", () => "x"),
    false,
    "pid 0 is our own group",
  );
  assert.equal(
    stillSameProcess(1, "x", () => "x"),
    false,
    "pid 1 is init",
  );
});

/** A sweep harness with a fake process table. */
function sweepFixture(h: string, table: Record<number, string>) {
  const killed: { pid: number; group: boolean; signal: string }[] = [];
  const res = sweepOrphans(
    h,
    {
      ps: (pid) => table[pid] ?? null,
      alive: (pid) => pid in table,
      kill: (pid, group, signal) => killed.push({ pid, group, signal }),
    },
    999_999, // our own pid — never present in the fixtures
  );
  return { res, killed };
}

test("sweep adopts a DEAD owner's registry and kills its children", () => {
  const h = home();
  mkdirSync(registryDir(h), { recursive: true });
  writeFileSync(join(registryDir(h), "777.tsv"), "800\t1\tsleep 900\n");

  // owner 777 absent from the table = dead; child 800 present and matching.
  const { res, killed } = sweepFixture(h, { 800: "sleep 900" });
  assert.equal(res.adopted, 1);
  assert.deepEqual(killed, [{ pid: 800, group: true, signal: "SIGTERM" }]);
  assert.equal(res.killed.length, 1);
});

test("sweep NEVER touches a registry whose owner is still alive (a second CLI is normal)", () => {
  const h = home();
  mkdirSync(registryDir(h), { recursive: true });
  writeFileSync(join(registryDir(h), "778.tsv"), "801\t1\tsleep 900\n");

  const { res, killed } = sweepFixture(h, { 778: "prometheus", 801: "sleep 900" });
  assert.equal(res.adopted, 0, "a live sibling owns its own children");
  assert.deepEqual(killed, []);
});

test("sweep REFUSES a reused pid — the whole point of recording the command", () => {
  const h = home();
  mkdirSync(registryDir(h), { recursive: true });
  writeFileSync(join(registryDir(h), "779.tsv"), "802\t1\tsleep 900\n");

  // owner dead, pid 802 alive — but it is now someone's database, not our agent.
  const { res, killed } = sweepFixture(h, { 802: "/usr/local/bin/postgres -D /data" });
  assert.deepEqual(killed, [], "a stranger that inherited the pid is left alone");
  assert.equal(res.skippedReused, 1);
});

test("sweep tolerates a corrupt registry and still removes it", () => {
  const h = home();
  mkdirSync(registryDir(h), { recursive: true });
  writeFileSync(join(registryDir(h), "780.tsv"), "not-a-pid\tgarbage\n\n\t\t\n");
  const { res, killed } = sweepFixture(h, {});
  assert.equal(res.adopted, 1);
  assert.deepEqual(killed, [], "nothing parseable ⇒ nothing signalled");
});

test("sweep on a home that has never run is a silent no-op", () => {
  const { res, killed } = sweepFixture(home(), {});
  assert.deepEqual(res, { adopted: 0, killed: [], skippedReused: 0 });
  assert.deepEqual(killed, []);
});

/* ══ REGRESSION: the pid-reuse guard (Phase 4's acceptance criterion) ═══════════════════
 * Both of these were live leaks, found by a real SIGKILL test rather than by reading code.
 * The unit tests below are the cheap version of that probe; keep them.
 */

test("REGRESSION: the reuse guard is the START TIME, not the command line", () => {
  // The guard used to compare `ps -o command=`. For anything launched through a shebang or
  // wrapper script the kernel rewrites argv during exec, so the string recorded at spawn
  // never matched the string read at sweep:
  //     recorded : python3 -c import time; time.sleep(300)
  //     ps says  : /opt/homebrew/…/Python -c import time; time.sleep(300)
  // The sweep read that as "this pid belongs to someone else now", skipped the kill, and
  // deleted the registry — so every `pip`/`python3` orphan survived forever. That is the
  // exact case Phase 4's acceptance criterion names.
  const started = "Mon Aug 10 16:00:00 2026";
  const ps = (): string => started;
  assert.equal(stillSameProcess(4242, started, ps), true);
  // a DIFFERENT start time on the same pid = the pid was recycled ⇒ never signal it
  assert.equal(stillSameProcess(4242, "Mon Aug 10 15:59:59 2026", ps), false);
});

test("REGRESSION: the guard tolerates ps column padding but not a different time", () => {
  // `ps` pads its columns and the width varies by field, so an exact string compare was
  // fragile in a second way. Whitespace is normalized on both sides; the VALUE is not.
  assert.equal(
    stillSameProcess(1234, "Mon Aug 10 16:00:00 2026", () => "  Mon  Aug 10   16:00:00 2026  "),
    true,
  );
});

test("REGRESSION: a record with no start time is dropped, never guessed at", () => {
  // Rows written by an older build have no identity field. Trusting them would mean
  // choosing between leaking an orphan and signalling a stranger's pid; only one of those
  // is recoverable, so the row is discarded.
  assert.deepEqual(parseRegistry("100\t1\t\tsome command"), []);
  assert.deepEqual(parseRegistry("100\t1"), []);
  assert.equal(
    stillSameProcess(100, "", () => "Mon Aug 10 16:00:00 2026"),
    false,
  );
});

test("REGRESSION: the sentinel reads lstart under a PINNED locale", () => {
  // `lstart` is a human-formatted date and therefore locale-dependent:
  //     it_IT → "lun 10 ago 16:25:36 2026"
  //     C     → "Mon Aug 10 16:25:36 2026"
  // Node recorded the user's locale while the detached sentinel ran with a sanitized
  // environment and read the C form — a guaranteed mismatch, and a guaranteed skipped kill,
  // on every machine not running in English. Both readers must pin it.
  assert.match(SENTINEL_SCRIPT, /LC_ALL=C[^\n]*ps -p/, "the sentinel must pin the locale");
  assert.match(SENTINEL_SCRIPT, /-o lstart=/, "and must compare start time, not command");
  assert.ok(!/-o command=/.test(SENTINEL_SCRIPT), "the command line is not an identity");
});
