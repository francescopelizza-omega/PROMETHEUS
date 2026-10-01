// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/Segmented.tsx — the segmented control the merged routes share (handoff_3 §1).
 *
 * Catalog and Workspace each swallowed three former rail nouns, so both need one control
 * that says which of three things you are looking at. Before this, every tab strip in the
 * app was hand-rolled: catalog.tsx had an underline strip with `aria-current="page"` and no
 * `role="tab"`, docs.tsx had pills WITH `role="tab"`, and MarketplaceView had a third. They
 * looked different and only one was navigable by keyboard.
 *
 * This is a PILL/segmented control, not the underline `Tabs` primitive in @prometheus/ui —
 * §1 asks for segmented, and the distinction is not cosmetic: an underline reads as "these
 * are sections of the page below", a segment reads as "these are alternatives, one at a
 * time", which is what a merged route is.
 *
 * Keyboard: roving tabindex with Arrow/Home/End per the ARIA tabs pattern, reusing the pure
 * `nextTabIndex` helper so the wrap arithmetic has one implementation.
 */

import { nextTabIndex } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useRef } from "react";

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  /** optional trailing count — the catalog/workspace segments show how many rows are behind them. */
  count?: number;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  /** the accessible name of the group (e.g. "Catalog sections"). */
  label: string;
  className?: string;
  style?: CSSProperties;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  style,
}: SegmentedProps<T>): ReactElement {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const index = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={label}
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 2,
        borderRadius: "var(--radius-lg)",
        background: "var(--bg-inset)",
        border: "1px solid var(--border-chip)",
        // §7: a segment label must never wrap — a two-line pill breaks the strip's height
        // and, in a flex row beside a search box, it is the first thing to collapse.
        flex: "none",
        ...style,
      }}
      onKeyDown={(e) => {
        const next = nextTabIndex(e.key, index, options.length);
        if (next === index) return;
        e.preventDefault();
        const target = options[next];
        if (!target) return;
        onChange(target.id);
        // move real focus with the selection (roving tabindex, not just aria)
        stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 11px",
              borderRadius: "var(--radius-md)",
              border: "1px solid transparent",
              background: active ? "var(--bg-active)" : "transparent",
              borderColor: active ? "var(--border-strong)" : "transparent",
              color: active ? "var(--text-title)" : "var(--text-secondary)",
              fontFamily: "var(--font-ui)",
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              cursor: "pointer",
              whiteSpace: "nowrap", // §7
            }}
          >
            {o.label}
            {typeof o.count === "number" && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  color: "var(--text-muted)",
                }}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default Segmented;
