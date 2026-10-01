// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/DecisionOverlay.tsx — the §9 overlay contract, in one place.
 *
 * "Never render a decision surface in-flow (the VerdictSheet-below-the-fold lesson) —
 * verdict/permission decisions are overlays or pinned cards, never scroll-dependent."
 *
 * That lesson cost a release: a BLOCK verdict rendered as an ordinary child of a
 * scrolling route, so the verdict — and the escape hatch under it — sat below the fold.
 * The user saw a button do nothing. Three routes (models, repos, environments) still
 * rendered their gate sheet that way; catalog had a hand-rolled fixed wrapper that
 * nobody else could reuse. This is that wrapper, promoted and given the rest of the
 * contract:
 *
 *   - FIXED, centred, above everything at the modal rung (`Z.modal`), so it cannot
 *     scroll out of view;
 *   - FOCUS TRAP + focus restore, so Tab cannot walk into the page behind a pending
 *     decision;
 *   - ESCAPE closes (mapped to cancel — the safe answer);
 *   - a VISIBLE close control, because a modal whose only exit is a keyboard shortcut
 *     is a modal some users cannot leave;
 *   - the body scrolls INSIDE the overlay (`maxHeight: 90vh`), so a long findings list
 *     never pushes the actions off-screen — the same bug in a different costume.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui only.
 */

import { Z, useFocusTrap } from "@prometheus/ui";
import { type ReactElement, type ReactNode, useRef } from "react";

export interface DecisionOverlayProps {
  /** accessible name — what decision is being asked for. */
  label: string;
  /** Escape, the backdrop, and the ✕ all call this. It must be the SAFE answer. */
  onDismiss(): void;
  /** how wide the decision panel may get. */
  width?: number;
  children: ReactNode;
}

export function DecisionOverlay({
  label,
  onDismiss,
  width = 680,
  children,
}: DecisionOverlayProps): ReactElement {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef, true, onDismiss);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => {
        // backdrop-only: a click that started inside the panel must not dismiss it.
        if (e.target === e.currentTarget) onDismiss();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDismiss();
      }}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--bg-app) 65%, transparent)",
        padding: "var(--space-8)",
        overflow: "auto",
        zIndex: Z.modal,
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        style={{
          position: "relative",
          width: `min(${width}px, 100%)`,
          maxHeight: "90vh",
          overflow: "auto",
          outline: "none",
        }}
      >
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Close ${label}`}
          title="Close (Esc)"
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: Z.modal + 1,
            width: 26,
            height: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "var(--radius-md)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-strong)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}

export default DecisionOverlay;
