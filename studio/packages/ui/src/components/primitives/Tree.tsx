/**
 * Tree.tsx — a disclosure tree (file 08 §3.1; the §5.6 file explorer + §5.5 catalog
 * tree of tiers/scopes). `role="tree"` / `role="treeitem"` with `aria-expanded` +
 * `aria-level`, arrow-key navigation (Right expands, Left collapses, Up/Down move).
 *
 * The flatten + navigation logic is PURE + exported for tests (the tree's behaviour
 * is the testable surface; rendering is not). @radix-ui has no tree; this is the
 * vendored accessible implementation, token-styled.
 */

import { type KeyboardEvent, type ReactNode, useState } from "react";
import { fs, rad, sp, v } from "./styles.js";

export interface TreeNode {
  id: string;
  label: ReactNode;
  /** A leading glyph/icon (e.g. ▾ folder, a tier glyph ✓ ◆ ⓘ — §5.5). */
  icon?: ReactNode;
  /** A plain-text key used for the visible-row navigation (defaults to id). */
  text?: string;
  children?: TreeNode[];
}

/** A flattened, visible tree row (respecting the expanded set). Pure + testable. */
export interface FlatRow {
  node: TreeNode;
  level: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** Flatten a tree to the visible rows given the expanded-id set (pure). */
export function flattenTree(
  nodes: TreeNode[],
  expanded: ReadonlySet<string>,
  level = 0,
): FlatRow[] {
  const out: FlatRow[] = [];
  for (const node of nodes) {
    const hasChildren = (node.children?.length ?? 0) > 0;
    const isExpanded = expanded.has(node.id);
    out.push({ node, level, hasChildren, expanded: isExpanded });
    if (hasChildren && isExpanded) {
      out.push(...flattenTree(node.children!, expanded, level + 1));
    }
  }
  return out;
}

export interface TreeProps {
  nodes: TreeNode[];
  /** The currently-selected node id (controlled). */
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Open node ids (controlled); if omitted the Tree self-manages. */
  expandedIds?: string[];
  onExpandedChange?: (ids: string[]) => void;
  "aria-label"?: string;
  className?: string;
}

export function Tree({
  nodes,
  selectedId,
  onSelect,
  expandedIds,
  onExpandedChange,
  "aria-label": ariaLabel,
  className,
}: TreeProps): ReactNode {
  const [internalExpanded, setInternalExpanded] = useState<string[]>([]);
  const expanded = expandedIds ?? internalExpanded;
  const expandedSet = new Set(expanded);
  const [activeId, setActiveId] = useState<string | undefined>(selectedId);

  function setExpanded(ids: string[]): void {
    if (onExpandedChange) onExpandedChange(ids);
    else setInternalExpanded(ids);
  }
  function toggle(id: string): void {
    setExpanded(expandedSet.has(id) ? expanded.filter((x) => x !== id) : [...expanded, id]);
  }

  const rows = flattenTree(nodes, expandedSet);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const idx = rows.findIndex((r) => r.node.id === activeId);
    const cur = rows[idx];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveId(rows[Math.min(idx + 1, rows.length - 1)]?.node.id);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveId(rows[Math.max(idx - 1, 0)]?.node.id);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (cur?.hasChildren && !cur.expanded) toggle(cur.node.id);
        else if (cur?.hasChildren) setActiveId(rows[idx + 1]?.node.id);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (cur?.hasChildren && cur.expanded) toggle(cur.node.id);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (cur) {
          if (cur.hasChildren) toggle(cur.node.id);
          onSelect?.(cur.node.id);
        }
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="tree"
      aria-label={ariaLabel}
      className={className}
      onKeyDown={onKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a `tree` IS an interactive composite widget (the single tab stop that owns arrow-key roving over its treeitems, per the WAI-ARIA tree pattern) — tabIndex={0} is required here.
      tabIndex={0}
      style={{
        fontFamily: v("font-ui"),
        fontSize: fs("body"),
        color: v("text-primary"),
        outline: "none",
      }}
    >
      {rows.map((row) => {
        const selected = row.node.id === selectedId;
        const active = row.node.id === activeId;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: per the WAI-ARIA tree pattern, keyboard is handled once at the role="tree" container (single tab stop + arrow roving + Enter/Space); the treeitem onClick is the pointer path only.
          <div
            key={row.node.id}
            role="treeitem"
            aria-level={row.level + 1}
            aria-selected={selected}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            onClick={() => {
              setActiveId(row.node.id);
              if (row.hasChildren) toggle(row.node.id);
              onSelect?.(row.node.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: sp(2),
              height: "var(--row-h, 28px)",
              paddingInline: sp(2),
              paddingLeft: `calc(${sp(2)} + ${row.level} * 14px)`,
              borderRadius: rad("sm"),
              background: selected
                ? "color-mix(in srgb, var(--accent) 16%, transparent)"
                : active
                  ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                  : "transparent",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden="true" style={{ width: "1em", color: v("text-secondary") }}>
              {row.hasChildren ? (row.expanded ? "▾" : "▸") : ""}
            </span>
            {row.node.icon != null && <span aria-hidden="true">{row.node.icon}</span>}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.node.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export default Tree;
