/**
 * patterns/VerdictCard.tsx — the nemesis verdict card (handoff §4).
 *
 * ONE rendering contract, used in all four places a verdict can appear: the Home
 * island, the catalog install flow, the security console, and the chat transcript.
 * A verdict that looks different depending on where you meet it is a verdict you
 * learn to skim.
 *
 * The contract, verbatim from §4:
 *   - a chip carrying GLYPH + WORD (never color alone) — ◑ WARN / ● ALLOW / ✕ BLOCK;
 *   - the artifact name (mono) + its source kind;
 *   - findings: rule id (mono, severity-colored) + one-line description + file:line
 *     (mono, muted). SUPPRESSED findings render greyed with their reason;
 *   - actions: Details · Install anyway… (warn outline; a BLOCK demands a typed
 *     confirm, which the host supplies) · Quarantine (danger outline).
 *
 * Severity (`clean|low|medium|high|critical`) and decision tier (`allow|warn|block`)
 * are DIFFERENT axes and are never conflated here: the chip reads the tier, each
 * finding reads its own severity.
 *
 * Presentational only — token colors, no engine calls, no decisions (08 §6/C5).
 */

import type { CSSProperties, ReactElement } from "react";
import { FORCE_TOKEN } from "../security/util.js";
import { SEVERITY_ROLE, type Severity, VERDICT_LABEL, type VerdictTier } from "../tokens.js";

/** The glyphs §4 names. Distinct from VERDICT_GLYPH (which the StatusBar shield uses). */
const CARD_GLYPH: Record<VerdictTier, string> = {
  allow: "●",
  warn: "◑",
  block: "✕",
  error: "✕",
};

const TIER_VAR: Record<VerdictTier, string> = {
  allow: "--ok",
  warn: "--warn",
  block: "--danger",
  error: "--danger",
};

/** One finding row in the card. */
export interface VerdictCardFinding {
  /** the rule id, e.g. "N-204". */
  rule: string;
  /** a one-line, human description of what was found. */
  description: string;
  /** where it was found — "setup.sh:41". */
  where?: string;
  severity: Severity;
  /** when set, the finding is rendered GREYED with this reason (§4 suppressed). */
  suppressedReason?: string;
}

export interface VerdictCardProps {
  /** the decision tier — drives the chip only. */
  verdict: VerdictTier;
  /** the scanned artifact's name (mono). */
  artifact: string;
  /** what kind of thing it is — "plugin · github", "model", "repo". */
  sourceKind?: string;
  /** the overall risk score, when the engine reported one. */
  riskScore?: number;
  findings?: readonly VerdictCardFinding[];
  /** cap the rendered findings; the rest collapse into a "+N more" line. */
  maxFindings?: number;
  onDetails?(): void;
  /**
   * "Install anyway…". The HOST owns the typed-confirm for a BLOCK (§4) — this card
   * only surfaces the action and marks it as requiring one.
   */
  onInstallAnyway?(): void;
  onQuarantine?(): void;
  /** hide the action row entirely (the Home island's read-only rendering). */
  actions?: boolean;
  className?: string;
}

