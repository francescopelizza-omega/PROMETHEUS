// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * mcp/host/http-transport.ts — the streamable-HTTP MCP client transport (CLI-037 core lift).
 *
 * Lifted from the audited desktop `main/mcp/transport.ts` (APP-095) so the CLI and desktop
 * share ONE implementation, then hardened per CLI-037: an injected `fetch` (default
 * `globalThis.fetch`) for testability, a `timeoutMs` override, keychain-backed bearer auth
 * resolved through an injected secrets seam (the token never touches disk config or a log),
 * and a typed `McpTransportError{kind}` on every failure (never a bare string, never a hang).
 *
 * The 2025-03 "Streamable HTTP" transport: the client POSTs JSON-RPC to ONE endpoint and the
 * server replies either `application/json` OR upgrades the SAME response to an SSE
 * `text/event-stream`; so every POST carries `Accept: application/json, text/event-stream`.
 * The `initialize` reply returns `Mcp-Session-Id`, echoed on every later request; a `DELETE`
 * ends the session. SSRF: `validateRemoteTransport` gates the URL BEFORE any I/O and re-runs
 * on each manual redirect hop, and a cross-origin hop drops the auth headers + session id so a
 * 302 to a private/metadata address never ships a bearer token. No new npm deps — global fetch.
 *
 * PURE over `fetch`: no `node:` import here, so it is renderer-import-safe; the combined
 * stdio+http `createMcpTransportFactory` (which pulls the Node-only stdio child) lives in the
 * `node.ts` barrel, consumed via the `@prometheus/core/mcp-node` subpath.
 */
import {
  type McpClientTransport,
  type McpToolCallResult,
  McpTransportError,
} from "./transports.js";
import { validateRemoteTransport } from "./transports.js";
import type { McpServerConfig, McpToolDescriptor } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
/** The current streamable-HTTP protocol version echoed on every request. */
const HTTP_PROTOCOL_VERSION = "2025-06-18";

/** The `fetch` seam (default `globalThis.fetch`; tests inject a stub / point at a fake server). */
export type FetchLike = typeof fetch;

export interface HttpTransportDeps {
  /** The fetch implementation (default `globalThis.fetch`). */
  fetch?: FetchLike;
  /** Resolve a keychain secret REF → its value (the bearer token), or undefined if unset. */
  resolveAuth?: (ref: string) => Promise<string | undefined>;
}

interface HttpTransportConfig {
  kind: "http";
  url: string;
  headers?: Record<string, string>;
  authSecretRef?: string;
  timeoutMs?: number;
}

/** A single streamable-HTTP MCP client connection (SDK-agnostic; drives one endpoint). */
export class StreamableHttpTransport implements McpClientTransport {
  private readonly cfg: McpServerConfig;
  private readonly fetchImpl: FetchLike;
  private readonly resolveAuth: ((ref: string) => Promise<string | undefined>) | undefined;
  private readonly timeoutMs: number;
  private nextId = 1;
  private sessionId: string | null = null;
  /** The resolved `Authorization` header value; kept only in memory, never persisted/logged. */
  private authHeader: string | null = null;
  private closed = false;
  /** In-flight request aborters so `close()` can tear down a pending POST / SSE read. */
  private readonly inflight = new Set<AbortController>();

