/**
 * verdict-view.ts — render a C3 SecurityVerdict and map a tier to a PROCESS
 * EXIT CODE. This is pure presentation over a verdict engine-bridge already
 * decided (C5): the CLI never upgrades/downgrades safety here.
 *
 * EXIT CODE contract (mirrors nemesis decision tiers, per the task spec):
 *   allow -> 0 · warn -> 10 · block -> 20 · error -> 2
 */
import type {
  Finding,
  ForcedDangerFull,
  NemesisVerdict,
  SecurityVerdict,
  Severity,
  VerdictTier,
} from "@prometheus/engine-bridge";
import { normalizeSeverity, parseNemesisVerdict } from "@prometheus/engine-bridge";

import { bgBanner, c, kv, table } from "./render.js";

/** Map a VerdictTier to the process exit code the CLI must use. */
export function exitCodeForTier(tier: VerdictTier): number {
  switch (tier) {
    case "allow":
      return 0;
    case "warn":
      return 10;
    case "block":
      return 20;
    case "error":
      return 2;
  }
}

/** A colored, uppercased label for a verdict tier (allow green, block red, …). */
export function tierLabel(tier: VerdictTier): string {
  switch (tier) {
    case "allow":
      return c.green("ALLOW");
    case "warn":
      return c.yellow("WARN");
    case "block":
      return c.red("BLOCK");
    case "error":
      return c.red("ERROR");
  }
}

/** A short headline sentence for the verdict. */
export function tierHeadline(tier: VerdictTier): string {
  switch (tier) {
    case "allow":
      return "Safe to install / run / use.";
    case "warn":
      return "Proceed with caution — review the findings below.";
    case "block":
      return "BLOCKED — known threats detected. Do not install/run.";
    case "error":
      return "FAIL-CLOSED — could not obtain a trustworthy verdict. Treat as BLOCKED.";
  }
}

function severityColor(sev: Finding["severity"]): string {
  switch (sev) {
    case "critical":
      return c.red(sev.toUpperCase());
    case "high":
      return c.red(sev.toUpperCase());
    case "medium":
      return c.yellow(sev.toUpperCase());
    case "low":
      return c.blue(sev.toUpperCase());
    case "clean":
      return c.green(sev.toUpperCase());
  }
}

/**
 * Render a full SecurityVerdict to a multi-line string for `prometheus gate`.
 * Includes the colored verdict, the risk score, signed flag, and a findings
 * table when present.
 */
export function renderVerdict(v: SecurityVerdict): string {
  const out: string[] = [];
  out.push(`${tierLabel(v.verdict)}  ${c.dim(tierHeadline(v.verdict))}`);
  out.push("");
  out.push(kv("target", v.target || "—"));
  out.push(kv("risk score", riskScoreColored(v.verdict, v.risk_score)));
  out.push(kv("signed", v.signed ? c.green("yes") : c.dim("no")));
  out.push(kv("scanned at", c.dim(v.scannedAt)));

  if (v.findings.length > 0) {
    out.push("");
    out.push(c.bold(`findings (${v.findings.length})`));
    const rows = v.findings.map((f) => [
      severityColor(f.severity),
      f.klass,
      f.rule,
      c.dim(f.where),
    ]);
    out.push(
      table(
        [{ header: "SEVERITY" }, { header: "CLASS" }, { header: "RULE" }, { header: "WHERE" }],
        rows,
      ),
    );
  } else if (v.verdict === "allow") {
    out.push("");
    out.push(c.dim("No findings."));
  }

  return out.join("\n");
}

function riskScoreColored(tier: VerdictTier, score: number): string {
  const s = String(score);
  switch (tier) {
    case "allow":
      return c.green(s);
    case "warn":
      return c.yellow(s);
    default:
      return c.red(s);
  }
}

