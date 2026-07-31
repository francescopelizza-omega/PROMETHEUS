/**
 * dap-host.test.ts — node:test for the MAIN-process DAP host (launch + routing).
 *
 * Runs NOW (no electron, no real debugpy/js-debug — they are NOT installed here).
 * It drives DapHost with an INJECTED FAKE DAP child (decodes the host's frames
 * with the core DapMessageReader, replies in-frame) so launch handshake, request
 * routing (by request_seq), events, and termination are exercised deterministically.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test dap-host.test.ts
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { DapMessageReader, encodeDapMessage } from "@prometheus/core";

import { type DapChild, DapHost, type DapSocket, adapterFor, isLoopbackHost } from "./dap-host.js";

/**
 * A controllable fake DAP adapter child. Decodes the requests the host writes and,
 * by default, AUTO-REPLIES success to each (so initialize/launch resolve and
 * arbitrary requests succeed). Tests flip `autoReply` off to leave a request
 * hanging, push events, or fail a specific command.
 */
class FakeDapChild extends EventEmitter implements DapChild {
  pid = 7777;
  autoReply = true;
  /** the capability body this fake returns from `initialize` (APP-079). */
  capabilities: Record<string, unknown> = {};
  /** per-command auto-reply body overrides (e.g. a canned setBreakpoints response). */
  overrides: Record<string, unknown> = {};
  /** the commands+seqs+arguments the host sent (for payload + ORDER assertions). */
  sent: { seq: number; command: string; args?: unknown }[] = [];
  killed = false;
  private readonly reader = new DapMessageReader();
  readonly stdin = {
    write: (data: string): void => {
      for (const msg of this.reader.feed(Buffer.from(data, "utf8"))) {
        if (msg.type !== "request") continue;
        this.sent.push({ seq: msg.seq, command: msg.command, args: msg.arguments });
        if (this.autoReply) {
          const body =
            msg.command in this.overrides
              ? this.overrides[msg.command]
              : msg.command === "initialize"
                ? this.capabilities
                : {};
          queueMicrotask(() => this.respond(msg.seq, msg.command, true, body));
        }
      }
    },
  };
  readonly stdout = new EventEmitter() as unknown as DapChild["stdout"];
  readonly stderr = new EventEmitter() as unknown as DapChild["stderr"];

  on(event: "exit" | "error", listener: (...a: never[]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void);
  }
  kill(): void {
    this.killed = true;
    queueMicrotask(() => super.emit("exit", 0, null));
  }

  private push(msg: unknown): void {
    (this.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(encodeDapMessage(msg as never), "utf8"),
    );
  }

  /** Reply to a request (success or failure). */
  respond(
    requestSeq: number,
    command: string,
    success: boolean,
    body: unknown,
    message?: string,
  ): void {
    this.push({
      seq: 1000 + requestSeq,
      type: "response",
      request_seq: requestSeq,
      success,
      command,
      ...(message ? { message } : {}),
      body,
    });
  }

  /** Push a DAP event (stopped/output/terminated/…). */
  event(event: string, body: unknown): void {
    this.push({ seq: 9000, type: "event", event, body });
  }
}

/**
 * A controllable fake TCP DAP adapter (APP-080). Same request-decode/auto-reply engine
 * as FakeDapChild but over a single duplex socket surface — no stdin/stdout/stderr split.
 * The injected connect factory schedules its `'connect'` event so the host's connect gate
 * resolves; `destroy()` flips `destroyed` + emits `'close'` (asserted at teardown).
 */
class FakeDapSocket extends EventEmitter implements DapSocket {
  destroyed = false;
  noDelay = false;
  autoReply = true;
  capabilities: Record<string, unknown> = {};
  overrides: Record<string, unknown> = {};
  sent: { seq: number; command: string; args?: unknown }[] = [];
  private readonly reader = new DapMessageReader();

  write(data: string): void {
    for (const msg of this.reader.feed(Buffer.from(data, "utf8"))) {
      if (msg.type !== "request") continue;
      this.sent.push({ seq: msg.seq, command: msg.command, args: msg.arguments });
      if (this.autoReply) {
        const body =
          msg.command in this.overrides
            ? this.overrides[msg.command]
            : msg.command === "initialize"
              ? this.capabilities
              : {};
        queueMicrotask(() => this.respond(msg.seq, msg.command, true, body));
      }
    }
  }
  setNoDelay(noDelay: boolean): void {
    this.noDelay = noDelay;
  }
  destroy(): void {
    this.destroyed = true;
    queueMicrotask(() => this.emit("close", false));
  }

