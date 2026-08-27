/**
 * main/ide/gate.ts — the GATE-BEFORE-RUN logic (file 07 §5.2 / §9, C4/C5).
 *
 * THE GOLDEN RULE made concrete (C5): the editor may open + edit files freely, but
 * the moment it would EXECUTE a project — the FIRST Run/Debug of a freshly-opened-
 * or-cloned workspace — it crosses a gate. JS NEVER decides "safe": this module
 * reuses the REAL engine-bridge `gate()` (the only nemesis spawner) and renders its
 * verdict. FAIL-CLOSED: a missing/timed-out/unparseable scanner ⇒ verdict "error"
 * ⇒ BLOCK (engine-bridge already collapses those to "error").
 *
 * The decision (file 07 §5.2):
 *   has this workspace been gated at its current HEAD?
 *     ├─ trusted (a clean verdict bound to the source commit in trust.json) → ALLOW
 *     │   immediately (no re-prompt on every F5 — only when the tree changes),
 *     └─ untrusted / changed → run the REAL `gate(workspaceRoot)`:
 *         ├─ allow → launch          (ALLOW)
 *         ├─ warn  → modal w/ findings + "Run anyway?" (defaults NO) (WARN)
 *         └─ block/error → refuse; open Gate Log; offer `nemesis ui`  (BLOCK)
 *
 * The trust check reuses engine-bridge's `listTrusted()` (reads ~/.config/
 * prometheus/trust.json, fail-soft) — Studio writes no trust itself; the engine
 * owns the verdict cache + the HMAC-signed audit trail (C5). This module only
 * MATCHES a workspace+HEAD against that store and, when no trust exists, asks the
 * engine for a fresh verdict.
 *
 * Node/stdlib + engine-bridge only (the sanctioned nemesis spawner). LIVE: the
 * gate() path runs the real binary; the trust path reads the real trust store.
 */

import {
  type EngineConfig,
  type SecurityVerdict,
  type TrustedSource,
  type VerdictTier,
  gate as engineGate,
  listTrusted,
} from "@prometheus/engine-bridge";

/* ------------------------------------------------------------------------- *
 * The run-gate decision shape (what ide-ipc / the renderer renders)
 * ------------------------------------------------------------------------- */

/** The run-gate outcome the renderer acts on (file 07 §5.2). */
export type RunGateDecision = "allow" | "warn" | "block";

/** The full run-gate result — a RENDERED engine verdict, never a JS-fabricated one. */
export interface RunGateResult {
  /** allow → launch · warn → "Run anyway?" modal (default NO) · block → refuse. */
  decision: RunGateDecision;
  /** true only for `decision === "allow"` — the single boolean the launcher checks. */
  mayLaunch: boolean;
  /** true when the decision came from a cached/trusted verdict (no fresh scan ran). */
  trusted: boolean;
  /** the workspace this verdict is for. */
  workspaceRoot: string;
  /** the engine verdict (present when a fresh scan ran). */
  verdict?: SecurityVerdict;
  /** the trust-store entry that satisfied the gate (present when trusted). */
  trustEntry?: TrustedSource;
  /** a short human reason for the Gate Log. */
  reason: string;
}

/** Map an engine VerdictTier → the run-gate decision (the SPINE collapse). */
function decisionFromTier(tier: VerdictTier): RunGateDecision {
  switch (tier) {
    case "allow":
      return "allow";
    case "warn":
      return "warn";
    default:
      // block + error (fail-closed) both refuse the launch.
      return "block";
  }
}

/* ------------------------------------------------------------------------- *
 * Trust matching (reads the engine trust store; JS decides nothing about safety)
 * ------------------------------------------------------------------------- */

/**
 * The workspace identity the trust check matches on. `workspaceRoot` is the
 * file:///abs or /abs path; `head` is the current git HEAD sha when the workspace
 * is a repo (the verdict cache binds a clean verdict to the source commit, §5.2).
 */
export interface WorkspaceIdentity {
  workspaceRoot: string;
  /** the git HEAD sha (40-hex) when known — undefined for a non-repo workspace. */
  head?: string;
}

