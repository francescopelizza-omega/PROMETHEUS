/**
 * ide/OutlineView.tsx — the Structure / Outline tool window (JetBrains Structure ·
 * VS Code Outline parity).
 *
 * Shows the ACTIVE editor file's symbol tree (classes / methods / functions / fields)
 * from `textDocument/documentSymbol`, with jump-to-symbol. The `documentSymbolProvider`
 * is already registered in Monaco (⌘⇧O); this panel consumes the same LSP request over
 * the existing lspEnsure/lspRequest transport (idempotent — reuses the running server),
 * so there is NO new IPC. Clicking a symbol dispatches `ide:reveal-position`, which the
 * focused EditorPane reveals.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the pure lsp-convert + stores +
 * window.prometheus only.
 */

import { Button } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { hasKnownLsp } from "./state/lang-detect.js";
import { type NormalizedSymbol, normalizeSymbols } from "./state/lsp-convert.js";
import { useTabsStore } from "./state/stores.js";
import { activeDoc } from "./state/tabs-reducer.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** LSP SymbolKind → a compact glyph (a small, legible subset; default "·"). */
const KIND_GLYPH: Record<number, string> = {
  5: "C", // Class
  11: "I", // Interface
  23: "S", // Struct
  10: "E", // Enum
  22: "e", // EnumMember
  12: "ƒ", // Function
  6: "m", // Method
  9: "◇", // Constructor
  7: "p", // Property
  8: "▪", // Field
  13: "v", // Variable
  14: "π", // Constant
  2: "▢", // Module
  3: "▢", // Namespace
  26: "T", // TypeParameter
};
function kindGlyph(kind: unknown): string {
  return typeof kind === "number" ? (KIND_GLYPH[kind] ?? "·") : "·";
}

/** Reveal a symbol in the focused editor (1-based line/column). */
function jump(s: NormalizedSymbol): void {
  window.dispatchEvent(
    new CustomEvent("ide:reveal-position", {
      detail: {
        line: s.selectionRange.start.line + 1,
        column: s.selectionRange.start.character + 1,
      },
    }),
  );
}

function SymbolRows({
  symbols,
  depth,
  keyPrefix,
  collapsed,
  toggle,
}: {
  symbols: NormalizedSymbol[];
  depth: number;
  keyPrefix: string;
  collapsed: Set<string>;
  toggle: (key: string) => void;
}): ReactElement {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {symbols.map((s, i) => {
        const key = `${keyPrefix}/${i}:${s.name}`;
        const hasKids = s.children.length > 0;
        const isCollapsed = collapsed.has(key);
        return (
          <li key={key}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                paddingLeft: depth * 12,
                fontSize: "0.74rem",
              }}
            >
              {hasKids ? (
                <button
                  type="button"
                  aria-label={isCollapsed ? "expand" : "collapse"}
                  onClick={() => toggle(key)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    width: 12,
                    padding: 0,
                  }}
                >
                  {isCollapsed ? "▸" : "▾"}
                </button>
              ) : (
                <span style={{ width: 12 }} />
              )}
              <span style={{ color: "var(--accent)", width: 12, textAlign: "center" }}>
                {kindGlyph(s.kind)}
              </span>
              <button
                type="button"
                onClick={() => jump(s)}
                style={{
                  flex: 1,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: "0.74rem",
                  padding: "1px 0",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {s.name}
                {s.detail ? (
                  <span style={{ color: "var(--text-secondary)" }}> {s.detail}</span>
                ) : null}
              </button>
            </div>
            {hasKids && !isCollapsed && (
              <SymbolRows
                symbols={s.children}
                depth={depth + 1}
                keyPrefix={key}
                collapsed={collapsed}
                toggle={toggle}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function OutlineView({ root }: { root: string }): ReactElement {
  const tabs = useTabsStore((s) => s.tabs);
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const active = activeDoc(tabs, tabs.focusedGroup);
  const uri = active?.uri;
  const lang = active?.languageId;

  const [symbols, setSymbols] = useState<NormalizedSymbol[]>([]);
  const [status, setStatus] = useState<"none" | "loading" | "empty" | "ready" | "unsupported">(
    "none",
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const api = ide();
    const wsRoot = workspaceRoot ?? root;
    if (!api || !uri || !lang) {
      setSymbols([]);
      setStatus("none");
      return;
    }
    if (!hasKnownLsp(lang)) {
      setSymbols([]);
      setStatus("unsupported");
      return;
    }
    setStatus("loading");
    const ens = await api.lspEnsure(lang, wsRoot).catch(() => undefined);
    if (!ens?.ok || !ens.serverId) {
      setSymbols([]);
      setStatus("empty");
      return;
    }
    const r = await api
      .lspRequest(ens.serverId, wsRoot, "textDocument/documentSymbol", {
        textDocument: { uri },
      })
      .catch(() => undefined);
    const syms = r?.ok ? normalizeSymbols(r.result) : [];
    setSymbols(syms);
    setStatus(syms.length > 0 ? "ready" : "empty");
  }, [uri, lang, workspaceRoot, root]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback((key: string) => {
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }, []);

  const fileName = uri ? (uri.split("/").pop() ?? uri) : "";

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 8, fontSize: "0.8rem" }}
      aria-label="outline"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span
          style={{
            flex: 1,
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono, monospace)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {fileName || "no file"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          disabled={status === "loading"}
        >
          {status === "loading" ? "…" : "⟳"}
        </Button>
      </div>

      {status === "none" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          Open a file to see its structure.
        </p>
      )}
      {status === "unsupported" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          No language server for this file type.
        </p>
      )}
      {status === "empty" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          No symbols (the server may still be indexing — press ⟳).
        </p>
      )}
      {symbols.length > 0 && (
        <SymbolRows
          symbols={symbols}
          depth={0}
          keyPrefix="root"
          collapsed={collapsed}
          toggle={toggle}
        />
      )}
    </div>
  );
}

export default OutlineView;
