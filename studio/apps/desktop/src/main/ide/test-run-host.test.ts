/**
 * test-run-host.test.ts — node:test for the streaming testmgr run host (APP-013).
 *
 * Runs NOW (no electron, no python): the spawn seam is an INJECTED FAKE child, so
 * argv construction, JSON-line re-assembly across chunk boundaries, ordered event
 * forwarding, the terminal envelope, the output cap, and the kill registry are all
 * exercised deterministically.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test test-run-host.test.ts
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { IdeTestEvent } from "../../shared/ipc-contract.js";
import {
  type TestRunChild,
  type TestRunRequest,
  buildTestArgv,
  parseTapLine,
  runTestVerb,
} from "./test-run-host.js";

/** A controllable fake sidecar child: tests push stdout chunks + close it. */
class FakeTestChild extends EventEmitter implements TestRunChild {
  killedWith: string | undefined;
  readonly stdout = new EventEmitter() as unknown as TestRunChild["stdout"];
  readonly stderr = new EventEmitter() as unknown as TestRunChild["stderr"];

  kill(signal?: NodeJS.Signals): void {
    this.killedWith = signal ?? "SIGTERM";
    queueMicrotask(() => super.emit("close", null));
  }
  pushStdout(text: string): void {
    (this.stdout as unknown as EventEmitter).emit("data", Buffer.from(text, "utf8"));
  }
  pushStderr(text: string): void {
    (this.stderr as unknown as EventEmitter).emit("data", Buffer.from(text, "utf8"));
  }
  close(code: number): void {
    super.emit("close", code);
  }
}

const REQ: TestRunRequest = {
  root: "/proj",
  framework: "pytest",
  ids: ["tests/test_a.py::test_one", "tests/test_a.py::test_p[a-b]"],
};

test("buildTestArgv: run verb → testmgr.py run --path --framework + one --id per node id", () => {
  const argv = buildTestArgv(REQ, "/sidecar");
  assert.equal(argv[0], "/sidecar/testmgr.py");
  assert.deepEqual(argv.slice(1, 6), ["run", "--path", "/proj", "--framework", "pytest"]);
  assert.deepEqual(argv.slice(6), [
    "--id",
    "tests/test_a.py::test_one",
    "--id",
    "tests/test_a.py::test_p[a-b]",
  ]);
});

test("buildTestArgv: rerun → rerun-failed verb with ONLY the supplied failed ids", () => {
  const argv = buildTestArgv(
    { root: "/proj", framework: "unittest", ids: ["pkg.mod.Cls.test_two"], rerun: true },
    "/sidecar",
  );
  assert.equal(argv[1], "rerun-failed");
  // exactly one --failed pair and nothing from any prior run set
  assert.deepEqual(argv.slice(6), ["--failed", "pkg.mod.Cls.test_two"]);
  assert.ok(!argv.includes("--id"));
});

test("runTestVerb streams ORDERED events (JSON lines split across chunks) + summary", async () => {
  const child = new FakeTestChild();
  let spawned: { cmd: string; args: string[]; cwd: string } | undefined;
  const events: IdeTestEvent[] = [];
  const promise = runTestVerb(
    (cmd, args, opts) => {
      spawned = { cmd, args, cwd: opts.cwd };
      return child;
    },
    REQ,
    (ev) => events.push(ev),
    { sidecarDir: "/sidecar" },
  );
  // one event torn across two chunks + a second event and the envelope in one chunk
  child.pushStdout('{"event":"test","id":"tests/test_a.py::test_one","status":"pa');
  child.pushStdout('ss"}\n{"event":"test","id":"tests/test_a.py::test_p[a-b]","status":"fail"}\n');
  child.pushStdout(
    '{"command":"run","ok":true,"summary":{"total":2,"passed":1,"failed":1,"skipped":0,"exitCode":1}}\n',
  );
  child.close(0);
  const result = await promise;
  assert.equal(spawned?.cwd, "/proj");
  assert.equal(spawned?.args[0], "/sidecar/testmgr.py");
  assert.deepEqual(
    events.map((e) => [e.id, e.status]),
    [
      ["tests/test_a.py::test_one", "pass"],
      ["tests/test_a.py::test_p[a-b]", "fail"],
    ],
  );
  assert.equal(result.ok, true);
  assert.equal(result.summary?.total, 2);
  assert.equal(result.summary?.failed, 1);
});

