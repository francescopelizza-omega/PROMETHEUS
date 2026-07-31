/**
 * ide/ClipboardHistory.tsx — the "Paste from History" picker (JetBrains ⌘⇧V · VS Code
 * clipboard-ring parity; plan file 01).
 *
 * A modal list of the renderer-local clipboard ring (useClipboardStore). Type to filter,
 * ↑/↓ to move, Enter to paste the selected entry at the caret — which it does by
 * dispatching `ide:insert-text` (EditorPane inserts it into the focused editor as a
 * single undo step). Esc / click-out closes.
 *
 * Renderer-SANDBOXED (C5): react + the pure store only. No engine, no IPC — the copied
 * text never leaves the renderer.
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import { useClipboardStore } from "./state/clipboard-store.js";

/** A single-line, whitespace-collapsed preview of a (possibly multi-line) entry. */
function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

export function ClipboardHistory({ onClose }: { onClose: () => void }): ReactElement {
  const entries = useClipboardStore((s) => s.entries);
  const clear = useClipboardStore((s) => s.clear);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.toLowerCase().includes(q));
  }, [entries, query]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const paste = (text: string | undefined): void => {
    if (typeof text === "string") {
      window.dispatchEvent(new CustomEvent("ide:insert-text", { detail: { text } }));
    }
    onClose();
  };

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 1100,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: 60,
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: role=dialog on a div matches the CommandPalette modal; we manage focus/escape ourselves rather than use <dialog> */}
      <div
        role="dialog"
        aria-label="paste from history"
        style={{
          width: "min(560px, 90vw)",
          background: "var(--bg-surface-2, #16161b)",
          border: "1px solid var(--border-subtle, #232329)",
          borderRadius: "var(--radius-md, 8px)",
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              paste(filtered[active]);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder="Paste from history — filter…"
          aria-label="clipboard history query"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--border-subtle, #232329)",
            color: "var(--text-primary, #e7e7ea)",
            fontSize: "0.9rem",
            outline: "none",
          }}
        />
        <div style={{ maxHeight: 360, overflow: "auto" }}>
          {filtered.length === 0 && (
            <p
              style={{ padding: 12, color: "var(--text-secondary, #9a9aa3)", fontSize: "0.82rem" }}
            >
              {entries.length === 0 ? "Clipboard history is empty." : "No matches."}
            </p>
          )}
          {filtered.map((entry, i) => (
            <button
              key={`${i}:${entry.slice(0, 24)}`}
              type="button"
              aria-current={i === active ? "true" : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => paste(entry)}
              title={entry}
              style={{
                width: "100%",
                textAlign: "left",
                border: "none",
                padding: "6px 12px",
                cursor: "pointer",
                background: i === active ? "var(--bg-surface-2, #1d1d24)" : "transparent",
                display: "flex",
                alignItems: "center",
                gap: 8,
                font: "inherit",
              }}
            >
              <span
                style={{
                  color: "var(--text-secondary, #9a9aa3)",
                  fontSize: "0.68rem",
                  width: 16,
                  textAlign: "right",
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  flex: 1,
                  fontSize: "0.8rem",
                  color: "var(--text-primary, #e7e7ea)",
                  fontFamily: "var(--font-mono, monospace)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {preview(entry)}
              </span>
            </button>
          ))}
        </div>
        {entries.length > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              padding: "4px 8px",
              borderTop: "1px solid var(--border-subtle, #232329)",
            }}
          >
            <button
              type="button"
              onClick={() => clear()}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-secondary, #9a9aa3)",
                cursor: "pointer",
                fontSize: "0.72rem",
                padding: "2px 6px",
              }}
            >
              Clear history
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ClipboardHistory;
