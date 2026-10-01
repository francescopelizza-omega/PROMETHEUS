// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * EngineState.tsx — the §3.2 status-bar molecule (08 §4.2 / §5.2). Projects the
 * bridge connectivity probe (python ok? nemesis present? DB freshness?) into the
 * ambient nemesis shield: a `<VerdictBadge compact>` whose tier is derived
 * fail-closed by `shieldTier`, click → opens the Security panel (rule #2: security
 * is always one glance away, never a destination you must remember).
 *
 * Binds an `EngineStateData` (mirror of the bridge probe) via a TYPE-ONLY import (C5).
 *
 * GOLDEN RULE (C5): NEVER decides "safe" — `shieldTier` is a pure, FAIL-CLOSED
 * projection (python down / nemesis missing / DB absent ⇒ the loud `error` shield;
 * a stale DB downgrades a clean shield to `warn`; it never upgrades toward `allow`).
 * The shield is announced + labelled (the glyph + tier text carry it, not color).
 */

import type { ReactElement } from "react";
import { VerdictBadge } from "../components/VerdictBadge.js";
import type { EngineStateData } from "./types.js";
import { type EngineProbe, engineSummary, shieldTier } from "./util.js";

export interface EngineStateProps {
  state: EngineStateData;
  /** Open the Security panel (the shield click target, 08 §4.2). */
  onOpenSecurity?: () => void;
  /** Compact = the status-bar shield (glyph only); default shows a short summary. */
  compact?: boolean;
  className?: string;
}

export function EngineState({
  state,
  onOpenSecurity,
  compact = true,
  className,
}: EngineStateProps): ReactElement {
  const probe: EngineProbe = {
    pythonOk: state.pythonOk,
    nemesisPresent: state.nemesisPresent,
    dbFreshness: state.dbFreshness,
    shield: state.shield,
  };
  const tier = shieldTier(probe);
  const summary = engineSummary(probe);

  const content = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-3, 6px)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <span aria-hidden="true">🛡</span>
      <VerdictBadge
        verdict={tier}
        compact={compact}
        aria-label={`nemesis shield: ${tier}. ${summary}`}
      />
      {!compact && (
        <span
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          {summary}
        </span>
      )}
    </span>
  );

  if (onOpenSecurity) {
    return (
      <button
        type="button"
        className={className}
        onClick={onOpenSecurity}
        title={summary}
        data-shield={tier}
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "var(--space-1, 2px)",
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <span className={className} title={summary} data-shield={tier}>
      {content}
    </span>
  );
}

export default EngineState;
