// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/CallHierarchyView.tsx — the Call Hierarchy tool window (JetBrains "Call Hierarchy"
 * ⌥⌘H · VS Code "Show Call Hierarchy" parity).
 *
 * Place the caret on a function/method, open this panel, hit ⟳ — it runs
 * `textDocument/prepareCallHierarchy` at the caret, then lazily expands each node via
 * `callHierarchy/incomingCalls` (Callers) or `callHierarchy/outgoingCalls` (Callees).
 * Clicking a node opens its file (tabs store) and reveals the call site.
 *
 * Reuse — NO new IPC:
 *  · the caret arrives via the `ide:cursor-position` CustomEvent EditorPane already
 *    emits (added for Breadcrumbs); we keep the latest {uri,line,column};
 *  · symbols cross the existing lspEnsure/lspRequest transport (same as the Outline);
 *  · jumping reuses the tabs store `open` + the `ide:reveal-position` event.
 *
 * Renderer-SANDBOXED (C5): react + the pure lang-detect + stores + window.prometheus.
 */

import { Button } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { detectLanguage, hasKnownLsp } from "./state/lang-detect.js";
import type { LspRange } from "./state/lsp-convert.js";
import { useTabsStore } from "./state/stores.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** LSP CallHierarchyItem (the fields we consume). */
interface CHItem {
  name: string;
  kind?: number;
  detail?: string;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}

/** A lazily-expanded node: an item + its (unfetched=null) child calls. */
interface HierNode {
  id: string;
  item: CHItem;
  /** the call-site range to reveal when clicked (a caller's fromRange, or the item's own). */
  reveal: LspRange;
  children: HierNode[] | null; // null = not yet fetched
  expanded: boolean;
  loading: boolean;
}

const KIND_GLYPH: Record<number, string> = {
  12: "ƒ", // Function
  6: "m", // Method
  9: "◇", // Constructor
  5: "C", // Class
};
function kindGlyph(kind: unknown): string {
  return typeof kind === "number" ? (KIND_GLYPH[kind] ?? "·") : "·";
}

function isRange(r: unknown): r is LspRange {
  const o = r as LspRange | undefined;
  const pos = (p: unknown): boolean =>
    !!p && typeof p === "object" && typeof (p as { line?: unknown }).line === "number";
  return !!o && pos(o.start) && pos(o.end);
}

/** Coerce one raw LSP CallHierarchyItem (dropping anything malformed). */
function toItem(raw: unknown): CHItem | null {
  const o = raw as Partial<CHItem> | undefined;
  if (!o || typeof o.uri !== "string" || !isRange(o.range) || !isRange(o.selectionRange)) {
    return null;
  }
  return {
    name: typeof o.name === "string" && o.name ? o.name : "?",
    kind: typeof o.kind === "number" ? o.kind : undefined,
    detail: typeof o.detail === "string" ? o.detail : undefined,
    uri: o.uri,
    range: o.range,
    selectionRange: o.selectionRange,
  };
}

function basename(uri: string): string {
  return uri.split("/").pop() ?? uri;
}

/** Open the target file (preview tab) then reveal the 0-based range start (→1-based). */
function jump(uri: string, r: LspRange): void {
  useTabsStore
    .getState()
    .open(uri, { name: basename(uri), languageId: detectLanguage(uri), preview: true });
  // the model swap (fsRead) is async — reveal after it settles; a re-click retries.
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("ide:reveal-position", {
        detail: { line: r.start.line + 1, column: r.start.character + 1 },
      }),
    );
  }, 160);
}

let nodeSeq = 0;
function mkNode(item: CHItem, reveal: LspRange): HierNode {
  nodeSeq += 1;
  return { id: `n${nodeSeq}`, item, reveal, children: null, expanded: false, loading: false };
}

