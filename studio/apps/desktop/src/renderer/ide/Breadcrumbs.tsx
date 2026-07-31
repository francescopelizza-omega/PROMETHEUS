/**
 * ide/Breadcrumbs.tsx — the editor breadcrumbs bar (VS Code breadcrumbs · JetBrains
 * navigation bar parity).
 *
 * A thin row under each group's TabBar showing `folder › folder › file.ts › Class ›
 * method` — the file's path (relative to the workspace root) followed by the SYMBOL
 * TRAIL that contains the caret. Clicking a symbol segment dispatches
 * `ide:reveal-position` (the same jump the Outline uses), so the caret lands on that
 * symbol. Path segments are display-only (no dead dropdowns).
 *
 * Data reuse — NO new IPC:
 *  · symbols come from `textDocument/documentSymbol` over the existing lspEnsure/
 *    lspRequest transport (same request the Outline + Monaco ⌘⇧O already run);
 *  · the caret position arrives via the `ide:cursor-position` CustomEvent that
 *    EditorPane's editor emits on every cursor move + model swap (filtered by group).
 *
 * Renderer-SANDBOXED (C5): react + the pure lsp-convert + stores + window.prometheus.
 */

import { type ReactElement, useEffect, useRef, useState } from "react";

import { hasKnownLsp } from "./state/lang-detect.js";
import { type LspRange, type NormalizedSymbol, normalizeSymbols } from "./state/lsp-convert.js";
import { useTabsStore } from "./state/stores.js";
import { activeDoc } from "./state/tabs-reducer.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** LSP SymbolKind → a compact glyph (subset; default "·"). Mirrors OutlineView. */
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

/** Is the 0-based (line, ch) caret inside this LSP range? */
function contains(r: LspRange, line: number, ch: number): boolean {
  const afterStart = line > r.start.line || (line === r.start.line && ch >= r.start.character);
  const beforeEnd = line < r.end.line || (line === r.end.line && ch <= r.end.character);
  return afterStart && beforeEnd;
}

/** Walk the symbol tree top-down, collecting the deepest chain that contains the caret. */
function trailAt(symbols: NormalizedSymbol[], line: number, ch: number): NormalizedSymbol[] {
  const out: NormalizedSymbol[] = [];
  let level = symbols;
  // bounded by tree depth; each step descends into the containing symbol's children.
  for (let guard = 0; guard < 64; guard++) {
    const hit = level.find((s) => contains(s.range, line, ch));
    if (!hit) break;
    out.push(hit);
    level = hit.children;
  }
  return out;
}

