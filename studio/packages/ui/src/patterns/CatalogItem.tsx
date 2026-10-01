// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * CatalogItem.tsx — one cmd_list catalog row (08 §3.2 / §5.5). A tier glyph
 * (Official ◆ / External ✓ / Documented-only ⓘ), the name, scope, an optional rank,
 * and an install CTA carrying a `<VerdictBadge>`. Documented-only items show ⓘ and
 * route to a guided flow — NEVER an inline Install (08 §5.5).
 *
 * Binds a `CatalogItemData` (mirror of cmd_list `{ name, tier, scope }`) via a
 * TYPE-ONLY import (C5). The renderer passes a real catalog row straight in.
 *
 * GOLDEN RULE (C5): NEVER decides "safe" — an External item is always nemesis-scanned
 * (its `verdict` is the engine's), rendered inert. The tier glyph + text label carry
 * the tier (never color alone, 08 §7). Actions are callback PROPS.
 */

import type { ReactElement } from "react";
import { VerdictBadge } from "../components/VerdictBadge.js";
import { StatusMark } from "./StatusMark.js";
import type { CatalogItemData } from "./types.js";
import { inert, isDocumentedOnly, tierGlyph, tierLabel } from "./util.js";

export interface CatalogItemProps {
  item: CatalogItemData;
  /** Install (dry-run) the item — the External/Official CTA (verdict-gated). */
  onInstall?: () => void;
  /** Open the guided flow for a Documented-only item (never an inline install). */
  onGuide?: () => void;
  /** Select / open the item detail. */
  onSelect?: () => void;
  className?: string;
}

export function CatalogItem({
  item,
  onInstall,
  onGuide,
  onSelect,
  className,
}: CatalogItemProps): ReactElement {
  const name = inert(item.name) || "item";
  const scope = inert(item.scope ?? "");
  const documented = isDocumentedOnly(item.tier);
  const tierColor =
    item.tier === "official"
      ? "var(--brand)"
      : item.tier === "documented"
        ? "var(--text-secondary)"
        : "var(--ok)";

  return (
    <div
      className={className}
      data-tier={item.tier}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-4, 8px)",
        paddingBlock: "var(--space-3, 6px)",
        paddingInline: "var(--space-4, 8px)",
        borderBottom: "1px solid var(--border-subtle)",
        fontFamily: "var(--font-ui)",
      }}
    >
      {/* tier glyph — color + glyph; the label rides in the title + aria. */}
      <span
        aria-label={`${tierLabel(item.tier)} tier`}
        title={tierLabel(item.tier)}
        style={{
          color: tierColor,
          fontFamily: "var(--font-mono)",
          lineHeight: 1,
          minWidth: "1.2em",
        }}
      >
        {tierGlyph(item.tier)}
      </span>

      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "var(--text-primary)",
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            textAlign: "left",
          }}
        >
          {name}
        </button>
      ) : (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{name}</span>
      )}

      {scope.length > 0 && (
        <span
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          {scope}
        </span>
      )}

      {typeof item.rank === "number" && item.rank > 0 && (
        <span
          title={`rank ${item.rank}`}
          style={{
            color: "var(--warn)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          ★{item.rank}
        </span>
      )}

      <span style={{ flex: 1 }} />

      {item.presence != null && <StatusMark presence={item.presence} />}

      {item.verdict != null && <VerdictBadge verdict={item.verdict} compact />}

      {documented
        ? onGuide && (
            <button type="button" onClick={onGuide} style={ctaBtn(false)}>
              ↗ Open dossier
            </button>
          )
        : onInstall && (
            <button type="button" onClick={onInstall} style={ctaBtn(true)}>
              ⤓ Install
            </button>
          )}
    </div>
  );
}

function ctaBtn(primary: boolean) {
  return {
    paddingInline: "var(--space-4, 8px)",
    paddingBlock: "var(--space-1, 2px)",
    borderRadius: "var(--radius-sm, 4px)",
    cursor: "pointer",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-small-size, 0.8125rem)",
    fontWeight: 600,
    background: primary ? "var(--brand)" : "transparent",
    border: `1px solid ${primary ? "var(--brand)" : "var(--border-strong)"}`,
    // The label sits ON the `--brand` fill, so it needs the computed `--on-brand`.
    // `--brand-fg` is #ffffff on the dark scheme and measures 3.96:1 over `--brand` —
    // under the 4.5:1 a label carries. It stays in use where it is a FILL, not a label
    // (the Toggle knob), which is why this is a call-site change and not a token change.
    color: primary ? "var(--on-brand)" : "var(--text-secondary)",
  } as const;
}

export default CatalogItem;