export function CallHierarchyView({ root }: { root: string }): ReactElement {
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const [mode, setMode] = useState<"callers" | "callees">("callers");
  const [roots, setRoots] = useState<HierNode[]>([]);
  const [status, setStatus] = useState<
    "idle" | "loading" | "empty" | "ready" | "unsupported" | "nocaret"
  >("idle");
  const [targetName, setTargetName] = useState<string>("");
  // latest caret from EditorPane's cursor events (1-based line/column + uri + lang).
  const caretRef = useRef<{ uri: string; line: number; column: number } | null>(null);

  useEffect(() => {
    const onCursor = (e: Event): void => {
      const d = (e as CustomEvent<{ uri?: string; line?: number; column?: number }>).detail;
      if (!d || typeof d.uri !== "string" || typeof d.line !== "number") return;
      caretRef.current = { uri: d.uri, line: d.line, column: d.column ?? 1 };
    };
    window.addEventListener("ide:cursor-position", onCursor);
    return () => window.removeEventListener("ide:cursor-position", onCursor);
  }, []);

  /** Ensure the LSP server for a uri's language; returns {serverId, wsRoot} or null. */
  const ensure = useCallback(
    async (uri: string): Promise<{ serverId: string; wsRoot: string } | null> => {
      const api = ide();
      const wsRoot = workspaceRoot ?? root;
      const lang = detectLanguage(uri);
      if (!api || !wsRoot || !hasKnownLsp(lang) || uri.startsWith("scratch:")) return null;
      const ens = await api.lspEnsure(lang, wsRoot).catch(() => undefined);
      if (!ens?.ok || !ens.serverId) return null;
      return { serverId: ens.serverId, wsRoot };
    },
    [workspaceRoot, root],
  );

  /** Fetch the incoming/outgoing calls for an item → child nodes. */
  const fetchCalls = useCallback(
    async (item: CHItem): Promise<HierNode[]> => {
      const api = ide();
      const e = await ensure(item.uri);
      if (!api || !e) return [];
      const method =
        mode === "callers" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
      const r = await api.lspRequest(e.serverId, e.wsRoot, method, { item }).catch(() => undefined);
      if (!r?.ok || !Array.isArray(r.result)) return [];
      const out: HierNode[] = [];
      for (const call of r.result as unknown[]) {
        const c = call as { from?: unknown; to?: unknown; fromRanges?: unknown };
        const child = toItem(mode === "callers" ? c.from : c.to);
        if (!child) continue;
        // callers: reveal the call SITE inside the caller (first fromRange). callees:
        // reveal the callee's own selection.
        const fr = Array.isArray(c.fromRanges) && isRange(c.fromRanges[0]) ? c.fromRanges[0] : null;
        const reveal = mode === "callers" ? (fr ?? child.selectionRange) : child.selectionRange;
        out.push(mkNode(child, reveal));
      }
      return out;
    },
    [mode, ensure],
  );

  /** Run prepareCallHierarchy at the caret → the root node(s). */
  const analyze = useCallback(async () => {
    const caret = caretRef.current;
    if (!caret) {
      setStatus("nocaret");
      setRoots([]);
      return;
    }
    const api = ide();
    const e = await ensure(caret.uri);
    if (!api || !e) {
      setStatus("unsupported");
      setRoots([]);
      return;
    }
    setStatus("loading");
    const r = await api
      .lspRequest(e.serverId, e.wsRoot, "textDocument/prepareCallHierarchy", {
        textDocument: { uri: caret.uri },
        position: { line: caret.line - 1, character: Math.max(0, caret.column - 1) },
      })
      .catch(() => undefined);
    const raw = r?.ok && Array.isArray(r.result) ? r.result : [];
    const items = raw.map(toItem).filter(Boolean) as CHItem[];
    if (items.length === 0) {
      setStatus("empty");
      setRoots([]);
      setTargetName("");
      return;
    }
    setTargetName(items[0]?.name ?? "");
    setRoots(items.map((it) => mkNode(it, it.selectionRange)));
    setStatus("ready");
  }, [ensure]);

  // re-analyze when the caller/callee mode flips (skip the initial mount so an untouched
  // panel stays "idle" instead of eagerly running with no caret).
  const firstRef = useRef(true);
  // A Callers↔Callees flip must REBUILD the roots (fresh tree for the new direction),
  // even though `analyze` itself doesn't read `mode` — hence `mode` is a deliberate dep.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mode` re-run is intentional
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    void analyze();
  }, [mode, analyze]);

  /** Toggle a node — lazily fetch its children on first expand. */
  const toggle = useCallback(
    async (node: HierNode) => {
      const setTree = (mut: (n: HierNode) => void): void => {
        setRoots((prev) => {
          const walk = (list: HierNode[]): HierNode[] =>
            list.map((n) => {
              if (n.id === node.id) {
                const copy = { ...n, children: n.children ? [...n.children] : n.children };
                mut(copy);
                return copy;
              }
              return n.children ? { ...n, children: walk(n.children) } : n;
            });
          return walk(prev);
        });
      };
      if (node.children === null && !node.loading) {
        setTree((n) => {
          n.loading = true;
          n.expanded = true;
        });
        const kids = await fetchCalls(node.item);
        setTree((n) => {
          n.children = kids;
          n.loading = false;
          n.expanded = true;
        });
        return;
      }
      setTree((n) => {
        n.expanded = !n.expanded;
      });
    },
    [fetchCalls],
  );

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 8, fontSize: "0.8rem" }}
      aria-label="call-hierarchy"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
        <Button
          size="sm"
          variant={mode === "callers" ? "primary" : "ghost"}
          onClick={() => setMode("callers")}
        >
          Callers
        </Button>
        <Button
          size="sm"
          variant={mode === "callees" ? "primary" : "ghost"}
          onClick={() => setMode("callees")}
        >
          Callees
        </Button>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={() => void analyze()} title="Analyze at caret">
          {status === "loading" ? "…" : "⟳"}
        </Button>
      </div>

      {targetName && status === "ready" && (
        <div
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.72rem",
            marginBottom: 6,
          }}
        >
          {mode === "callers" ? "Callers of" : "Callees of"}{" "}
          <span style={{ color: "var(--text-primary)" }}>{targetName}</span>
        </div>
      )}

      {status === "idle" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          Put the caret on a function, then press ⟳.
        </p>
      )}
      {status === "nocaret" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          No caret yet — click into an editor first.
        </p>
      )}
      {status === "unsupported" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          No call-hierarchy server for this file type.
        </p>
      )}
      {status === "empty" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          Nothing at the caret (the server may still be indexing — press ⟳).
        </p>
      )}
      {roots.length > 0 && <HierRows nodes={roots} depth={0} toggle={toggle} />}
    </div>
  );
}

