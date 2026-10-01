// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import type { ToolCapabilityState } from "../agent/protocol/negotiate.js";
/**
 * ai/model-health.ts — turn the capability/breaker/context-window state this repo already
 * measures into something a human can actually see.
 *
 * `ToolCapabilityState` (negotiate.ts), `BreakerSnapshot` (resilience/circuitBreaker.ts) and
 * `ContextWindowResult` (context-window.ts) each carry real, hard-won information about an
 * endpoint — whether it can function-call, whether it's currently failing fast, whether its
 * real context window was ever actually measured — but none of it reached the user. This module
 * is the pure merge: given one turn's worth of that state, produce a single, storable,
 * displayable `EndpointHealthRecord`.
 *
 * PURE: no node, no fetch, no clock of its own (the caller supplies `nowIso`/`nowMs`, so the
 * "healthy vs open vs recovering" wording and the store's on-disk shape are both deterministic
 * and testable).
 */
import type { BreakerSnapshot, BreakerState } from "../resilience/circuitBreaker.js";

/** Which transport this endpoint is CURRENTLY being driven through. */
export type TransportMode = "native" | "text";

/** Where the context-window number came from — mirrors `ContextWindowSource`, plus "declared"
 *  for a cloud endpoint (or a local one never probed), which is never measured, only stated. */
export type ContextWindowOrigin =
  | "ollama"
  | "ollama-loaded"
  | "openai-models"
  | "default"
  | "declared";

/** One endpoint's health, as of the last turn that touched it. */
export interface EndpointHealthRecord {
  endpointId: string;
  model: string;
  locality: "local" | "cloud";
  transport: TransportMode;
  /** has this endpoint PROVEN — at least once — that it can produce a call on `transport`? */
  demonstrated: boolean;
  nativeCalls: number;
  textCallsWhileNative: number;
  textSyntaxCalls: number;
  nativeRejected: boolean;
  breakerState: BreakerState;
  breakerFailures: number;
  /** ms epoch the breaker last tripped open, or null if it never has. */
  breakerOpenedAt: number | null;
  contextWindow: number;
  contextWindowSource: ContextWindowOrigin;
  /** ISO timestamp of the turn that produced this record. */
  lastUsedIso: string;
}

/** Keyed by `endpointId` — the on-disk/IPC shape both the CLI's and the desktop's stores use. */
export type ModelHealthStore = Record<string, EndpointHealthRecord>;

/** A breaker snapshot placeholder for an endpoint that has never gone through a breaker at all
 *  (e.g. this turn's transport didn't consult one) — reads as healthy, because nothing has ever
 *  failed on it. */
export const NO_BREAKER_SNAPSHOT: BreakerSnapshot = {
  state: "closed",
  failures: 0,
  openedAt: null,
};

/** Assemble one endpoint's health record from this turn's state. */
export function buildHealthRecord(input: {
  endpointId: string;
  model: string;
  locality: "local" | "cloud";
  transport: TransportMode;
  capability: ToolCapabilityState;
  breaker?: BreakerSnapshot;
  contextWindow: number;
  contextWindowSource: ContextWindowOrigin;
  nowIso: string;
}): EndpointHealthRecord {
  const breaker = input.breaker ?? NO_BREAKER_SNAPSHOT;
  const demonstrated =
    input.transport === "native"
      ? input.capability.nativeCalls > 0
      : input.capability.textSyntaxCalls > 0;
  return {
    endpointId: input.endpointId,
    model: input.model,
    locality: input.locality,
    transport: input.transport,
    demonstrated,
    nativeCalls: input.capability.nativeCalls,
    textCallsWhileNative: input.capability.textCallsWhileNative,
    textSyntaxCalls: input.capability.textSyntaxCalls,
    nativeRejected: input.capability.nativeRejected,
    breakerState: breaker.state,
    breakerFailures: breaker.failures,
    breakerOpenedAt: breaker.openedAt,
    contextWindow: input.contextWindow,
    contextWindowSource: input.contextWindowSource,
    lastUsedIso: input.nowIso,
  };
}

const BREAKER_STATES: ReadonlySet<string> = new Set(["closed", "open", "half-open"]);
const TRANSPORT_MODES: ReadonlySet<string> = new Set(["native", "text"]);
const LOCALITIES: ReadonlySet<string> = new Set(["local", "cloud"]);
const CONTEXT_WINDOW_ORIGINS: ReadonlySet<string> = new Set([
  "ollama",
  "ollama-loaded",
  "openai-models",
  "default",
  "declared",
]);

/**
 * Validate an untrusted value as a well-formed `EndpointHealthRecord` — every field checked,
 * not just `endpointId`/`model`. The IPC boundary this guards (`modelHealth:record`) used to
 * pass its argument through to disk almost unchecked: a partial/malformed record (e.g. from a
 * compromised renderer, or any future caller that isn't `buildHealthRecord`'s own output) would
 * persist verbatim and then crash the Settings ▸ Model Health render the next time it read a
 * missing/wrong-typed field back out. Returns a fresh, normalized copy (never the input object)
 * on success, `null` on any mismatch — the caller rejects rather than guesses.
 */
