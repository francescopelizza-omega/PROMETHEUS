/**
 * FindingRow.tsx — one nemesis finding as a row (08 §3.2 / §5.2).
 *
 * `severity ▍` bar + `rule_id` (mono) + `rel_path:line` (mono, click → opens the
 * file in the editor at that line) + a klass tag. Binds an `active_findings[]` row
 * (the PatternFinding mirror) via a TYPE-ONLY import — the renderer passes a real
 * engine finding straight in (C5).
 *
 * GOLDEN RULE (C5): every engine-sourced string (rule_id, rel_path, klass, detail)
 * is rendered INERT (run through `inert()` — ANSI + control stripped). This
 * component decides NOTHING about "safe": the severity it shows is the one the
 * engine classified; color is paired with a glyph + text label (08 §7, never color
 * alone). The locator click is a callback PROP — no IPC lives here.
 */

import type { ReactElement } from "react";
import { t } from "../i18n/index.js";
import type { PatternFinding } from "./types.js";
import { inert, klassVar, severityGlyph, severityVar } from "./util.js";

export interface FindingRowProps {
  finding: PatternFinding;
  /** Open `rel_path` at `line` in the editor — the click-to-editor jump (§3.2). */
  onOpenLocation?: (rel_path: string, line: number | undefined) => void;
  className?: string;
}

/** The `rel_path:line` locator string, ANSI/control-stripped, in mono. */
function locator(finding: PatternFinding): string {
  const path = inert(finding.rel_path);
  const line = typeof finding.line === "number" ? `:${finding.line}` : "";
  return `${path}${line}`;
}

export function FindingRow({ finding, onOpenLocation, className }: FindingRowProps): ReactElement {
  const sevVar = severityVar(finding.severity);
  const sevGlyph = severityGlyph(finding.severity);
  const loc = locator(finding);
  const klass = inert(finding.klass ?? "");
  const ruleId = inert(finding.rule_id);
  const detail = inert(finding.detail ?? "");
  const spoken = t("findingRow.spoken", { severity: finding.severity, rule: ruleId, loc });

  return (
    <div
      className={className}
      data-rule-id={ruleId}
      data-severity={finding.severity}
      aria-label={spoken}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-4, 8px)",
        borderBottom: "1px solid var(--border-subtle)",
        paddingBlock: "var(--space-3, 6px)",
        paddingInline: "var(--space-4, 8px)",
        fontFamily: "var(--font-ui)",
      }}
    >
      {/* severity ▍ bar — color + glyph (color never alone, 08 §7). */}
      <span
        aria-hidden="true"
        title={finding.severity}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-2, 4px)",
          color: sevVar,
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          lineHeight: 1,
          minWidth: "1.2em",
        }}
      >
        <span style={{ color: sevVar }}>▍</span>
        <span>{sevGlyph}</span>
      </span>

      {/* rule_id (mono). */}
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, whiteSpace: "nowrap" }}>
        {ruleId}
      </span>

      {/* rel_path:line — a button so it is keyboard-operable + click → editor. */}
      {onOpenLocation ? (
        <button
          type="button"
          aria-label={`Open ${loc}`}
          onClick={() => onOpenLocation(inert(finding.rel_path), finding.line)}
          title={loc}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 0,
            color: "var(--accent)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            textDecoration: "underline",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
            whiteSpace: "nowrap",
            maxWidth: "34%",
            textAlign: "left",
          }}
        >
          {loc}
        </button>
      ) : (
        <span
          title={loc}
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
            whiteSpace: "nowrap",
            maxWidth: "34%",
          }}
        >
          {loc}
        </span>
      )}

      {/* detail — inert, ellipsised. */}
      {detail.length > 0 && (
        <span
          title={detail}
          style={{
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {detail}
        </span>
      )}

      {/* klass tag — icon-tinted, never the sole signal (08 §2.2). Raw engine
          active_findings[] carry no klass, so render the chip only when present. */}
      {klass.length > 0 && (
        <span
          data-klass={klass}
          aria-label={`class ${klass}`}
          style={{
            marginLeft: detail.length > 0 ? undefined : "auto",
            display: "inline-flex",
            alignItems: "center",
            paddingInline: "var(--space-3, 6px)",
            paddingBlock: "var(--space-1, 2px)",
            borderRadius: "var(--radius-sm, 4px)",
            border: `1px solid ${klassVar(klass)}`,
            color: klassVar(klass),
            background: `color-mix(in srgb, ${klassVar(klass)} 12%, transparent)`,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          {klass}
        </span>
      )}
    </div>
  );
}

export default FindingRow;
