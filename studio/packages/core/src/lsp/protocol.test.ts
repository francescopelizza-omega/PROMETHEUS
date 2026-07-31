/**
 * protocol.test.ts — LSP JSON-RPC framing + the DAP framing (file 07 §4/§5).
 *
 * The language servers (pyright/tsserver) and debug adapters (debugpy/js-debug)
 * are NOT installed in this env, so a real session cannot run — but the WIRE
 * framing is pure and fully testable. We assert: Content-Length encode/decode
 * round-trips (incl. multibyte bodies, where byte-length != char-length), the
 * MessageReader reassembles messages split across chunks and coalesces multiple
 * frames in one chunk, malformed frames throw, request/notification/cancel
 * builders + type guards, the server registry map (incl. the pythonPath init
 * option from the env-manager), and the DAP framing round-trip + builders.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DapMessageReader,
  type DapResponse,
  decodeDapMessage,
  encodeDapMessage,
  isDapEvent,
  isDapResponse,
  makeDapRequest,
  makeSeqGenerator,
} from "../dap/protocol.js";
import {
  MessageReader,
  RPC_ERROR,
  type RpcResponse,
  decodeMessage,
  encodeMessage,
  isNotification,
  isResponse,
  isServerRequest,
  makeCancel,
  makeErrorResponse,
  makeIdGenerator,
  makeNotification,
  makeRequest,
  makeResponse,
} from "./protocol.js";
import {
  initOptionsFor,
  requiresGateBeforeDownload,
  serverFor,
  serverIdFor,
  supportedLanguages,
} from "./servers.js";

/* --- server→client requests (APP-078) ------------------------------------ */

test("isServerRequest vs isResponse vs isNotification (direction disambiguation)", () => {
  const serverReq = { jsonrpc: "2.0" as const, id: 7, method: "workspace/applyEdit", params: {} };
  const responseToUs = { jsonrpc: "2.0" as const, id: 7, result: {} };
  const notif = { jsonrpc: "2.0" as const, method: "textDocument/publishDiagnostics", params: {} };
  assert.equal(isServerRequest(serverReq), true); // id AND method → must be answered
  assert.equal(isServerRequest(responseToUs), false); // id + result → a response to us
  assert.equal(isServerRequest(notif), false); // method, no id → notification
  assert.equal(isResponse(responseToUs), true);
  assert.equal(isNotification(notif), true);
});

test("makeResponse / makeErrorResponse echo the id; error defaults to MethodNotFound", () => {
  assert.deepEqual(makeResponse(9, { applied: true }), {
    jsonrpc: "2.0",
    id: 9,
    result: { applied: true },
  });
  const err = makeErrorResponse("abc"); // string id per spec
  assert.equal(err.id, "abc");
  assert.equal(err.error?.code, RPC_ERROR.MethodNotFound);
});

/* --- LSP Content-Length framing ------------------------------------------ */

test("encodeMessage: Content-Length is the UTF-8 BYTE length of the body", () => {
  const req = makeRequest(1, "initialize", { rootUri: "file:///ws" });
  const frame = encodeMessage(req);
  const body = JSON.stringify(req);
  assert.match(frame, /^Content-Length: \d+\r\n\r\n/);
  const declared = Number(/Content-Length: (\d+)/.exec(frame)![1]);
  assert.equal(declared, Buffer.byteLength(body, "utf8"));
});

test("encode -> decode round-trips a request", () => {
  const req = makeRequest(7, "textDocument/completion", { position: { line: 1, character: 2 } });
  const frame = encodeMessage(req);
  const decoded = decodeMessage(Buffer.from(frame, "utf8"));
  assert.ok(decoded);
  assert.deepEqual(decoded!.message, req);
  assert.equal(decoded!.consumed, Buffer.byteLength(frame, "utf8"));
});

test("decode handles a multibyte (emoji) body without desync", () => {
  // an emoji is multiple UTF-8 bytes but one+ JS chars — byte length must drive.
  const note = makeNotification("window/logMessage", { message: "done ✅ 🚀" });
  const frame = encodeMessage(note);
  const decoded = decodeMessage(Buffer.from(frame, "utf8"));
  assert.ok(decoded);
  assert.deepEqual(decoded!.message, note);
});

test("decodeMessage returns null when the buffer holds only a partial frame", () => {
  const frame = encodeMessage(makeRequest(1, "shutdown"));
  const buf = Buffer.from(frame, "utf8");
  // headers not yet complete
  assert.equal(decodeMessage(buf.subarray(0, 5)), null);
  // header complete but body truncated
  const headerEnd = buf.indexOf("\r\n\r\n", 0, "utf8") + 4;
  assert.equal(decodeMessage(buf.subarray(0, headerEnd + 1)), null);
});

test("decodeMessage throws on a missing Content-Length header", () => {
  const bad = Buffer.from("X-Foo: 1\r\n\r\n{}", "utf8");
  assert.throws(() => decodeMessage(bad), /Content-Length/);
});