function HierRows({
  nodes,
  depth,
  toggle,
}: {
  nodes: HierNode[];
  depth: number;
  toggle: (n: HierNode) => void;
}): ReactElement {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {nodes.map((n) => (
        <li key={n.id}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              paddingLeft: depth * 12,
              fontSize: "0.74rem",
            }}
          >
            <button
              type="button"
              aria-label={n.expanded ? "collapse" : "expand"}
              onClick={() => void toggle(n)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                width: 12,
                padding: 0,
              }}
            >
              {n.loading ? "…" : n.expanded ? "▾" : "▸"}
            </button>
            <span style={{ color: "var(--accent)", width: 12, textAlign: "center" }}>
              {kindGlyph(n.item.kind)}
            </span>
            <button
              type="button"
              onClick={() => jump(n.item.uri, n.reveal)}
              title={n.item.uri}
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
                minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                whiteSpace: "nowrap",
              }}
            >
              {n.item.name}
              <span style={{ color: "var(--text-secondary)" }}> {basename(n.item.uri)}</span>
            </button>
          </div>
          {n.expanded && n.children && n.children.length > 0 && (
            <HierRows nodes={n.children} depth={depth + 1} toggle={toggle} />
          )}
          {n.expanded && n.children && n.children.length === 0 && (
            <div
              style={{
                paddingLeft: (depth + 1) * 12 + 12,
                color: "var(--text-secondary)",
                fontSize: "0.7rem",
              }}
            >
              (none)
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export default CallHierarchyView;