  private push(msg: unknown): void {
    this.emit("data", Buffer.from(encodeDapMessage(msg as never), "utf8"));
  }
  respond(requestSeq: number, command: string, success: boolean, body: unknown): void {
    this.push({
      seq: 1000 + requestSeq,
      type: "response",
      request_seq: requestSeq,
      success,
      command,
      body,
    });
  }
  event(event: string, body: unknown): void {
    this.push({ seq: 9000, type: "event", event, body });
  }
}

const PY_LAUNCH = { type: "python", request: "launch" as const, name: "pytest", module: "pytest" };
const ATTACH_LOCAL = {
  type: "python",
  request: "attach" as const,
  name: "attach",
  connect: { host: "127.0.0.1", port: 5678 },
};

test("adapterFor maps a debug type to its adapter spec", () => {
  // python resolves to the REAL debugpy invocation against the given interpreter
  // (APP-029) — defaults to python3 when the launch config carries no interpreter.
  assert.equal(adapterFor("python")?.cmd, "python3");
  assert.deepEqual(adapterFor("python")?.args, ["-m", "debugpy.adapter"]);
  assert.equal(adapterFor("python", "/venv/bin/python")?.cmd, "/venv/bin/python");
  assert.equal(adapterFor("node")?.cmd, "js-debug");
  assert.equal(adapterFor("cobol"), undefined);
});

test("DapHost launches: initialize → launch handshake, returns a sessionId", async () => {
  const child = new FakeDapChild();
  const host = new DapHost({ spawn: () => child, mintId: () => "s1" });
  const { sessionId } = await host.launch(PY_LAUNCH);
  assert.equal(sessionId, "s1");
  // the handshake sent initialize THEN launch (in order).
  assert.equal(child.sent[0]?.command, "initialize");
  assert.equal(child.sent[1]?.command, "launch");
  assert.equal(host.status("s1")?.state, "running");
  await host.dispose();
});

test("DapHost rejects launch for an unknown adapter type", async () => {
  const host = new DapHost({ spawn: () => new FakeDapChild() });
  await assert.rejects(
    host.launch({ type: "cobol", request: "launch", name: "x" }),
    /no debug adapter/,
  );
  await host.dispose();
});

test("DapHost routes a request to its response body by request_seq", async () => {
  const child = new FakeDapChild();
  const host = new DapHost({ spawn: () => child, mintId: () => "s1", requestTimeoutMs: 500 });
  await host.launch(PY_LAUNCH);

  child.autoReply = false;
  const p = host.request("s1", "stackTrace", { threadId: 1 });
  // find the seq the host used for stackTrace and reply with a specific body.
  const sent = child.sent.find((m) => m.command === "stackTrace");
  assert.ok(sent, "stackTrace was sent to the adapter");
  child.respond(sent!.seq, "stackTrace", true, { stackFrames: [{ id: 1, name: "run" }] });
  const body = (await p) as { stackFrames: { name: string }[] };
  assert.equal(body.stackFrames[0]?.name, "run");
  child.autoReply = true; // let the dispose-time disconnect resolve promptly.
  await host.dispose();
});

test("DapHost round-trips a `threads` request untouched (APP-031)", async () => {
  const child = new FakeDapChild();
  const host = new DapHost({ spawn: () => child, mintId: () => "s1", requestTimeoutMs: 500 });
  await host.launch(PY_LAUNCH);

  child.autoReply = false;
  const p = host.request("s1", "threads", {});
  const sent = child.sent.find((m) => m.command === "threads");
  assert.ok(sent, "threads was sent to the adapter");
  child.respond(sent!.seq, "threads", true, {
    threads: [
      { id: 1, name: "MainThread" },
      { id: 7, name: "worker-1" },
    ],
  });
  const body = (await p) as { threads: { id: number; name: string }[] };
  assert.deepEqual(body.threads, [
    { id: 1, name: "MainThread" },
    { id: 7, name: "worker-1" },
  ]);
  child.autoReply = true;
  await host.dispose();
});

