/**
 * agent/permission-config.ts — the PRODUCER the §3.4 rule engine never had.
 *
 * `evaluatePermission` has taken a `rules` list since it was written, and `withRememberedGrants`
 * has accepted `baseRules` since it was written. Nothing ever supplied either. `permissionRules`
 * had exactly two mentions in the whole repository — its declaration and its single read — and
 * no assignment anywhere, so the list was always empty and the engine decided on remembered
 * grants alone. A user could not express "never touch this path" or "stop asking me about git
 * status" at all, and the documentation described a feature that could not be reached.
 *
 * PRECEDENCE, stated once because it is the thing that is easy to get subtly wrong:
 *
 *   1. the nemesis gate — safety, outside this ladder entirely; no `allow` here bypasses it;
 *   2. the loop's broker — an allowlist `block` cannot be undone by anything below;
 *   3. the engine's SAFE DEFAULTS — `.env` deny, external paths ask;
 *   4. USER RULES ⊕ remembered grants, merged deny-priority (this module's output);
 *   5. the permission mode and the autonomy ladder, inside the host's own confirm;
 *   6. the human.
 *
 * Because the base default is `ask`, a user `allow` can only ever REMOVE a prompt — it can
 * never grant something the layers above it refused. That asymmetry is what makes it safe to
 * read rules out of a file.
 *
 * TWO LAYERS, NOT ONE. The user's own config may allow, ask and deny. A PROJECT file may only
 * tighten — ask and deny — and never allow. A `.prometheus.toml` arrives with a clone, from
 * whoever wrote the repository, and a project file that could hand out permissions would be a
 * supply-chain hole with a config-shaped door. This mirrors the tighten-only posture the
 * profile loader already applies.
 *
 * PURE: no fs, no toml, no node. The loader half lives in `system/host/permission-rules.ts`.
 */
import type { PermissionRule } from "./permission-engine.js";
import { isTooBroad } from "./scoped-permission.js";

/** The `[permissions]` table as written by a human. */
export interface PermissionRulesConfig {
  allow?: readonly string[];
  ask?: readonly string[];
  deny?: readonly string[];
}

export interface CompiledPermissionRules {
  /** last-match-wins, in the order the engine must evaluate them. */
  rules: PermissionRule[];
  /** patterns that were refused, so a host can SAY so rather than silently ignoring them. */
  rejected: { key: string; pattern: string; reason: string }[];
}

/** Trim, drop blanks and non-strings, dedupe — a config file is hand-written. */
function clean(list: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    if (typeof raw !== "string") continue;
    const p = raw.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Compile the user layer and the (untrusted) project layer into one rule list.
 *
 * The emitted ORDER is the whole contract, because the engine is last-match-wins:
 * allow first, then ask, then deny — so a deny always beats an ask, and an ask always beats an
 * allow, no matter what order the human wrote them in.
 */
export function compilePermissionRules(
  user: PermissionRulesConfig | undefined,
  project?: PermissionRulesConfig,
): CompiledPermissionRules {
  const rejected: CompiledPermissionRules["rejected"] = [];

  const userAllow = clean(user?.allow).filter((pattern) => {
    // An `allow: ["*"]` is not a preference, it is turning the ladder off in a file the user
    // may not remember writing. The same test the remembered-grant store applies.
    if (isTooBroad(pattern)) {
      rejected.push({
        key: "permissions.allow",
        pattern,
        reason: "an allow rule may not hand over the whole tool surface",
      });
      return false;
    }
    return true;
  });

  for (const pattern of clean(project?.allow)) {
    rejected.push({
      key: "permissions.allow",
      pattern,
      reason: "a project file cannot grant permissions — it may only ask for or deny them",
    });
  }

  const rules: PermissionRule[] = [
    ...userAllow.map((match) => ({ match, decision: "allow" as const })),
    ...clean(user?.ask).map((match) => ({ match, decision: "ask" as const })),
    ...clean(project?.ask).map((match) => ({ match, decision: "ask" as const })),
    ...clean(user?.deny).map((match) => ({ match, decision: "deny" as const })),
    ...clean(project?.deny).map((match) => ({ match, decision: "deny" as const })),
  ];
  return { rules, rejected };
}
