// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * lsp/protocol.ts — the shared LSP wire TYPES + a pure JSON-RPC framing helper
 * (file 07 §3.2/§4).
 *
 * Language servers run as child processes IN THE ELECTRON MAIN PROCESS (never the
 * renderer — C5), speaking LSP over stdio JSON-RPC. The renderer's Monaco
 * providers proxy every request through `lsp:request`. THIS module is the pure,
 * binary-free part of that: the message shapes and the Content-Length header
 * encode/decode. It spawns nothing — it is fully testable without any server
 * binary (which is exactly the env limit: pyright/tsserver are NOT installed
 * here, so the framing + routing is tested as pure functions).
 *
 * Node built-ins only (no node:* needed — string/byte math on UTF-8).
 */

/* ------------------------------------------------------------------------- *
 * JSON-RPC 2.0 message shapes (the subset LSP uses)
 * ------------------------------------------------------------------------- */

/** A JSON-RPC request id (number or string per the spec). */
export type RpcId = number | string;

/** A JSON-RPC request (expects a response). */
export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
}

/** A JSON-RPC notification (no id, no response). */
export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** A JSON-RPC error object. */
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC response (success xor error). */
export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId | null;
  result?: unknown;
  error?: RpcError;
}

/** Any framed message on the wire. */
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

/** Standard JSON-RPC error codes used by LSP (subset). */
export const RPC_ERROR = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** LSP: request cancelled (`$/cancelRequest`, file 07 §4.2). */
  RequestCancelled: -32800,
  ServerNotInitialized: -32002,
} as const;

/* ------------------------------------------------------------------------- *
 * A subset of LSP method params/results the editor wires (file 07 §3.3)
 * ------------------------------------------------------------------------- */

/** LSP `Position` (0-based line + UTF-16 character offset). */
export interface LspPosition {
  line: number;
  character: number;
}

/** LSP `Range`. */
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** LSP `TextDocumentIdentifier`. */
export interface TextDocumentIdentifier {
  uri: string;
}

/** LSP diagnostic severity. */
export type DiagnosticSeverity = 1 | 2 | 3 | 4; // Error | Warning | Information | Hint

/** LSP `Diagnostic` (→ Monaco markers / Problems panel, §3.3). */
export interface LspDiagnostic {
  range: LspRange;
  severity?: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
}

/** LSP `PublishDiagnosticsParams` (the push the renderer turns into markers). */
export interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
}

/** LSP `InitializeParams` (the subset we send). */
export interface InitializeParams {
  processId: number | null;
  rootUri: string | null;
  capabilities: Record<string, unknown>;
  /** server-specific init options (e.g. pyright's pythonPath — §4.1). */
  initializationOptions?: unknown;
  workspaceFolders?: { uri: string; name: string }[] | null;
}

/* ------------------------------------------------------------------------- *
 * Content-Length framing (the riskiest pure bit — encode/decode round-trip)
 * ------------------------------------------------------------------------- */

const CRLF = "\r\n";
const HEADER_SEP = CRLF + CRLF;

/**
 * Encode a JSON-RPC message into an LSP stdio frame:
 *   `Content-Length: <bytes>\r\n\r\n<json>`
 * The length is the UTF-8 BYTE length of the JSON body (not the char length) —
 * the spec is explicit, and a multibyte body (e.g. an emoji in a hover) would
 * desync the stream otherwise. Returns the full frame as a string.
 */
export function encodeMessage(msg: RpcMessage): string {
  const body = JSON.stringify(msg);
  const length = Buffer.byteLength(body, "utf8");
  return `Content-Length: ${length}${HEADER_SEP}${body}`;
}

/** One decoded message plus the number of BYTES it consumed from the buffer. */
export interface DecodedFrame {
  message: RpcMessage;
  /** bytes consumed (header + body), so the caller can slice the buffer. */
  consumed: number;
}

/**
 * Try to decode ONE complete frame from the head of a UTF-8 buffer. Returns the
 * decoded message + consumed byte count, or `null` if the buffer does not yet
 * hold a full frame (the stdio reader keeps appending and re-tries). Throws on a
 * malformed header or non-JSON body (the host surfaces it as a protocol error).
 *
 * This is the inverse of `encodeMessage` and the pair is round-trip tested.
 */