test("parseTapLine reads vitest/TAP ok/not ok/skip (APP-040 vitest streaming half)", () => {
  assert.deepEqual(parseTapLine("ok 1 - adds numbers"), { id: "adds numbers", status: "pass" });
  assert.deepEqual(parseTapLine("not ok 2 - throws on bad input"), {
    id: "throws on bad input",
    status: "fail",
  });
  assert.deepEqual(parseTapLine("ok 3 - later # SKIP not ready"), { id: "later", status: "skip" });
  assert.deepEqual(parseTapLine("ok 4 wip # TODO"), { id: "wip", status: "skip" });
  assert.equal(parseTapLine("TAP version 13"), null);
  assert.equal(parseTapLine("1..4"), null);
  assert.equal(parseTapLine("# a comment"), null);
});

test("runTestVerb forwards a follow-up failure event's output + file:line (APP-040)", async () => {
  const child = new FakeTestChild();
  const events: IdeTestEvent[] = [];
  const promise = runTestVerb(
    () => child,
    REQ,
    (ev) => events.push(ev),
    {
      sidecarDir: "/sidecar",
    },
  );
  child.pushStdout('{"event":"test","id":"tests/test_a.py::test_one","status":"fail"}\n');
  child.pushStdout(
    '{"event":"test","id":"tests/test_a.py::test_one","status":"fail","output":["E AssertionError"],"file":"tests/test_a.py","line":42}\n',
  );
  child.pushStdout(
    '{"command":"run","ok":true,"summary":{"total":1,"passed":0,"failed":1,"skipped":0}}\n',
  );
  child.close(1);
  await promise;
  assert.equal(events.length, 2);
  assert.equal(events[0]?.output, undefined); // the live status carries none
  assert.deepEqual(events[1]?.output, ["E AssertionError"]);
  assert.equal(events[1]?.file, "tests/test_a.py");
  assert.equal(events[1]?.line, 42);
});

test("runTestVerb surfaces the sidecar's fail-soft envelope (ok:false + error)", async () => {
  const child = new FakeTestChild();
  const promise = runTestVerb(
    () => child,
    REQ,
    () => {},
    { sidecarDir: "/sidecar" },
  );
  child.pushStdout(
    '{"command":"run","ok":false,"error":"pytest is not installed in the target environment","_exit":2}\n',
  );
  child.close(2);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /pytest is not installed/);
});

test("runTestVerb fails closed when the child exits without a terminal envelope", async () => {
  const child = new FakeTestChild();
  const promise = runTestVerb(
    () => child,
    REQ,
    () => {},
    { sidecarDir: "/sidecar" },
  );
  child.pushStderr("Traceback: boom\n");
  child.close(1);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no terminal envelope/);
  assert.match(result.error ?? "", /boom/);
});

test("runTestVerb SIGKILLs a child that exceeds the stdout cap (fail-closed)", async () => {
  const child = new FakeTestChild();
  const promise = runTestVerb(
    () => child,
    REQ,
    () => {},
    { sidecarDir: "/sidecar" },
  );
  const blob = "x".repeat(1024 * 1024);
  for (let i = 0; i < 9; i++) child.pushStdout(blob);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(child.killedWith, "SIGKILL");
  assert.match(result.error ?? "", /aborted/);
});

test("runTestVerb registers a killer in the kill set and removes it on settle", async () => {
  const child = new FakeTestChild();
  const kills = new Set<() => void>();
  const promise = runTestVerb(
    () => child,
    REQ,
    () => {},
    { sidecarDir: "/sidecar", kills },
  );
  assert.equal(kills.size, 1);
  // the disposer path: killing via the registry settles the run fail-closed
  for (const kill of kills) kill();
  child.close(1);
  await promise;
  assert.equal(child.killedWith, "SIGKILL");
  assert.equal(kills.size, 0);
});

test("runTestVerb resolves an error result when the spawn itself throws", async () => {
  const result = await runTestVerb(
    () => {
      throw new Error("ENOENT python3");
    },
    REQ,
    () => {},
    { sidecarDir: "/sidecar" },
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ENOENT/);
});

test("runTestVerb ignores stray non-JSON lines and torn garbage without crashing", async () => {
  const child = new FakeTestChild();
  const events: IdeTestEvent[] = [];
  const promise = runTestVerb(
    () => child,
    REQ,
    (ev) => events.push(ev),
    {
      sidecarDir: "/sidecar",
    },
  );
  child.pushStdout("some stray warning\n{not json}\n");
  child.pushStdout('{"event":"test","id":"a.py::t","status":"skip","message":"why"}\n');
  child.pushStdout(
    '{"command":"run","ok":true,"summary":{"total":1,"passed":0,"failed":0,"skipped":1}}\n',
  );
  child.close(0);
  const result = await promise;
  assert.deepEqual(events, [{ id: "a.py::t", status: "skip", message: "why" }]);
  assert.equal(result.ok, true);
});