test("decodeMessage throws on a non-JSON body", () => {
  const body = "not json";
  const bad = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf8");
  assert.throws(() => decodeMessage(bad), /not valid JSON/);
});

test("MessageReader reassembles a message split across chunks", () => {
  const reader = new MessageReader();
  const msg = makeRequest(42, "textDocument/hover", { uri: "file:///a.py" });
  const frame = encodeMessage(msg);
  const buf = Buffer.from(frame, "utf8");
  const mid = Math.floor(buf.length / 2);
  assert.deepEqual(reader.feed(buf.subarray(0, mid)), []); // incomplete
  assert.ok(reader.pending() > 0);
  const got = reader.feed(buf.subarray(mid));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], msg);
  assert.equal(reader.pending(), 0);
});

test("MessageReader coalesces multiple frames in a single chunk", () => {
  const reader = new MessageReader();
  const a = makeRequest(1, "a");
  const b = makeNotification("b");
  const combined = encodeMessage(a) + encodeMessage(b);
  const got = reader.feed(combined);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], a);
  assert.deepEqual(got[1], b);
});

test("id generator is monotonic; builders + cancel + type guards", () => {
  const nextId = makeIdGenerator();
  assert.equal(nextId(), 1);
  assert.equal(nextId(), 2);

  const req = makeRequest(3, "m", { x: 1 });
  assert.equal("id" in req, true);
  const note = makeNotification("n");
  assert.equal("params" in note, false); // no params omitted cleanly

  const cancel = makeCancel(3);
  assert.equal(cancel.method, "$/cancelRequest");
  assert.deepEqual(cancel.params, { id: 3 });

  const response: RpcResponse = { jsonrpc: "2.0", id: 3, result: { ok: true } };
  assert.equal(isResponse(response), true);
  assert.equal(isNotification(response), false);
  assert.equal(isNotification(note), true);
  assert.equal(isResponse(note), false);
});

/* --- LSP server registry (file 07 §4.1) ---------------------------------- */

test("server registry: python -> pyright, ts/js share tsserver", () => {
  assert.equal(serverIdFor("python"), "pyright");
  assert.equal(serverIdFor("typescript"), "tsserver");
  assert.equal(serverIdFor("javascript"), "tsserver");
  assert.equal(serverIdFor("typescript"), serverIdFor("javascript"));
  assert.equal(serverIdFor("cobol"), undefined);
  assert.ok(supportedLanguages().includes("python"));
});

test("server registry: pyright initOptions carries the venv pythonPath (file 04)", () => {
  const opts = initOptionsFor("python", {
    rootUri: "file:///ws",
    interpreterPath: "/ws/.venv/bin/python",
    envName: ".venv",
  }) as { python?: { pythonPath?: string } };
  assert.equal(opts.python?.pythonPath, "/ws/.venv/bin/python");
  // with no interpreter, an empty options object (no crash).
  const none = initOptionsFor("python", { rootUri: "file:///ws" }) as Record<string, unknown>;
  assert.deepEqual(none, {});
});

test("server registry: rust/go are on-demand (gate-before-download), python is not", () => {
  assert.equal(requiresGateBeforeDownload("rust"), true);
  assert.equal(requiresGateBeforeDownload("go"), true);
  assert.equal(requiresGateBeforeDownload("python"), false);
  assert.equal(serverFor("rust")?.sourcing, "on-demand");
  assert.equal(serverFor("python")?.sourcing, "bundled");
});

/* --- DAP framing (file 07 §5) -------------------------------------------- */

test("DAP encode -> decode round-trips a request", () => {
  const req = makeDapRequest(1, "setBreakpoints", {
    source: { path: "/ws/app.py" },
    breakpoints: [{ line: 10 }],
  });
  const frame = encodeDapMessage(req);
  const decoded = decodeDapMessage(Buffer.from(frame, "utf8"));
  assert.ok(decoded);
  assert.deepEqual(decoded!.message, req);
});

test("DapMessageReader reassembles split frames and classifies messages", () => {
  const reader = new DapMessageReader();
  const evt = { seq: 5, type: "event" as const, event: "stopped", body: { reason: "breakpoint" } };
  const resp: DapResponse = {
    seq: 6,
    type: "response",
    request_seq: 1,
    success: true,
    command: "continue",
  };
  const frames = encodeDapMessage(evt) + encodeDapMessage(resp);
  const buf = Buffer.from(frames, "utf8");
  // split mid-stream
  const got1 = reader.feed(buf.subarray(0, 20));
  const got2 = reader.feed(buf.subarray(20));
  const all = [...got1, ...got2];
  assert.equal(all.length, 2);
  assert.equal(isDapEvent(all[0]!), true);
  assert.equal(isDapResponse(all[1]!), true);
});

test("DAP seq generator is monotonic; malformed DAP frame throws", () => {
  const nextSeq = makeSeqGenerator(10);
  assert.equal(nextSeq(), 10);
  assert.equal(nextSeq(), 11);
  const bad = Buffer.from("Content-Length: notanumber\r\n\r\n{}", "utf8");
  assert.throws(() => decodeDapMessage(bad), /Content-Length/);
});
