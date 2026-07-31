/**
 * dap/protocol.ts — the Debug Adapter Protocol wire TYPES + the DAP stdio framing
 * (file 07 §5).
 *
 * Debug adapters run the SAME shape as language servers: child processes IN THE
 * MAIN PROCESS, speaking DAP over stdio, proxied through `dap-host.ts`. DAP uses
 * the same `Content-Length`-framed envelope as LSP but a DIFFERENT message body
 * (request/response/event, not JSON-RPC). THIS module is the pure part: the body
 * shapes + the framing pair. It spawns nothing — debugpy/js-debug are NOT
 * installed in this env, so the framing + routing is tested as pure functions.
 *
 * Node built-ins only.
 */

/* ------------------------------------------------------------------------- *
 * DAP message bodies (the subset the DebugPanel drives — file 07 §5)
 * ------------------------------------------------------------------------- */

/** Every DAP message carries a monotonic sequence number. */
export interface DapProtocolMessage {
  seq: number;
  type: "request" | "response" | "event";
}

/** A DAP request (client → adapter): launch, setBreakpoints, continue, … */
export interface DapRequest extends DapProtocolMessage {
  type: "request";
  command: string;
  arguments?: unknown;
}

/** A DAP response (adapter → client) to a request. */
export interface DapResponse extends DapProtocolMessage {
  type: "response";
  /** seq of the corresponding request. */
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

/** A DAP event (adapter → client): stopped, output, terminated, … */
export interface DapEvent extends DapProtocolMessage {
  type: "event";
  event: string;
  body?: unknown;
}

/** Any DAP message on the wire. */
export type DapMessage = DapRequest | DapResponse | DapEvent;

/* ------------------------------------------------------------------------- *
 * A subset of DAP request args / event bodies (file 07 §5)
 * ------------------------------------------------------------------------- */

/** A `.vscode/launch.json`-compatible launch configuration (file 07 §5.1). */
export interface DebugConfig {
  type: string; // 'python' | 'node' | 'rust' | …
  request: "launch" | "attach";
  name: string;
  /** resolved interpreter (e.g. `${venv:interpreter}` → file 04). */
  python?: string;
  program?: string;
  module?: string;
  args?: string[];
  console?: "internalConsole" | "integratedTerminal" | "externalTerminal";
  runtimeArgs?: string[];
  /** workspace folder substitution target. */
  cwd?: string;
  /**
   * Remote/attach target (APP-080): a `request: "attach"` config that carries a
   * `connect` opens a TCP socket to `host:port` and speaks framed DAP over it
   * instead of spawning a local adapter. This is debugpy's client-mode attach
   * argument shape (`{ connect: { host, port } }`) — passed to the adapter VERBATIM.
   */
  connect?: { host: string; port: number };
}

/**
 * One `SourceBreakpoint` (DAP): a 1-based line plus optional adapter-evaluated
 * predicates. `condition` gates the stop on a boolean expression; `hitCondition`
 * is a STRING expression on the hit count (`">5"`, `"==3"`, `"%2"`, or a bare
 * `"5"` = "on the 5th hit" — NEVER coerced to a number); `logMessage` turns the
 * breakpoint into a LOGPOINT (log `{expr}`-interpolated text, never pause). All
 * three are user data passed through to the adapter VERBATIM (no argv/eval here).
 */
export interface SourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** `setBreakpoints` arguments (REPLACE-ALL per source: the FULL list every send). */
export interface SetBreakpointsArguments {
  source: { path: string };
  breakpoints: SourceBreakpoint[];
  sourceModified?: boolean;
}

/** One adapter `exceptionBreakpointFilters` entry (from the initialize capabilities). */
export interface ExceptionBreakpointsFilter {
  filter: string;
  label: string;
  description?: string;
  default?: boolean;
  supportsCondition?: boolean;
}

/** `setExceptionBreakpoints` arguments. `filters` are filter IDs; `{ filters: [] }`
 *  CLEARS all (omitting the request leaves the adapter's prior filters active). */
export interface SetExceptionBreakpointsArguments {
  filters: string[];
  filterOptions?: { filterId: string; condition?: string }[];
}

/**
 * The subset of the DAP `initialize` response `Capabilities` the debugger surface
 * gates on. The response `body` of an `initialize` request IS this object (there is
 * no nesting). Every field is optional — an adapter that omits one means "false".
 */
export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsLogPoints?: boolean;
  supportsExceptionFilterOptions?: boolean;
  /** the adapter honours `setVariable` (edit a paused variable's value, APP-080). */
  supportsSetVariable?: boolean;
  exceptionBreakpointFilters?: ExceptionBreakpointsFilter[];
}

