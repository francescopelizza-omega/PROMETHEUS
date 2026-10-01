// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * FindingRow.tsx — one nemesis finding as a row (file 03 §4 / §10).
 *
 * Renders rule_id + a severity chip (tinted by the SEVERITY_ROLE token, never the
 * sole signal — a glyph + text carry it too, 08 §7), the finding class, and the
 * `path:line` locator. An expandable drawer reveals the snippet + detail.
 *
 * GOLDEN RULE (C5 / §2.1): every engine-sourced string (detail, snippet, path,
 * rule_id) is rendered as INERT TEXT — funnelled through `inertText` (ANSI +
 * control chars stripped) and dropped into a React TEXT child or a <pre>. NEVER
 * dangerouslySetInnerHTML, NEVER markdown-with-raw-HTML. This component decides
 * nothing about "safe" — the severity it shows is the one the engine classified.
 */

import { type ReactElement, useState } from "react";
import { t } from "../i18n/index.js";
import { type RoleToken, SEVERITY_GLYPH, SEVERITY_ROLE, type Severity } from "../tokens.js";
import type { SecFinding, SecSeverity } from "./types.js";
import { inertText } from "./util.js";

/** Map the engine's UPPERCASE severity token to the lowercase tokens.ts key. */
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
      return "clean"; // INFO → the calm "clean" role/glyph
  }
}

/** A severity role → CSS var (text-secondary is the only non-`--role` mapping). */
function roleVar(role: RoleToken): string {
  return role === "text-secondary" ? "var(--text-secondary)" : `var(--${role})`;
}

/** The severity chip — color + glyph + uppercase token (color is never alone). */
function SeverityChip({ severity }: { severity: SecSeverity }): ReactElement {
  const key = severityKey(severity);
  // INFO is a calm, muted signal (08 §2.2 info → --text-secondary) — NOT green:
  // a green chip would read as a passed/clean check. Mirrors patterns/util severityRole.
  const role: RoleToken = severity === "INFO" ? "text-secondary" : SEVERITY_ROLE[key];
  const color = roleVar(role);
  return (
    <span
      data-severity={severity}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2, 4px)",
        paddingInline: "var(--space-3, 6px)",
        paddingBlock: "var(--space-1, 2px)",
        borderRadius: "var(--radius-full, 9999px)",
        border: `1px solid ${color}`,
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-small-size, 0.8125rem)",
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">{SEVERITY_GLYPH[key]}</span>
      {severity}
    </span>
  );
}

export interface FindingRowProps {
  finding: SecFinding;
  /** Start with the snippet drawer open (default false). */
  defaultExpanded?: boolean;
  /** Trailing control(s) — e.g. a Disinfect-bucket badge or a checkbox. */
  trailing?: ReactElement;
  /** Open the finding's file at its line (08 §5.2 click → editor). When set, the
   *  locator renders as a keyboard-operable link (§7). */
  onOpenLocation?: (path: string, line: number | undefined) => void;
  className?: string;
}

/** The `path:line:col` locator, ANSI/control-stripped, in mono. */
function locator(finding: SecFinding): string {
  const path = inertText(finding.path);
  const line = typeof finding.line === "number" ? `:${finding.line}` : "";
  const col = typeof finding.column === "number" ? `:${finding.column}` : "";
  return `${path}${line}${col}`;
}

export function FindingRow({
  finding,
  defaultExpanded = false,
  trailing,
  onOpenLocation,
  className,
}: FindingRowProps): ReactElement {
  const [open, setOpen] = useState(defaultExpanded);
  const hasDrawer =
    (typeof finding.snippet === "string" && finding.snippet.length > 0) ||
    (typeof finding.detail === "string" && finding.detail.length > 0);
  // The accessible row name: severity, rule_id, location (08 §7 — SR announces
  // severity/rule_id/file/line; via the i18n catalog, not concatenation).
  const rowLabel = t("findingRow.spoken", {
    severity: finding.severity,
    rule: inertText(finding.rule_id),
    loc: locator(finding),
  });

  return (
    <div
      className={className}
      data-rule-id={finding.rule_id}
      style={{
        display: "flex",
        flexDirection: "column",
        borderBottom: "1px solid var(--border-subtle)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <div
        aria-label={rowLabel}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4, 8px)",
          paddingBlock: "var(--space-3, 6px)",
          paddingInline: "var(--space-4, 8px)",
        }}
      >
        {hasDrawer ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Collapse finding detail" : "Expand finding detail"}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              padding: 0,
              width: "1.2em",
            }}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span style={{ width: "1.2em" }} />
        )}
        <SeverityChip severity={finding.severity} />
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
          {inertText(finding.rule_id)}
        </span>
        <span
          style={{
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          {inertText(finding.klass)}
        </span>
        {onOpenLocation ? (
          <button
            type="button"
            aria-label={t("findingRow.openLocation", { loc: locator(finding) })}
            title={t("findingRow.openLocation", { loc: locator(finding) })}
            onClick={() => onOpenLocation(inertText(finding.path), finding.line)}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "var(--accent)",
              textDecoration: "underline",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
              whiteSpace: "nowrap",
              maxWidth: "40%",
            }}
          >
            {locator(finding)}
          </button>
        ) : (
          <span
            style={{
              marginLeft: "auto",
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
              whiteSpace: "nowrap",
              maxWidth: "40%",
            }}
            title={locator(finding)}
          >
            {locator(finding)}
          </span>
        )}
        {trailing}
      </div>
      {open && hasDrawer && (
        <div
          style={{
            paddingInline: "var(--space-8, 16px)",
            paddingBottom: "var(--space-4, 8px)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3, 6px)",
          }}
        >
          {typeof finding.detail === "string" && finding.detail.length > 0 && (
            <p
              style={{
                margin: 0,
                color: "var(--text-secondary)",
                fontSize: "var(--text-small-size, 0.8125rem)",
              }}
            >
              {inertText(finding.detail)}
            </p>
          )}
          {typeof finding.snippet === "string" && finding.snippet.length > 0 && (
            <pre
              style={{
                margin: 0,
                padding: "var(--space-4, 8px)",
                background: "var(--bg-inset)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-md, 6px)",
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-code-size, 0.78125rem)",
                lineHeight: 1.5,
                overflowX: "auto",
                whiteSpace: "pre",
              }}
            >
              {inertText(finding.snippet)}
            </pre>
          )}
          {typeof finding.remediation === "string" && finding.remediation.length > 0 && (
            <p
              style={{
                margin: 0,
                color: "var(--text-secondary)",
                fontSize: "var(--text-small-size, 0.8125rem)",
              }}
            >
              <span style={{ color: "var(--accent)" }}>Fix: </span>
              {inertText(finding.remediation)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default FindingRow;
