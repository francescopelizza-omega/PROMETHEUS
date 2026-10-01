// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/BookmarksPanel.tsx — the Bookmarks tool window (APP-061).
 *
 * A token-styled floating panel listing every bookmark grouped by file (path-sorted, then
 * line), each row showing its mnemonic badge (0–9) + line + optional label. Click a row to
 * navigate (opens the tab if closed, via the container's onNavigate); ✕ removes it. Reads
 * the shared useBookmarksStore — the pure model is node:test-covered in bookmarks.test.ts.
 *
 * Renderer-SANDBOXED (C5): react + the store only — no monaco/electron/core.
 */
import { type CSSProperties, type ReactElement, useMemo, useRef } from "react";

import { Z, useFocusTrap } from "@prometheus/ui";
import { type Bookmark, allSorted, useBookmarksStore } from "./state/bookmarks.js";

export interface BookmarksPanelProps {
  /** navigate to a bookmark (open the tab if closed + reveal the line). */
  onNavigate(uri: string, line: number): void;
  onClose(): void;
}

/** The file basename for a uri (display only — the full uri is the row key). */
function basename(uri: string): string {
  const path = uri.replace(/^[a-z]+:\/\//, "");
  return path.split("/").pop() || uri;
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3, 6px)",
  padding: "var(--space-2, 4px) var(--space-3, 6px)",
  borderRadius: "var(--radius-sm, 4px)",
  cursor: "pointer",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

export function BookmarksPanel({ onNavigate, onClose }: BookmarksPanelProps): ReactElement {
  // §9.2 overlay contract: it declares role="dialog" but had no focus trap and no Escape —
  // Tab walked the editor behind it and the ✕ was the only way out.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(rootRef, true, onClose);

  const state = useBookmarksStore((s) => s.state);
  const remove = useBookmarksStore((s) => s.remove);
  // group by file (path-sorted) → the rows, guarded against a partial store.
  const groups = useMemo(() => {
    const byUri = new Map<string, Bookmark[]>();
    for (const b of allSorted(state)) {
      const arr = byUri.get(b.uri) ?? [];
      arr.push(b);
      byUri.set(b.uri, arr);
    }
    return [...byUri.entries()];
  }, [state]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Bookmarks"
      style={{
        // `fixed`, not `absolute` (§9.2): as `absolute` this resolved against whatever
        // ancestor happened to be positioned — the editor route root is not — so the panel's
        // "10% from the top, centred" was measured against an arbitrary box and moved when
        // the layout around it changed. Fixed means the viewport, which is what the numbers
        // below have always described.
        position: "fixed",
        top: "10%",
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(560px, 80vw)",
        maxHeight: "70vh",
        overflow: "auto",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-md, 6px)",
        boxShadow: "var(--elevation-e3, 0 10px 40px rgba(0,0,0,0.4))",
        // Z.modal: it declares role="dialog" and is the only thing the user can interact
        // with while it is up. On the `dropdown` rung (500) any menu opened behind it would
        // have painted over it.
        zIndex: Z.modal,
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-3, 6px) var(--space-4, 8px)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <strong>Bookmarks</strong>
        <button
          type="button"
          aria-label="Close bookmarks"
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: "0.9rem",
          }}
        >
          ✕
        </button>
      </header>

      {groups.length === 0 ? (
        <div style={{ padding: "var(--space-8, 16px)", color: "var(--text-secondary)" }}>
          No bookmarks yet. Toggle one with ⌘/Ctrl-F3, or set a numbered mnemonic with
          ⌘/Ctrl-Shift-&lt;digit&gt;.
        </div>
      ) : (
        <div style={{ padding: "var(--space-2, 4px)" }}>
          {groups.map(([uri, marks]) => (
            <div key={uri} style={{ marginBottom: "var(--space-3, 6px)" }}>
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.72rem",
                  padding: "var(--space-1, 2px) var(--space-3, 6px)",
                }}
                title={uri}
              >
                {basename(uri)}
              </div>
              {marks.map((b) => (
                <div
                  key={`${uri}:${b.line}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onNavigate(uri, b.line)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onNavigate(uri, b.line);
                  }}
                  style={rowStyle}
                >
                  <span
                    aria-hidden={b.mnemonic === undefined}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 18,
                      height: 18,
                      flexShrink: 0,
                      borderRadius: "var(--radius-sm, 4px)",
                      border: "1px solid var(--border-strong)",
                      color: b.mnemonic === undefined ? "var(--text-secondary)" : "var(--accent)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.72rem",
                    }}
                  >
                    {b.mnemonic ?? "•"}
                  </span>
                  <span
                    style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}
                  >
                    line {b.line}
                    {b.label ? ` · ${b.label}` : ""}
                  </span>
                  <button
                    type="button"
                    aria-label={`remove bookmark at line ${b.line}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(uri, b.line);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      fontSize: "0.8rem",
                      padding: 0,
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default BookmarksPanel;