/* ── The unified verdict CARD (CLI-039) ────────────────────────────────────────── *
 * ONE renderer for both the light `SecurityVerdict` (client.gate) and the full
 * `NemesisVerdict` (gateFull) — banner + kv block + blind-ceiling line + findings table
 * + a per-tier next-step hint. Presentation only (C5): it never re-decides a verdict. */

const BANNER: Record<VerdictTier, { text: string; tone: "ok" | "warn" | "danger" }> = {
  allow: { text: "GATE PASSED", tone: "ok" },
  warn: { text: "GATE WARN", tone: "warn" },
  block: { text: "GATE BLOCKED", tone: "danger" },
  error: { text: "GATE ERROR — FAIL-CLOSED", tone: "danger" },
};

/** One dim next-step line per verdict class (deliverable 4). */
const NEXT_STEP: Record<VerdictTier, string> = {
  allow: "Next: safe to proceed — add --sign to record a verifiable verdict in the audit log.",
  warn: "Next: review the findings; `prometheus secure disinfect <target>` neutralizes the fixable ones.",
  block: "Next: do NOT install/run — inspect with `nemesis defang <target>` or quarantine it.",
  error: "Next: fail-closed, no trustworthy verdict — check `prometheus doctor` and $NEMESIS_BIN.",
};

const TIER_RANK: Record<VerdictTier, number> = { allow: 0, warn: 1, block: 2, error: 3 };
const MAX_CARD_ROWS = 8;

interface CardRow {
  rule: string;
  severity: Severity;
  where: string;
  excerpt: string;
}
interface CardModel {
  tier: VerdictTier;
  target: string;
  risk: number | null;
  signed: boolean | null;
  scannedAt: string | null;
  policy: string | null;
  cached: boolean | null;
  /** the target could not be fully inspected (unscannable / an in-container finding). */
  capped: boolean;
  rows: CardRow[];
  totalFindings: number;
  recommendation: string | null;
  blockingReasons: string[];
}

function cardFromSecurity(v: SecurityVerdict): CardModel {
  return {
    tier: v.verdict,
    target: v.target,
    risk: v.risk_score,
    signed: v.signed,
    scannedAt: v.scannedAt,
    policy: null,
    cached: null,
    capped: false, // the light path carries no unscannable / container signal
    rows: v.findings.map((f) => ({
      rule: f.rule,
      severity: f.severity,
      where: f.where,
      excerpt: "—",
    })),
    totalFindings: v.findings.length,
    recommendation: null,
    blockingReasons: [],
  };
}

function cardFromNemesis(v: NemesisVerdict): CardModel {
  const top = Array.isArray(v.top_findings) ? v.top_findings : [];
  const rows: CardRow[] = top.map((f) => ({
    rule: f.rule_id || f.rule || "—", // the stable rule id first (acceptance: "rule ids")
    severity: normalizeSeverity(f.severity),
    where: f.path ?? "—",
    excerpt: f.detail || f.category || "—",
  }));
  const classTotal = Object.values(v.class_counts ?? {}).reduce<number>(
    (a, n) => a + (typeof n === "number" ? n : 0),
    0,
  );
  return {
    tier: v.verdict,
    target: v.target,
    risk: v.risk_score,
    signed: Boolean(v.signature),
    scannedAt: v.scanned_at,
    policy: v.policy ?? null,
    cached: v.cached ?? null,
    // blind ceiling: unscannable OR any finding whose engine class is "container".
    capped: v.unscannable === true || top.some((f) => f.klass === "container"),
    rows,
    totalFindings: Math.max(classTotal, rows.length),
    recommendation: v.recommendation || null,
    blockingReasons: Array.isArray(v.blocking_reasons) ? v.blocking_reasons : [],
  };
}