/**
 * Does the trust store hold a CLEAN verdict for this workspace at this HEAD?
 * Pure over the supplied trust list (injectable for tests; defaults to the live
 * `listTrusted()`). A match requires:
 *   - the entry's pinned `ident` references the current HEAD (sha / `tree:` / a
 *     content shape the engine wrote), AND
 *   - the entry's recorded `verdict` is a NON-blocking token (allow/warn/clean).
 * A blocked/error trust token never satisfies the gate (it would re-prompt). When
 * `head` is unknown (non-repo) NO trust can match — we always fall through to a
 * fresh scan (the safe direction). JS never UPGRADES toward trusted here; it only
 * recognises a clean entry the engine previously wrote.
 */
export function hasTrustedVerdict(
  id: WorkspaceIdentity,
  trusted: TrustedSource[] = listTrusted(),
): TrustedSource | undefined {
  if (!id.head) return undefined;
  const head = id.head.toLowerCase();
  const rootTail = pathTail(id.workspaceRoot);
  for (const entry of trusted) {
    if (!identMatchesHead(entry.ident, head)) continue;
    // a recorded blocking verdict never counts as trusted.
    if (isBlockingToken(entry.verdict)) continue;
    // best-effort workspace association: the trust key/source mentions the root tail.
    if (rootTail && !mentionsRoot(entry, rootTail)) continue;
    return entry;
  }
  return undefined;
}

/** Does a pinned trust ident reference this HEAD sha? (full or abbreviated, or `tree:`/`git:`-prefixed). */
function identMatchesHead(ident: string, head: string): boolean {
  if (!ident) return false;
  const norm = ident.toLowerCase();
  // strip a known prefix the engine may write (e.g. "git:<sha>", "tree:<hash>").
  const bare = norm.includes(":") ? norm.slice(norm.lastIndexOf(":") + 1) : norm;
  if (bare.length < 7) return false; // too short to be a sha to match on
  return head.startsWith(bare) || bare.startsWith(head);
}

/** Is a recorded verdict token a BLOCKING one (block/error/critical/high)? */
function isBlockingToken(verdict: string | undefined): boolean {
  if (!verdict) return false;
  const v = verdict.toLowerCase();
  return v === "block" || v === "error" || v === "critical" || v === "high";
}

/** Does the trust entry's key/source mention the workspace root tail? */
function mentionsRoot(entry: TrustedSource, rootTail: string): boolean {
  return (
    entry.key.toLowerCase().includes(rootTail.toLowerCase()) ||
    (entry.source ?? "").toLowerCase().includes(rootTail.toLowerCase()) ||
    // a generic dir-pinned entry with no path hint is accepted (HEAD already matched).
    !(entry.source ?? "").includes("/")
  );
}