export function VerdictCard({
  verdict,
  artifact,
  sourceKind,
  riskScore,
  findings = [],
  maxFindings = 4,
  onDetails,
  onInstallAnyway,
  onQuarantine,
  actions = true,
  className,
}: VerdictCardProps): ReactElement {
  const tierVar = TIER_VAR[verdict];
  const shown = findings.slice(0, maxFindings);
  const hidden = findings.length - shown.length;
  const blocking = verdict === "block" || verdict === "error";
  return (
    <section
      className={className}
      aria-label={`nemesis verdict ${VERDICT_LABEL[verdict]} for ${artifact}`}
      style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 11px",
            borderRadius: 7,
            background: `color-mix(in srgb, var(${tierVar}) 12%, transparent)`,
            border: `1px solid color-mix(in srgb, var(${tierVar}) 40%, transparent)`,
            color: `var(${tierVar})`,
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: "0.06em",
          }}
        >
          <span aria-hidden="true">{CARD_GLYPH[verdict]}</span>
          {VERDICT_LABEL[verdict]}
        </span>
        <span
          title={artifact}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            color: "var(--text-primary)",
            // Ellipsis, not `break-all`. §3 mandates break-all on the PERMISSION card, where
            // the path IS the thing being authorised and must be readable in full. Here the
            // artifact is a heading above the findings — breaking it mid-token pushed the
            // verdict pill and risk score down a line for no benefit. The full value is on
            // the title, and `onDetails` opens the security console.
            //
            // `flex: 1 1 0`, and the BASIS is the load-bearing part. With `flexWrap: wrap`
            // the browser assigns items to lines using their HYPOTHETICAL size (the basis),
            // before any shrinking — so an `auto` basis wraps the risk score onto a second
            // line even though the artifact would have happily shrunk to make room. A zero
            // basis makes the artifact ask for nothing, fit on the line, then grow into
            // whatever is left. This is the wrap the baseline caught.
            flex: "1 1 0",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {artifact}
        </span>
        {sourceKind && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", flex: "none" }}>
            {sourceKind}
          </span>
        )}
        {typeof riskScore === "number" && (
          <span
            title="nemesis risk score"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-muted)",
              flex: "none",
            }}
          >
            rs {riskScore}
          </span>
        )}
      </div>

      {shown.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {shown.map((f) => {
            const suppressed = Boolean(f.suppressedReason);
            const roleVar = suppressed ? "--text-muted" : `--${SEVERITY_ROLE[f.severity]}`;
            return (
              <div key={`${f.rule}:${f.where ?? ""}:${f.description}`} style={findingRow()}>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10.5,
                    color: `var(${roleVar})`,
                    flex: "none",
                  }}
                >
                  {f.rule}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: suppressed ? "var(--text-disabled)" : "var(--text-body)",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {f.description}
                  {f.suppressedReason && (
                    <span style={{ color: "var(--text-disabled)" }}>
                      {" "}
                      — suppressed ({f.suppressedReason})
                    </span>
                  )}
                </span>
                {f.where && (
                  <span
                    title={f.where}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10.5,
                      color: "var(--text-disabled)",
                      // `0 1 auto`, not `none`: the description beside it is already
                      // `flex:1 minWidth:0`, so this path was the only child of the row that
                      // could not shrink — a long file:line overflowed the finding's border.
                      // It gives way to the description, since the description is the finding.
                      flex: "0 1 auto",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.where}
                  </span>
                )}
              </div>
            );
          })}
          {hidden > 0 && (
            <span style={{ fontSize: 11, color: "var(--text-muted)", paddingLeft: 2 }}>
              +{hidden} more finding{hidden === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}

      {actions && (onDetails || onInstallAnyway || onQuarantine) && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {onDetails && (
            <button type="button" onClick={onDetails} style={neutralBtn()}>
              Details
            </button>
          )}
          {onInstallAnyway && (
            <button
              type="button"
              onClick={onInstallAnyway}
              // a BLOCK's override is a typed confirm the HOST raises — say so here so
              // the button never reads like a one-click bypass. The token is the SHARED
              // constant, not a re-typed literal: this tooltip previously described
              // PurgeDialog's basename rule and taught the wrong gesture.
              title={
                blocking
                  ? `Overriding a BLOCK requires typing "${FORCE_TOKEN}" to confirm`
                  : "Install despite the warning"
              }
              style={outlineBtn("--warn")}
            >
              Install anyway…
            </button>
          )}
          <span style={{ flex: 1 }} />
          {onQuarantine && (
            <button
              type="button"
              onClick={onQuarantine}
              style={outlineBtn("--danger", "--danger-fg")}
            >
              Quarantine
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function findingRow(): CSSProperties {
  return {
    display: "flex",
    gap: 8,
    alignItems: "baseline",
    padding: "7px 10px",
    borderRadius: 8,
    background: "var(--bg-inset)",
    border: "1px solid var(--border-row)",
  };
}

function neutralBtn(): CSSProperties {
  return {
    padding: "6px 13px",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    color: "var(--text-title)",
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function outlineBtn(tone: string, fg = tone): CSSProperties {
  return {
    padding: "6px 13px",
    borderRadius: 8,
    background: "transparent",
    border: `1px solid color-mix(in srgb, var(${tone}) 45%, transparent)`,
    color: `var(${fg})`,
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
}

export default VerdictCard;
