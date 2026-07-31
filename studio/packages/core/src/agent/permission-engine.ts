/**
 * agent/permission-engine.ts — user-editable allow/ask/deny autonomy policy (file 14 §3.4).
 *
 * Sits at the ToolBroker chokepoint as a PRE-FILTER: every tool call resolves to
 * allow / ask / deny via a last-rule-wins rule list (tool-ref globs + parsed-bash
 * command matching), plus safe defaults — `.env` files denied (except `*.env.example`),
 * an `external_directory` escape → ask, and a doom-loop guard (3+ identical calls in a
 * turn) → ask. PURE: no IO, no spawn, shell matching is tokenized-then-compared.
 *
 * LOAD-BEARING INVARIANT (C5): this is an AUTONOMY policy, NOT a safety verdict. A
 * `deny`/`ask` here can stop a call BEFORE it reaches the nemesis gate; an `allow` here
 * NEVER bypasses the gate — code that fetches/runs still crosses `nemesis gate` (the
 * engine decides "safe", not this engine).
 */

/** The three policy outcomes (opencode parity). */
export type PermissionDecision = "allow" | "ask" | "deny";

/** One policy rule (last matching rule wins). */
export interface PermissionRule {
  /**
   * what to match: a tool-ref glob ("engine:*", "*:write", "ext:acme:*") OR a bash
   * command pattern prefixed "bash:" ("bash:git push *", "bash:rm *").
   */
  match: string;
  decision: PermissionDecision;
}

/** A tool call being evaluated. */
export interface PermissionInput {
  /** the tool ref ("engine:install" | "<server>:<tool>" | "ext:<id>:<cmd>"). */
  ref: string;
  /** the bash argv when this call runs a shell command (the `bash`/exec tool). */
  argv?: string[];
  /** filesystem path args this call touches (for .env / external-dir checks). */
  paths?: string[];
}

/** Per-evaluation context (call history powers the doom-loop guard). */
export interface PermissionContext {
  workspaceRoot: string;
  /** refs called so far IN THIS TURN (most recent last). */
  callHistory: string[];
  /** the doom-loop threshold (default 3). */
  doomLoopThreshold?: number;
}

/** The decision + why (the `rule` is the winning rule, or a safe-default tag). */
export interface PermissionResult {
  decision: PermissionDecision;
  reason: string;
  rule?: string;
}

/* ── shell tokenizer + bash matcher ────────────────────────────────────────── */

/** Minimal POSIX-ish tokenizer: splits on whitespace, honors single/double quotes. */
export function shellWords(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === " " || ch === "\t" || ch === "\n") {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Match a "bash:" command pattern against an argv. Pattern tokens compare positionally;
 * a `*` token matches any single arg; a trailing `*` matches any remaining args. Exact
 * tokens must match. ("git push *" matches ["git","push","origin","main"].)
 */
export function matchBashPattern(pattern: string, argv: readonly string[]): boolean {
  const pat = shellWords(pattern);
  for (let i = 0; i < pat.length; i++) {
    const tok = pat[i];
    if (tok === "*" && i === pat.length - 1) return true; // trailing * = match the rest
    if (i >= argv.length) return false;
    if (tok === "*") continue; // single-arg wildcard
    if (tok !== argv[i]) return false;
  }
  return pat.length === argv.length;
}

/** Match a tool-ref glob ("engine:*", "*:write") against a ref. */
export function matchRef(pattern: string, ref: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`);
  return re.test(ref);
}
function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/* ── safe defaults (§3.4) ──────────────────────────────────────────────────── */

/** `.env` (and `.env.*`) but NOT `*.env.example` — the deny target (§3.4). */
export function isProtectedEnvFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (base.endsWith(".env.example") || base.endsWith(".env.sample")) return false;
  return base === ".env" || base.startsWith(".env.") || base.endsWith(".env");
}

/** Whether a path escapes the workspace root (external-directory → ask, §3.4). */
export function isExternalPath(path: string, workspaceRoot: string): boolean {
  const root = workspaceRoot.replace(/\/$/, "");
  if (path.startsWith("/")) return !(path === root || path.startsWith(`${root}/`));
  // a relative path that climbs out of the root
  return path.split("/").includes("..") && countClimb(path) > 0;
}
function countClimb(path: string): number {
  let depth = 0;
  for (const seg of path.split("/")) {
    if (seg === "..") depth -= 1;
    else if (seg !== "." && seg !== "") depth += 1;
    if (depth < 0) return 1;
  }
  return 0;
}

/** Count consecutive identical trailing refs (the doom-loop run length). */
export function doomLoopRunLength(history: readonly string[], ref: string): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === ref) n += 1;
    else break;
  }
  return n;
}

/* ── the engine ────────────────────────────────────────────────────────────── */

const RESULT = (decision: PermissionDecision, reason: string, rule?: string): PermissionResult => ({
  decision,
  reason,
  ...(rule ? { rule } : {}),
});

/**
 * Evaluate one tool call against the rule list + safe defaults (§3.4). Order:
 * (1) `.env` deny (hard safe-default); (2) external-dir → ask; (3) doom-loop → ask;
 * (4) last-matching user rule wins; (5) base default (`allow`). A malformed rule is
 * skipped (never silently flips to allow). `allow` here is policy-only — the gate still runs.
 */
export function evaluatePermission(
  input: PermissionInput,
  rules: readonly PermissionRule[],
  ctx: PermissionContext,
  baseDefault: PermissionDecision = "allow",
): PermissionResult {
  // (1) .env deny — the one place a default is hard
  for (const p of input.paths ?? []) {
    if (isProtectedEnvFile(p))
      return RESULT("deny", `secret-bearing file refused: ${p}`, "safe-default:.env");
  }
  // (2) external-directory → ask
  for (const p of input.paths ?? []) {
    if (isExternalPath(p, ctx.workspaceRoot)) {
      return RESULT("ask", `path outside the workspace: ${p}`, "safe-default:external-dir");
    }
  }
  // (4) last-matching rule wins (evaluated before the doom-loop escalation so an
  //     explicit deny still denies; an explicit allow is escalated to ask by the loop guard)
  let matched: PermissionResult | undefined;
  for (const rule of rules) {
    let hit = false;
    if (rule.match.startsWith("bash:") && input.argv) {
      hit = matchBashPattern(rule.match.slice("bash:".length), input.argv);
    } else if (!rule.match.startsWith("bash:")) {
      try {
        hit = matchRef(rule.match, input.ref);
      } catch {
        hit = false; // malformed glob → skip, never allow
      }
    }
    if (hit) matched = RESULT(rule.decision, `rule "${rule.match}"`, rule.match);
  }
  const base = matched ?? RESULT(baseDefault, "base default");
  // (3) doom-loop: an otherwise-allowed call repeated 3+ times → ask (break the loop)
  const threshold = ctx.doomLoopThreshold ?? 3;
  if (base.decision === "allow" && doomLoopRunLength(ctx.callHistory, input.ref) + 1 >= threshold) {
    return RESULT(
      "ask",
      `doom-loop guard: ${input.ref} called ${threshold}+ times — confirm to continue`,
      "safe-default:doom-loop",
    );
  }
  return base;
}

/** Bind a rule set into a reusable evaluator (the ToolBroker pre-filter). */
export function permissionEngine(
  rules: readonly PermissionRule[],
  baseDefault: PermissionDecision = "allow",
): (input: PermissionInput, ctx: PermissionContext) => PermissionResult {
  return (input, ctx) => evaluatePermission(input, rules, ctx, baseDefault);
}
