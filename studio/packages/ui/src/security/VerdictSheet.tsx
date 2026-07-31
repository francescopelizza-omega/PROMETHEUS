/**
 * VerdictSheet.tsx — the full nemesis verdict, rendered (file 03 §5).
 *
 * One sheet for all four tiers (allow / warn / block / error). Its color + label
 * come ONLY from the §3 verdictMapping mirror (`verdictDisplay`) — this component
 * NEVER scores, never recomputes risk, never decides "safe" (C5). It paints what
 * the engine returned and offers the §3 override affordance:
 *
 *   - allow  → green "SAFE — no known threats found"; proceed CTA.
 *   - warn   → amber "REVIEW"; findings list. If a CRITICAL/HIGH finding is
 *              present (`needsExplicitApproval`), the "Install anyway" CTA is
 *              GATED behind an explicit acknowledgement checkbox (§5.2).
 *   - block / error → deep-red; PRIMARY CTA is "Cancel". The Force escape hatch
 *              hides under a collapsed "▸ Advanced: override this block"
 *              disclosure (§5.3) — friction by design.
 *
 * Also surfaces the honesty surface (§6/§11): safe_to triad, blocking_reasons,
 * severity counts, a blind-spot / unscannable note, the `cached` badge, policy.
 * Every engine string is inert text. Decision callbacks are PROPS.
 */

import { type ReactElement, useState } from "react";
import { Button } from "../components/Button.js";
import { VerdictBadge } from "../components/VerdictBadge.js";
import { t } from "../i18n/index.js";
import { SEVERITY_ROLE, type Severity } from "../tokens.js";
import { FindingRow } from "./FindingRow.js";
import type { SecFinding, SecSeverity, SecVerdict } from "./types.js";
import { inertText, needsExplicitApproval, roleVar, verdictDisplay } from "./util.js";

const SEVERITY_ORDER: SecSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

function severityKey(sev: SecSeverity): Severity {
  switch (sev) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "clean";
  }
}

/** Flatten findings_by_class into one list (top_findings first, then the rest). */
function allFindings(verdict: SecVerdict): SecFinding[] {
  const seen = new Set<SecFinding>();
  const out: SecFinding[] = [];
  for (const f of verdict.top_findings ?? []) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  for (const list of Object.values(verdict.findings_by_class ?? {})) {
    for (const f of list ?? []) {
      if (!seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
  }
  return out;
}

export interface VerdictSheetProps {
  verdict: SecVerdict;
  /** Reflects the policy the engine RAN under; gates MEDIUM in warn (§5.2). */
  strict?: boolean;
  /** allow/warn proceed (or "Install anyway"); the renderer wires the install. */
  onProceed?: () => void;
  /** Cancel / hold (block/error primary, warn secondary). */
  onCancel?: () => void;
  /** Open the Force-override dialog (block/error, under the Advanced disclosure). */
  onRequestForce?: () => void;
  /** §5.2 warn secondary: disinfect then install (security.remediate disinfect). */
  onDisinfect?: () => void;
  /** §5.2 refuse: quarantine the scanned source (security.remediate quarantine). */
  onQuarantine?: () => void;
  /** §5.2: surface the full signed verdict JSON (the verdict_full nemesis verify reads). */
  onViewJson?: () => void;
  /** §5.2 click → open a finding's file at its line in the editor. */
  onOpenLocation?: (path: string, line: number | undefined) => void;
  className?: string;
}

/** A small key→value honesty line. */
function Fact({
  label,
  children,
}: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div style={{ display: "flex", gap: "var(--space-3, 6px)", alignItems: "baseline" }}>
      <span
        style={{
          color: "var(--text-secondary)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          minWidth: "8.5rem",
        }}
      >
        {label}
      </span>
      <span
        style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-small-size, 0.8125rem)" }}
      >
        {children}
      </span>
    </div>
  );
}