test("DapHost carries the exact setBreakpoints payload to the adapter (APP-012)", async () => {
  const child = new FakeDapChild();
  const host = new DapHost({ spawn: () => child, mintId: () => "s1", requestTimeoutMs: 500 });
  await host.launch(PY_LAUNCH);

  child.autoReply = false;
  // REPLACE-ALL per source: absolute source.path + 1-based breakpoints[].line.
  const args = { source: { path: "/ws/app/main.py" }, breakpoints: [{ line: 3 }, { line: 10 }] };
  const p = host.request("s1", "setBreakpoints", args);
  const sent = child.sent.find((m) => m.command === "setBreakpoints");
  assert.ok(sent, "setBreakpoints was sent to the adapter");
  assert.deepEqual(sent!.args, args);
  // the adapter verifies one + ADJUSTS the other's line — the body round-trips as-is.
  child.respond(sent!.seq, "setBreakpoints", true, {
    breakpoints: [
      { verified: true, line: 3, id: 1 },
      { verified: true, line: 11, id: 2 },
    ],
  });
  const body = (await p) as { breakpoints: { verified: boolean; line: number }[] };
  assert.deepEqual(
    body.breakpoints.map((b) => [b.verified, b.line]),
    [
      [true, 3],
      [true, 11],
    ],
  );
  child.autoReply = true; // let the dispose-time disconnect resolve promptly.
  await host.dispose();
});

test("APP-079: host captures initialize capabilities + returns them from launch", async () => {
  const child = new FakeDapChild();
  child.capabilities = {
    supportsConfigurationDoneRequest: true,
    supportsLogPoints: true,
    exceptionBreakpointFilters: [
      { filter: "raised", label: "Raised Exceptions" },
      { filter: "uncaught", label: "Uncaught Exceptions", default: true },
    ],
  };
  const host = new DapHost({ spawn: () => child, mintId: () => "s1" });
  const { capabilities } = await host.launch(PY_LAUNCH);
  assert.equal(capabilities.supportsConfigurationDoneRequest, true);
  assert.equal(capabilities.supportsLogPoints, true);
  assert.deepEqual(
    capabilities.exceptionBreakpointFilters?.map((f) => f.filter),
    ["raised", "uncaught"],
  );
  await host.dispose();
});

test("APP-079: host applies the launch plan AFTER `initialized` — setBreakpoints (with condition/hitCondition/logMessage) + setExceptionBreakpoints, configurationDone LAST", async () => {
  const child = new FakeDapChild();
  child.capabilities = { supportsConfigurationDoneRequest: true, supportsLogPoints: true };
  const host = new DapHost({ spawn: () => child, mintId: () => "s1", requestTimeoutMs: 500 });
  await host.launch(PY_LAUNCH, {
    sources: [
      {
        path: "/ws/app/main.py",
        breakpoints: [
          { line: 3, condition: "x > 3" },
          { line: 10, hitCondition: "5" },
          { line: 14, logMessage: "n={n}" },
        ],
      },
    ],
    exceptionFilters: ["uncaught"],
  });

  // BEFORE `initialized`, no config-phase message may have been sent (protocol order).
  const configCmds = ["setBreakpoints", "setExceptionBreakpoints", "configurationDone"];
  assert.equal(
    child.sent.some((m) => configCmds.includes(m.command)),
    false,
    "no setBreakpoints/configurationDone before the initialized event",
  );

  child.event("initialized", {});
  // let the host's async config phase drain (setBreakpoints → setException → configDone).
  await new Promise((r) => setTimeout(r, 20));

  const bp = child.sent.find((m) => m.command === "setBreakpoints");
  assert.ok(bp, "setBreakpoints was sent after initialized");
  assert.deepEqual(bp!.args, {
    source: { path: "/ws/app/main.py" },
    breakpoints: [
      { line: 3, condition: "x > 3" },
      { line: 10, hitCondition: "5" },
      { line: 14, logMessage: "n={n}" },
    ],
  });
  // setExceptionBreakpoints carried the filter IDs.
  const exc = child.sent.find((m) => m.command === "setExceptionBreakpoints");
  assert.deepEqual(exc?.args, { filters: ["uncaught"] });

  // ORDER: setBreakpoints & setExceptionBreakpoints both precede configurationDone,
  // and configurationDone is the LAST config-phase message the adapter saw.
  const order = child.sent.map((m) => m.command);
  const idxInit = order.indexOf("setBreakpoints");
  const idxExc = order.indexOf("setExceptionBreakpoints");
  const idxDone = order.indexOf("configurationDone");
  assert.ok(idxInit >= 0 && idxExc >= 0 && idxDone >= 0);
  assert.ok(idxInit < idxDone && idxExc < idxDone, "configurationDone follows the config sends");
  assert.equal(
    order.filter((c) => configCmds.includes(c)).at(-1),
    "configurationDone",
    "configurationDone is the last config-phase message",
  );
  await host.dispose();
});

