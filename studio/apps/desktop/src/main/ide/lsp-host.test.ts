/**
 * lsp-host.test.ts — node:test for the MAIN-process LSP host supervision + routing.
 *
 * Runs NOW (no electron, no real pyright — it is NOT installed in this env). It
 * drives LspHost with an INJECTED FAKE JSON-RPC child (an EventEmitter-backed
 * stand-in) so the whole state machine is exercised deterministically:
 *   - LAZY START: a server boots on the first ensure(), not before,
 *   - REQUEST ROUTING: a request gets the matching server response (by id),
 *   - CANCELLATION: an in-flight request is cancelled (rejects + `$/cancelRequest`),
 *   - CRASH → BACKOFF → RESTART: an unexpected exit respawns within the 3/30s
 *     window; the 4th crash leaves it `failed`,
 *   - IDLE GC: the last didClose arms a timer that stops the server.
 *
 * The framing comes from the PURE core lsp/protocol.ts (the host writes real LSP
 * frames; the fake child decodes them with MessageReader and replies in-frame).
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test lsp-host.test.ts
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { MessageReader, encodeMessage } from "@prometheus/core";

import { type LspChild, LspHost } from "./lsp-host.js";

/**
 * A controllable fake LSP child. It decodes the frames the host writes and, by
 * default, AUTO-REPLIES to every request with `{}` (so the initialize handshake
 * completes and arbitrary requests resolve). Tests can flip `autoReply` off to
 * leave a request in-flight (for the cancel/timeout cases) or call `crash()`.
 */
class FakeLspChild extends EventEmitter implements LspChild {
  pid = 4242;
  autoReply = true;
  /** the methods+ids the host sent us (for assertions). */
  sent: { id?: number | string; method?: string }[] = [];
  /** APP-078: the FULL outbound frames (to assert response result/error bodies). */
  frames: Record<string, unknown>[] = [];
  killed = false;
  private readonly reader = new MessageReader();
  readonly stdin = {
    write: (data: string): void => {
      for (const msg of this.reader.feed(Buffer.from(data, "utf8"))) {
        const m = msg as { id?: number | string; method?: string };
        this.sent.push({ id: m.id, method: m.method });
        this.frames.push(msg as Record<string, unknown>);
        if (this.autoReply && m.id !== undefined && m.method !== undefined) {
          // reply on the next tick so the host's pending map is populated first.
          queueMicrotask(() => this.reply(m.id as number, {}));
        }
      }
    },
  };

  /** APP-078: push a server→client REQUEST frame (id + method). */
  pushRequest(id: number | string, method: string, params?: unknown): void {
    (this.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(encodeMessage({ jsonrpc: "2.0", id, method, params }), "utf8"),
    );
  }
  readonly stdout = new EventEmitter() as unknown as LspChild["stdout"];
  readonly stderr = new EventEmitter() as unknown as LspChild["stderr"];

  on(event: "exit" | "error", listener: (...a: never[]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void);
  }
  kill(): void {
    this.killed = true;
    // a kill triggers an exit (signal) like a real child.
    queueMicrotask(() => super.emit("exit", null, "SIGTERM"));
  }

  /** Push a JSON-RPC response frame to the host (as if on stdout). */
  reply(id: number, result: unknown): void {
    (this.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(encodeMessage({ jsonrpc: "2.0", id, result }), "utf8"),
    );
  }

  /** Push a publishDiagnostics notification. */
  pushDiagnostics(uri: string, diagnostics: unknown[]): void {
    (this.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(
        encodeMessage({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri, diagnostics },
        }),
        "utf8",
      ),
    );
  }

  /** Simulate an UNEXPECTED crash (exit non-zero). */
  crash(): void {
    super.emit("exit", 1, null);
  }
}

/** A deterministic, hand-driven timer surface for idle-GC + backoff tests. */
class FakeTimers {
  private seq = 0;
  private clock = 0;
  readonly scheduled = new Map<number, { fn: () => void; due: number }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.scheduled.set(id, { fn, due: this.clock + ms });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.scheduled.delete(h as number);
  };
  now = (): number => this.clock;
  /** advance the clock and fire everything due. */
  advance(ms: number): void {
    this.clock += ms;
    for (const [id, t] of [...this.scheduled]) {
      if (t.due <= this.clock) {
        this.scheduled.delete(id);
        t.fn();
      }
    }
  }
}