function cardFromForcedDanger(fd: ForcedDangerFull[], fallbackTarget: string): CardModel {
  const worst = fd.reduce((a, b) => (TIER_RANK[b.verdict] > TIER_RANK[a.verdict] ? b : a));
  return {
    tier: worst.verdict,
    target: worst.label || fallbackTarget,
    risk: worst.risk_score,
    signed: null,
    scannedAt: null,
    policy: null,
    cached: null,
    capped: false,
    rows: [],
    totalFindings: 0,
    recommendation: null,
    blockingReasons: fd.flatMap((f) =>
      Array.isArray(f.blocking_reasons) ? f.blocking_reasons : [],
    ),
  };
}

/** Collapse whitespace and truncate an excerpt to `max` DISPLAY columns (adds an ellipsis). */
function truncateExcerpt(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1))}…`;
}

function termWidth(): number {
  const cols = process.stdout.columns;
  return typeof cols === "number" && cols > 0 ? cols : 80;
}

function renderCard(m: CardModel): string {
  const b = BANNER[m.tier];
  const out: string[] = [bgBanner(b.text, b.tone), ""];
  out.push(kv("target", m.target || "—"));
  if (m.risk !== null) out.push(kv("risk score", riskScoreColored(m.tier, m.risk)));
  if (m.signed !== null) out.push(kv("signed", m.signed ? c.green("yes") : c.dim("no")));
  if (m.scannedAt) out.push(kv("scanned at", c.dim(m.scannedAt)));
  if (m.policy) out.push(kv("policy", c.dim(m.policy)));
  if (m.cached) out.push(kv("cache", c.dim("hit (re-run --fresh to bypass)")));

  if (m.capped) {
    out.push("");
    out.push(
      c.dim(
        "⚠ verdict CAPPED (blind ceiling): part of the target could not be inspected — this is NOT a clean scan.",
      ),
    );
  }

  if (m.rows.length > 0) {
    out.push("");
    out.push(c.bold(`findings (${m.totalFindings})`));
    const exMax = Math.max(20, termWidth() - 50);
    const shown = m.rows.slice(0, MAX_CARD_ROWS);
    const rows = shown.map((r) => [
      r.rule || "—",
      severityColor(r.severity),
      c.dim(r.where || "—"),
      truncateExcerpt(r.excerpt || "—", exMax),
    ]);
    out.push(
      table(
        [{ header: "RULE" }, { header: "SEVERITY" }, { header: "WHERE" }, { header: "EXCERPT" }],
        rows,
      ),
    );
    if (m.totalFindings > shown.length) {
      out.push(c.dim(`  … and ${m.totalFindings - shown.length} more (use --json)`));
    }
  }

  for (const r of m.blockingReasons) out.push(c.red(`  ! ${r}`));

  out.push("");
  if (m.recommendation) out.push(c.dim(m.recommendation));
  out.push(c.dim(NEXT_STEP[m.tier]));
  return out.join("\n");
}

/** Render EITHER a light SecurityVerdict or a full NemesisVerdict as one unified card. */
export function renderVerdictCard(v: SecurityVerdict | NemesisVerdict): string {
  return renderCard("top_findings" in v ? cardFromNemesis(v) : cardFromSecurity(v));
}

/**
 * Opportunistically render a verdict card from an ENGINE ENVELOPE (the install flow) — a nested
 * `nemesis.verdict/1` object or an install `forced_danger[]` block. Returns null when nothing
 * parseable is present (the caller then passes the engine text through unchanged); NEVER re-runs
 * the gate. Pretty-mode only — the caller keeps `--json` byte-identical.
 */
export function verdictCardFromEnvelope(env: unknown): string | null {
  if (!env || typeof env !== "object") return null;
  const e = env as Record<string, unknown>;
  if (e.schema === "nemesis.verdict/1" && typeof e.verdict === "string") {
    return renderVerdictCard(parseNemesisVerdict(e, String(e.target ?? "")));
  }
  const fd = e.forced_danger;
  if (Array.isArray(fd) && fd.length > 0) {
    return renderCard(
      cardFromForcedDanger(fd as ForcedDangerFull[], String(e.command ?? "install")),
    );
  }
  return null;
}