export function VerdictSheet({
  verdict,
  strict = false,
  onProceed,
  onCancel,
  onRequestForce,
  onDisinfect,
  onQuarantine,
  onViewJson,
  onOpenLocation,
  className,
}: VerdictSheetProps): ReactElement {
  const display = verdictDisplay(verdict.verdict);
  const color = roleVar(display.color);
  const [acknowledged, setAcknowledged] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const refuse = display.defaultAction === "refuse"; // block / error
  const requiresApproval = needsExplicitApproval(verdict.verdict, verdict.severity_counts, {
    strict,
  });
  const findings = allFindings(verdict);

  return (
    <section
      className={className}
      data-verdict={verdict.verdict}
      aria-label={t("verdict.sheetLabel", { label: display.label })}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-8, 16px)",
        background: "var(--bg-surface)",
        border: `1px solid ${refuse ? color : "var(--border-subtle)"}`,
        borderRadius: "var(--radius-lg, 10px)",
        padding: "var(--space-12, 24px)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-ui)",
        // refuse tiers get a faint deep-red wash behind the whole sheet.
        backgroundImage: refuse
          ? `linear-gradient(0deg, color-mix(in srgb, ${color} 6%, transparent), color-mix(in srgb, ${color} 6%, transparent))`
          : undefined,
      }}
    >
      {/* ── header: badge + label + cached ────────────────────────────────── */}
      {/* role="alert"/assertive so a screen reader announces a blocked install the
          instant the sheet mounts (08 §7 — "a blocked install must be announced").
          A plain <div> (not <header>) carries the alert role — a landmark element
          must not be overridden with a live-region role. */}
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        style={{ display: "flex", alignItems: "center", gap: "var(--space-6, 12px)" }}
      >
        <VerdictBadge verdict={verdict.verdict} risk_score={verdict.risk_score} />
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1, 2px)" }}>
          <strong style={{ color, fontSize: "var(--text-h1-size, 1.375rem)" }}>
            {display.label}
          </strong>
          <span
            style={{
              color: "var(--text-secondary)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            {inertText(verdict.target)}
          </span>
        </div>
        {verdict.cached && (
          <span
            style={{
              marginLeft: "auto",
              paddingInline: "var(--space-3, 6px)",
              paddingBlock: "var(--space-1, 2px)",
              borderRadius: "var(--radius-full, 9999px)",
              border: "1px solid var(--border-strong)",
              color: "var(--text-secondary)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
            title="This verdict was served from the local verdict cache."
          >
            cached
          </span>
        )}
      </div>

      {/* ── recommendation (engine string, inert) ─────────────────────────── */}
      {typeof verdict.recommendation === "string" && verdict.recommendation.length > 0 && (
        <p style={{ margin: 0, color: "var(--text-secondary)" }}>
          {inertText(verdict.recommendation)}
        </p>
      )}

      {/* ── blocking_reasons (refuse tiers) ───────────────────────────────── */}
      {verdict.blocking_reasons?.length > 0 && (
        <ul
          style={{
            margin: 0,
            paddingLeft: "var(--space-12, 24px)",
            color: refuse ? color : "var(--text-primary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          {verdict.blocking_reasons.map((reason, i) => (
            <li key={`${i}-${reason}`}>{inertText(reason)}</li>
          ))}
        </ul>
      )}

      {/* ── honesty facts: safe_to / counts / blind-spot / policy ─────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 4px)" }}>
        <Fact label="Safe to install">{verdict.safe_to?.install ? "yes" : "no"}</Fact>
        <Fact label="Safe to run">{verdict.safe_to?.run_plug_and_play ? "yes" : "no"}</Fact>
        <Fact label="Safe as AI agent">{verdict.safe_to?.use_as_ai_cli_agent ? "yes" : "no"}</Fact>
        <Fact label="Severity counts">
          <span>
            {SEVERITY_ORDER.filter((s) => (verdict.severity_counts?.[s] ?? 0) > 0)
              .map((s) => `${s} ${verdict.severity_counts[s]}`)
              .join("  ") || "none"}
          </span>
        </Fact>
        <Fact label="Policy">{inertText(verdict.policy)}</Fact>
        <Fact label="Files scanned">{String(verdict.provenance?.files_scanned ?? 0)}</Fact>
      </div>

      {/* ── blind-spot / unscannable note (honesty surface §6/§11) ────────── */}
      {(verdict.unscannable ||
        (verdict.provenance && !verdict.provenance.db.seeded) ||
        (verdict.provenance?.sca_unscanned_ecosystems?.length ?? 0) > 0) && (
        <div
          role="note"
          style={{
            padding: "var(--space-4, 8px)",
            border: "1px solid var(--warn)",
            borderRadius: "var(--radius-md, 6px)",
            background: "color-mix(in srgb, var(--warn) 10%, transparent)",
            color: "var(--warn)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          {verdict.unscannable && <div>Some content could not be scanned (blind spot).</div>}
          {verdict.provenance && !verdict.provenance.db.seeded && (
            <div>Signature DB not seeded — known-malware detection is OFF.</div>
          )}
          {(verdict.provenance?.sca_unscanned_ecosystems?.length ?? 0) > 0 && (
            <div>
              Dependencies not scanned for:{" "}
              {verdict.provenance.sca_unscanned_ecosystems.map((e) => inertText(e)).join(", ")}
            </div>
          )}
        </div>
      )}

      {/* ── findings list (warn/block/error) ──────────────────────────────── */}
      {findings.length > 0 && (
        <div
          style={{
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md, 6px)",
            overflow: "hidden",
          }}
        >
          {findings.map((f, i) => (
            <FindingRow
              key={`${f.rule_id}-${f.path}-${i}`}
              finding={f}
              onOpenLocation={onOpenLocation}
            />
          ))}
        </div>
      )}

      {/* ── warn: explicit-approval checkbox (gates "Install anyway") ─────── */}
      {verdict.verdict === "warn" && requiresApproval && (
        <label
          style={{
            display: "flex",
            gap: "var(--space-3, 6px)",
            alignItems: "flex-start",
            color: "var(--text-primary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.currentTarget.checked)}
          />
          <span>
            I have reviewed the findings above and accept the risk of installing this anyway.
          </span>
        </label>
      )}

      {/* ── actions ───────────────────────────────────────────────────────── */}
      <footer style={{ display: "flex", gap: "var(--space-4, 8px)", flexWrap: "wrap" }}>
        {!refuse && (
          <Button
            variant={verdict.verdict === "allow" ? "primary" : "danger"}
            disabled={requiresApproval && !acknowledged}
            onClick={onProceed}
          >
            {verdict.verdict === "allow" ? t("verdict.install") : t("verdict.installAnyway")}
          </Button>
        )}
        {/* warn secondary: disinfect then install (§5.2). */}
        {verdict.verdict === "warn" && onDisinfect && (
          <Button variant="ghost" onClick={onDisinfect}>
            {t("verdict.disinfectInstall")}
          </Button>
        )}
        {refuse && (
          <Button variant="primary" onClick={onCancel}>
            {t("verdict.cancel")}
          </Button>
        )}
        {/* refuse: quarantine the scanned source (§5.2). */}
        {refuse && onQuarantine && (
          <Button variant="ghost" onClick={onQuarantine}>
            {t("verdict.quarantine")}
          </Button>
        )}
        {!refuse && (
          <Button variant="ghost" onClick={onCancel}>
            {t("verdict.cancel")}
          </Button>
        )}
        {/* always available: the full signed verdict JSON (verdict_full). */}
        {onViewJson && (
          <Button variant="ghost" onClick={onViewJson}>
            {t("verdict.viewJson")}
          </Button>
        )}

        {/* refuse tiers: Force hides under a collapsed Advanced disclosure (§5.3) */}
        {refuse && (
          <div style={{ width: "100%", marginTop: "var(--space-4, 8px)" }}>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontFamily: "var(--font-ui)",
                fontSize: "var(--text-small-size, 0.8125rem)",
                padding: 0,
              }}
            >
              <span aria-hidden="true">{advancedOpen ? "▾" : "▸"}</span> Advanced: override this
              block
            </button>
            {advancedOpen && (
              <div style={{ marginTop: "var(--space-4, 8px)" }}>
                <Button variant="danger" onClick={onRequestForce}>
                  ☠ Force install at my own risk…
                </Button>
              </div>
            )}
          </div>
        )}
      </footer>
    </section>
  );
}

export default VerdictSheet;