test("LspHost lazily spawns one server per (languageId, root) on ensure", () => {
  let spawns = 0;
  const children: FakeLspChild[] = [];
  const host = new LspHost({
    spawn: () => {
      spawns += 1;
      const c = new FakeLspChild();
      children.push(c);
      return c;
    },
  });

  assert.equal(spawns, 0); // nothing at construction (lazy)
  const { serverId } = host.ensure("python", { rootUri: "file:///proj" });
  assert.equal(serverId, "pyright");
  assert.equal(spawns, 1);
  // a second ensure of the SAME (id, root) reuses the server — no respawn.
  host.ensure("python", { rootUri: "file:///proj" });
  assert.equal(spawns, 1);
  // a DIFFERENT root spawns a second server.
  host.ensure("python", { rootUri: "file:///other" });
  assert.equal(spawns, 2);
  // the initialize handshake was sent on the first child.
  assert.ok(children[0]?.sent.some((m) => m.method === "initialize"));
  host.dispose();
});

test("LspHost routes a request to its server response by id", async () => {
  const child = new FakeLspChild();
  const host = new LspHost({ spawn: () => child });
  const { serverId } = host.ensure("typescript", { rootUri: "file:///proj" });

  // override autoReply to return a specific result for the next request.
  child.autoReply = false;
  const { id, result } = host.request(serverId, "file:///proj", "textDocument/hover", {
    textDocument: { uri: "file:///proj/a.ts" },
  });
  // the host wrote the request to the child with our id.
  assert.ok(child.sent.some((m) => m.id === id && m.method === "textDocument/hover"));
  child.reply(id, { contents: "hover!" });
  const res = (await result) as { contents: string };
  assert.equal(res.contents, "hover!");
  host.dispose();
});

