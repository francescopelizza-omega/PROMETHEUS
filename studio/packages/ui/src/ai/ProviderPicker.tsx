/**
 * ProviderPicker.tsx — the Tier-A-first provider rows (file 12 §5 / §5.1).
 *
 * Renders provider rows grouped A→B→C in PROMOTION order (open-weight first within a
 * tier), each with a cost-traffic-light (reusing the <CostLight> atom), the wiring
 * caption, and the right CTA: Tier A "Use", Tier B "Sign in", Tier C "Configure⚠"
 * (which the screen routes into the §4.1 warn modal). The light + sort TEACH the
 * cheaper wiring — the same provider is blue via OAuth, red via API key.
 *
 * Presentational: selection + configure intents are raised to the container (C5).
 */
import type { ReactElement } from "react";
import { Button } from "../components/Button.js";
import { CostLight } from "../components/CostLight.js";
import { fs, rad, sp, v } from "../components/primitives/styles.js";
import { type AiProviderRow, type CostTier, TIER_SECTION, groupByTier } from "./types.js";

export interface ProviderPickerProps {
  rows: readonly AiProviderRow[];
  /** the currently-active connector id (gets the ● + "Recommended" treatment). */
  activeId?: string;
  /** Tier A "Use" / Tier B "Sign in" — select a non-metered connector directly. */
  onSelect?: (row: AiProviderRow) => void;
  /** Tier C "Configure⚠" — opens the §4.1 warn + typed-confirm flow. */
  onConfigureMetered?: (row: AiProviderRow) => void;
  /** §6 escape hatch — repoint a metered open-weight row to a free local serve. */
  onRunLocally?: (row: AiProviderRow) => void;
}

function ctaLabel(tier: CostTier): string {
  return tier === "A" ? "Use" : tier === "B" ? "Sign in →" : "Configure ⚠";
}

/** The §5.1 three-tier provider list. */
export function ProviderPicker({
  rows,
  activeId,
  onSelect,
  onConfigureMetered,
  onRunLocally,
}: ProviderPickerProps): ReactElement {
  const groups = groupByTier(rows);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: sp(6), fontFamily: v("font-ui") }}>
      {groups.map(({ tier, rows: tierRows }) => (
        <section key={tier} aria-label={TIER_SECTION[tier].title}>
          <header style={{ marginBottom: sp(2) }}>
            <div style={{ fontSize: fs("small"), fontWeight: 600, color: v("text-primary") }}>
              {TIER_SECTION[tier].title}
            </div>
            <div style={{ fontSize: fs("small"), color: v("text-secondary") }}>
              {TIER_SECTION[tier].note}
            </div>
          </header>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              border: `1px solid ${v("border-subtle")}`,
              borderRadius: rad("md"),
              overflow: "hidden",
            }}
          >
            {tierRows.map((row) => {
              const active = row.id === activeId;
              return (
                <li
                  key={row.id}
                  data-active={active || undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: sp(3),
                    padding: `${sp(3)} ${sp(4)}`,
                    borderTop: `1px solid ${v("border-subtle")}`,
                    background: active ? v("bg-inset") : "transparent",
                  }}
                >
                  <CostLight tier={row.tier} showLabel={false} />
                  <span
                    aria-hidden="true"
                    style={{ color: active ? v("ok") : v("text-secondary"), width: "1ch" }}
                  >
                    {active ? "●" : ""}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      flex: "0 0 12rem",
                      color: v("text-primary"),
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {row.label}
                  </span>
                  <code
                    style={{
                      flex: "0 0 13rem",
                      color: v("text-secondary"),
                      fontFamily: v("font-mono"),
                      fontSize: fs("small"),
                    }}
                  >
                    {row.kind}
                  </code>
                  <span style={{ flex: 1, color: v("text-secondary"), fontSize: fs("small") }}>
                    {row.caption}
                    {row.tier === "A" && row.id === activeId ? "  Recommended (free, local)" : ""}
                  </span>
                  {row.tier === "C" ? (
                    <span style={{ display: "inline-flex", gap: sp(2) }}>
                      {row.repointSuggest && onRunLocally != null && (
                        <Button variant="secondary" onClick={() => onRunLocally(row)}>
                          Run it locally →
                        </Button>
                      )}
                      <Button variant="danger" onClick={() => onConfigureMetered?.(row)}>
                        {ctaLabel(row.tier)}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant={row.tier === "A" ? "primary" : "secondary"}
                      onClick={() => onSelect?.(row)}
                    >
                      {ctaLabel(row.tier)}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {tier === "B" && tierRows.some((r) => r.verifyAtSetup) && (
            <p
              style={{ margin: `${sp(2)} 0 0`, fontSize: fs("small"), color: v("text-secondary") }}
            >
              ↳ verify third-party-IDE coverage against the provider's current ToS at setup
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

export default ProviderPicker;