test("APP-079: host emits configApplied with the setBreakpoints response for verified fold-back", async () => {
  const child = new FakeDapChild();
  child.capabilities = { supportsConfigurationDoneRequest: true };
  // the adapter verifies line 4 + rejects line 8 — the fold-back must carry both back.
  child.overrides.setBreakpoints = {
    breakpoints: [
      { verified: true, line: 4 },
      { verified: false, line: 8 },
    ],
  };
  const host = new DapHost({ spawn: () => child, mintId: () => "s1", requestTimeoutMs: 500 });
  const applied: Array<{ path: string; sentLines: number[]; breakpoints: unknown[] }> = [];
  host.on("configApplied", (e) =>
    applied.push({ path: e.path, sentLines: e.sentLines, breakpoints: e.breakpoints }),
  );

  await host.launch(PY_LAUNCH, {
    sources: [{ path: "/ws/m.py", breakpoints: [{ line: 4 }, { line: 8, condition: "ok" }] }],
  });

  child.event("initialized", {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0]?.sentLines, [4, 8]);
  assert.deepEqual(
    (applied[0]?.breakpoints as { verified: boolean; line: number }[]).map((b) => [
      b.verified,
      b.line,
    ]),
    [
      [true, 4],
      [false, 8],
    ],
  );
  child.autoReply = true;
  await host.dispose();
});

test("DapHost sends an EMPTY setBreakpoints list verbatim (clearing a source, APP-012)", async () => {
  const child = new FakeDapChild();
  const host = new DapHost({ spawn: () => child, mintId: () => "s1", requestTimeoutMs: 500 });
  await host.launch(PY_LAUNCH);

  // removing a file's last breakpoint must SEND breakpoints: [], never omit the request.
  await host.request("s1", "setBreakpoints", {
    source: { path: "/ws/app/main.py" },
    breakpoints: [],
  });
  const sent = child.sent.find((m) => m.command === "setBreakpoints");
  assert.deepEqual(sent?.args, { source: { path: "/ws/app/main.py" }, breakpoints: [] });
  await host.dispose();
});

test("DapHost rejects a failed DAP response", async () => {
  const child = new FakeDapChild();
  const host = new DapHost({ spawn: () => child, mintId: () => "s1", requestTimeoutMs: 500 });
  await host.launch(PY_LAUNCH);
  child.autoReply = false;
  const p = host.request("s1", "setBreakpoints", { source: { path: "a.py" }, breakpoints: [] });
  const sent = child.sent.find((m) => m.command === "setBreakpoints");
  child.respond(sent!.seq, "setBreakpoints", false, undefined, "no such file");
  await assert.rejects(p, /setBreakpoints failed: no such file/);
  child.autoReply = true; // let the dispose-time disconnect resolve promptly.
  await host.dispose();
});