  constructor(cfg: McpServerConfig, deps: HttpTransportDeps = {}) {
    this.cfg = cfg;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.resolveAuth = deps.resolveAuth;
    const t = cfg.transport;
    this.timeoutMs =
      t.kind === "http" && t.timeoutMs && t.timeoutMs > 0 ? t.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  private http(): HttpTransportConfig {
    const t = this.cfg.transport;
    if (t.kind !== "http")
      throw new McpTransportError("protocol", `not an http transport: "${t.kind}"`);
    return t;
  }

  async connect(): Promise<void> {
    const t = this.http();
    // fail-closed SSRF/header/scheme gate BEFORE any network I/O.
    const v = validateRemoteTransport(t);
    if (!v.ok) throw new McpTransportError("protocol", v.error ?? "invalid remote transport");
    // resolve the bearer token (if any) through the injected secrets seam — the raw value
    // is held only on `this.authHeader`, never written to config or surfaced in a log/list.
    if (t.authSecretRef && this.resolveAuth) {
      const secret = await this.resolveAuth(t.authSecretRef);
      if (secret) this.authHeader = `Bearer ${secret}`;
    }
    await this.rpc(
      "initialize",
      {
        protocolVersion: HTTP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "prometheus", version: "0.0.0" },
      },
      true,
    );
    await this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const r = (await this.rpc("tools/list", {})) as { tools?: unknown };
    const tools = Array.isArray(r?.tools) ? r.tools : [];
    return tools.map((raw): McpToolDescriptor => {
      const t = (raw ?? {}) as Record<string, unknown>;
      return {
        name: String(t.name ?? ""),
        ...(typeof t.title === "string" ? { title: t.title } : {}),
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        inputSchema: t.inputSchema,
        ...(t.annotations && typeof t.annotations === "object"
          ? { annotations: t.annotations as McpToolDescriptor["annotations"] }
          : {}),
      };
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const r = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: unknown;
      isError?: unknown;
    };
    return { content: r?.content, isError: r?.isError === true };
  }

  async close(): Promise<void> {
    this.closed = true;
    // abort any in-flight POST / SSE read so no socket keeps the event loop alive.
    for (const ac of this.inflight) ac.abort();
    this.inflight.clear();
    if (!this.sessionId) return;
    const t = this.http();
    try {
      await this.fetchImpl(t.url, {
        method: "DELETE",
        headers: this.headers(false),
        redirect: "manual",
      });
    } catch {
      /* best-effort session teardown */
    }
    this.sessionId = null;
  }

  /** Request headers: allow-listed config headers + Accept + protocol + session + bearer.
   *  `dropAuth` (a cross-origin redirect target) omits the config auth headers, bearer, and
   *  session id so a token is never leaked to a host other than the configured origin. */
  private headers(withBody: boolean, dropAuth = false): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": HTTP_PROTOCOL_VERSION,
      ...(dropAuth ? {} : (this.http().headers ?? {})),
    };
    if (withBody) h["Content-Type"] = "application/json";
    if (this.sessionId && !dropAuth) h["Mcp-Session-Id"] = this.sessionId;
    if (this.authHeader && !dropAuth) h.Authorization = this.authHeader;
    return h;
  }

  /** Send one JSON-RPC request, follow one manual redirect (re-validated), read the reply
   *  (JSON or SSE), and return its `result` (throws typed on a JSON-RPC error / non-2xx). */
  private async rpc(method: string, params: unknown, capture = false): Promise<unknown> {
    if (this.closed) throw new McpTransportError("protocol", "MCP transport closed");
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const res = await this.post(this.http().url, body, 0);
    if (capture) {
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
    }
    if (res.status === 404)
      throw new McpTransportError("protocol", `MCP session expired (${method} → 404)`);
    if (!res.ok) throw new McpTransportError("http", `MCP ${method} → HTTP ${res.status}`);
    const msg = await this.withReadDeadline(res, () => this.readResponse(res, id));
    if (msg?.error) throw new McpTransportError("protocol", msg.error.message ?? "MCP error");
    return msg?.result;
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return;
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    try {
      const res = await this.post(this.http().url, body, 0);
      await res.text().catch(() => ""); // drain the (usually empty 202) body so the socket frees
    } catch {
      /* a notification failing is non-fatal */
    }
  }

  /** POST with a wall-clock timeout + MANUAL redirect handling (each hop re-validated). Once a
   *  redirect leaves the original origin, auth headers + session id are dropped (mirroring
   *  fetch's cross-origin Authorization stripping). A timeout rejects `McpTransportError`(timeout). */
  private async post(
    url: string,
    body: string,
    hop: number,
    origin: string = new URL(url).origin,
  ): Promise<Response> {
    if (hop > 3) throw new McpTransportError("http", "too many redirects");
    const crossOrigin = new URL(url).origin !== origin;
    const ac = new AbortController();
    this.inflight.add(ac);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers(true, crossOrigin),
        body,
        redirect: "manual",
        signal: ac.signal,
      });
    } catch (e) {
      if (timedOut)
        throw new McpTransportError("timeout", `MCP request timed out after ${this.timeoutMs}ms`);
      if (this.closed) throw new McpTransportError("protocol", "MCP transport closed");
      throw new McpTransportError("http", e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      this.inflight.delete(ac);
    }
    // a 3xx: re-validate the redirect target through the SAME SSRF gate before following.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      const next = new URL(loc, url).toString();
      const v = validateRemoteTransport({ kind: "http", url: next });
      if (!v.ok) throw new McpTransportError("protocol", `redirect blocked: ${v.error}`);
      await res.body?.cancel().catch(() => {});
      return this.post(next, body, hop + 1, origin);
    }
    return res;
  }

  /**
   * Apply the transport's timeout to READING the response body, not just to receiving headers.
   *
   * `post`'s AbortController is cleared in its own `finally`, the moment `fetch` resolves — and
   * for `text/event-stream` that is only the HEADERS. The body is read afterwards, by `readSse`,
   * under no deadline whatsoever: a server that answers `tools/list` with an SSE content-type,
   * writes a `notifications/progress` event, and then simply holds the stream open left
   * `listTools()` awaiting forever. `timeoutMs` was configured, obeyed for the handshake, and
   * silently absent for the part that actually stalls.
   *
   * Cancelling the body is what unwinds the pending `reader.read()`, so the loop exits instead
   * of leaking a reader on a socket nobody is draining.
   */
  private async withReadDeadline<T>(res: Response, read: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        void res.body?.cancel().catch(() => {});
        reject(
          new McpTransportError("timeout", `MCP response body timed out after ${this.timeoutMs}ms`),
        );
      }, this.timeoutMs);
      // never hold the process open on this timer alone
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    });
    try {
      return await Promise.race([read(), deadline]);
    } catch (e) {
      // a body cancelled BY the deadline surfaces as the timeout, not as a torn-stream error
      if (timedOut && !(e instanceof McpTransportError)) {
        throw new McpTransportError(
          "timeout",
          `MCP response body timed out after ${this.timeoutMs}ms`,
        );
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Read a JSON or SSE response and return the JSON-RPC message whose `id` matches. */
  private async readResponse(
    res: Response,
    id: number,
  ): Promise<{ id?: unknown; result?: unknown; error?: { message?: string } } | null> {
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("text/event-stream") && res.body) {
      return this.readSse(res.body, id);
    }
    const text = await res.text();
    if (!text.trim()) return null; // an accepted notification / empty body
    let msg: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      throw new McpTransportError("protocol", "malformed JSON-RPC response body");
    }
    /**
     * The SAME two checks the SSE path does, and for the same reason — this branch had neither.
     *
     * A body carrying `method` is a server request, not our answer: returning it made `rpc()`
     * read `undefined` off it and `listTools()` turn that into `[]`, i.e. a server that connects,
     * reports healthy and offers no tools. And with no id check at all, a reply for a DIFFERENT
     * id was accepted as ours. Both are refused loudly rather than silently mis-read: an empty
     * tool list is indistinguishable from a server that genuinely has none.
     */
    if (typeof msg.method === "string") {
      throw new McpTransportError("protocol", `expected a response, got a "${msg.method}" request`);
    }
    if (typeof msg.id === "number" && msg.id !== id) {
      throw new McpTransportError("protocol", `response id ${msg.id} does not match request ${id}`);
    }
    return msg;
  }

  /** Parse an SSE stream (WHATWG ReadableStream), buffering across reads, and return the first
   *  `data:` JSON message whose `id` matches. `:`-comments / keepalives / other ids are ignored. */
  private async readSse(
    stream: ReadableStream<Uint8Array>,
    id: number,
  ): Promise<{ id?: unknown; result?: unknown; error?: { message?: string } } | null> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        // an event ends at a blank line; SSE permits LF / CRLF / CR terminators. A chunk can
        // split MID-event, so we buffer until a boundary appears.
        let m = /\r\n\r\n|\r\r|\n\n/.exec(buf);
        while (m) {
          const raw = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          const data = raw
            .split(/\r\n|\r|\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, "")) // strip a single leading space after `data:`
            .join("\n");
          if (data) {
            let msg: {
              id?: unknown;
              method?: unknown;
              result?: unknown;
              error?: { message?: string };
            };
            try {
              msg = JSON.parse(data);
            } catch {
              throw new McpTransportError("protocol", "malformed SSE JSON-RPC data");
            }
            /**
             * A message carrying `method` is a server REQUEST or notification, never our
             * response — and a server numbers ids from its own counter, so one can collide with
             * the id we are waiting on. Returning it would hand `callTool` a request object
             * whose `content` is undefined: a silent empty result rather than an error.
             *
             * The skip is a NO-OP here rather than a `continue`, deliberately. `continue` jumps
             * to `while (m)` WITHOUT re-running the exec below, so the next iteration slices the
             * already-advanced buffer at a stale offset and cuts the following event mid-token —
             * turning an ordinary "notification then result in one flush" into a
             * `malformed SSE JSON-RPC data` throw. Progress notifications followed by a result
             * on the same POST stream is the standard long-running-tool shape, so that was a
             * coin flip on TCP segment boundaries.
             */
            if (typeof msg.method !== "string" && typeof msg.id === "number" && msg.id === id) {
              return msg;
            }
          }
          m = /\r\n\r\n|\r\r|\n\n/.exec(buf);
        }
        if (done) return null;
      }
    } finally {
      reader.releaseLock();
      await stream.cancel().catch(() => {});
    }
  }
}

/** An http-only TransportFactory (tests / callers that only speak streamable-HTTP). */
export function createHttpTransportFactory(
  deps: HttpTransportDeps = {},
): (cfg: McpServerConfig) => McpClientTransport {
  return (cfg: McpServerConfig): McpClientTransport => new StreamableHttpTransport(cfg, deps);
}
