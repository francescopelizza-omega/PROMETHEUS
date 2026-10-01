// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/shared/path-completion/PathCompletionDropdown.tsx — the "@"-path suggestion
 * list, portaled to document.body and positioned by usePathCompletion's `box` (the SAME
 * useAnchoredLayer mechanism AgentPane's own mention/slash/model pickers already use, so
 * this reads as the same UI language rather than a bolted-on second style).
 */
import { type AnchoredLayerBox, Z } from "@prometheus/ui";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";

import type { PathCompletionEntryView } from "../../../shared/ipc-contract.js";

export interface PathCompletionDropdownProps {
  box: AnchoredLayerBox | null;
  items: readonly PathCompletionEntryView[];
  activeIndex: number;
  maxHeight?: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
}

const DEFAULT_MAX_HEIGHT = 220;

export function PathCompletionDropdown({
  box,
  items,
  activeIndex,
  maxHeight = DEFAULT_MAX_HEIGHT,
  onHover,
  onSelect,
}: PathCompletionDropdownProps): ReactElement | null {
  if (!box || items.length === 0) return null;
  return createPortal(
    <div
      aria-label="path completion"
      style={{
        position: "fixed",
        left: box.left,
        top: box.top,
        width: box.width,
        maxHeight,
        overflow: "auto",
        background: "var(--bg-surface-2)",
        border: "1px solid var(--border-strong)",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        zIndex: Z.dropdown,
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.name}
          type="button"
          aria-current={i === activeIndex ? "true" : undefined}
          onMouseEnter={() => onHover(i)}
          // Chromium focuses a clicked <button> by default; without this, selecting an
          // entry by mouse steals focus away from the text input (which then unmounts this
          // button, and focus falls back to document.body) — the caller's onBlur close()
          // would also fire mid-click otherwise. preventDefault on mousedown stops the
          // focus shift before it happens, so the input never loses focus at all.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(i)}
          style={{
            display: "flex",
            gap: 6,
            width: "100%",
            textAlign: "left",
            border: "none",
            padding: "4px 8px",
            cursor: "pointer",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.72rem",
            background: i === activeIndex ? "var(--bg-inset)" : "transparent",
            color: "var(--text-primary)",
          }}
        >
          <span aria-hidden="true" style={{ color: "var(--text-secondary)" }}>
            {item.isDir ? "▤" : "@"}
          </span>
          {item.name}
        </button>
      ))}
    </div>,
    document.body,
  );
}