test("DapHost forwards DAP events to the renderer feed + flips state on terminated", async () => {
  const child = new FakeDapChild();
  const host = new DapHost({ spawn: () => child, mintId: () => "s1" });
  const events: { event: string }[] = [];
  host.on("event", (e) => events.push({ event: e.event }));
  await host.launch(PY_LAUNCH);

  child.event("stopped", { reason: "breakpoint", threadId: 1 });
  child.event("output", { category: "stdout", output: "hi\n" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(
    events.map((e) => e.event),
    ["stopped", "output"],
  );

  child.event("terminated", {});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(host.status("s1")?.state, "terminated");
  await host.dispose();
});

test("DapHost rejects a request to an unknown session (fail-closed)", async () => {
  const host = new DapHost({ spawn: () => new FakeDapChild() });
  await assert.rejects(host.request("nope", "continue"), /no debug session/);
  await host.dispose();
});

test("DapHost terminate disconnects + kills the adapter", async () => {
  const child = new FakeDapChild();
  const host = new DapHost({ spawn: () => child, mintId: () => "s1" });
  await host.launch(PY_LAUNCH);
  await host.terminate("s1");
  assert.equal(child.killed, true);
  assert.equal(host.status("s1"), undefined);
  // a disconnect request was attempted before the kill.
  assert.ok(child.sent.some((m) => m.command === "disconnect"));
  await host.dispose();
});

/* ── APP-080: remote/attach socket transport + set-value ─────────────────────*/

test("APP-080: isLoopbackHost — literal loopback only; wildcards + hostnames are remote", () => {
  for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.5.5.5", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(h), true, `${h} is loopback`);
  }
  for (const h of ["0.0.0.0", "::", "10.0.0.5", "192.168.1.1", "example.com", "127.0.0.256"]) {
    assert.equal(isLoopbackHost(h), false, `${h} is remote/invalid`);
  }
});

test("APP-080: a `connect` attach opens a socket + runs initialize→attach (connect verbatim)", async () => {
  const socket = new FakeDapSocket();
  let connectCalls = 0;
  const host = new DapHost({
    spawn: () => new FakeDapChild(),
    connect: (h, p) => {
      connectCalls++;
      assert.equal(h, "127.0.0.1");
      assert.equal(p, 5678);
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
    mintId: () => "s1",
    requestTimeoutMs: 500,
  });
  const { sessionId } = await host.launch(ATTACH_LOCAL);
  assert.equal(sessionId, "s1");
  assert.equal(connectCalls, 1, "the injected socket connect was used, not spawn");
  assert.equal(socket.noDelay, true, "Nagle disabled for a request/response protocol");
  // handshake sent initialize THEN attach; the attach args carry `connect` untouched.
  assert.equal(socket.sent[0]?.command, "initialize");
  assert.equal(socket.sent[1]?.command, "attach");
  assert.deepEqual(socket.sent[1]?.args, {
    name: "attach",
    connect: { host: "127.0.0.1", port: 5678 },
  });
  assert.equal(host.status("s1")?.state, "running");
  await host.dispose();
});

test("APP-080: the SAME framed request routing works over the socket transport", async () => {
  const socket = new FakeDapSocket();
  const host = new DapHost({
    spawn: () => new FakeDapChild(),
    connect: () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
    mintId: () => "s1",
    requestTimeoutMs: 500,
  });
  await host.launch(ATTACH_LOCAL);
  socket.autoReply = false;
  const p = host.request("s1", "setVariable", {
    variablesReference: 12,
    name: "x",
    value: "99",
  });
  const sent = socket.sent.find((m) => m.command === "setVariable");
  assert.ok(sent, "setVariable was framed over the socket");
  assert.deepEqual(sent!.args, { variablesReference: 12, name: "x", value: "99" });
  socket.respond(sent!.seq, "setVariable", true, { value: "99", type: "int" });
  const body = (await p) as { value: string; type: string };
  assert.deepEqual(body, { value: "99", type: "int" });
  socket.autoReply = true;
  await host.dispose();
});

test("APP-080: a REMOTE (non-loopback) attach without confirmation never opens a socket", async () => {
  let connectCalls = 0;
  const host = new DapHost({
    spawn: () => new FakeDapChild(),
    connect: () => {
      connectCalls++;
      return new FakeDapSocket();
    },
    mintId: () => "s1",
  });
  await assert.rejects(
    host.launch({
      type: "python",
      request: "attach",
      name: "remote",
      connect: { host: "10.0.0.5", port: 5678 },
    }),
    /requires confirmation/,
  );
  assert.equal(connectCalls, 0, "no socket opened for an unconfirmed remote attach");
  await host.dispose();
});

test("APP-080: a CONFIRMED remote attach (allowRemote) opens the socket", async () => {
  const socket = new FakeDapSocket();
  let connectCalls = 0;
  const host = new DapHost({
    spawn: () => new FakeDapChild(),
    connect: () => {
      connectCalls++;
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
    mintId: () => "s2",
  });
  const { sessionId } = await host.launch(
    {
      type: "python",
      request: "attach",
      name: "remote",
      connect: { host: "10.0.0.5", port: 5678 },
    },
    undefined,
    { allowRemote: true },
  );
  assert.equal(sessionId, "s2");
  assert.equal(connectCalls, 1);
  await host.dispose();
});

test("APP-080: a `connect` config is refused when the host has no socket transport", async () => {
  const host = new DapHost({ spawn: () => new FakeDapChild(), mintId: () => "s1" });
  await assert.rejects(host.launch(ATTACH_LOCAL), /socket .*unavailable/);
  await host.dispose();
});

test("APP-080: a `connect` target on a launch request is refused (defence-in-depth)", async () => {
  const host = new DapHost({
    spawn: () => new FakeDapChild(),
    connect: () => new FakeDapSocket(),
    mintId: () => "s1",
  });
  await assert.rejects(
    host.launch({
      type: "python",
      request: "launch",
      name: "x",
      connect: { host: "127.0.0.1", port: 5678 },
    }),
    /requires request "attach"/,
  );
  await host.dispose();
});

test("APP-080: a connect ERROR (e.g. ECONNREFUSED) fails launch closed + destroys the socket", async () => {
  const socket = new FakeDapSocket();
  const host = new DapHost({
    spawn: () => new FakeDapChild(),
    connect: () => {
      queueMicrotask(() => socket.emit("error", new Error("ECONNREFUSED")));
      return socket;
    },
    mintId: () => "s1",
    requestTimeoutMs: 500,
  });
  await assert.rejects(host.launch(ATTACH_LOCAL), /ECONNREFUSED/);
  assert.equal(socket.destroyed, true, "the connecting socket was destroyed on error");
  assert.equal(host.status("s1")?.state, "failed");
  await host.dispose();
});

test("APP-080: a socket session terminates cleanly — destroy() closes the fd, no leak", async () => {
  const socket = new FakeDapSocket();
  const host = new DapHost({
    spawn: () => new FakeDapChild(),
    connect: () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
    mintId: () => "s1",
  });
  await host.launch(ATTACH_LOCAL);
  await host.terminate("s1");
  assert.equal(socket.destroyed, true, "the socket was destroyed on teardown");
  assert.equal(host.status("s1"), undefined);
  assert.ok(
    socket.sent.some((m) => m.command === "disconnect"),
    "a best-effort disconnect preceded the destroy",
  );
  await host.dispose();
});

test("APP-080: host captures supportsSetVariable from the initialize capabilities", async () => {
  const child = new FakeDapChild();
  child.capabilities = { supportsSetVariable: true };
  const host = new DapHost({ spawn: () => child, mintId: () => "s1" });
  const { capabilities } = await host.launch(PY_LAUNCH);
  assert.equal(capabilities.supportsSetVariable, true);
  await host.dispose();
});

test("detectAdapter: no detector configured ⇒ unavailable, never silently 'available'", async () => {
  const host = new DapHost({ spawn: () => new FakeDapChild() });
  const r = await host.detectAdapter("python");
  assert.equal(r.available, false);
  assert.match(r.detail, /unavailable in this host/);
  await host.dispose();
});

test("detectAdapter: an unknown non-python type is rejected before ever calling the detector", async () => {
  let called = false;
  const host = new DapHost({
    spawn: () => new FakeDapChild(),
    detector: async () => {
      called = true;
      return { type: "cobol", available: true, detail: "should never happen" };
    },
  });
  const r = await host.detectAdapter("cobol");
  assert.equal(r.available, false);
  assert.match(r.detail, /unknown debug type/);
  assert.equal(called, false);
  await host.dispose();
});

test("detectAdapter: delegates to the injected detector for python/node", async () => {
  const host = new DapHost({
    spawn: () => new FakeDapChild(),
    detector: async (type, pythonPath) => ({
      type,
      available: type === "python",
      detail: pythonPath ?? "no interpreter",
    }),
  });
  const py = await host.detectAdapter("python", "/venv/bin/python");
  assert.equal(py.available, true);
  assert.equal(py.detail, "/venv/bin/python");
  const node = await host.detectAdapter("node");
  assert.equal(node.available, false);
  await host.dispose();
});

test("installAdapter: no installer configured ⇒ refuses, never fakes success", async () => {
  const host = new DapHost({ spawn: () => new FakeDapChild() });
  const r = await host.installAdapter("python");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /unavailable in this host/);
  await host.dispose();
});

test("installAdapter: delegates to the injected installer with the given opts", async () => {
  const calls: Array<{ type: string; opts: unknown }> = [];
  const host = new DapHost({
    spawn: () => new FakeDapChild(),
    installer: async (type, opts) => {
      calls.push({ type, opts });
      return { ok: true, output: "installed" };
    },
  });
  const r = await host.installAdapter("python", { pythonPath: "/venv/bin/python", confirm: true });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: "python",
    opts: { pythonPath: "/venv/bin/python", confirm: true },
  });
  await host.dispose();
});

test("DapHost request times out fail-closed when the adapter never replies", async () => {
  const child = new FakeDapChild();
  child.autoReply = false;
  // a tiny timeout so the test is fast; the timer is real here (short).
  const host = new DapHost({ spawn: () => child, mintId: () => "s1", requestTimeoutMs: 20 });
  await host.launch({ ...PY_LAUNCH }).catch(() => {});
  // launch itself will reject on timeout (the fake never replies); assert a fresh request times out.
  const p = host.request("s1", "threads").catch((e: Error) => e.message);
  // wait past the timeout.
  const msg = await p;
  assert.match(String(msg), /timed out/);
  child.autoReply = true; // let the dispose-time disconnect resolve promptly.
  await host.dispose();
});
