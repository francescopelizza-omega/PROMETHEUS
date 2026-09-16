/**
 * ide/MethodHierarchyView.tsx — the Method Hierarchy tool window (JetBrains "Method
 * Hierarchy" · APP-097). For the method under the caret, walk the enclosing type's
 * super/subtypes and badge each type with whether it DEFINES / OVERRIDES / INHERITS a member
 * of that name — so you can see where a method is declared and everywhere it's overridden.
 *
 * Mirrors TypeHierarchyView (same caret feed + LSP transport + reveal) and adds a per-type
 * `textDocument/documentSymbol` membership check. The defines/overrides badge is a NAME
 * heuristic (there is no LSP method-hierarchy request): a same-name/different-signature
 * overload reads as an override, so the badge is labeled name-based, not signature-resolved.
 *
 * Fan-out is bounded — depth ≤ MAX_DEPTH, types fetched lazily per expanded node (never an
 * eager whole-graph walk), each type costing one documentSymbol parse.
 *
 * Renderer-SANDBOXED (C5): react + the pure lang-detect/structure-filter + stores +
 * window.prometheus.
 */

import { Button } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { detectLanguage, hasKnownLsp } from "./state/lang-detect.js";
import { type LspRange, normalizeSymbols } from "./state/lsp-convert.js";
import { useTabsStore } from "./state/stores.js";
import { memberMatch, symbolAtPosition } from "./state/structure-filter.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** Max super/subtype traversal depth — documentSymbol per type is a full-file parse, so keep
 *  the lazy walk shallow (fetch on expand, never eager). */
const MAX_DEPTH = 4;

/** LSP TypeHierarchyItem (the fields we consume). */
interface THItem {
  name: string;
  kind?: number;
  detail?: string;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}

/** Where a type stands relative to the caret's method (the name-based badge). */
type Membership = "defines" | "overrides" | "inherits";

/** A lazily-expanded type node: the item + its membership + (unfetched=null) related types. */
interface HierNode {
  id: string;
  item: THItem;
  /** the member (same name) inside THIS type, if any — the click target + badge source. */
  memberRange: LspRange | null;
  children: HierNode[] | null; // null = not yet fetched
  expanded: boolean;
  loading: boolean;
}

const KIND_GLYPH: Record<number, string> = {
  5: "C", // Class
  11: "I", // Interface
  23: "S", // Struct
  10: "E", // Enum
  26: "T", // TypeParameter
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

function toItem(raw: unknown): THItem | null {
  const o = raw as Partial<THItem> | undefined;
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

function jump(uri: string, r: LspRange): void {
  useTabsStore
    .getState()
    .open(uri, { name: basename(uri), languageId: detectLanguage(uri), preview: true });
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("ide:reveal-position", {
        detail: { line: r.start.line + 1, column: r.start.character + 1 },
      }),
    );
  }, 160);
}

let nodeSeq = 0;
function mkNode(item: THItem, memberRange: LspRange | null): HierNode {
  nodeSeq += 1;
  return { id: `m${nodeSeq}`, item, memberRange, children: null, expanded: false, loading: false };
}

/** The badge for a node given its depth (0 = the caret's own type) and mode. */
function membershipOf(
  node: HierNode,
  isRoot: boolean,
  mode: "supertypes" | "subtypes",
): Membership {
  if (!node.memberRange) return "inherits";
  if (isRoot) return "defines";
  return mode === "subtypes" ? "overrides" : "defines";
}

const BADGE_COLOR: Record<Membership, string> = {
  defines: "var(--ok)",
  overrides: "var(--warn)",
  inherits: "var(--text-secondary)",
};

