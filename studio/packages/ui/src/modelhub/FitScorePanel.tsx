/**
 * FitScorePanel.tsx — the §7 per-quant fit table + recommended-quant explainer.
 *
 * Renders one row per quant: size · est-VRAM · a verdict chip
 * (FITS/TIGHT/PARTIAL/OVERFLOW, or "needs cc≥8.9 / vLLM-only" when caps-gated) ·
 * a quality bar · the runner. The head of the (sidecar-ranked) list is the
 * recommended quant — surfaced with the §4.4 explainer line.
 *
 * SANDBOXED + C5: imports only react + this package. It NEVER scores or fits — the
 * `fit` prop is the sidecar's FitResult (fit.py); this component is a pure
 * projection of `verdict`/`runnable`/`blockedReason` into chips. Every engine
 * string is run through `inert()`. Actions are PROPS (onDownload / onDownloadServe
 * / onOpenCard) — no IPC lives here.
 */

import type { ReactElement } from "react";

import type { FitResultData, ScoredQuantData } from "./types.js";
import {
  type FitVerdict,
  fitChipText,
  fitGlyph,
  fitRole,
  formatGb,
  inert,
  qualityBar,
  recommendedExplainer,
  roleVar,
} from "./util.js";

export interface FitScorePanelProps {
  /** the sidecar fit result (recommended + ranked + reasons). */
  fit: FitResultData | null;
  /** loading flag (the panel shows a placeholder while the sidecar fits). */
  loading?: boolean;
  /** download the named quant (stage → nemesis → admit). */
  onDownload?: (quantLabel: string) => void;
  /** download AND serve the named quant (the one-click §7 action). */
  onDownloadServe?: (quantLabel: string) => void;
  /** open the model card in the OS browser. */
  onOpenCard?: () => void;
}

/** A monospace table cell. */
function Cell({
  children,
  width,
  color,
}: {
  children: React.ReactNode;
  width?: string;
  color?: string;
}): ReactElement {
  return (
    <span
      style={{
        display: "inline-block",
        width,
        color: color ?? "var(--text-primary)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-small-size, 0.8125rem)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {children}
    </span>
  );
}

/** One fit-table row. */
function QuantRow({
  q,
  recommended,
}: {
  q: ScoredQuantData;
  recommended: boolean;
}): ReactElement {
  const verdict = q.verdict as FitVerdict;
  const role = q.runnable ? fitRole(verdict) : "danger";
  const runner = (q.runnerHint ?? []).map((r) => inert(r)).join("/") || "—";
  return (
    <li
      data-verdict={verdict}
      data-runnable={q.runnable}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-4, 8px)",
        padding: "4px 6px",
        borderRadius: "var(--radius-sm, 4px)",
        opacity: q.runnable ? 1 : 0.6,
        background: recommended ? "var(--bg-surface-2)" : "transparent",
      }}
    >
      <Cell width="92px">
        {recommended && <span aria-hidden="true">▸ </span>}
        {inert(q.label)}
      </Cell>
      <Cell width="64px" color="var(--text-secondary)">
        {formatGb(q.weightsGb)}
      </Cell>
      <Cell width="72px" color="var(--text-secondary)">
        {q.runnable ? formatGb(q.estVramGb) : "—"}
      </Cell>
      <Cell width="150px" color={roleVar(role)}>
        {fitChipText({
          verdict,
          ratio: q.ratio,
          runnable: q.runnable,
          blockedReason: q.blockedReason,
        })}
      </Cell>
      <Cell width="92px" color="var(--text-secondary)">
        <span style={{ letterSpacing: "-1px" }}>{qualityBar(q.qualityRank)}</span>{" "}
        {q.qualityRank.toFixed(2)}
      </Cell>
      <Cell width="84px" color="var(--text-secondary)">
        {runner}
        {recommended ? " ★" : ""}
      </Cell>
    </li>
  );
}

export function FitScorePanel({
  fit,
  loading = false,
  onDownload,
  onDownloadServe,
  onOpenCard,
}: FitScorePanelProps): ReactElement {
  if (loading) {
    return (
      <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>
        Scoring quants against your hardware…
      </p>
    );
  }
  if (!fit) {
    return (
      <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>
        Select a model to score its quants on your hardware.
      </p>
    );
  }

  const recLabel = fit.recommended?.label ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
      {/* header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4, 8px)",
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          padding: "0 6px",
        }}
      >
        <span style={{ display: "inline-block", width: "92px" }}>Quant</span>
        <span style={{ display: "inline-block", width: "64px" }}>Size</span>
        <span style={{ display: "inline-block", width: "72px" }}>Est VRAM</span>
        <span style={{ display: "inline-block", width: "150px" }}>Verdict</span>
        <span style={{ display: "inline-block", width: "92px" }}>Quality</span>
        <span style={{ display: "inline-block", width: "84px" }}>Runner</span>
      </div>

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "2px" }}>
        {(fit.ranked ?? []).map((q) => (
          <QuantRow key={`${q.label}:${q.fmt}`} q={q} recommended={q.label === recLabel} />
        ))}
      </ul>

      {/* §4.4 recommended explainer */}
      <p
        data-recommended={recLabel ?? "none"}
        style={{
          margin: 0,
          padding: "6px 8px",
          borderRadius: "var(--radius-sm, 4px)",
          background: "var(--bg-surface-2)",
          color: fit.recommended
            ? roleVar(fitRole(fit.recommended.verdict as FitVerdict))
            : "var(--danger)",
          fontSize: "0.82rem",
          lineHeight: 1.4,
        }}
      >
        <span aria-hidden="true">
          {fit.recommended ? `${fitGlyph(fit.recommended.verdict as FitVerdict)} ` : "✕ "}
        </span>
        {recommendedExplainer(recLabel ? { label: recLabel } : null, fit.reasons ?? [])}
      </p>

      {/* §7 actions (PROPS only — no IPC here) */}
      <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
        {recLabel && onDownload && (
          <button type="button" onClick={() => onDownload(recLabel)} style={primaryBtn}>
            ⭳ Download {inert(recLabel)}
          </button>
        )}
        {recLabel && onDownloadServe && (
          <button type="button" onClick={() => onDownloadServe(recLabel)} style={ghostBtn}>
            ⭳▶ Download &amp; Serve
          </button>
        )}
        {onOpenCard && (
          <button type="button" onClick={onOpenCard} style={ghostBtn}>
            Open card
          </button>
        )}
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "var(--brand-fg)",
  borderRadius: "var(--radius-md, 6px)",
  padding: "5px 10px",
  fontSize: "0.82rem",
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  border: "1px solid var(--border-subtle)",
  background: "transparent",
  color: "var(--text-primary)",
  borderRadius: "var(--radius-md, 6px)",
  padding: "5px 10px",
  fontSize: "0.82rem",
  cursor: "pointer",
};

export default FitScorePanel;
