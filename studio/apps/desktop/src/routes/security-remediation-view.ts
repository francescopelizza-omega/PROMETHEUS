// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/security-remediation-view.ts — PURE helpers for the Security route's
 * remediation progress pane + purge-confirm seam (APP-010). JSX-free so node:test
 * pins the runId filtering, the partial-chunk buffering, and the typed-confirm
 * ZERO-CALL contract WITHOUT a DOM (the repo has no render harness; the pure
 * decision logic IS the contract).
 *
 * The `securityProgress` feed (main/security-ipc.ts:124) is PER-WINDOW and SHARED
 * by every security op (gateFull / threatdb update / install / disinfect). The
 * route mints a runId per remediation op and echoes it into `remediate()`; these
 * helpers fold ONLY that run's lines into the pane (strict runId match) so a
 * concurrent gate/threatdb stream can never interleave (§9 / deliverable 3). The
 * renderer NEVER decides "safe" — this is cosmetic log text only (C5).
 */

import type { SecurityRemediateRequest, SecurityRemediateResult } from "../shared/ipc-contract.js";

/** ANSI SGR escapes the engine colours its stdout with — stripped before display. */
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Basename of a logical path (the tail after the last "/" or "\"). REPLICATED from
 * core.purgeBasename (byte-for-byte) rather than imported: @prometheus/core's barrel
 * pulls node:fs providers that cannot cross the renderer sandbox (C5) — the same
 * reason @prometheus/ui carries its own copy. The test pins agreement with core so
 * the two can never drift.
 */
function basename(path: string): string {
  if (typeof path !== "string" || path.length === 0) return "";
  const trimmed = path.replace(/[/\\]+$/, "");
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

/** Byte-exact basename match — no trim, no case-fold, no Unicode normalize (§9.3).
 *  Mirrors core.purgeNameMatches; a non-string or empty basename is `false`. */
function nameMatchesBasename(typed: unknown, path: string): boolean {
  if (typeof typed !== "string") return false;
  const expected = basename(path);
  return expected.length > 0 && typed === expected;
}

/** Cap so a chatty disinfect can't grow the pane unbounded (newest kept). */
export const REMEDIATION_LOG_CAP = 400;

/**
 * The remediation pane state: the rendered lines + the partial-line BUFFER.
 * node-pty / child stderr arrives as partial chunks, not whole lines — the buffer
 * holds the RAW trailing fragment (un-stripped, so an ANSI escape split across two
 * chunks re-joins before stripping) until its terminating `\n` (or the run's
 * flush), so the last progress line (often the summary, which rarely ends in `\n`)
 * is never dropped.
 */
export interface RemediationFeedState {
  lines: string[];
  buffer: string;
}

/** The idle pane — no lines, empty buffer. Shared to keep resets referentially cheap. */
export const EMPTY_REMEDIATION_FEED: RemediationFeedState = { lines: [], buffer: "" };

/** Keep only the newest REMEDIATION_LOG_CAP lines. */
function capLines(lines: string[]): string[] {
  return lines.length > REMEDIATION_LOG_CAP
    ? lines.slice(lines.length - REMEDIATION_LOG_CAP)
    : lines;
}

/** ANSI-strip + CR-trim one completed line (escapes only strip once the whole line
 *  is assembled, so a chunk-split escape is never left half-removed). */
function cleanLine(line: string): string {
  return line.replace(ANSI, "").replace(/\r$/, "");
}

/**
 * Fold one progress event into the feed IFF it belongs to the ACTIVE run. Foreign
 * runIds, a null active run, and run-less global lines are IGNORED (fail-closed
 * isolation — deliverable 3). The RAW chunk is appended to the buffer and split on
 * `\n`; each complete line is then ANSI-stripped, CR-trimmed, blank-dropped and
 * capped, while the trailing partial stays buffered raw. PURE — returns a new state
 * (or the same one when nothing changed).
 */
export function reduceRemediationFeed(
  state: RemediationFeedState,
  event: { runId?: string; message?: string; raw?: string } | null | undefined,
  activeRunId: string | null,
): RemediationFeedState {
  if (!event || activeRunId === null || event.runId !== activeRunId) return state;
  const raw = typeof event.raw === "string" ? event.raw : (event.message ?? "");
  if (raw.length === 0) return state;
  const segments = (state.buffer + raw).split("\n");
  const buffer = segments.pop() ?? ""; // the trailing partial stays buffered (raw)
  const complete = segments.map(cleanLine).filter((l) => l.trim().length > 0);
  if (complete.length === 0) return { lines: state.lines, buffer };
  return { lines: capLines([...state.lines, ...complete]), buffer };
}

/**
 * Flush the buffered partial line when a run ENDS (the terminal `{ok}`). The final
 * progress line usually arrives WITHOUT a trailing `\n`, so discarding the buffer
 * would lose it. ANSI-stripped like any other line. Always clears the buffer. PURE.
 */
export function flushRemediationFeed(state: RemediationFeedState): RemediationFeedState {
  const rest = cleanLine(state.buffer).trim();
  if (rest.length === 0)
    return state.buffer.length === 0 ? state : { lines: state.lines, buffer: "" };
  return { lines: capLines([...state.lines, rest]), buffer: "" };
}

/**
 * A run correlation id that ALWAYS satisfies main's RUN_ID zod regex
 * (`[A-Za-z0-9._:-]+`, ≤128). `crypto.randomUUID` when present, a Date/random
 * fallback otherwise; any stray char is mapped to `-` so the seam never rejects it.
 */
export function mintRemediationRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw = c?.randomUUID
    ? c.randomUUID()
    : `remediate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const safe = raw.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
  return safe.length > 0 ? safe : "remediate";
}

/**
 * The EXACT remediate request the route sends when a purge is CONFIRMED (§9.3).
 * The typed basename is forwarded VERBATIM as `typedName` — main compares it
 * byte-exact against `purgeBasename(target)` and refuses on any mismatch (no trim,
 * no case-fold, no Unicode normalization).
 */
export function buildPurgeRequest(
  item: { path: string },
  typedName: string,
  runId?: string,
): SecurityRemediateRequest {
  const req: SecurityRemediateRequest = {
    op: "purge",
    target: item.path,
    kind: "quarantine",
    typedName,
  };
  if (runId !== undefined) req.runId = runId;
  return req;
}

/**
 * The route-side fail-closed purge gate (§9.3 / gotcha line 66): the purge request
 * is built ONLY when the typed string byte-exactly matches the item's basename —
 * the SAME `purgeNameMatches` core predicate PurgeDialog gates its CTA on and main
 * re-checks. Returns `null` (⇒ no `remediate` call) on any mismatch. Defense in
 * depth: even a buggy caller that fired `onConfirm` with a wrong name cannot leak a
 * destroy request. PURE.
 */
export function purgeRequestIfConfirmed(
  item: { path: string },
  typed: string,
  runId?: string,
): SecurityRemediateRequest | null {
  return nameMatchesBasename(typed, item.path) ? buildPurgeRequest(item, typed, runId) : null;
}

/** The outcome of forwarding a purge confirmation: refused (no call made) or the
 *  engine's result for the one call that WAS made. */
export type PurgeForwardOutcome =
  | { called: false; refused: string }
  | { called: true; result: SecurityRemediateResult };

/**
 * Forward a purge confirmation to `remediate` IFF the typed name matches (§9.3
 * zero-call contract). On mismatch, `remediate` is NEVER invoked. The dependency
 * is injected so the route→main seam is unit-testable with a spy (no DOM): the
 * route passes `window.prometheus.security.remediate`.
 */
export async function forwardPurge(
  remediate: (req: SecurityRemediateRequest) => Promise<SecurityRemediateResult>,
  item: { path: string },
  typed: string,
  runId?: string,
): Promise<PurgeForwardOutcome> {
  const req = purgeRequestIfConfirmed(item, typed, runId);
  if (!req)
    return { called: false, refused: "purge refused: typed name does not match the filename" };
  return { called: true, result: await remediate(req) };
}
