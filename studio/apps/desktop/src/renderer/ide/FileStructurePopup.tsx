/**
 * ide/FileStructurePopup.tsx — the ⌘F12 File Structure popup (JetBrains "File Structure" ·
 * VS Code "Go to Symbol in Editor"; APP-097). A centered modal over the active editor listing
 * the current file's documentSymbol tree, filter-as-you-type (subsequence match, ancestor
 * chain retained), ↑/↓ + Enter to jump, Esc to close. Focus is trapped in the filter input
 * while open and restored to the Monaco editor on close (an APP-100 a11y requirement met from
 * day one) — hence a React portal, not a Monaco-owned overlay widget.
 *
 * Presentational + pure: symbols are fetched by the EditorPane host and the pure
 * `filterSymbols` does the matching; this component owns only the input/keyboard/focus UX.
 *
 * Renderer-SANDBOXED (C5): react (+ createPortal) + the pure structure-filter + lsp-convert
 * types. No window.prometheus, no IPC.
 */

import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Z } from "@prometheus/ui";
import type { NormalizedSymbol } from "./state/lsp-convert.js";
import { filterSymbols } from "./state/structure-filter.js";

/** LSP SymbolKind → a compact glyph (superset of the hierarchy views' class-only set). */
const KIND_GLYPH: Record<number, string> = {
  5: "C", // Class
  6: "m", // Method
  9: "⊕", // Constructor
  8: "◆", // Field
  7: "◇", // Property
  10: "E", // Enum
  11: "I", // Interface
  12: "ƒ", // Function
  13: "v", // Variable
  14: "◦", // Constant
  23: "S", // Struct
  22: "e", // EnumMember
  26: "T", // TypeParameter
};
function kindGlyph(kind: unknown): string {
  return typeof kind === "number" ? (KIND_GLYPH[kind] ?? "·") : "·";
}

export function FileStructurePopup({
  symbols,
  onSelect,
  onClose,
}: {
  symbols: NormalizedSymbol[];
  /** jump to a chosen symbol (the host reveals its selectionRange); popup then closes. */
  onSelect(symbol: NormalizedSymbol): void;
  /** close + restore focus to the editor (the host owns the restore). */
  onClose(): void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const rows = useMemo(() => filterSymbols(symbols, query), [symbols, query]);

  // clamp the selection whenever the filtered set changes.
  useEffect(() => {
    setSel((s) => (rows.length === 0 ? 0 : Math.min(s, rows.length - 1)));
  }, [rows.length]);

  // focus the filter input on open (focus trap: the input is the only tab stop).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // keep the selected row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: number): void => {
    const row = rows[i];
    if (row) {
      onSelect(row.symbol);
      onClose();
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (rows.length === 0 ? 0 : (s + 1) % rows.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (rows.length === 0 ? 0 : (s - 1 + rows.length) % rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(sel);
    } else if (e.key === "Tab") {
      e.preventDefault(); // trap focus — the input stays the only tab stop
    }
  };

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop is a click-to-dismiss target; keyboard dismiss is Esc, handled on the dialog.
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        background: "var(--overlay, rgba(0,0,0,0.35))",
        zIndex: Z.dropdown,
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a role="dialog" div matches the other EditorPane overlay hosts; a native <dialog> needs showModal() plumbing that fights the portal + focus-trap approach. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="File Structure"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          width: "min(560px, 90vw)",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface-1)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "var(--shadow-e3, 0 12px 40px rgba(0,0,0,0.45))",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          type="text"
          aria-label="filter symbols"
          placeholder="Filter symbols…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            margin: 8,
            padding: "6px 8px",
            fontSize: "0.82rem",
            background: "var(--surface-2)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            outline: "none",
          }}
        />
        <ul
          ref={listRef}
          style={{ listStyle: "none", margin: 0, padding: "0 8px 8px", overflow: "auto", flex: 1 }}
        >
          {rows.length === 0 && (
            <li style={{ color: "var(--text-secondary)", fontSize: "0.76rem", padding: 6 }}>
              No matching symbols.
            </li>
          )}
          {rows.map((r, i) => (
            <li key={`${r.symbol.name}:${r.symbol.selectionRange.start.line}:${r.depth}`}>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav is ↑/↓/Enter on the dialog; rows are pointer shortcuts, and the row is not a tab stop (focus is trapped in the filter input). */}
              <div
                aria-current={i === sel}
                onClick={() => choose(i)}
                onMouseMove={() => setSel(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  paddingLeft: 6 + r.depth * 14,
                  paddingRight: 6,
                  paddingTop: 2,
                  paddingBottom: 2,
                  fontSize: "0.78rem",
                  borderRadius: 4,
                  cursor: "pointer",
                  background: i === sel ? "var(--surface-3)" : "transparent",
                }}
              >
                <span style={{ color: "var(--accent)", width: 12, textAlign: "center" }}>
                  {kindGlyph(r.symbol.kind)}
                </span>
                <span
                  style={{
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono, monospace)",
                  }}
                >
                  {r.symbol.name}
                </span>
                {r.symbol.detail && (
                  <span
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: "0.72rem",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.symbol.detail}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

export default FileStructurePopup;
