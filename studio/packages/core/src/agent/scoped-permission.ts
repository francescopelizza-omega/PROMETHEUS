// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/scoped-permission.ts — remembered "don't ask again" grants over the PURE permission
 * engine (WRAPPER Subsystem 3). Wraps `evaluatePermission` WITHOUT touching its math: it owns a
 * layered set of learned grants (once / session / project / user, optionally path-bound), derives
 * the NARROWEST reusable subject from a concrete confirm answer, and regenerates the flat
 * PermissionRule[] the engine consumes.
 *
 * LOAD-BEARING (C5 + Claude-parity):
 *  - DENY ALWAYS WINS: scoped ALLOW rules are placed BEFORE the base rules and scoped DENY rules
 *    AFTER them, so under the engine's last-matching-rule-wins a narrow allow can never override a
 *    broader deny (base or scoped). The base rules keep their own relative order.
 *  - NEVER hand over the shell / the workspace: `deriveSubject` and `add` REFUSE an over-broad
 *    subject (`*`, `engine:*`, `bash:*`) and anything carrying `--force`.
 *  - A grant answered against a SAFE-DEFAULT ask (.env / external-dir / doom-loop) is forced to
 *    scope `once`, so a guard can never be permanently disabled by a single "always".
 */
import type { PermissionDecision, PermissionRule } from "./permission-engine.js";

/** How long a remembered grant lives. */
export type GrantScope = "once" | "session" | "project" | "user";

export interface Grant {
  /** a tool-ref glob ("engine:install") or a bash pattern ("bash:git status"). */
  subject: string;
  decision: "allow" | "deny";
  scope: GrantScope;
  /** project grants bind to a workspace root; they don't apply in a different project. */
  root?: string;
  /** optional per-file binding: the grant applies only when the call touches one of these paths. */
  paths?: string[];
}

/**
 * Is a subject broad enough that remembering it would hand over the shell or the whole surface?
 * Refuses `*`, any `…:*`, an empty/`*` bash body, and anything containing `--force`.
 */
export function isTooBroad(subject: string): boolean {
  if (subject.includes("--force")) return true;
  if (subject.startsWith("bash:")) {
    const body = subject.slice("bash:".length).trim();
    return body === "" || body === "*";
  }
  return subject === "*" || subject.endsWith(":*");
}

/**
 * Derive the NARROWEST reusable subject for a call the user chose to always-allow. A bash call
 * becomes its exact command (`bash:git status`); any other tool becomes its exact ref. Returns
 * null when the result would be too broad or carries `--force` — the caller then must not persist.
 */
export function deriveSubject(ref: string, argv?: readonly string[]): string | null {
  if (argv && argv.length > 0) {
    if (argv.some((a) => a === "--force" || a.startsWith("--force="))) return null;
    /**
     * A `*` in the APPROVED command is a shell glob. A `*` in a stored subject is a PERMISSION
     * wildcard. They look identical and mean opposite things, so a subject derived from a
     * concrete call must never carry one across.
     *
     * `permission-engine.ts` matches a `bash:` pattern positionally and documents it plainly:
     * "a trailing `*` matches any remaining args". So answering "always allow" to a single
     * `rm *` — where the user meant "these files, here, now" — stored `bash:rm *`, which from
     * then on matched `rm` with ANY arguments: `rm -rf /`, `rm -rf ~`, forever, in every
     * session, with no further prompt. `isTooBroad` did not catch it because it only refuses a
     * body that is EXACTLY `*`.
     *
     * Refusing to remember is the right answer rather than escaping it: the matcher has no
     * escape syntax, and "allow this once" remains available. The user loses nothing but the
     * shortcut they could not have meant to ask for.
     */
    if (argv.some((a) => a.includes("*"))) return null;
    const cmd = argv.join(" ").trim();
    if (cmd === "") return null;
    const subject = `bash:${cmd}`;
    return isTooBroad(subject) ? null : subject;
  }
  if (!ref || isTooBroad(ref)) return null;
  return ref;
}

/** The result of trying to remember a grant. */
export interface AddResult {
  ok: boolean;
  reason?: string;
  /** the scope actually stored (may be downgraded to `once` for a safe-default answer). */
  scope?: GrantScope;
}

/**
 * A stateful store of learned grants layered over the pure engine. Not persisted here — the host
 * serializes `all()` for session/project/user scopes; `once`/`session` are cleared on their events.
 */
export class ScopedPermissionStore {
  private grants: Grant[] = [];

  /**
   * Remember a grant. Refuses an over-broad subject. When `fromSafeDefault` is set (the ask was a
   * `.env` / external-dir / doom-loop guard) an ALLOW is forced to scope `once` so the guard is
   * never permanently disabled.
   */
  add(grant: Grant, opts: { fromSafeDefault?: boolean } = {}): AddResult {
    if (isTooBroad(grant.subject))
      return { ok: false, reason: `subject too broad: ${grant.subject}` };
    let scope = grant.scope;
    if (opts.fromSafeDefault && grant.decision === "allow" && scope !== "once") {
      scope = "once"; // never let a single "always" permanently disable a safety guard
    }
    this.grants.push({ ...grant, scope });
    return { ok: true, scope };
  }

  /** Drop `once` grants (call after each tool decision). */
  clearOnce(): void {
    this.grants = this.grants.filter((g) => g.scope !== "once");
  }

  /** Drop non-persistent grants (call at session end) — keeps project + user. */
  clearSession(): void {
    this.grants = this.grants.filter((g) => g.scope === "project" || g.scope === "user");
  }

  /** All stored grants (for serialization / inspection). */
  all(): readonly Grant[] {
    return this.grants;
  }

  /** Grants that apply to a call at `root` touching `paths`. */
  private applicable(root: string, paths: readonly string[]): Grant[] {
    return this.grants.filter((g) => {
      if (g.scope === "project" && g.root !== undefined && g.root !== root) return false;
      if (g.paths && g.paths.length > 0)
        return paths.some((p) => (g.paths as string[]).includes(p));
      return true;
    });
  }

  /**
   * Merge the base rule list with the applicable grants, DENY-priority:
   * `[…scoped allows, …base, …scoped denies]`. Feed the result straight to `evaluatePermission`.
   */
  merge(
    base: readonly PermissionRule[],
    root: string,
    paths: readonly string[] = [],
  ): PermissionRule[] {
    const apps = this.applicable(root, paths);
    const rule = (g: Grant): PermissionRule => ({
      match: g.subject,
      decision: g.decision as PermissionDecision,
    });
    const allows = apps.filter((g) => g.decision === "allow").map(rule);
    const denies = apps.filter((g) => g.decision === "deny").map(rule);
    return [...allows, ...base, ...denies];
  }
}