/** A `stopped` event body (the debugger paused). */
export interface StoppedEventBody {
  reason: string; // 'breakpoint' | 'step' | 'exception' | …
  threadId?: number;
  description?: string;
}

/** An `output` event body (debug console line). */
export interface OutputEventBody {
  category?: "console" | "stdout" | "stderr" | "important";
  output: string;
}

/* ------------------------------------------------------------------------- *
 * Framing — DAP uses the SAME Content-Length envelope as LSP
 * ------------------------------------------------------------------------- */

const CRLF = "\r\n";
const HEADER_SEP = CRLF + CRLF;

/** Encode a DAP message into a `Content-Length`-framed stdio frame (UTF-8 bytes). */
export function encodeDapMessage(msg: DapMessage): string {
  const body = JSON.stringify(msg);
  const length = Buffer.byteLength(body, "utf8");
  return `Content-Length: ${length}${HEADER_SEP}${body}`;
}

/** One decoded DAP message + the bytes it consumed. */
export interface DecodedDapFrame {
  message: DapMessage;
  consumed: number;
}

/**
 * Decode ONE complete DAP frame from the head of a UTF-8 buffer, or `null` if the
 * buffer does not yet hold a full frame. Throws on a malformed header / non-JSON
 * body. The byte-length discipline matches LSP (§ protocol.ts) so a multibyte
 * `output` line cannot desync the adapter stream.
 */
export function decodeDapMessage(buffer: Buffer): DecodedDapFrame | null {
  const headerEnd = buffer.indexOf(HEADER_SEP, 0, "utf8");
  if (headerEnd === -1) return null;

  const headerText = buffer.toString("utf8", 0, headerEnd);
  const contentLength = parseContentLength(headerText);
  if (contentLength === null) {
    throw new Error("DAP frame: missing or invalid Content-Length header");
  }

  const bodyStart = headerEnd + Buffer.byteLength(HEADER_SEP, "utf8");
  const bodyEnd = bodyStart + contentLength;
  if (buffer.length < bodyEnd) return null;

  const body = buffer.toString("utf8", bodyStart, bodyEnd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`DAP frame: body is not valid JSON (${(err as Error).message})`);
  }
  return { message: parsed as DapMessage, consumed: bodyEnd };
}

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

/** A stateful DAP stream decoder (same shape as the LSP MessageReader). */
export class DapMessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer | string): DapMessage[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = Buffer.concat([this.buffer, incoming]);
    const out: DapMessage[] = [];
    for (;;) {
      const frame = decodeDapMessage(this.buffer);
      if (!frame) break;
      out.push(frame.message);
      this.buffer = this.buffer.subarray(frame.consumed);
    }
    return out;
  }

  pending(): number {
    return this.buffer.length;
  }
}

/* ------------------------------------------------------------------------- *
 * Message builders + a seq generator (pure)
 * ------------------------------------------------------------------------- */

/** A monotonic seq generator (one per debug session). */
export function makeSeqGenerator(start = 1): () => number {
  let next = start;
  return () => next++;
}

/** Build a DAP request envelope (pure). */
export function makeDapRequest(seq: number, command: string, args?: unknown): DapRequest {
  return args === undefined
    ? { seq, type: "request", command }
    : { seq, type: "request", command, arguments: args };
}

/** Type guard: is this a DAP event? */
export function isDapEvent(msg: DapMessage): msg is DapEvent {
  return msg.type === "event";
}

/** Type guard: is this a DAP response? */
export function isDapResponse(msg: DapMessage): msg is DapResponse {
  return msg.type === "response";
}
