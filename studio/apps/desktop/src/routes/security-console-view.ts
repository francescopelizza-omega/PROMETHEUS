// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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

import {
  type ClassifiedLine,
  type StreamLineLevel,
  classifyStreamLine,
  streamLineLevel,
} from "./stream-line-level.js";

/* ── the gate banner ─────────────────────────────────────────────────────────*/

/**
 * §4's banner copy — DERIVED from the gate's actual mode, not asserted.
 *
 * The banner used to be two constants rendered unconditionally under a green shield. The
 * engine branches on `PROMETHEUS_GATE` (prometheus.py) and records the mode it ran in on
 * EVERY audit row as `gate_mode`; that field is parsed by engine-bridge and typed all the
 * way into the UI package, and had zero readers anywhere in the repo. So a user running
 * `PROMETHEUS_GATE=off` — nothing scanned at all — opened the security console and was told,
 * in green, "nemesis gate — armed, fail-closed".
 *
 * That is a false security claim on the security console itself, which is why the mode now
 * decides the copy AND the tint. The rules:
 *
 *   enforce  → armed, fail-closed (the only state that earns the green shield)
 *   warn     → findings are reported, nothing is blocked
 *   off      → nothing is being scanned
 *   unknown  → we have not seen a decision, so we do not claim one either way
 *
 * "unknown" is deliberately NOT green. An empty audit log and an unreadable audit log are
 * currently indistinguishable at the bridge (it fails soft to `[]`), so the honest banner in
 * both cases is "we cannot see our own evidence", never a reassurance.
 */
export type GateMode = "enforce" | "warn" | "off" | "unknown";

export interface GateBanner {
  mode: GateMode;
  title: string;
  note: string;
  /** the role token the shield chip and title tint with. */
  role: "ok" | "warn" | "danger";
}

const BANNERS: Record<GateMode, Omit<GateBanner, "mode">> = {
  enforce: {
    title: "nemesis gate — armed, fail-closed",
    note: "Every staged artifact is scanned before it can execute. A scanner that cannot answer counts as a refusal, not as a pass.",
    role: "ok",
  },
  warn: {
    title: "nemesis gate — WARN MODE, nothing is blocked",
    note: "Findings are reported and recorded, but a block does not stop an install. Set PROMETHEUS_GATE=enforce to fail closed.",
    role: "warn",
  },
  off: {
    title: "nemesis gate — OFF, nothing is being scanned",
    note: "PROMETHEUS_GATE is set to off, so artifacts execute without a verdict. Nothing on this page describes what is running now.",
    role: "danger",
  },
  unknown: {
    title: "nemesis gate — mode unknown",
    note: "No gate decision has been recorded by the engine in this session, so the console cannot say which mode it is running in. The mode comes from PROMETHEUS_GATE in the environment that launched the app.",
    role: "warn",
  },
};

/** Normalise the engine's `gate_mode` string; anything unrecognised is `unknown`. */
export function gateModeOf(raw: string | undefined | null): GateMode {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return v === "enforce" || v === "warn" || v === "off" ? v : "unknown";
}

/**
 * The banner for an audit log, newest-first (the order `auditLog()` returns).
 *
 * `opts.configured` — main's own `$PROMETHEUS_GATE`, i.e. the mode the NEXT engine spawn will
 * inherit — wins outright when it is recognised. That is a LIVE fact about the running process,
 * and the whole failure this function had was inferring a present-tense claim from history.
 *
 * Without it, falls back to the newest row that carries a mode AND is not older than `sinceMs`.
 * The ordering rule alone does not deliver the invariant: "newest row wins" says nothing about
 * whether that row has anything to do with the process now running, so an `enforce` row from
 * last week vouched for a session started today with `PROMETHEUS_GATE=off`, painting
 * `role: "ok"`. `break`, not `continue`, once a row is too old — the list is newest-first, so
 * nothing after it can be newer.
 *
 * With neither, the banner says it cannot tell rather than guessing.
 */
export function gateBanner(
  rows: readonly { gate_mode?: string; at?: string }[] | null | undefined,
  opts: { sinceMs?: number; configured?: string | null } = {},
): GateBanner {
  const live = gateModeOf(opts.configured);
  if (live !== "unknown") return { mode: live, ...BANNERS[live] };
  const list = Array.isArray(rows) ? rows : [];
  for (const r of list) {
    const mode = gateModeOf(r?.gate_mode);
    if (mode === "unknown") continue;
    if (opts.sinceMs !== undefined) {
      const t = Date.parse(r?.at ?? "");
      if (!Number.isFinite(t) || t < opts.sinceMs) break; // too old to vouch for this session
    }
    return { mode, ...BANNERS[mode] };
  }
  return { mode: "unknown", ...BANNERS.unknown };
}

/** Back-compat re-exports — the enforce copy, for surfaces that have no audit log to read. */
export const GATE_BANNER_TITLE = BANNERS.enforce.title;
export const GATE_BANNER_NOTE = BANNERS.enforce.note;

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
  // `blocking_reasons` are the gate's SENTENCES, not scanner findings — the audit row
  // carries no findings array at all. Calling them "findings" put a count of prose in the
  // column every other surface uses for nemesis rule hits.
  const n = row.blocking_reasons?.length ?? 0;
  if (n > 0) return `${n} ${n === 1 ? "reason" : "reasons"}`;
  // …and "clean" is a SEVERITY word (tokens.ts says so verbatim: "`clean` is a SEVERITY,
  // never a verdict"). Deriving it from the TIER `allow` restates the decision as if it were
  // an independent measurement — §4's two-axis rule, in the row beside the verdict chip.
  return row.verdict === "allow" ? "no findings recorded" : "no reason recorded";
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

/**
 * Classify one streamed remediation line into a StreamLog level.
 *
 * Delegates to the SHARED classifier: the catalog install log needed the identical thing
 * (handoff_3 §2's coloured lines), and the two engines emit overlapping vocabulary — a
 * nemesis scan line shows up in both — so a second copy here would drift the moment either
 * spec moved. Kept as a named export because "remediation" is the kind this route always
 * passes, and a call site that has to remember a string literal is a call site that will
 * one day pass the wrong one.
 */
export function remediationLineLevel(text: string): StreamLineLevel {
  return streamLineLevel(text, "remediation");
}

/**
 * Classify a remediation line AND return the text to print.
 *
 * Same delegation as above, to the variant that also strips a leading marker the gutter
 * glyph is about to repeat. Named here so the route never has to remember the kind string.
 */
export function classifyRemediationLine(text: string): ClassifiedLine {
  return classifyStreamLine(text, "remediation");
}
