/**
 * ModelCard.tsx — the LM-Studio-style model card (08 §3.2 / §5.4). Name · params ·
 * license · a VRAM **fit meter** · quantization chips (GGUF/FP8/AWQ) · a local/served
 * pill · a primary Download/Serve CTA carrying a `<VerdictBadge>`.
 *
 * Binds a `ModelCardData` (mirror of an OPEN_MODELS row + a Cookbook fit) via a
 * TYPE-ONLY import (C5). The renderer passes a real model row straight in.
 *
 * GOLDEN RULE (C5): NEVER fit-scores or decides "safe" — the `vramFitRatio` is the
 * engine's fit math, the `verdict` is nemesis'. This renders both inert. Every
 * string (name/license/params/fitCaption) is run through `inert()`. The fit meter's
 * band + the CTA verdict are pure projections; actions are callback PROPS.
 */

import type { ReactElement } from "react";
import { VerdictBadge } from "../components/VerdictBadge.js";
import type { ModelCardData } from "./types.js";
import { clampFitRatio, fitMeterVar, inert } from "./util.js";

export interface ModelCardProps {
  model: ModelCardData;
  /** Download the model (stage → nemesis → admit) — verdict-gated downstream. */
  onDownload?: () => void;
  /** Serve the model (start an endpoint) — verdict-gated downstream. */
  onServe?: () => void;
  /** Open the full model card / detail tab. */
  onOpen?: () => void;
  className?: string;
}

export function ModelCard({
  model,
  onDownload,
  onServe,
  onOpen,
  className,
}: ModelCardProps): ReactElement {
  const name = inert(model.name) || inert(model.id) || "model";
  const license = inert(model.license);
  const params = inert(model.params ?? "");
  const fitRatio = clampFitRatio(model.vramFitRatio);
  const anyFits = model.quants.some((q) => q.fits === true);
  const fitColor = fitMeterVar(anyFits ? true : undefined, model.vramFitRatio);
  const fitCaption = inert(model.fitCaption ?? "");

  return (
    <article
      className={className}
      data-model-id={inert(model.id)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-6, 12px)",
        padding: "var(--space-8, 16px)",
        borderRadius: "var(--radius-lg, 10px)",
        border: "1px solid var(--border-subtle)",
        background: "var(--bg-surface)",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
        minWidth: "16rem",
      }}
    >
      {/* header — name + license. */}
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "var(--space-4, 8px)",
        }}
      >
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "var(--text-primary)",
              fontFamily: "var(--font-ui)",
              fontSize: "var(--text-h2-size, 1.125rem)",
              fontWeight: 600,
              textAlign: "left",
            }}
          >
            {name}
          </button>
        ) : (
          <span style={{ fontSize: "var(--text-h2-size, 1.125rem)", fontWeight: 600 }}>{name}</span>
        )}
        {license.length > 0 && (
          <span
            style={{
              color: "var(--text-secondary)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            {license}
          </span>
        )}
      </header>

      {params.length > 0 && (
        <span
          style={{
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {params}
        </span>
      )}

      {/* VRAM fit meter — banded; caption carries "fits/>budget" (color never alone, 08 §7). */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 4px)" }}>
        <span
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          VRAM fit
        </span>
        <div
          role="meter"
          aria-valuenow={Math.round(fitRatio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={
            fitCaption.length > 0 ? fitCaption : `VRAM fit ${Math.round(fitRatio * 100)}%`
          }
          style={{
            position: "relative",
            height: "8px",
            borderRadius: "var(--radius-full, 9999px)",
            background: "var(--border-subtle)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.round(fitRatio * 100)}%`,
              borderRadius: "var(--radius-full, 9999px)",
              background: fitColor,
              transition: "width var(--motion-panel, 180ms) ease-out",
            }}
          />
        </div>
        {fitCaption.length > 0 && (
          <span
            style={{
              color: fitColor,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            {fitCaption}
          </span>
        )}
      </div>

      {/* quant chips. */}
      {model.quants.length > 0 && (
        <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
          {model.quants.map((q) => {
            const qColor =
              q.fits === false
                ? "var(--danger)"
                : q.fits === true
                  ? "var(--ok)"
                  : "var(--text-secondary)";
            return (
              <span
                key={inert(q.label)}
                title={q.fits === false ? "exceeds budget" : q.fits === true ? "fits" : undefined}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  paddingInline: "var(--space-3, 6px)",
                  paddingBlock: "var(--space-1, 2px)",
                  borderRadius: "var(--radius-sm, 4px)",
                  border: `1px solid ${qColor}`,
                  color: qColor,
                  background: `color-mix(in srgb, ${qColor} 10%, transparent)`,
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-small-size, 0.8125rem)",
                  lineHeight: 1,
                }}
              >
                {inert(q.label)}
              </span>
            );
          })}
        </div>
      )}

      {/* local / served pill row. */}
      {(model.local || model.served) && (
        <div style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
          {model.local && <StatePill label="local" />}
          {model.served && <StatePill label="served" />}
        </div>
      )}

      {/* CTA row — the primary action carries the pre-action VerdictBadge. */}
      <footer
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4, 8px)",
          marginTop: "auto",
        }}
      >
        {model.verdict != null && (
          <VerdictBadge verdict={model.verdict} risk_score={model.riskScore} compact />
        )}
        <span style={{ flex: 1 }} />
        {onDownload && (
          <button type="button" onClick={onDownload} style={ctaBtn(false)}>
            ⤓ Download
          </button>
        )}
        {onServe && (
          <button type="button" onClick={onServe} style={ctaBtn(true)}>
            ▶ Serve
          </button>
        )}
      </footer>
    </article>
  );
}

function StatePill({ label }: { label: string }): ReactElement {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        paddingInline: "var(--space-3, 6px)",
        paddingBlock: "var(--space-1, 2px)",
        borderRadius: "var(--radius-full, 9999px)",
        border: "1px solid var(--accent)",
        color: "var(--accent)",
        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-small-size, 0.8125rem)",
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  );
}

function ctaBtn(primary: boolean) {
  return {
    paddingInline: "var(--space-6, 12px)",
    paddingBlock: "var(--space-2, 4px)",
    borderRadius: "var(--radius-md, 6px)",
    cursor: "pointer",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-small-size, 0.8125rem)",
    fontWeight: 600,
    background: primary ? "var(--brand)" : "transparent",
    border: `1px solid ${primary ? "var(--brand)" : "var(--border-strong)"}`,
    color: primary ? "var(--brand-fg)" : "var(--text-primary)",
  } as const;
}

export default ModelCard;
