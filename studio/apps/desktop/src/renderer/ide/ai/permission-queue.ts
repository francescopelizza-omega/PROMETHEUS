// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/permission-queue.ts — the §3 write-permission queue, keyed by the session that owns it.
 *
 * One DiffReview instance renders whichever chat tab is active, so its state has to be
 * per-session or one tab's answer lands on another's changeset. `applyingBy` and `errorBy` were
 * already keyed that way, with a comment explaining exactly why; the permission queue itself was
 * flat component state. So a card raised for tab A stayed on screen after switching to tab B, and
 * approving it ran the apply against B's ChangeSet — B's files written on a permission the human
 * granted for a path in tab A, with B's own paths never shown. Tab A's approved apply, meanwhile,
 * silently never happened.
 *
 * Kept here as plain data so the rule can be tested: the component is a .tsx, and this repo has
 * no DOM for the node:test harness to render one in.
 */

/** One awaiting write, as raised by the applier. Shape mirrors `PendingWrite`. */
export interface QueuedWrite {
  path: string;
  change: string;
  insideWorkingSet: boolean;
}

/** session id → the writes that session is still waiting on a human for. */
export type PermissionQueues<T extends QueuedWrite = QueuedWrite> = Record<string, T[]>;

/** Raise `asks` for `sid`, leaving every other session's queue untouched. */
export function raiseFor<T extends QueuedWrite>(
  queues: PermissionQueues<T>,
  sid: string,
  asks: T[],
): PermissionQueues<T> {
  return { ...queues, [sid]: asks };
}

/** The card `sid` should be showing, or undefined when it has nothing pending. */
export function headFor<T extends QueuedWrite>(
  queues: PermissionQueues<T>,
  sid: string,
): T | undefined {
  return queues[sid]?.[0];
}

/**
 * Pop `sid`'s head after it was answered. Returns the new map and whether that session's queue is
 * now EMPTY — which is the signal to proceed with the apply, and must be read per session rather
 * than from a shared length.
 */
export function answerHeadFor<T extends QueuedWrite>(
  queues: PermissionQueues<T>,
  sid: string,
): { queues: PermissionQueues<T>; drained: boolean } {
  const rest = (queues[sid] ?? []).slice(1);
  return { queues: { ...queues, [sid]: rest }, drained: rest.length === 0 };
}

/** Drop `sid`'s whole queue (a deny cancels that session's apply, and only that one). */
export function clearFor<T extends QueuedWrite>(
  queues: PermissionQueues<T>,
  sid: string,
): PermissionQueues<T> {
  return { ...queues, [sid]: [] };
}
