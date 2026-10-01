// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * DisinfectWizard.tsx — guided remediation, then the HONEST residual (file 03 §9.1).
 *
 * Given a verdict's findings, it splits them (via the pure `disinfectPlan`) into:
 *   - Remediable — the offending line will be NEUTRALISED in place; a `.bak` of
 *     the original is kept so the edit is reversible.
 *   - Not remediable — hard malware / in-archive findings that can only be
 *     QUARANTINED, never fixed in place.
 * The [Disinfect & re-scan] CTA hands both buckets to `onDisinfect`; the renderer
 * runs the engine remediation + a fresh scan, then passes the resulting verdict
 * back as `result`. We render THAT honest residual verdict (it may still be warn/
 * block) — the wizard never claims success the engine didn't confirm (C5/§11).
 *
 * Presentational: it derives buckets, emits the action, and renders the residual
 * VerdictSheet. Engine strings are inert text.
 */

import { type ReactElement, useState } from "react";
import { Button } from "../components/Button.js";
import { FindingRow } from "./FindingRow.js";
import { VerdictSheet } from "./VerdictSheet.js";
import type { SecFinding, SecVerdict } from "./types.js";
import { disinfectPlan } from "./util.js";

export interface DisinfectWizardProps {
  /** The findings to remediate (typically a verdict's flattened findings). */
  findings: SecFinding[];
  /** Run the remediation + re-scan; the renderer wires window.prometheus.*. */
  onDisinfect?: (plan: { remediable: SecFinding[]; quarantineOnly: SecFinding[] }) => void;
  /** The honest re-scan verdict, set by the renderer after disinfection. */
  result?: SecVerdict;
  /** True while the remediation + re-scan is running. */
  busy?: boolean;
  className?: string;
}

function Bucket({
  title,
  note,
  findings,
  accent,
}: {
  title: string;
  note: string;
  findings: SecFinding[];
  accent: string;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3, 6px)" }}>
        <strong style={{ color: accent }}>
          {title} ({findings.length})
        </strong>
        <span
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          {note}
        </span>
      </div>
      {findings.length > 0 ? (
        <div
          style={{
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md, 6px)",
            overflow: "hidden",
          }}
        >
          {findings.map((f, i) => (
            <FindingRow key={`${f.rule_id}-${f.path}-${i}`} finding={f} />
          ))}
        </div>
      ) : (
        <span
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          none
        </span>
      )}
    </div>
  );
}

export function DisinfectWizard({
  findings,
  onDisinfect,
  result,
  busy = false,
  className,
}: DisinfectWizardProps): ReactElement {
  const [requested, setRequested] = useState(false);
  const plan = disinfectPlan(findings);

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-8, 16px)",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      <Bucket
        title="Will neutralise in place"
        note="the offending line is rewritten; a .bak is kept"
        findings={plan.remediable}
        accent="var(--ok)"
      />
      <Bucket
        title="Will quarantine"
        note="cannot be fixed in place — sidelined instead"
        findings={plan.quarantineOnly}
        accent="var(--warn)"
      />

      <div>
        <Button
          variant="primary"
          disabled={busy || (plan.remediable.length === 0 && plan.quarantineOnly.length === 0)}
          onClick={() => {
            setRequested(true);
            onDisinfect?.(plan);
          }}
        >
          {busy ? "Disinfecting…" : "Disinfect & re-scan"}
        </Button>
      </div>

      {/* the honest residual verdict (may still be warn/block) */}
      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" }}>
          <strong style={{ color: "var(--text-secondary)" }}>Re-scan result</strong>
          <VerdictSheet verdict={result} />
        </div>
      )}
      {requested && !result && !busy && (
        <p
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          Waiting for the re-scan verdict…
        </p>
      )}
    </div>
  );
}

export default DisinfectWizard;