test("LspHost forwards publishDiagnostics as a host event", async () => {
  const child = new FakeLspChild();
  const host = new LspHost({ spawn: () => child });
  const got: { serverId: string; uri: string }[] = [];
  host.on("diagnostics", (e) => got.push({ serverId: e.serverId, uri: e.params.uri }));
  host.ensure("python", { rootUri: "file:///proj" });
  child.pushDiagnostics("file:///proj/a.py", [{ message: "boom" }]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(got.length, 1);
  assert.equal(got[0]?.serverId, "pyright");
  assert.equal(got[0]?.uri, "file:///proj/a.py");
  host.dispose();
});

/* --- APP-078: server→client requests (workspace/applyEdit relay) ---------- */

test("LspHost relays workspace/applyEdit + respondApplyEdit answers the server's id", async () => {
  const child = new FakeLspChild();
  const host = new LspHost({ spawn: () => child });
  const got: { serverId: string; requestId: number | string }[] = [];
  host.on("applyEdit", (e) => got.push({ serverId: e.serverId, requestId: e.requestId as number }));
  host.ensure("python", { rootUri: "file:///proj" });
  child.pushRequest(77, "workspace/applyEdit", { edit: { changes: {} } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(got.length, 1);
  assert.equal(got[0]?.requestId, 77);
  // the renderer applied it → ack; the host writes a `{applied:true}` response echoing id 77.
  host.respondApplyEdit("pyright", "file:///proj", 77, true);
  const resp = child.frames.find((f) => f.id === 77 && "result" in f);
  assert.ok(resp, "a response with id 77 was written (no dangling)");
  assert.deepEqual(resp?.result, { applied: true });
  host.dispose();
});

test("LspHost answers an UNKNOWN server request with MethodNotFound (no dangling id)", async () => {
  const child = new FakeLspChild();
  const host = new LspHost({ spawn: () => child });
  host.ensure("python", { rootUri: "file:///proj" });
  child.pushRequest("cfg-1", "workspace/configuration", { items: [] });
  await new Promise((r) => setTimeout(r, 5));
  const resp = child.frames.find((f) => f.id === "cfg-1" && "error" in f);
  assert.ok(resp, "an error response with id cfg-1 was written");
  assert.equal((resp?.error as { code: number }).code, -32601); // MethodNotFound
  host.dispose();
});

test("LspHost timeboxes an un-acked applyEdit → replies applied:false, no dangling", () => {
  const timers = new FakeTimers();
  const child = new FakeLspChild();
  const host = new LspHost({ spawn: () => child, timers });
  host.on("applyEdit", () => {}); // renderer never acks
  host.ensure("python", { rootUri: "file:///proj" });
  child.pushRequest(88, "workspace/applyEdit", { edit: {} });
  timers.advance(5_000); // past the 5s timebox
  const resp = child.frames.find((f) => f.id === 88 && "result" in f);
  assert.ok(resp, "the timebox wrote a response for id 88");
  assert.deepEqual(resp?.result, { applied: false });
  host.dispose();
});

test("LspHost cancels an in-flight request (rejects + sends $/cancelRequest)", async () => {
  const child = new FakeLspChild();
  child.autoReply = false; // leave the request hanging so we can cancel it.
  const host = new LspHost({ spawn: () => child });
  const { serverId } = host.ensure("python", { rootUri: "file:///proj" });

  const { id, result } = host.request(serverId, "file:///proj", "textDocument/completion");
  host.cancel(serverId, "file:///proj", id);
  await assert.rejects(result, /cancelled/);
  // a `$/cancelRequest` notification was written to the child.
  assert.ok(child.sent.some((m) => m.method === "$/cancelRequest"));
  host.dispose();
});

test("LspHost restarts a crashed server with backoff, then fails after 3 tries in the window", () => {
  const timers = new FakeTimers();
  const children: FakeLspChild[] = [];
  const host = new LspHost({
    spawn: () => {
      const c = new FakeLspChild();
      children.push(c);
      return c;
    },
    timers,
    policy: {
      maxRestarts: 3,
      restartWindowMs: 30_000,
      idleGcMs: 300_000,
      requestTimeoutMs: 30_000,
    },
  });

  const states: string[] = [];
  host.on("state", (s) => states.push(s.state));
  host.ensure("python", { rootUri: "file:///proj" });
  assert.equal(children.length, 1);

  // crash #1 → restart scheduled inside the window → respawn immediately (synchronous spawn).
  children[0]!.crash();
  assert.equal(children.length, 2, "crash #1 respawns");
  children[1]!.crash();
  assert.equal(children.length, 3, "crash #2 respawns");
  children[2]!.crash();
  assert.equal(children.length, 4, "crash #3 respawns");
  // the 4th crash exceeds maxRestarts (3) inside the 30s window → failed, no respawn.
  children[3]!.crash();
  assert.equal(children.length, 4, "4th crash does NOT respawn");
  const status = host.status("pyright", "file:///proj");
  assert.equal(status?.state, "failed");
  host.dispose();
});

test("LspHost crash-counter resets after a server stays healthy past the window", () => {
  const timers = new FakeTimers();
  const children: FakeLspChild[] = [];
  const host = new LspHost({
    spawn: () => {
      const c = new FakeLspChild();
      children.push(c);
      return c;
    },
    timers,
    policy: {
      maxRestarts: 3,
      restartWindowMs: 30_000,
      idleGcMs: 300_000,
      requestTimeoutMs: 30_000,
    },
  });
  host.ensure("python", { rootUri: "file:///proj" });

  children[0]!.crash();
  children[1]!.crash();
  children[2]!.crash(); // restarts=3 now
  assert.equal(children.length, 4);
  // a long healthy run (clock advances past the window) resets the counter…
  timers.advance(31_000);
  children[3]!.crash(); // …so this is a FRESH fault, not the 4th → respawns.
  assert.equal(children.length, 5, "counter reset → respawns after a healthy run");
  host.dispose();
});

test("LspHost idle-GC stops a server after the last document closes", () => {
  const timers = new FakeTimers();
  const child = new FakeLspChild();
  const host = new LspHost({
    spawn: () => child,
    timers,
    policy: { idleGcMs: 300_000 },
  });
  const { serverId } = host.ensure("python", { rootUri: "file:///proj" });
  host.didOpen(serverId, "file:///proj", "file:///proj/a.py", "python", "x = 1");
  assert.equal(host.status(serverId, "file:///proj")?.openDocs, 1);

  host.didClose(serverId, "file:///proj", "file:///proj/a.py");
  // last doc closed → idle timer armed; before it fires the server is still up.
  assert.equal(host.status(serverId, "file:///proj")?.state, "running");
  timers.advance(300_000);
  // idle GC fired → the server was stopped (removed from the registry).
  assert.equal(host.status(serverId, "file:///proj"), undefined);
  assert.equal(child.killed, true);
  host.dispose();
});

test("LspHost rejects a request to an unknown server (fail-closed, no fabricated result)", async () => {
  const host = new LspHost({ spawn: () => new FakeLspChild() });
  const { id, result } = host.request("pyright", "file:///nope", "textDocument/hover");
  assert.equal(id, -1);
  await assert.rejects(result, /no LSP server/);
  host.dispose();
});

test("LspHost ensure throws for a language with no registered server", () => {
  const host = new LspHost({ spawn: () => new FakeLspChild() });
  assert.throws(() => host.ensure("cobol", { rootUri: "file:///proj" }), /no language server/);
  host.dispose();
});

test("LspHost setInterpreter restarts pyright when the interpreter changes", () => {
  let spawns = 0;
  const host = new LspHost({
    spawn: () => {
      spawns += 1;
      return new FakeLspChild();
    },
  });
  const { serverId } = host.ensure("python", {
    rootUri: "file:///proj",
    interpreterPath: "/proj/.venv/bin/python",
  });
  assert.equal(spawns, 1);
  // same path → no restart.
  assert.equal(host.setInterpreter(serverId, "file:///proj", "/proj/.venv/bin/python"), false);
  assert.equal(spawns, 1);
  // changed path → pyright restarts (new interpreter in initializationOptions).
  assert.equal(host.setInterpreter(serverId, "file:///proj", "/other/.venv/bin/python"), true);
  assert.equal(spawns, 2);
  host.dispose();
});
