// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * TokenEconomyPanel.tsx — the Token-economy bottom-panel surface.
 *
 * The graphical twin of the CLI `prometheus tokens`: the curated token-saving toolkit
 * Prometheus proposes by default (terse output / prompt caching / repo map / local
 * RAG / …) + the honest Gemini-Nano local-feasibility assessment. A paid/free toggle
 * tailors the proposal; a "show all" toggle reveals the opt-in techniques.
 *
 * Renderer-SANDBOXED: react + the PURE core registry (`@prometheus/core` tokenEconomy,
 * static data — no IO, no engine) + token colors only (no raw hex).
 */
import * as tokenEconomy from "@prometheus/core/token-economy";
import type { ActivityId } from "@prometheus/ui";
import { type ReactElement, useState } from "react";

type Tool = tokenEconomy.TokenTool;

const SAVES_COLOR: Record<string, string> = {
  input: "var(--accent)",
  output: "var(--ok)",
  both: "var(--brand, var(--accent))",
};

function bestForColor(b: string): string {
  return b === "paid-closed" ? "var(--danger)" : b === "free-local" ? "var(--ok)" : "var(--accent)";
}

function Badge({ text, color }: { text: string; color: string }): ReactElement {
  return (
    <span
      style={{
        fontSize: "0.68rem",
        padding: "1px 6px",
        borderRadius: "var(--radius-sm, 4px)",
        border: `1px solid ${color}`,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function ToolCard({ t }: { t: Tool }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <li
      style={{
        listStyle: "none",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md, 6px)",
        padding: "8px 10px",
        background: "var(--bg-surface-2)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          color: "var(--text-primary)",
          cursor: "pointer",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: "3px",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          {t.defaultOn && (
            <span style={{ color: "var(--ok)" }} aria-label="proposed by default">
              ★
            </span>
          )}
          <span style={{ fontWeight: 600, fontSize: "0.86rem" }}>{t.name}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: "4px" }}>
            <Badge text={t.bestFor} color={bestForColor(t.bestFor)} />
            <Badge
              text={`saves ${t.saves}`}
              color={SAVES_COLOR[t.saves] ?? "var(--text-secondary)"}
            />
            {t.maturity === "experimental" && <Badge text="experimental" color="var(--warn)" />}
          </span>
        </span>
        <span style={{ color: "var(--text-secondary)", fontSize: "0.78rem", lineHeight: 1.35 }}>
          {t.pitch}
        </span>
        <span style={{ color: "var(--text-secondary)", fontSize: "0.72rem", opacity: 0.85 }}>
          → {t.tokenSaving}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: "6px", display: "grid", gap: "4px", fontSize: "0.74rem" }}>
          {t.install && (
            <div style={{ display: "flex", gap: "6px", alignItems: "baseline", flexWrap: "wrap" }}>
              <b style={{ color: "var(--text-secondary)" }}>install</b>
              <code style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
                {t.install}
              </code>
              <button
                type="button"
                aria-label={`Copy install command for ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard?.writeText(t.install);
                }}
                style={{
                  fontSize: "0.66rem",
                  padding: "0 6px",
                  borderRadius: "var(--radius-sm, 4px)",
                  border: "1px solid var(--border-subtle)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                copy
              </button>
            </div>
          )}
          <div>
            <b style={{ color: "var(--text-secondary)" }}>usage</b>{" "}
            <span style={{ color: "var(--text-secondary)" }}>{t.usage}</span>
          </div>
          <div>
            <b style={{ color: "var(--warn)" }}>tradeoff</b>{" "}
            <span style={{ color: "var(--text-secondary)" }}>{t.notes}</span>
          </div>
        </div>
      )}
    </li>
  );
}

function NanoSection({ onNavigate }: { onNavigate?: (id: ActivityId) => void }): ReactElement {
  const n = tokenEconomy.GEMINI_NANO;
  const feasColor =
    n.feasible === "yes" ? "var(--ok)" : n.feasible === "partial" ? "var(--warn)" : "var(--danger)";
  return (
    <div style={{ display: "grid", gap: "6px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontWeight: 600, fontSize: "0.86rem" }}>
          Gemini Nano — local feasibility
        </span>
        <Badge text={n.feasible} color={feasColor} />
        <Badge
          text={n.accountRequired ? "account needed" : "no account"}
          color={n.accountRequired ? "var(--danger)" : "var(--ok)"}
        />
        <Badge
          text={n.weightsRedistributable ? "weights open" : "weights NOT redistributable"}
          color={n.weightsRedistributable ? "var(--ok)" : "var(--danger)"}
        />
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "4px" }}>
        {n.methods.map((m) => (
          <li key={m.method} style={{ fontSize: "0.74rem", display: "flex", gap: "6px" }}>
            <span style={{ color: m.endorsed ? "var(--ok)" : "var(--danger)" }} aria-hidden="true">
              {m.endorsed ? "✓" : "✗"}
            </span>
            <span>
              <b aria-label={`${m.method} — ${m.endorsed ? "endorsed" : "not endorsed"}`}>
                {m.method}
              </b>{" "}
              <span style={{ color: "var(--text-secondary)" }}>
                ({m.reliability}) — {m.tosLegal}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div style={{ fontSize: "0.74rem" }}>
        <b style={{ color: "var(--text-secondary)" }}>Recommended open ~4GB alternatives:</b>
        <ul style={{ margin: "2px 0 0", paddingLeft: "16px", color: "var(--text-secondary)" }}>
          {n.alternatives.map((a) => (
            <li key={a.id}>
              {onNavigate ? (
                <button
                  type="button"
                  onClick={() => onNavigate("models")}
                  title="Open the Model Hub to download this model"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    color: "var(--accent)",
                    cursor: "pointer",
                    font: "inherit",
                    textAlign: "left",
                  }}
                >
                  {a.label}
                </button>
              ) : (
                a.label
              )}
            </li>
          ))}
        </ul>
      </div>
      <p
        style={{ fontSize: "0.72rem", color: "var(--text-secondary)", margin: 0, lineHeight: 1.4 }}
      >
        {n.recommendation}
      </p>
    </div>
  );
}

/** The Token-economy panel. */
export function TokenEconomyPanel({
  onNavigate,
}: { onNavigate?: (id: ActivityId) => void } = {}): ReactElement {
  const [paid, setPaid] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const tools = tokenEconomy.proposeToolkits({ usingPaidModel: paid, includeOptIn: showAll });

  const toggleBtn = (label: string, active: boolean, onClick: () => void): ReactElement => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontSize: "0.74rem",
        padding: "3px 10px",
        borderRadius: "var(--radius-md, 6px)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border-subtle)"}`,
        background: active ? "var(--bg-surface-2)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      role="region"
      aria-label="Save tokens — token-economy toolkit"
      style={{
        height: "100%",
        overflow: "auto",
        padding: "var(--space-4, 8px)",
        boxSizing: "border-box",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
        display: "grid",
        gap: "var(--space-8, 12px)",
        alignContent: "start",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontWeight: 700, fontSize: "0.95rem" }}>Save tokens</h2>
        <span style={{ color: "var(--text-secondary)", fontSize: "0.76rem", flex: 1 }}>
          {tokenEconomy.proposeHeadline(paid)}
        </span>
        <span style={{ display: "flex", gap: "4px" }}>
          {toggleBtn("Free / local", !paid, () => setPaid(false))}
          {toggleBtn("Paid model", paid, () => setPaid(true))}
          {toggleBtn(showAll ? "Defaults" : "Show all", showAll, () => setShowAll((v) => !v))}
        </span>
      </div>

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "6px" }}>
        {tools.length === 0 && (
          <li style={{ listStyle: "none", color: "var(--text-secondary)", fontSize: "0.8rem" }}>
            No token-saving tools proposed.
          </li>
        )}
        {tools.map((t) => (
          <ToolCard key={t.id} t={t} />
        ))}
      </ul>

      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          paddingTop: "var(--space-4, 8px)",
        }}
      >
        <NanoSection onNavigate={onNavigate} />
      </div>
    </div>
  );
}

export default TokenEconomyPanel;
