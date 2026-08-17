/**
 * routes/security-console-view.ts — PURE view model for the handoff_3 §4 Security console.
 *
 * §4 adds three things the route could not previously say: how the gate is CONFIGURED (armed,
 * fail-closed), what it has DECIDED (allow/warn/block counts), and how far a remediation has
 * got. All three are derivations over data the route already holds, and all three are easy to
 * get subtly wrong in a way a screenshot cannot catch — so they live here.
 *
 * ## The counts are of DECISIONS, not of files
 *
 * `gateCounts` folds the gate-audit log, which has one row per gate invocation. Two scans of
 * the same artifact are two rows, and that is deliberate: the pills say "the gate blocked
 * three times today", not "three bad files exist". A de-duplicated count would quietly hide a
 * user who is retrying a blocked install over and over, which is exactly the pattern the
 * banner should make visible.
 */

/* ── the gate banner ─────────────────────────────────────────────────────────*/

/** §4's banner copy. One home, so the console and any future status surface agree. */
export const GATE_BANNER_TITLE = "nemesis gate — armed, fail-closed";
export const GATE_BANNER_NOTE =
  "Every fetched artifact is scanned before it can execute. A scanner that cannot answer counts as a refusal, not as a pass.";

/** The verdict tallies behind the banner's pills. */
export interface GateCounts {
  allow: number;
  warn: number;
  block: number;
  /** the scanner could not speak — counted separately, never folded into `block`. */
  error: number;
  total: number;
}

/** The audit row shape these helpers read. Structural, so the UI type satisfies it. */
export interface AuditRowLike {
  at: string;
  label?: string;
  target: string;
  verdict: string;
  blocking_reasons?: string[];
  tier?: string;
  decision?: string | null;
}

/**
 * Tally the audit log.
 *
 * An unrecognised verdict string counts as `error`, not as `allow`. The gate log is written by
 * the engine and read here; a verdict this build does not know about is precisely the case
 * where assuming "fine" is unsafe, and the pill row is the one place a user looks to decide
 * whether anything needs attention.
 */
export function gateCounts(rows: readonly AuditRowLike[]): GateCounts {
  const c: GateCounts = { allow: 0, warn: 0, block: 0, error: 0, total: rows.length };
  for (const r of rows) {
    switch (r.verdict) {
      case "allow":
        c.allow += 1;
        break;
      case "warn":
        c.warn += 1;
        break;
      case "block":
        c.block += 1;
        break;
      default:
        c.error += 1;
    }
  }
  return c;
}

/* ── verdict history rows ────────────────────────────────────────────────────*/

/**
 * A compact relative age: `now`, `4m`, `3h`, `6d`, `2w`.
 *
 * Deliberately coarse. The exact timestamp is one hover away in the signed log below; what
 * this column answers is "is this still relevant", and a full locale timestamp in a 74px-chip
 * row is the thing that pushes the artifact path into an ellipsis.
 */
export function ageLabel(at: string, now: number = Date.now()): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "—";
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 45) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** One row of §4's verdict-history island. */
export interface HistoryRow {
  key: string;
  verdict: string;
  /** the artifact the gate ran on (mono, ellipsized). */
  artifact: string;
  /** where it came from — the audit `label`, else the tier. */
  source: string;
  /** "3 findings" / "clean" — never a bare number with no noun. */
  findings: string;
  age: string;
}

/** Summarise a row's findings. Zero reasons on a non-allow verdict is still not "clean". */
export function findingsSummary(row: AuditRowLike): string {
  const n = row.blocking_reasons?.length ?? 0;
  if (n > 0) return `${n} ${n === 1 ? "finding" : "findings"}`;
  return row.verdict === "allow" ? "clean" : "no reason recorded";
}

/**
 * Project the audit log into history rows, newest first.
 *
 * The log arrives in the engine's order; this sorts explicitly rather than trusting it,
 * because a history island that silently shows the OLDEST verdict at the top is the kind of
 * bug that survives review — it looks completely normal.
 */
export function historyRows(
  rows: readonly AuditRowLike[],
  opts: { limit?: number; now?: number } = {},
): HistoryRow[] {
  const now = opts.now ?? Date.now();
  const sorted = [...rows].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const capped = typeof opts.limit === "number" ? sorted.slice(0, opts.limit) : sorted;
  return capped.map((r, i) => ({
    key: `${r.at}:${r.target}:${i}`,
    verdict: r.verdict,
    artifact: r.target,
    source: r.label || r.tier || "—",
    findings: findingsSummary(r),
    age: ageLabel(r.at, now),
  }));
}

/* ── remediation progress ────────────────────────────────────────────────────*/

/** `2 / 3` — resolved findings out of the ones the run addressed. */
export interface RemediationProgress {
  done: number;
  total: number;
}

/**
 * Derive the progress bar from a disinfect RESULT.
 *
 * Returns null while a run is in flight, and that is the honest answer: the engine's
 * `resolved`/`unresolved` split is computed from the post-fix re-scan, so it does not exist
 * until the run ends. The island shows an indeterminate bar until then rather than a
 * determinate one climbing on invented steps — a bar that says `2/3` while the truth is
 * unknown is worse than a bar that admits it is still working.
 */
export function remediationProgress(
  result: { resolved?: unknown; unresolved?: unknown } | null | undefined,
): RemediationProgress | null {
  if (!result) return null;
  const done = Array.isArray(result.resolved) ? result.resolved.length : 0;
  const left = Array.isArray(result.unresolved) ? result.unresolved.length : 0;
  const total = done + left;
  return total > 0 ? { done, total } : null;
}
