// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/relay-protocol.ts — the prom-msg wire frame + target resolution (pure).
 *
 * Agents emit inter-agent messages by running `prom-msg <to> "<text>"`, which writes ONE
 * NDJSON frame `{from,to,content}\n` to the relay's UNIX socket (from = $PROM_AGENT, never
 * a forgeable arg). The relay parses + resolves the raw `to` (a teammate name, an
 * orchestrator/broadcast alias, or `done`) into a real bus address + MessageKind, using
 * the run topology. PURE: text/frame in, resolved message out — the socket IO lives in
 * bus-relay.ts. The verb→address mapping mirrors core protocol.ts so internal + external
 * comms agree.
 */
import type { orchestration } from "@prometheus/core";

type MessageKind = orchestration.MessageKind;

/** A raw frame as written by prom-msg (before topology resolution). */
export interface RawFrame {
  from: string;
  to: string;
  content: string;
}

/** Aliases that mean "report up to whoever I report to". */
const REPORT_TARGETS = new Set(["parent", "orchestrator", "up", "lead", "boss"]);
/** Aliases that mean "everyone". */
const BROADCAST_TARGETS = new Set(["all", "broadcast", "everyone", "team", "swarm"]);

const MAX_FRAME = 1024 * 1024; // 1MB guard

/** Parse + validate one NDJSON line into a RawFrame, or null (bad/oversized/missing fields). */
export function parseFrame(line: string): RawFrame | null {
  if (line.length > MAX_FRAME) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const f = obj as Record<string, unknown>;
  if (typeof f.from !== "string" || typeof f.to !== "string" || typeof f.content !== "string")
    return null;
  if (f.from === "" || f.to === "") return null;
  return { from: f.from, to: f.to, content: f.content };
}

export interface ResolveCtx {
  orchestrator: string;
  /** the parent of an agent (undefined for the orchestrator). */
  parentOf: (name: string) => string | undefined;
}

export interface ResolvedMessage {
  from: string;
  to: string;
  kind: MessageKind;
  content: string;
}

/**
 * Resolve a raw frame against the topology:
 *   "done"                       → the sender's result, addressed to its parent (or "user"
 *                                  when the orchestrator finishes the whole run);
 *   parent/orchestrator/up/…     → a msg to the sender's parent (orchestrator);
 *   all/broadcast/everyone/…     → a broadcast msg;
 *   a "Q: …" content             → a question;
 *   else (a teammate name)       → a msg to that agent.
 */
export function resolveFrame(frame: RawFrame, ctx: ResolveCtx): ResolvedMessage {
  const raw = frame.to.toLowerCase();
  const parent = ctx.parentOf(frame.from);

  if (raw === "done") {
    return { from: frame.from, to: parent ?? "user", kind: "result", content: frame.content };
  }
  if (REPORT_TARGETS.has(raw)) {
    return {
      from: frame.from,
      to: parent ?? ctx.orchestrator,
      kind: "msg",
      content: frame.content,
    };
  }
  if (BROADCAST_TARGETS.has(raw)) {
    return { from: frame.from, to: "broadcast", kind: "msg", content: frame.content };
  }
  const kind: MessageKind = /^\s*q:/i.test(frame.content) ? "question" : "msg";
  return { from: frame.from, to: frame.to, kind, content: frame.content };
}

/** Format a bus message for delivery into an agent's input line. */
export function formatForDelivery(from: string, content: string, broadcast = false): string {
  return `[from ${from}]${broadcast ? " (broadcast)" : ""} ${content}`;
}
