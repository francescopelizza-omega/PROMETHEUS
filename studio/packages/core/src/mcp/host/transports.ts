/**
 * mcp/host/transports.ts — the MCP client transport seam (file 09 §2.2 / Open Q).
 *
 * `@modelcontextprotocol/sdk` is NOT a studio dependency here, so core defines the
 * transport INTERFACE only; the real SDK-backed client (stdio subprocess /
 * streamable-http) is constructed in the Electron main process and injected as a
 * `TransportFactory` (the same injected-backend pattern as engine-bridge's pty
 * host). `FakeTransport` lets the manager + tests run with no SDK, no subprocess.
 */
import type { McpServerConfig, McpToolDescriptor } from "./types.js";

/* ── remote (streamable-HTTP) transport validation (APP-095) ─────────────────── *
 * A remote MCP URL is a fresh SSRF surface: the desktop main process MUST run this pure
 * gate on every renderer-supplied config BEFORE any network I/O (and re-run it on each
 * redirect hop). Fail-closed: https OR http-on-localhost ONLY, never a private/link-local
 * range (cloud metadata at 169.254.169.254, RFC1918), and a header-NAME allowlist so a
 * config can't smuggle `Host`/`Content-Length`/framing overrides. Pure (no fetch/net). */

export interface RemoteTransportValidation {
  ok: boolean;
  error?: string;
}

/** The explicit loopback hosts plain-http is allowed to reach (a local dev MCP server). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** Request/entity headers a client must never let a config override (framing / routing). */
const BLOCKED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "upgrade",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
]);

const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

/**
 * True when `host` is a private / link-local / loopback address (RFC1918, 127/8, ::1,
 * fc00::/7, 169.254/16, IPv4-mapped). Used to BLOCK a redirect/URL that would reach an
 * internal service (SSRF) — the loopback allow is handled separately by the caller.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost")) return true;
  // IPv6 unspecified (:: / all-zero groups).
  if (h === "::" || /^0*(:0*)+$/.test(h)) return true;
  // IPv6 unique-local (fc00::/7) + link-local (fe80::/10).
  if (
    h.includes(":") &&
    (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9"))
  ) {
    return true;
  }
  // Resolve the address to a dotted-quad IPv4 if it is one, an IPv4-mapped IPv6, OR the
  // IPv4-mapped IPv6 in its HEX serialization (`::ffff:a00:1`) — which is exactly how WHATWG
  // `new URL()` renders a mapped address, and what the previous dotted-only regex missed (SSRF).
  let ipv4: string | null = null;
  const mappedDec = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedDec) {
    ipv4 = mappedDec[1]!;
  } else if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    const lo = Number.parseInt(mappedHex[2]!, 16);
    ipv4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  } else if (!h.includes(":")) {
    ipv4 = h;
  }
  // An unclassified IPv6 literal (global-unicast) is left for the caller — blocking every v6
  // would refuse legitimate public v6 servers; DNS-rebind is out of scope here.
  if (ipv4 === null) return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  return false;
}

/**
 * Validate a remote (http/streamable-http) MCP transport config — fail-closed (APP-095).
 * `t` is a plain transport-config shape (kind + url + headers). Accepts ONLY https to a
 * non-private host, or http to an explicit loopback; rejects malformed URLs, private/
 * link-local ranges, and non-allowlisted / bad header names.
 */
export function validateRemoteTransport(t: {
  kind: string;
  url?: string;
  headers?: Record<string, string>;
}): RemoteTransportValidation {
  if (t.kind !== "http") return { ok: false, error: `not a remote transport: "${t.kind}"` };
  if (!t.url) return { ok: false, error: "a remote server needs a url" };
  let u: URL;
  try {
    u = new URL(t.url);
  } catch {
    return { ok: false, error: "malformed url" };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = LOOPBACK_HOSTS.has(host);
  if (u.protocol === "https:") {
    if (isPrivateHost(host) && !loopback) {
      return { ok: false, error: "url resolves to a private/link-local address (SSRF blocked)" };
    }
  } else if (u.protocol === "http:") {
    if (!loopback)
      return { ok: false, error: "plain http is only allowed on localhost — use https" };
  } else {
    return { ok: false, error: `unsupported scheme "${u.protocol}" (use https)` };
  }
  for (const name of Object.keys(t.headers ?? {})) {
    if (!HEADER_NAME_RE.test(name)) return { ok: false, error: `invalid header name: "${name}"` };
    if (BLOCKED_HEADERS.has(name.toLowerCase())) {
      return { ok: false, error: `header not allowed: "${name}"` };
    }
  }
  return { ok: true };
}

/**
 * A typed transport-layer failure (CLI-037). The `kind` lets a caller distinguish a
 * timeout/abort from an HTTP status error from a malformed-protocol reply — never a bare
 * string, so `mcp test` can render a precise reason and tests can assert the class.
 */
export class McpTransportError extends Error {
  readonly kind: "timeout" | "http" | "protocol";
  constructor(kind: "timeout" | "http" | "protocol", message: string) {
    super(message);
    this.name = "McpTransportError";
    this.kind = kind;
  }
}

/** The result of an MCP tools/call (content is opaque; isError mirrors the SDK). */
export interface McpToolCallResult {
  content: unknown;
  isError?: boolean;
}

/** The minimal MCP client surface the host manager drives (SDK-agnostic). */
export interface McpClientTransport {
  connect(): Promise<void>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
  close(): Promise<void>;
  /**
   * Has the far side GONE — the child exited, the socket closed?
   *
   * Optional so a transport with no notion of dying (the fake, an in-process one) simply
   * omits it. Without it the manager had no way to learn that a server had crashed: the
   * transport failed its in-flight requests and said nothing else, so `health` stayed
   * `"ready"` forever. The tools kept being advertised, the model kept calling them, and
   * every call came back as a transport error the user could not connect to "that server
   * died four turns ago".
   */
  isDead?(): boolean;
}

/** Build a transport for a server config (the real one wraps the MCP SDK Client). */
export type TransportFactory = (cfg: McpServerConfig) => McpClientTransport;

/** Options to script a FakeTransport's behaviour in tests. */
export interface FakeTransportOptions {
  tools?: McpToolDescriptor[];
  result?: McpToolCallResult;
  failConnect?: boolean;
}

/** A no-subprocess transport for the manager's tests (mirrors pty-host's fake backend). */
export class FakeTransport implements McpClientTransport {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  connected = false;
  closed = false;
  /** flip to simulate the far side dying between calls (the crashed-server case). */
  dead = false;
  private readonly opts: FakeTransportOptions;

  constructor(opts: FakeTransportOptions = {}) {
    this.opts = opts;
  }

  isDead(): boolean {
    return this.dead;
  }

  async connect(): Promise<void> {
    if (this.opts.failConnect) throw new Error("FakeTransport: connect failed");
    this.connected = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return this.opts.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    this.calls.push({ name, args });
    return this.opts.result ?? { content: { ok: true } };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
  }
}
