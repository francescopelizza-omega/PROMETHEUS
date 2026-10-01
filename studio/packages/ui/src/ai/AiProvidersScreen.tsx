// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * AiProvidersScreen.tsx — the Settings → AI Providers screen (file 12 §5.1).
 *
 * Assembles the wireframe: the "Brain for" surface selector + the active-brain line,
 * the cost-light legend, the Tier-A-first <ProviderPicker>, the live <SpendMeter> (only
 * when a metered connector is active), and it HOSTS the §4.1 <CostWarningModal> — a
 * "Configure ⚠" on a Tier-C row opens it; the typed-confirm acceptance is raised to the
 * container (which persists confirmedCostWarningAt + the audit record, C5).
 *
 * Fully presentational + controlled: every datum + handler is a prop. No engine, no
 * keychain, no money decision here — those live in core/desktop-main behind the props.
 */
import { type ReactElement, useState } from "react";
import { Select } from "../components/primitives/Select.js";
import { fs, rad, sp, v } from "../components/primitives/styles.js";
import { type CostWarningConfirm, CostWarningModal } from "./CostWarningModal.js";
import { ProviderPicker } from "./ProviderPicker.js";
import { SpendMeter } from "./SpendMeter.js";
import type { AiProviderRow, CostWarningInput } from "./types.js";

/** An active metered connector's live spend, for the meter line. */
export interface ActiveMeter {
  providerLabel: string;
  spentUsd: number;
  capUsd: number;
  warnAtPct?: number;
  lastEstimateUsd?: number;
  onCapNote?: string;
}

/** The surfaces a brain can be picked for (§2.4 EnabledSurface). */
export interface BrainSurface {
  id: string;
  label: string;
}

export interface AiProvidersScreenProps {
  surfaces: BrainSurface[];
  selectedSurfaceId: string;
  onSurfaceChange: (id: string) => void;
  /** the human label of the active brain for the selected surface (e.g. "qwen3:8b (local)"). */
  activeBrainLabel?: string;
  rows: readonly AiProviderRow[];
  /** the active connector id (drives the ● + Recommended treatment in the picker). */
  activeId?: string;
  /** active metered connectors → spend meter lines (empty ⇒ "none active — $0.00 this month"). */
  activeMeters?: ActiveMeter[];
  onSelect?: (row: AiProviderRow) => void;
  onRunLocally?: (row: AiProviderRow) => void;
  /** confirm — the typed-confirm passed; container persists + enables the connector. */
  onConfirmMetered?: (row: AiProviderRow, confirm: CostWarningConfirm) => void;
}

/** Build the modal's provider copy from a Tier-C row. */
function modalInput(row: AiProviderRow): CostWarningInput {
  return {
    providerLabel: row.label,
    ...(row.modelId ? { modelLabel: row.modelId } : {}),
    ...(row.caption ? { priceLine: row.caption } : {}),
    ...(row.repointSuggest ? { repointSuggest: true } : {}),
  };
}

/** The §5.1 AI-Providers settings screen. */
export function AiProvidersScreen({
  surfaces,
  selectedSurfaceId,
  onSurfaceChange,
  activeBrainLabel,
  rows,
  activeId,
  activeMeters = [],
  onSelect,
  onRunLocally,
  onConfirmMetered,
}: AiProvidersScreenProps): ReactElement {
  const [configuring, setConfiguring] = useState<AiProviderRow | null>(null);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: sp(4),
        fontFamily: v("font-ui"),
        color: v("text-primary"),
      }}
    >
      <header style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: sp(4) }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: sp(2),
            fontSize: fs("small"),
          }}
        >
          Brain for:
          <Select
            aria-label="Brain for surface"
            value={selectedSurfaceId}
            onValueChange={onSurfaceChange}
            options={surfaces.map((s) => ({ value: s.id, label: s.label }))}
          />
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: sp(2),
            fontSize: fs("small"),
          }}
        >
          <span aria-hidden="true" style={{ color: v("ok") }}>
            ●
          </span>
          Active: {activeBrainLabel ?? "none selected"}
        </span>
      </header>

      <div
        role="note"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: sp(4),
          padding: sp(3),
          fontSize: fs("small"),
          color: v("text-secondary"),
          background: v("bg-inset"),
          borderRadius: rad("md"),
          border: `1px solid ${v("border-subtle")}`,
        }}
      >
        <span>
          <span aria-hidden="true" style={{ color: v("ok") }}>
            🟢
          </span>{" "}
          local / free
        </span>
        <span>
          <span aria-hidden="true" style={{ color: v("accent") }}>
            🔵
          </span>{" "}
          subscription-included
        </span>
        <span>
          <span aria-hidden="true" style={{ color: v("danger") }}>
            🔴
          </span>{" "}
          metered (pay-per-use)
        </span>
      </div>

      <ProviderPicker
        rows={rows}
        activeId={activeId}
        onSelect={onSelect}
        onRunLocally={onRunLocally}
        onConfigureMetered={(row) => setConfiguring(row)}
      />

      <footer style={{ borderTop: `1px solid ${v("border-subtle")}`, paddingTop: sp(3) }}>
        <div style={{ fontSize: fs("small"), color: v("text-secondary"), marginBottom: sp(2) }}>
          Spend meter (active metered connectors):
        </div>
        {activeMeters.length === 0 ? (
          <div style={{ fontSize: fs("small"), color: v("text-secondary") }}>
            none active — $0.00 this month
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: sp(2) }}>
            {activeMeters.map((meter) => (
              <SpendMeter key={meter.providerLabel} {...meter} />
            ))}
          </div>
        )}
      </footer>

      {configuring != null && (
        <CostWarningModal
          open={configuring != null}
          onOpenChange={(open) => {
            if (!open) setConfiguring(null);
          }}
          provider={modalInput(configuring)}
          onUseLocalInstead={
            configuring.repointSuggest && onRunLocally != null
              ? () => {
                  const row = configuring;
                  setConfiguring(null);
                  onRunLocally(row);
                }
              : undefined
          }
          onConfirm={(confirm) => {
            const row = configuring;
            setConfiguring(null);
            onConfirmMetered?.(row, confirm);
          }}
        />
      )}
    </div>
  );
}

export default AiProvidersScreen;
