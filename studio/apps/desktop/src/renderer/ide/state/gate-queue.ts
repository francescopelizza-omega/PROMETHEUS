/**
 * ide/state/gate-queue.ts — the buffered run-gate handoff for AI-authored new files.
 *
 * AI-written NEW files are untrusted-until-gated (§5.2). DiffReview announces the
 * uris it just wrote via the `ide:gate-new-files` CustomEvent, but the ONLY listener
 * lives in the editor route — and DiffReview is ALSO mounted in the shell AgentPane,
 * which exists precisely when that route is unmounted. An event with no listener is
 * silently dropped, which would let a gated file slip through un-gated (fail-open).
 *
 * This module is the fail-closed buffer: DiffReview ENQUEUES before dispatching; the
 * editor route DRAINS both in its event listener (live case) and once on mount (the
 * deferred case). Renderer-local, framework-free, no window/node dependencies.
 */

const pending: string[] = [];

/** Queue AI-written new-file uris for the next run-gate (call BEFORE the event). */
export function enqueueGateUris(uris: readonly string[]): void {
  pending.push(...uris);
}

/** Take (and clear) everything queued so far. */
export function drainGateUris(): string[] {
  return pending.splice(0, pending.length);
}

/** Anything still waiting for a gate? (the mount-time check). */
export function hasPendingGateUris(): boolean {
  return pending.length > 0;
}
