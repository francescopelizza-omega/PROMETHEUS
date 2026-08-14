/**
 * ide/ai/permission-gate.ts — the §3 permission decision, in one place.
 *
 * The rule the handoff states twice, and the reason this file is small: the card is
 * "the single VISIBLE authorisation surface", and "the applier's scope guard stays on
 * regardless". So this module answers exactly one question — *does a human need to be
 * asked about this write?* — and records the answer. It never writes, and it is never
 * the thing that stops a write; main's `assertInsideWorkingSet` is.
 *
 * The decision itself is NOT re-derived here: it is core's `scopedWriteDecision`, the
 * same function the CLI has used since the 08-07 fix. Re-implementing that rule in the
 * renderer is precisely how the two surfaces would drift apart again.
 *
 * Renderer-SANDBOXED (C5): a pure core subpath + window.prometheus only.
 */

import { scopedWriteDecision } from "@prometheus/core/agent-authorization";

import { useAuthorisationStore } from "../../stores/authorisation.js";

/** Session-scoped grants: paths the human said "this session" to. */
const sessionApproved = new Set<string>();

/** A single pending write the card describes. */
export interface PendingWrite {
  /** the `file://…` uri or absolute path the applier will touch. */
  uri: string;
  /** the absolute path, for display (mono, break-all). */
  path: string;
  insideWorkingSet: boolean;
  /** "new file" | "modify" | "delete". */
  change: string;
  /** e.g. "4 lines". */
  magnitude?: string;
}

/** Strip a `file://` prefix — the card and the approval IPC both want a bare path. */
export function toPath(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

/** Whether `path` is inside any of `roots`. Pure — mirrors main's isUnder(). */
export function isInsideRoots(path: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  return roots.some((root) => {
    const r = root.replace(/\/+$/, "");
    return path === r || path.startsWith(`${r}/`);
  });
}

/**
 * Does this write need a human? `false` when the level auto-approves it AND the target
 * is in scope (or was already approved this session). Uses core's ladder verbatim.
 */
export function needsPermission(w: PendingWrite): boolean {
  if (sessionApproved.has(w.path)) return false;
  const level = useAuthorisationStore.getState().level;
  const decision = scopedWriteDecision(
    level,
    "write_file",
    { destructiveHint: w.change === "delete" },
    w.insideWorkingSet,
  );
  return decision === "ask";
}

/**
 * Record a grant. `session` also remembers it locally so the next identical write in
 * this session skips the card; BOTH tell main about the path, because an out-of-scope
 * write is refused by the applier guard until main knows a human allowed that exact path.
 */
export async function grant(w: PendingWrite, scope: "once" | "session"): Promise<void> {
  if (scope === "session") sessionApproved.add(w.path);
  if (!w.insideWorkingSet) {
    await window.prometheus?.ide?.approveOutsideWorkingSet?.(w.path, scope).catch(() => {});
  }
}

/** Forget every session grant (a new chat session, or an explicit revoke). */
export async function revokeAll(): Promise<void> {
  sessionApproved.clear();
  await window.prometheus?.ide?.approveOutsideWorkingSet?.("", "clear").catch(() => {});
}

/** Push the active workspace roots to main so the applier guard has a scope to check. */
export async function declareWorkingSet(roots: readonly string[]): Promise<void> {
  await window.prometheus?.ide?.setWorkingSet?.(roots).catch(() => {});
}
