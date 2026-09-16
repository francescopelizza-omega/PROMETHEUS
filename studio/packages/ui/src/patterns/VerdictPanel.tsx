/**
 * VerdictPanel.tsx — the full scan_report rendered (08 §3.2 / §5.2): the body of the
 * security verdict modal/drawer. Verdict header (badge + risk gauge), blocking
 * reasons, grouped/sorted findings, the honesty caption, and the §5.2 action row
 * (Approve / Disinfect / Quarantine·Purge / Force…). Owned VISUALLY here; the
 * BEHAVIOUR (what each action does) lives in file 03 — every action is a callback PROP.
 *
 * Binds a `scan_report` (the PatternVerdictReport mirror) via a TYPE-ONLY import (C5).
 *
 * GOLDEN RULE (C5): NEVER scores/decides — it paints the `verdict`/`risk_score`/
 * `blocking_reasons`/`active_findings` the engine returned. Every string is inert.
 * The CTA set is gated purely by the engine tier (block/error ⇒ no inline install;
 * Force is the deep-red typed-confirm escape, opened by the caller). aria-live on
 * the header announces the verdict to a screen reader (08 §7).
 */

import type { ReactElement } from "react";
import { VerdictBadge } from "../components/VerdictBadge.js";
import { t } from "../i18n/index.js";
import { FindingRow } from "./FindingRow.js";
import { RiskGauge } from "./RiskGauge.js";
import type { PatternFinding, PatternVerdictReport } from "./types.js";
import { inert, klassVar, sortFindings } from "./util.js";

export interface VerdictPanelProps {
  report: PatternVerdictReport;
  /** Open a finding's `rel_path:line` in the editor (forwarded to each FindingRow). */
  onOpenLocation?: (rel_path: string, line: number | undefined) => void;
  /** Approve the artifact (allow/warn only — the primary CTA when not blocked). */
  onApprove?: () => void;
  /** Disinfect & install (warn variant secondary CTA). */
  onDisinfect?: () => void;
  /** Quarantine the source (block/error). */
  onQuarantine?: () => void;
  /** Open the deep-red Force typed-confirm flow (block override; never one-click). */
  onForce?: () => void;
  /** View the full signed verdict JSON. */
  onViewJson?: () => void;
  /** Cancel / dismiss. */
  onCancel?: () => void;
  className?: string;
}

/** The §5.2 honesty caption per tier (heuristic static analysis — not a sandbox). */
function honesty(verdict: PatternVerdictReport["verdict"]): string {
  switch (verdict) {
    case "allow":
      return t("verdict.honestyAllow");
    case "warn":
      return t("verdict.honestyWarn");
    case "error":
      return t("verdict.honestyError");
    default:
      return t("verdict.honestyBlock");
  }
}

/** A per-class count chip ("malware 2 · secret 1 · …"). */
function ClassChips({
  counts,
}: {
  counts: PatternVerdictReport["class_counts"];
}): ReactElement | null {
  const entries = Object.entries(counts ?? {}).filter(([, n]) => typeof n === "number" && n > 0);
  if (entries.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
      {entries.map(([klass, n]) => (
        <span
          key={klass}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-2, 4px)",
            paddingInline: "var(--space-3, 6px)",
            paddingBlock: "var(--space-1, 2px)",
            borderRadius: "var(--radius-sm, 4px)",
            border: `1px solid ${klassVar(klass)}`,
            color: klassVar(klass),
            background: `color-mix(in srgb, ${klassVar(klass)} 12%, transparent)`,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            lineHeight: 1,
          }}
        >
          {inert(klass)} {n}
        </span>
      ))}
    </div>
  );
}

