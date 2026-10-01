// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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

import { authDecision, scopedWriteDecision } from "@prometheus/core/agent-authorization";
import type { AuthToolEffect } from "@prometheus/core/agent-authorization";
import { classifyCommand, execAuthDecision, parseCommand } from "@prometheus/core/agent-exec";
import type { ToolCall } from "@prometheus/core/agent-loop";

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

/**
 * Does the autonomy ladder auto-approve this tool call without asking a human?
 *
 * ## Why this exists
 *
 * The pane asked about EVERY tool call at EVERY level. `authDecision`, `classifyAuth` and
 * `execAuthDecision` had zero callers anywhere under `apps/desktop`, so the authorisation level
 * — which is persisted and SHARED with the terminal — meant something different depending on
 * which surface you launched. A user who set `paranoid` was protected in both; a user who set
 * `commands` got terminal autonomy and an editor that still asked about every read.
 *
 * It also cuts the other way, and that half is a real gap rather than an annoyance. The pane's
 * MCP path auto-approved through `autoApprovable` (`core/mcp/host/policy.ts:38`), which tests
 * `readOnlyHint` and never looks at `openWorldHint`. `classifyAuth` checks `openWorldHint`
 * FIRST — its comment says "network / remote code — outranks readOnly" — so a tool carrying
 * both hints (core's `web_search`, and any MCP tool whose SERVER declares both) was auto at A1
 * here and auto only at A5 in the terminal. Routing through the ladder closes that by
 * construction rather than by patching the policy helper.
 *
 * ## The rule is core's, not a copy
 *
 * This is `hostAutoApproves` from `apps/cli/src/session/host.ts:921`, imported rather than
 * re-derived — the same discipline the file header states for `scopedWriteDecision`. Two
 * branches exist because the tool NAME is not enough to know the risk:
 *
 *   - `run_command`'s risk is its COMMAND. `execAuthDecision` grades the parsed command's tier;
 *     `authDecision` cannot see it, so a level that should auto-run `ls` would also auto-run
 *     `rm -rf` on the strength of the tool name alone.
 *   - `write_file` is handled ELSEWHERE here and deliberately not below. In this app it never
 *     reaches the confirm seam: `confirmToolCall` short-circuits it because it does not touch
 *     disk — it enqueues into diff review, where `needsPermission` above applies
 *     `scopedWriteDecision` to the real resolved path. The CLI has no diff review, so its copy
 *     needs the branch and this one does not.
 *
 * ## Parsing with no variables is correct here, not a shortcut
 *
 * `parseCommand(line, {})` matches what will ACTUALLY run: the desktop's `ide-ipc.ts` passes no
 * `vars` to `runSystemTool`, which parses at `system-tools.ts:979` with `deps.vars ?? {}`. The
 * CLI passes `execVarsFromEnv()` and so must classify with the same. Classifying a different
 * expansion from the one that executes is how a ladder decision stops describing the command —
 * so this must stay in step with whatever main supplies.
 *
 * FAIL-CLOSED throughout: an unparseable or unclassifiable command is never auto-approved, it
 * falls through to the card. `authDecision` itself refuses `NEVER_AUTO_TOOLS` at every level.
 */
export function autoApprovesToolCall(call: ToolCall, annotations?: AuthToolEffect): boolean {
  const level = useAuthorisationStore.getState().level;
  if (call.name === "run_command") {
    const line = typeof call.args.command === "string" ? call.args.command : "";
    if (!line) return false;
    const parsed = parseCommand(line, {});
    if (!parsed.ok) return false; // unparseable ⇒ the human decides, never the ladder
    const cls = classifyCommand(parsed.command);
    if (!cls.ok) return false;
    return execAuthDecision(level, cls.tier) === "allow";
  }
  return authDecision(level, call.name, annotations) === "allow";
}
