// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/remembered-confirm.ts — make "don't ask again" actually work.
 *
 * `ScopedPermissionStore`, `deriveSubject`, `isTooBroad` and the whole pure permission engine
 * were built, documented and unit-tested — and had ZERO production call sites. Nothing ever
 * consulted a remembered grant, so every destructive call re-prompted, forever, for the rest
 * of the session and every session after it. That is the single largest day-to-day gap
 * between this agent and the ones it is measured against: an agent you must re-authorise for
 * the same `git status` forty times is one you stop using.
 *
 * This is the missing seam, and it is deliberately a WRAPPER around the host's own confirm
 * rather than a change to the loop: the loop's broker already decides *whether* to ask, and
 * the host already knows *how* to ask. What was missing is the memory in between.
 *
 *   confirm = withRememberedGrants(hostConfirm, store, { workspaceRoot });
 *
 * The safety properties are inherited, not re-implemented:
 *   - DENY WINS — `store.merge` places scoped allows BEFORE the base rules and scoped denies
 *     AFTER them, and the engine is last-matching-rule-wins.
 *   - A remembered grant can never widen into the shell: `deriveSubject` returns null for an
 *     over-broad subject or anything carrying `--force`, and `add` refuses it again.
 *   - A grant answered against a SAFE DEFAULT (.env, external dir, doom loop) is forced to
 *     scope `once`, so one careless "always" cannot permanently disable a guard.
 *
 * PURE: no node, no IO. Persistence is the host's — it serializes `store.all()`.
 */

import type { ConfirmResult, ToolCall } from "./loop.js";
import { evaluatePermission } from "./permission-engine.js";
import type { PermissionRule } from "./permission-engine.js";
import type { GrantScope, ScopedPermissionStore } from "./scoped-permission.js";
import { deriveSubject } from "./scoped-permission.js";

/** How a host names a tool for the permission engine (`engine:install`, `bash:…`). */
export type RefOf = (call: ToolCall) => string;

/** Which path arguments a call touches — feeds the `.env` and external-dir safe defaults. */
export type PathsOf = (call: ToolCall) => string[];

/** The argv a call runs, when it runs one — makes a bash grant bind to the exact command. */
export type ArgvOf = (call: ToolCall) => string[] | undefined;

export interface RememberedConfirmOptions {
  workspaceRoot: string;
  /** the host's base rules (config). Scoped grants are merged around these, never into them. */
  baseRules?: readonly PermissionRule[];
  /** default `engine:<name>`; override to match the host's ref convention. */
  refOf?: RefOf;
  pathsOf?: PathsOf;
  argvOf?: ArgvOf;
  /** refs already called this turn — powers the engine's doom-loop guard. */
  callHistory?: string[];
  /** notified when a grant is stored, so the host can persist and tell the user. */
  onRemember?: (subject: string, scope: GrantScope) => void;
  /** notified when a remembered grant skipped a prompt (for an honest transcript line). */
  onAutoApprove?: (subject: string, reason: string) => void;
}

/** Default ref: the engine's own naming for a catalog tool. */
function defaultRef(call: ToolCall): string {
  return call.name.startsWith("bash:") ? call.name : `engine:${call.name}`;
}

/** Default path extraction — the argument names the catalog actually uses for paths. */
function defaultPaths(call: ToolCall): string[] {
  const out: string[] = [];
  for (const key of ["path", "file", "cwd", "target", "dest", "from", "to"]) {
    const v = call.args[key];
    if (typeof v === "string" && v) out.push(v);
  }
  return out;
}

function defaultArgv(call: ToolCall): string[] | undefined {
  const argv = call.args.argv;
  if (Array.isArray(argv) && argv.every((a) => typeof a === "string")) return argv as string[];
  const command = call.args.command;
  return typeof command === "string" && command ? command.split(/\s+/) : undefined;
}

/**
 * Wrap a host confirm so remembered grants are honoured and new ones can be learned.
 *
 * The order is the whole point: the store is consulted BEFORE the human is asked, and only
 * a decisive `allow` skips the prompt. An `ask` or a `deny` from the engine still reaches the
 * host — a remembered grant may only ever REMOVE a question, never add an approval the engine
 * would not have given.
 */
export function withRememberedGrants(
  hostConfirm: ((call: ToolCall) => ConfirmResult | Promise<ConfirmResult>) | undefined,
  store: ScopedPermissionStore,
  opts: RememberedConfirmOptions,
): (call: ToolCall) => Promise<ConfirmResult> {
  const refOf = opts.refOf ?? defaultRef;
  const pathsOf = opts.pathsOf ?? defaultPaths;
  const argvOf = opts.argvOf ?? defaultArgv;
  const base = opts.baseRules ?? [];

  return async (call: ToolCall): Promise<ConfirmResult> => {
    const ref = refOf(call);
    const paths = pathsOf(call);
    const argv = argvOf(call);

    const verdict = evaluatePermission(
      { ref, ...(argv ? { argv } : {}), ...(paths.length > 0 ? { paths } : {}) },
      store.merge(base, opts.workspaceRoot, paths),
      { workspaceRoot: opts.workspaceRoot, callHistory: opts.callHistory ?? [] },
      // The BASE default is `ask`, not `allow`: this wrapper only ever runs for calls the
      // broker already decided need a human, so "no rule matched" must keep asking.
      "ask",
    );

    if (verdict.decision === "allow") {
      opts.onAutoApprove?.(ref, verdict.reason);
      return { approved: true };
    }
    if (verdict.decision === "deny") {
      // A remembered DENY answers for the human — that is what "never do this" means.
      return { approved: false, reason: verdict.reason };
    }

    const answer = hostConfirm ? await hostConfirm(call) : false;
    const approved = typeof answer === "boolean" ? answer : answer.approved;
    const remember = typeof answer === "object" && answer.remember ? answer.remember : undefined;

    if (approved && remember) {
      // `deriveSubject` returns the NARROWEST reusable form, and null when remembering would
      // hand over the shell — in which case the approval still stands for this one call and
      // nothing is stored.
      const subject = deriveSubject(ref, argv);
      if (subject) {
        const res = store.add(
          {
            subject,
            decision: "allow",
            scope: remember,
            ...(remember === "project" ? { root: opts.workspaceRoot } : {}),
            ...(paths.length > 0 ? { paths } : {}),
          },
          // A `.env`, external-dir or doom-loop ask is a SAFE DEFAULT; the store downgrades
          // an "always" against one of those to `once` so the guard survives.
          { fromSafeDefault: (verdict.rule ?? "").startsWith("safe-default:") },
        );
        if (res.ok && res.scope) opts.onRemember?.(subject, res.scope);
      }
    }
    return answer;
  };
}