export function parseEndpointHealthRecord(input: unknown): EndpointHealthRecord | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!str(r.endpointId) || !str(r.model) || !str(r.lastUsedIso)) return null;
  if (!LOCALITIES.has(r.locality as string)) return null;
  if (!TRANSPORT_MODES.has(r.transport as string)) return null;
  if (typeof r.demonstrated !== "boolean") return null;
  if (!finiteNum(r.nativeCalls) || !finiteNum(r.textCallsWhileNative)) return null;
  if (!finiteNum(r.textSyntaxCalls)) return null;
  if (typeof r.nativeRejected !== "boolean") return null;
  if (!BREAKER_STATES.has(r.breakerState as string)) return null;
  if (!finiteNum(r.breakerFailures)) return null;
  if (r.breakerOpenedAt !== null && !finiteNum(r.breakerOpenedAt)) return null;
  if (!finiteNum(r.contextWindow)) return null;
  if (!CONTEXT_WINDOW_ORIGINS.has(r.contextWindowSource as string)) return null;
  return {
    endpointId: r.endpointId as string,
    model: r.model as string,
    locality: r.locality as EndpointHealthRecord["locality"],
    transport: r.transport as TransportMode,
    demonstrated: r.demonstrated,
    nativeCalls: r.nativeCalls as number,
    textCallsWhileNative: r.textCallsWhileNative as number,
    textSyntaxCalls: r.textSyntaxCalls as number,
    nativeRejected: r.nativeRejected,
    breakerState: r.breakerState as BreakerState,
    breakerFailures: r.breakerFailures as number,
    breakerOpenedAt: r.breakerOpenedAt as number | null,
    contextWindow: r.contextWindow as number,
    contextWindowSource: r.contextWindowSource as ContextWindowOrigin,
    lastUsedIso: r.lastUsedIso as string,
  };
}

/** Merge a fresh record into a store, keyed by endpoint id — the write side of every store. */
export function mergeHealthRecord(
  store: ModelHealthStore,
  record: EndpointHealthRecord,
): ModelHealthStore {
  return { ...store, [record.endpointId]: record };
}

/** One line describing the transport, for a human. */
export function describeTransport(r: EndpointHealthRecord): string {
  if (r.transport === "native") {
    if (r.nativeRejected) return "native (rejected — will retry in text)";
    return r.demonstrated ? "native ✓ proven" : "native (unverified)";
  }
  return r.demonstrated ? "text ✓ syntax proven" : "text";
}

/** One line describing the breaker, for a human — including a countdown while open. */
export function describeBreaker(
  r: EndpointHealthRecord,
  nowMs: number,
  coolDownMs = 30_000,
): string {
  if (r.breakerState === "closed") return r.breakerFailures > 0 ? "healthy (recovered)" : "healthy";
  if (r.breakerState === "half-open") return "recovering (probing)";
  const elapsed = r.breakerOpenedAt === null ? coolDownMs : nowMs - r.breakerOpenedAt;
  const remainingMs = Math.max(0, coolDownMs - elapsed);
  return `open — failing fast (retry in ~${Math.ceil(remainingMs / 1000)}s)`;
}

/** One line describing the context window — flags a silent default explicitly. */
export function describeContextWindow(r: EndpointHealthRecord): string {
  const n = r.contextWindow.toLocaleString("en-US");
  if (r.contextWindowSource === "default") {
    return `${n} tokens (⚠ unmeasured — probe failed, this is a guessed floor)`;
  }
  if (r.contextWindowSource === "declared") return `${n} tokens (declared)`;
  // "ollama-loaded" = the daemon serves LESS than the weights allow (OLLAMA_CONTEXT_LENGTH).
  // Saying so is the difference between "my model has 262k" and the 8k actually in force.
  if (r.contextWindowSource === "ollama-loaded") {
    return `${n} tokens (as SERVED by ollama — the model itself allows more; raise OLLAMA_CONTEXT_LENGTH to use it)`;
  }
  return `${n} tokens (measured via ${r.contextWindowSource})`;
}

/** Render a fixed-width-ish table for a terminal. Empty input still prints a header, so the
 *  command reads as "nothing used yet", not as if it crashed. */
export function formatHealthTable(records: readonly EndpointHealthRecord[], nowMs: number): string {
  const rows = [...records].sort((a, b) => b.lastUsedIso.localeCompare(a.lastUsedIso));
  const lines = [
    "ENDPOINT                          TRANSPORT              BREAKER                          CONTEXT WINDOW",
  ];
  if (rows.length === 0) {
    lines.push("(no endpoint has been used yet this install)");
    return lines.join("\n");
  }
  for (const r of rows) {
    const name = `${r.model} (${r.endpointId})`.padEnd(34).slice(0, 34);
    const transport = describeTransport(r).padEnd(22).slice(0, 22);
    const breaker = describeBreaker(r, nowMs).padEnd(32).slice(0, 32);
    const ctx = describeContextWindow(r);
    lines.push(`${name}${transport}${breaker}${ctx}`);
  }
  return lines.join("\n");
}