/** file:// uri (or scratch:) → display path segments relative to the workspace root. */
function pathSegments(uri: string, workspaceRoot: string | null | undefined): string[] {
  if (uri.startsWith("scratch:")) return [uri.slice("scratch:".length) || "scratch"];
  const stripScheme = (s: string): string => s.replace(/^file:\/\//, "");
  let fsPath: string;
  try {
    fsPath = decodeURIComponent(stripScheme(uri));
  } catch {
    fsPath = stripScheme(uri);
  }
  const root = workspaceRoot ? stripScheme(workspaceRoot).replace(/\/+$/, "") : "";
  let rel = fsPath;
  if (root && fsPath.startsWith(`${root}/`)) rel = fsPath.slice(root.length + 1);
  const segs = rel.split("/").filter(Boolean);
  // keep it legible when the file is deep outside the workspace — last 5 segments.
  return segs.length > 5 ? segs.slice(segs.length - 5) : segs;
}

/** Reveal a symbol's selection start in the focused editor (1-based). */
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

const SEP = "›";

export function Breadcrumbs({ group }: { group: number }): ReactElement | null {
  const tabs = useTabsStore((s) => s.tabs);
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const active = activeDoc(tabs, group);
  const uri = active?.uri;
  const lang = active?.languageId;

  const [symbols, setSymbols] = useState<NormalizedSymbol[]>([]);
  // caret 0-based {line, ch}; starts at document top so the path shows before any move.
  const [caret, setCaret] = useState<{ line: number; ch: number }>({ line: 0, ch: 0 });
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // fetch document symbols for the active file (immediate on uri change). Reuses the
  // Outline's transport — idempotent lspEnsure + lspRequest, no new IPC.
  useEffect(() => {
    let cancelled = false;
    const api = ide();
    const wsRoot = workspaceRoot;
    if (!api || !uri || !lang || !wsRoot || !hasKnownLsp(lang) || uri.startsWith("scratch:")) {
      setSymbols([]);
      return;
    }
    const run = async (): Promise<void> => {
      const ens = await api.lspEnsure(lang, wsRoot).catch(() => undefined);
      if (cancelled || !ens?.ok || !ens.serverId) {
        if (!cancelled) setSymbols([]);
        return;
      }
      const r = await api
        .lspRequest(ens.serverId, wsRoot, "textDocument/documentSymbol", {
          textDocument: { uri },
        })
        .catch(() => undefined);
      if (cancelled) return;
      setSymbols(r?.ok ? normalizeSymbols(r.result) : []);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [uri, lang, workspaceRoot]);

  // track the caret for THIS group; debounce a symbol refetch so the trail self-heals
  // after edits shift symbol ranges (the immediate fetch above handles tab switches).
  useEffect(() => {
    const onCursor = (e: Event): void => {
      const d = (e as CustomEvent<{ group?: number; line?: number; column?: number }>).detail;
      if (!d || d.group !== group || typeof d.line !== "number") return;
      setCaret({ line: d.line - 1, ch: typeof d.column === "number" ? d.column - 1 : 0 });
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        const api = ide();
        const wsRoot = workspaceRoot;
        if (!api || !uri || !lang || !wsRoot || !hasKnownLsp(lang) || uri.startsWith("scratch:")) {
          return;
        }
        void (async () => {
          const ens = await api.lspEnsure(lang, wsRoot).catch(() => undefined);
          if (!ens?.ok || !ens.serverId) return;
          const r = await api
            .lspRequest(ens.serverId, wsRoot, "textDocument/documentSymbol", {
              textDocument: { uri },
            })
            .catch(() => undefined);
          if (r?.ok) setSymbols(normalizeSymbols(r.result));
        })();
      }, 500);
    };
    window.addEventListener("ide:cursor-position", onCursor);
    return () => {
      window.removeEventListener("ide:cursor-position", onCursor);
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [group, uri, lang, workspaceRoot]);

  if (!active) return null;

  const segs = pathSegments(active.uri, workspaceRoot);
  const trail = trailAt(symbols, caret.line, caret.ch);

  const crumbStyle = {
    background: "transparent",
    border: "none",
    padding: "0 2px",
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: "0.72rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    maxWidth: 220,
  };

  return (
    <div
      aria-label="breadcrumbs"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        height: 22,
        minHeight: 22,
        padding: "0 8px",
        borderBottom: "1px solid var(--border-subtle, #232329)",
        background: "var(--bg-surface, #101015)",
        overflow: "hidden",
      }}
    >
      {segs.map((seg, i) => {
        const last = i === segs.length - 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: path segments are positional
          <span key={`p${i}`} style={{ display: "flex", alignItems: "center", gap: 2 }}>
            {i > 0 && (
              <span style={{ color: "var(--text-secondary, #9a9aa3)", fontSize: "0.7rem" }}>
                {SEP}
              </span>
            )}
            <span
              style={{
                ...crumbStyle,
                color: last ? "var(--text-primary, #e7e7ea)" : "var(--text-secondary, #9a9aa3)",
              }}
            >
              {seg}
            </span>
          </span>
        );
      })}
      {trail.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: symbol trail is positional
        <span key={`s${i}`} style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <span style={{ color: "var(--text-secondary, #9a9aa3)", fontSize: "0.7rem" }}>{SEP}</span>
          <span style={{ color: "var(--accent, #22d3ee)", fontSize: "0.7rem" }}>
            {kindGlyph(s.kind)}
          </span>
          <button
            type="button"
            onClick={() => jump(s)}
            title={`Jump to ${s.name}`}
            style={{ ...crumbStyle, color: "var(--text-primary, #e7e7ea)", cursor: "pointer" }}
          >
            {s.name}
          </button>
        </span>
      ))}
    </div>
  );
}

export default Breadcrumbs;
