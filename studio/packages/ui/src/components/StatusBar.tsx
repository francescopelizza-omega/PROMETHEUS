/**
 * StatusBar.tsx — "always-true facts" bar (08 §4.2/§5.6).
 *
 * The ambient embodiment of rule #2 (08): security is always one glance away,
 * never a destination. The permanent nemesis SHIELD lives here — a VerdictBadge
 * in compact form, tinted by the latest gate tier. Other slots (venv, served
 * model, git branch, problem counts) are passed in as children/items so this
 * primitive stays presentational; the real data binds in desktop (03/04/05).
 *
 * Renders left/right item groups. Each item is a small mono-friendly chip.
 */

import type { ReactElement, ReactNode } from "react";
import { t } from "../i18n/index.js";
import type { VerdictTier } from "../tokens.js";
import { VerdictBadge } from "./VerdictBadge.js";

export interface StatusItem {
  id: string;
  /** Optional leading glyph (e.g. 🛡 ⎇ ◐). */
  glyph?: string;
  label: ReactNode;
  /** Click handler — e.g. the shield opens the Security panel (08 §4.2). */
  onClick?: () => void;
  title?: string;
}

export interface StatusBarProps {
  /** The latest nemesis gate tier — drives the permanent shield. */
  shield?: VerdictTier;
  /** Click the shield → open the Security panel. */
  onShieldClick?: () => void;
  /** Items rendered to the left of the shield. */
  left?: StatusItem[];
  /** Items rendered on the right (git branch, problem counts, ⌘K hint…). */
  right?: StatusItem[];
  className?: string;
}

function Item({ item }: { item: StatusItem }): ReactElement {
  const interactive = typeof item.onClick === "function";
  return (
    <button
      type="button"
      onClick={item.onClick}
      title={item.title}
      disabled={!interactive}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2, 4px)",
        paddingInline: "var(--space-4, 8px)",
        paddingBlock: "var(--space-1, 2px)",
        background: "transparent",
        border: "none",
        color: "var(--text-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-small-size, 0.8125rem)",
        cursor: interactive ? "pointer" : "default",
        lineHeight: 1.4,
      }}
    >
      {item.glyph != null && <span aria-hidden="true">{item.glyph}</span>}
      <span>{item.label}</span>
    </button>
  );
}

export function StatusBar({
  shield,
  onShieldClick,
  left = [],
  right = [],
  className,
}: StatusBarProps): ReactElement {
  return (
    <footer
      className={className}
      role="contentinfo"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: "1.8rem",
        paddingInline: "var(--space-2, 4px)",
        background: "var(--bg-surface)",
        borderTop: "1px solid var(--border-subtle)",
        color: "var(--text-secondary)",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        {shield != null && (
          <button
            type="button"
            onClick={onShieldClick}
            title="nemesis — click to open Security"
            aria-label={t("statusBar.shield", { tier: shield })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2, 4px)",
              paddingInline: "var(--space-4, 8px)",
              paddingBlock: "var(--space-1, 2px)",
              background: "transparent",
              border: "none",
              cursor: typeof onShieldClick === "function" ? "pointer" : "default",
            }}
          >
            <span aria-hidden="true">🛡</span>
            <VerdictBadge verdict={shield} compact live="off" />
          </button>
        )}
        {left.map((item) => (
          <Item key={item.id} item={item} />
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center" }}>
        {right.map((item) => (
          <Item key={item.id} item={item} />
        ))}
      </div>
    </footer>
  );
}

export default StatusBar;