export function MethodHierarchyView({ root }: { root: string }): ReactElement {
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const [mode, setMode] = useState<"supertypes" | "subtypes">("subtypes");
  const [roots, setRoots] = useState<HierNode[]>([]);
  const [methodName, setMethodName] = useState<string>("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "empty" | "nomethod" | "ready" | "unsupported" | "nocaret"
  >("idle");
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

  /** Fetch a type's documentSymbol → the member (same name) inside it, or null. Scoped to the
   *  matching type symbol's children when found, else the whole file (a defensive fallback). */
  const memberIn = useCallback(
    async (item: THItem, name: string): Promise<LspRange | null> => {
      const api = ide();
      const e = await ensure(item.uri);
      if (!api || !e || !name) return null;
      const r = await api
        .lspRequest(e.serverId, e.wsRoot, "textDocument/documentSymbol", {
          textDocument: { uri: item.uri },
        })
        .catch(() => undefined);
      if (!r?.ok) return null;
      const syms = normalizeSymbols(r.result);
      const type = syms.find((s) => s.name === item.name);
      const hit = memberMatch(name, type ? type.children : syms);
      return hit ? hit.selectionRange : null;
    },
    [ensure],
  );

  /** Fetch the super/subtypes of an item, each tagged with its membership. */
  const fetchTypes = useCallback(
    async (item: THItem, name: string): Promise<HierNode[]> => {
      const api = ide();
      const e = await ensure(item.uri);
      if (!api || !e) return [];
      const method = mode === "supertypes" ? "typeHierarchy/supertypes" : "typeHierarchy/subtypes";
      const r = await api.lspRequest(e.serverId, e.wsRoot, method, { item }).catch(() => undefined);
      if (!r?.ok || !Array.isArray(r.result)) return [];
      const items = (r.result as unknown[]).map(toItem).filter(Boolean) as THItem[];
      const members = await Promise.all(items.map((it) => memberIn(it, name)));
      return items.map((it, i) => mkNode(it, members[i] ?? null));
    },
    [mode, ensure, memberIn],
  );

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
    // the member under the caret = deepest symbol whose range contains it.
    const ds = await api
      .lspRequest(e.serverId, e.wsRoot, "textDocument/documentSymbol", {
        textDocument: { uri: caret.uri },
      })
      .catch(() => undefined);
    const symbols = ds?.ok ? normalizeSymbols(ds.result) : [];
    const at = symbolAtPosition(symbols, caret.line - 1, Math.max(0, caret.column - 1));
    const name = at?.name ?? "";
    if (!name) {
      setStatus("nomethod");
      setRoots([]);
      setMethodName("");
      return;
    }
    setMethodName(name);
    // the enclosing type hierarchy root.
    const r = await api
      .lspRequest(e.serverId, e.wsRoot, "textDocument/prepareTypeHierarchy", {
        textDocument: { uri: caret.uri },
        position: { line: caret.line - 1, character: Math.max(0, caret.column - 1) },
      })
      .catch(() => undefined);
    const items = (r?.ok && Array.isArray(r.result) ? r.result : [])
      .map(toItem)
      .filter(Boolean) as THItem[];
    if (items.length === 0) {
      setStatus("empty");
      setRoots([]);
      return;
    }
    const members = await Promise.all(items.map((it) => memberIn(it, name)));
    setRoots(items.map((it, i) => mkNode(it, members[i] ?? null)));
    setStatus("ready");
  }, [ensure, memberIn]);

  const firstRef = useRef(true);
  // A Supertypes↔Subtypes flip rebuilds the tree for the new direction.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mode` re-run is intentional
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    void analyze();
  }, [mode, analyze]);

  const toggle = useCallback(
    async (node: HierNode, depth: number) => {
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
        if (depth >= MAX_DEPTH) {
          setTree((n) => {
            n.children = []; // depth cap — stop the lazy walk, render as a leaf
            n.expanded = true;
          });
          return;
        }
        setTree((n) => {
          n.loading = true;
          n.expanded = true;
        });
        const kids = await fetchTypes(node.item, methodName);
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
    [fetchTypes, methodName],
  );

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 8, fontSize: "0.8rem" }}
      aria-label="method-hierarchy"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
        <Button
          size="sm"
          variant={mode === "supertypes" ? "primary" : "ghost"}
          onClick={() => setMode("supertypes")}
        >
          Supertypes
        </Button>
        <Button
          size="sm"
          variant={mode === "subtypes" ? "primary" : "ghost"}
          onClick={() => setMode("subtypes")}
        >
          Subtypes
        </Button>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={() => void analyze()} title="Analyze at caret">
          {status === "loading" ? "…" : "⟳"}
        </Button>
      </div>

      {methodName && status === "ready" && (
        <div
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.72rem",
            marginBottom: 6,
          }}
        >
          {mode === "supertypes" ? "Supertypes defining" : "Subtypes overriding"}{" "}
          <span style={{ color: "var(--text-primary)" }}>{methodName}()</span>{" "}
          <span title="badges are name-based, not signature-resolved">·(name-based)</span>
        </div>
      )}

      {status === "idle" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          Put the caret on a method, then press ⟳.
        </p>
      )}
      {status === "nocaret" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          No caret yet — click into an editor first.
        </p>
      )}
      {status === "nomethod" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          No method at the caret — put it on a method name, then press ⟳.
        </p>
      )}
      {status === "unsupported" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          No hierarchy server for this file type.
        </p>
      )}
      {status === "empty" && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          No enclosing type at the caret (the server may still be indexing — press ⟳).
        </p>
      )}
      {roots.length > 0 && <HierRows nodes={roots} depth={0} mode={mode} toggle={toggle} />}
    </div>
  );
}

function HierRows({
  nodes,
  depth,
  mode,
  toggle,
}: {
  nodes: HierNode[];
  depth: number;
  mode: "supertypes" | "subtypes";
  toggle: (n: HierNode, depth: number) => void;
}): ReactElement {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {nodes.map((n) => {
        const badge = membershipOf(n, depth === 0, mode);
        return (
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
                onClick={() => void toggle(n, depth)}
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
                onClick={() => jump(n.item.uri, n.memberRange ?? n.item.selectionRange)}
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
              <span style={{ color: BADGE_COLOR[badge], fontSize: "0.64rem", fontWeight: 600 }}>
                {badge}
              </span>
            </div>
            {n.expanded && n.children && n.children.length > 0 && (
              <HierRows nodes={n.children} depth={depth + 1} mode={mode} toggle={toggle} />
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
        );
      })}
    </ul>
  );
}

export default MethodHierarchyView;
