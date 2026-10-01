// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
  /**
   * A semantic COLOR-VAR NAME (e.g. "--warn", "--ok") to tint this entry — never a hex.
   * Used by the §7 bar for the problems count, the engine state and the auth level, where
   * the value itself is the signal. Omitted → the bar's own muted text color.
   */
  tone?: string;
  /** Accessible name when the visible label alone is not descriptive (e.g. "A2"). */
  ariaLabel?: string;
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
  // A read-only entry (the model name, a token count, the cwd) is not a broken button — it
  // is a label. Rendering it as `<button disabled>` made the browser drop its `title`
  // tooltip and announced it to a screen reader as an unavailable control, so the branch,
  // git ref and problem counts lost the hover text that is the only thing explaining them.
  const st = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    paddingInline: 7,
    paddingBlock: 0,
    height: "100%",
    background: "transparent",
    border: "none",
    // §7: the bar is 11px mono. A `tone` (a semantic var NAME) tints the whole entry.
    color: item.tone ? `var(${item.tone})` : "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    cursor: interactive ? "pointer" : "default",
    lineHeight: 1,
    whiteSpace: "nowrap",
  } as const;
  const body = (
    <>
      {item.glyph != null && (
        <span aria-hidden="true" style={{ flex: "none" }}>
          {item.glyph}
        </span>
      )}
      {/* ellipsis, not a hard clip: the group clips at its edge, and a label cut mid-glyph
          reads as a rendering bug rather than as truncation. */}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {item.label}
      </span>
    </>
  );
  if (interactive) {
    return (
      <button
        type="button"
        onClick={item.onClick}
        title={item.title}
        aria-label={item.ariaLabel}
        style={st}
      >
        {body}
      </button>
    );
  }
  // A bare <span> cannot carry an accessible name, so role="note" is added only when the
  // caller actually supplied one — an empty role on every static entry would be noise.
  return (
    <span
      title={item.title}
      style={st}
      {...(item.ariaLabel ? { role: "note", "aria-label": item.ariaLabel } : {})}
    >
      {body}
    </span>
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
        // §7: a hard 26px bar — not a rem multiple, so it cannot drift with the type scale.
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 26,
        flex: "none",
        paddingInline: 5,
        background: "var(--bg-inset)",
        borderTop: "1px solid var(--border-header)",
        color: "var(--text-muted)",
        userSelect: "none",
      }}
    >
      {/*
        `minWidth: 0` + `overflow: hidden` on the GROUP: every item inside is
        `whiteSpace: nowrap` and the labels are unbounded strings the workspace supplies —
        a git branch, a served model id, a venv path. Without this the group's min-content
        width is the sum of all of them, and a long branch name pushes the whole 26px
        footer wider than the window (§9 layout rules).
      */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: "100%",
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {shield != null && (
          <button
            type="button"
            onClick={onShieldClick}
            title="nemesis — click to open Security"
            aria-label={t("statusBar.shield", { tier: shield })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              paddingInline: 7,
              height: "100%",
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: "100%",
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {right.map((item) => (
          <Item key={item.id} item={item} />
        ))}
      </div>
    </footer>
  );
}

export default StatusBar;