export function VerdictPanel({
  report,
  onOpenLocation,
  onApprove,
  onDisinfect,
  onQuarantine,
  onForce,
  onViewJson,
  onCancel,
  className,
}: VerdictPanelProps): ReactElement {
  const { verdict, risk_score, target, blocking_reasons, active_findings, class_counts } = report;
  const findings: PatternFinding[] = sortFindings(active_findings ?? []);
  const reasons = (blocking_reasons ?? []).map(inert).filter((r) => r.length > 0);
  const blocked = verdict === "block" || verdict === "error";

  return (
    <section
      className={className}
      data-verdict={verdict}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-8, 16px)",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      {/* header — badge + target + risk gauge (announced to a screen reader). */}
      <header
        aria-live="assertive"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-6, 12px)",
            flexWrap: "wrap",
          }}
        >
          <VerdictBadge verdict={verdict} risk_score={risk_score} />
          {target != null && (
            <span
              title={inert(target)}
              style={{
                color: "var(--text-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-small-size, 0.8125rem)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                whiteSpace: "nowrap",
                maxWidth: "60%",
              }}
            >
              {inert(target)}
            </span>
          )}
        </div>
        <RiskGauge score={risk_score} />
      </header>

      {/* blocking reasons. */}
      {reasons.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" }}>
          <h3
            style={{
              margin: 0,
              fontSize: "var(--text-h2-size, 1rem)",
              fontWeight: 600,
            }}
          >
            {t("verdict.blockingReasons")}
          </h3>
          <ul
            style={{
              margin: 0,
              paddingInlineStart: "var(--space-12, 24px)",
              color: "var(--danger)",
            }}
          >
            {reasons.map((r) => (
              <li key={r} style={{ fontSize: "var(--text-small-size, 0.8125rem)" }}>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* findings — grouped header + class chips + the sorted rows. */}
      {findings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-6, 12px)",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "var(--text-h2-size, 1rem)", fontWeight: 600 }}>
              {t("verdict.findingsCount", { count: findings.length })}
            </h3>
            <ClassChips counts={class_counts} />
          </div>
          <div
            style={{
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-lg, 10px)",
              overflow: "hidden",
              background: "var(--bg-surface)",
            }}
          >
            {findings.map((f, i) => (
              <FindingRow
                key={`${f.rule_id}:${f.rel_path}:${f.line ?? i}`}
                finding={f}
                onOpenLocation={onOpenLocation}
              />
            ))}
          </div>
        </div>
      )}

      {/* honesty caption. */}
      <p
        style={{
          margin: 0,
          color: "var(--text-secondary)",
          fontSize: "var(--text-small-size, 0.8125rem)",
        }}
      >
        {honesty(verdict)}
      </p>

      {/* action row — gated by the engine tier (08 §5.2). */}
      <footer
        style={{
          display: "flex",
          gap: "var(--space-4, 8px)",
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        {onViewJson && (
          <button type="button" onClick={onViewJson} style={ghostBtn()}>
            {t("verdict.viewJson")}
          </button>
        )}
        {blocked && onQuarantine && (
          <button type="button" onClick={onQuarantine} style={ghostBtn()}>
            {t("verdict.quarantine")}
          </button>
        )}
        {onCancel && (
          <button type="button" onClick={onCancel} style={ghostBtn()}>
            {t("verdict.cancel")}
          </button>
        )}
        {!blocked && verdict === "warn" && onDisinfect && (
          <button type="button" onClick={onDisinfect} style={secondaryBtn()}>
            {t("verdict.disinfectInstall")}
          </button>
        )}
        {!blocked && onApprove && (
          <button type="button" onClick={onApprove} style={primaryBtn()}>
            {verdict === "warn" ? t("verdict.installAnyway") : t("verdict.install")}
          </button>
        )}
        {blocked && verdict === "block" && onForce && (
          <button type="button" onClick={onForce} style={dangerBtn()}>
            {t("verdict.force")}
          </button>
        )}
      </footer>
    </section>
  );
}

/* ── local button surfaces (token-styled; the real <Button/> primitive is used by
 *    feature screens — the panel keeps its own inline surfaces to stay self-contained). ── */

function baseBtn() {
  return {
    paddingInline: "var(--space-8, 16px)",
    paddingBlock: "var(--space-3, 6px)",
    borderRadius: "var(--radius-md, 6px)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-body-size, 0.875rem)",
    fontWeight: 600,
    cursor: "pointer",
    lineHeight: 1.2,
  } as const;
}
function ghostBtn() {
  return {
    ...baseBtn(),
    background: "transparent",
    border: "1px solid var(--border-strong)",
    color: "var(--text-secondary)",
  };
}
function secondaryBtn() {
  return {
    ...baseBtn(),
    background: "transparent",
    border: "1px solid var(--accent)",
    color: "var(--accent)",
  };
}
function primaryBtn() {
  return {
    ...baseBtn(),
    background: "var(--brand)",
    border: "1px solid var(--brand)",
    // The label sits ON the `--brand` fill, so it needs the computed `--on-brand`.
    // `--brand-fg` is #ffffff on the dark scheme and measures 3.96:1 over `--brand` —
    // under the 4.5:1 a label carries. It stays in use where it is a FILL, not a label
    // (the Toggle knob), which is why this is a call-site change and not a token change.
    color: "var(--on-brand)",
  };
}
function dangerBtn() {
  return {
    ...baseBtn(),
    background: "var(--danger)",
    border: "1px solid var(--danger)",
    // `--on-danger` is the computed label colour for the `--danger` FILL (tokens/contrast.ts `onFill`).
    // The old `--brand-fg` here was WHITE on the dark scheme over a saturated light fill (~2:1),
    // and a plain `--bg-app` would be near-white over the same fill on the LIGHT scheme.
    color: "var(--on-danger)",
  };
}

export default VerdictPanel;