export function decodeMessage(buffer: Buffer): DecodedFrame | null {
  const headerEnd = buffer.indexOf(HEADER_SEP, 0, "utf8");
  if (headerEnd === -1) return null; // headers not fully arrived yet

  const headerText = buffer.toString("utf8", 0, headerEnd);
  const contentLength = parseContentLength(headerText);
  if (contentLength === null) {
    throw new Error("LSP frame: missing or invalid Content-Length header");
  }

  const bodyStart = headerEnd + Buffer.byteLength(HEADER_SEP, "utf8");
  const bodyEnd = bodyStart + contentLength;
  if (buffer.length < bodyEnd) return null; // body not fully arrived yet

  const body = buffer.toString("utf8", bodyStart, bodyEnd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`LSP frame: body is not valid JSON (${(err as Error).message})`);
  }
  return { message: parsed as RpcMessage, consumed: bodyEnd };
}

/** Parse the `Content-Length` value from a raw header block (case-insensitive). */
function parseContentLength(headerText: string): number | null {
  for (const line of headerText.split(CRLF)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    if (key === "content-length") {
      const n = Number(line.slice(idx + 1).trim());
      if (Number.isInteger(n) && n >= 0) return n;
      return null;
    }
  }
  return null;
}

/**
 * A stateful stream decoder: feed it chunks as they arrive on stdout and it
 * yields every COMPLETE message, retaining the partial tail for the next feed.
 * Pure aside from its internal buffer (no I/O) — the host owns the actual stdio.
 */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  /** Append a chunk and return every newly-complete message (in order). */
  feed(chunk: Buffer | string): RpcMessage[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = Buffer.concat([this.buffer, incoming]);
    const out: RpcMessage[] = [];
    for (;;) {
      const frame = decodeMessage(this.buffer);
      if (!frame) break;
      out.push(frame.message);
      this.buffer = this.buffer.subarray(frame.consumed);
    }
    return out;
  }

  /** Bytes still buffered (an unterminated partial frame). */
  pending(): number {
    return this.buffer.length;
  }
}

/* ------------------------------------------------------------------------- *
 * Request routing (pure) — the part the host uses to match responses to requests
 * ------------------------------------------------------------------------- */

/** Make a monotonically-increasing rpc id generator (per-server). */
export function makeIdGenerator(start = 1): () => number {
  let next = start;
  return () => next++;
}

/** Build a JSON-RPC request envelope (pure). */
export function makeRequest(id: RpcId, method: string, params?: unknown): RpcRequest {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

/** Build a JSON-RPC notification envelope (pure). */
export function makeNotification(method: string, params?: unknown): RpcNotification {
  return params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
}

/** A `$/cancelRequest` notification for an in-flight request (file 07 §4.2). */
export function makeCancel(id: RpcId): RpcNotification {
  return makeNotification("$/cancelRequest", { id });
}

/** Type guard: is this message a response (has an id and result/error)? */
export function isResponse(msg: RpcMessage): msg is RpcResponse {
  return "id" in msg && ("result" in msg || "error" in msg);
}

/** Type guard: is this message a server→client notification (method, no id)? */
export function isNotification(msg: RpcMessage): msg is RpcNotification {
  return "method" in msg && !("id" in msg);
}

/** Type guard: is this a server→CLIENT request (has BOTH id AND method — must be answered)?
 *  APP-078: e.g. `workspace/applyEdit`; leaving it unanswered can hang the server. */
export function isServerRequest(msg: RpcMessage): msg is RpcRequest {
  return "id" in msg && "method" in msg;
}

/** Build a JSON-RPC success response to a server request (pure). */
export function makeResponse(id: RpcId, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** Build a JSON-RPC error response (default MethodNotFound -32601) to a server request. */
export function makeErrorResponse(
  id: RpcId,
  code: number = RPC_ERROR.MethodNotFound,
  message = "method not supported by this client",
): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
