/**
 * DangerRibbon.tsx — the persistent forced-danger ribbon (file 03 §5.4).
 *
 * After a user FORCES a dangerous install over a deep-red block, this ribbon
 * stays pinned (NON-dismissable — there is intentionally no close button) for as
 * long as that forced artifact is installed. It restates the date and the rule
 * ids that were overridden, and offers the three remediation exits as callbacks:
 * [Quarantine] [Uninstall] [View audit]. The renderer wires those to
 * window.prometheus.security.*; this component only renders + emits.
 *
 * It decides nothing — it surfaces a `forced_danger` record the engine wrote and
 * makes the consequence permanently visible (C5 honesty surface). Engine strings
 * (label, rule ids) are inert text.
 */

import type { ReactElement } from "react";
import { Button } from "../components/Button.js";
import type { SecForcedDanger } from "./types.js";
import { inertText } from "./util.js";

export interface DangerRibbonProps {
  item: SecForcedDanger;
  /** Rule ids that were overridden (the renderer extracts them from the record). */
  ruleIds?: string[];
  onQuarantine?: () => void;
  onUninstall?: () => void;
  onViewAudit?: () => void;
  className?: string;
}

/** Format an ISO timestamp to a short local date string (fails soft to the raw). */
function shortDate(at: string | undefined): string {
  if (typeof at !== "string" || at.length === 0) return "unknown date";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? inertText(at) : d.toLocaleString();
}

export function DangerRibbon({
  item,
  ruleIds,
  onQuarantine,
  onUninstall,
  onViewAudit,
  className,
}: DangerRibbonProps): ReactElement {
  const rules = ruleIds ?? item.blocking_reasons ?? [];
  return (
    <div
      className={className}
      role="alert"
      aria-label="Forced dangerous install is active"
      data-forced-danger="true"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-6, 12px)",
        flexWrap: "wrap",
        paddingBlock: "var(--space-3, 6px)",
        paddingInline: "var(--space-6, 12px)",
        background: "color-mix(in srgb, var(--danger) 18%, var(--bg-surface))",
        borderTop: "2px solid var(--danger)",
        borderBottom: "2px solid var(--danger)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--text-small-size, 0.8125rem)",
      }}
    >
      <span aria-hidden="true" style={{ color: "var(--danger)", fontSize: "1.2rem" }}>
        ☠
      </span>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1, 2px)",
          flex: 1,
          minWidth: "12rem",
        }}
      >
        <strong style={{ color: "var(--danger)" }}>
          Forced dangerous install: {inertText(item.label)}
        </strong>
        <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
          {shortDate(item.at)}
          {rules.length > 0 && <> · {rules.map((r) => inertText(r)).join(", ")}</>}
        </span>
      </div>
      <div style={{ display: "flex", gap: "var(--space-2, 4px)" }}>
        <Button size="sm" variant="secondary" onClick={onQuarantine}>
          Quarantine
        </Button>
        <Button size="sm" variant="danger" onClick={onUninstall}>
          Uninstall
        </Button>
        <Button size="sm" variant="ghost" onClick={onViewAudit}>
          View audit
        </Button>
      </div>
    </div>
  );
}

export default DangerRibbon;
