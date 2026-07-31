/**
 * orchestration/bus-relay.ts — the UNIX-socket front-end over the in-RAM MessageBus.
 *
 * Agents (interactive CLIs in tmux windows) emit inter-agent messages by running the
 * `prom-msg` helper, which writes ONE NDJSON frame `{from,to,content}\n` to this socket.
 * The relay parses + resolves it against the topology (relay-protocol.ts) and posts it to
 * the SHARED in-RAM MessageBus (core bus.ts — which assigns the id/ts, notifies
 * subscribers, and serializes to JSONL). It then ACKs `{ok,id,ts}\n` so the agent learns
 * the bus id. The bus is the single source of truth — this is a thin socket adaptor, not a
 * second bus. node:net is loaded lazily via createRequire (engine-bridge's C5 boundary).
 */
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import type { orchestration } from "@prometheus/core";

import { type ResolveCtx, parseFrame, resolveFrame } from "./relay-protocol.js";

const nodeRequire = createRequire(import.meta.url);

type MessageBus = orchestration.MessageBus;

/** The minimal node:net surface we drive (avoids a static node:net import). */
interface NetSocket {
  on(ev: "data", cb: (d: Buffer) => void): void;
  on(ev: "error" | "close", cb: () => void): void;
  write(s: string): void;
}
interface NetServer {
  listen(path: string, cb: () => void): void;
  on(ev: "error", cb: (e: unknown) => void): void;
  close(cb?: () => void): void;
}
type NetModule = { createServer(cb: (sock: NetSocket) => void): NetServer };

export interface BusRelayDeps {
  bus: MessageBus;
  sockPath: string;
  /** orchestrator name + parentOf, to resolve `done`/`parent`/`broadcast`. */
  resolve: ResolveCtx;
  onError?: (msg: string) => void;
}

export interface BusRelayHandle {
  sockPath: string;
  close(): void;
}

const MAX_LINE = 1024 * 1024;

/**
 * Start the socket relay. Returns a handle to stop it. Crash-proof: a bad frame is ACKed
 * with an error (never throws into the loop), and an abruptly-closed writer can't take the
 * relay down (every connection swallows its own errors).
 */
export function startBusRelay(deps: BusRelayDeps): BusRelayHandle {
  const net = nodeRequire("node:net") as NetModule;
  const { sockPath } = deps;

  mkdirSync(dirname(sockPath), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(sockPath); // clear a stale socket from a crashed prior run (else EADDRINUSE)
  } catch {
    /* ENOENT is fine */
  }

  const server = net.createServer((sock: NetSocket) => {
    let buf = "";
    sock.on("error", () => {}); // an abrupt writer must never crash the relay
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.length > MAX_LINE && !buf.includes("\n")) {
        buf = "";
        try {
          sock.write('{"ok":false,"err":"frame too large"}\n');
        } catch {
          /* gone */
        }
        return;
      }
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line, sock, deps);
        nl = buf.indexOf("\n");
      }
    });
  });

  server.on("error", (e) =>
    deps.onError?.(`bus relay: ${e instanceof Error ? e.message : String(e)}`),
  );
  server.listen(sockPath, () => {
    try {
      chmodSync(sockPath, 0o600); // owner-only (the unix-socket fs perms ARE the authn)
    } catch {
      /* best-effort */
    }
  });

  return {
    sockPath,
    close() {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(sockPath);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Parse → resolve → post one NDJSON line; ACK the result. */
function handleLine(line: string, sock: NetSocket, deps: BusRelayDeps): void {
  if (line.trim() === "") return;
  const frame = parseFrame(line);
  if (!frame) {
    safeWrite(sock, '{"ok":false,"err":"bad frame"}\n');
    return;
  }
  try {
    const resolved = resolveFrame(frame, deps.resolve);
    const posted = deps.bus.post({
      from: resolved.from,
      to: resolved.to,
      kind: resolved.kind,
      content: resolved.content,
    });
    safeWrite(sock, `${JSON.stringify({ ok: true, id: posted.id, ts: posted.ts })}\n`);
  } catch (e) {
    deps.onError?.(`bus relay post: ${e instanceof Error ? e.message : String(e)}`);
    safeWrite(sock, '{"ok":false,"err":"post failed"}\n');
  }
}

function safeWrite(sock: NetSocket, s: string): void {
  try {
    sock.write(s);
  } catch {
    /* writer gone */
  }
}