/** The trailing path segment of a workspace root (for the loose association). */
function pathTail(p: string): string {
  const clean = p.replace(/^file:\/\//, "").replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx === -1 ? clean : clean.slice(idx + 1);
}

/* ------------------------------------------------------------------------- *
 * The run-gate (file 07 §5.2) — trusted → skip; else REAL engine gate; fail-closed
 * ------------------------------------------------------------------------- */

/** Options threaded into the run-gate (engine config + an injectable trust reader). */
export interface RunGateOptions {
  engineConfig?: EngineConfig;
  /** abort signal forwarded to the nemesis run. */
  signal?: AbortSignal;
  /** stderr sink for the live gate progress feed (cosmetic, C5). */
  onStderr?: (line: string) => void;
  /** injectable trust reader (defaults to the live `listTrusted()`); tests stub it. */
  readTrusted?: () => TrustedSource[];
  /** injectable gate runner (defaults to the REAL engine-bridge `gate()`); tests stub it. */
  runGate?: (target: string) => Promise<SecurityVerdict>;
  /**
   * Resolve the workspace's current HEAD sha when the REQUEST did not carry one.
   *
   * `hasTrustedVerdict` returns undefined the moment `id.head` is absent, and no renderer ever
   * sent it — so step 1 below, the documented "clean verdict bound to the current HEAD ⇒ ALLOW
   * immediately, no fresh scan, no F5 re-prompt", could never fire in production. Every Run and
   * every Debug paid for a full nemesis scan of the tree, and a repo whose scan tiers `warn`
   * re-prompted on every launch with no way to make it stop.
   *
   * Resolved HERE rather than pushed onto the renderer: main already has the workspace root and
   * a git host, the renderer is the least-trusted surface in the app (C5), and a trust-store
   * lookup keyed on a sha the RENDERER supplied would be a worse contract than one keyed on a
   * sha main read for itself. Injectable so tests need no repository.
   */
  resolveHead?: (workspaceRoot: string) => Promise<string | undefined>;
}

/**
 * Read the workspace's HEAD sha with plain git, or undefined when it is not a repository.
 *
 * Best-effort by design: a non-repo workspace, a fresh repo with no commits, or a missing git
 * binary all mean "no sha to key trust on", which correctly falls through to a fresh scan.
 */
async function defaultResolveHead(workspaceRoot: string): Promise<string | undefined> {
  // Through the git HOST, not `child_process` — C5 allows that import only inside
  // @prometheus/engine-bridge, and the lint rule is right: this module has no business
  // spawning. `headSha` already returns undefined for every "no sha" case.
  const { GitHost } = await import("./git-host.js");
  return new GitHost().headSha(workspaceRoot);
}

/**
 * Decide whether a Run/Debug of `id.workspaceRoot` may launch (file 07 §5.2).
 *
 *   1. If the trust store already holds a CLEAN verdict bound to the current HEAD →
 *      ALLOW immediately (`trusted:true`, no fresh scan — no F5 re-prompt).
 *   2. Otherwise run the REAL nemesis gate on the workspace tree and collapse:
 *      allow → ALLOW · warn → WARN (renderer shows "Run anyway?" default NO) ·
 *      block/error → BLOCK.
 *
 * FAIL-CLOSED (C5): the gate runner already returns verdict "error" on any failure
 * to obtain a trustworthy verdict (missing binary / timeout / unparseable) → BLOCK.
 * This function NEVER returns ALLOW for anything but tier "allow" or a clean
 * trusted entry; it never upgrades a verdict toward allow.
 */
export async function runGate(
  id: WorkspaceIdentity,
  opts: RunGateOptions = {},
): Promise<RunGateResult> {
  const workspaceRoot = id.workspaceRoot;
  if (!workspaceRoot || !workspaceRoot.trim()) {
    // nothing to launch → fail closed.
    return {
      decision: "block",
      mayLaunch: false,
      trusted: false,
      workspaceRoot,
      reason: "empty workspace root",
    };
  }

  // 1) trusted at this HEAD? → skip the scan.
  // The request rarely carries `head` (no renderer sends it), so resolve it here — without a
  // sha the trust lookup below cannot match anything and the fast path is dead.
  const readTrusted = opts.readTrusted ?? (() => listTrusted());
  let ident = id;
  if (!ident.head) {
    const resolved = await (opts.resolveHead ?? defaultResolveHead)(workspaceRoot).catch(
      () => undefined,
    );
    if (resolved) ident = { ...id, head: resolved };
  }
  let trustEntry: TrustedSource | undefined;
  try {
    trustEntry = hasTrustedVerdict(ident, readTrusted());
  } catch {
    // a broken trust read is NOT a reason to allow — fall through to a fresh scan.
    trustEntry = undefined;
  }
  if (trustEntry) {
    return {
      decision: "allow",
      mayLaunch: true,
      trusted: true,
      workspaceRoot,
      trustEntry,
      reason: `trusted verdict bound to HEAD ${id.head ?? "?"} (no re-scan)`,
    };
  }

  // 2) untrusted / changed → REAL nemesis gate (LIVE). Fail-closed inside gate().
  const doGate =
    opts.runGate ??
    ((target: string) =>
      engineGate(
        target,
        {
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
        },
        opts.engineConfig ?? {},
      ));

  let verdict: SecurityVerdict;
  try {
    verdict = await doGate(workspaceRoot);
  } catch (e) {
    // gate() is documented to fail closed and not throw; a hard crash still BLOCKS.
    return {
      decision: "block",
      mayLaunch: false,
      trusted: false,
      workspaceRoot,
      reason: `gate crashed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const decision = decisionFromTier(verdict.verdict);
  return {
    decision,
    mayLaunch: decision === "allow",
    trusted: false,
    workspaceRoot,
    verdict,
    reason: reasonFor(decision, verdict),
  };
}

/** A short Gate-Log reason line for a fresh verdict. */
function reasonFor(decision: RunGateDecision, verdict: SecurityVerdict): string {
  const n = verdict.findings.length;
  switch (decision) {
    case "allow":
      return `nemesis: allow (risk ${verdict.risk_score})`;
    case "warn":
      return `nemesis: warn — ${n} finding${n === 1 ? "" : "s"} (risk ${verdict.risk_score}); confirm before run`;
    default:
      return `nemesis: ${verdict.verdict} — ${n} finding${n === 1 ? "" : "s"} (risk ${verdict.risk_score}); launch refused`;
  }
}
