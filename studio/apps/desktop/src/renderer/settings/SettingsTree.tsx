// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * SettingsTree.tsx — the §2.1 Settings tree UI (file 13).
 *
 * Presentational + controlled: the authoritative tree (with `ownerFile` provenance)
 * comes from @prometheus/core over `window.prometheus` and is passed in as `nodes`
 * (the renderer can't import core — C5 sandbox). A search box filters the tree
 * (JetBrains-style) via the pure `filterNodes` helper. No raw hex.
 */
import { Panel } from "@prometheus/ui";
import { type ReactElement, useMemo, useState } from "react";

import { type SettingsNodeView, filterNodes } from "./settings-view.js";

export interface SettingsTreeProps {
  nodes: readonly SettingsNodeView[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

function Row({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: SettingsNodeView;
  depth: number;
  selected: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      aria-current={selected}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2, 4px)",
        width: "100%",
        textAlign: "left",
        padding: "var(--space-1, 2px) var(--space-3, 6px)",
        paddingLeft: `calc(var(--space-3, 6px) + ${depth * 14}px)`,
        background: selected ? "var(--bg-inset)" : "transparent",
        border: "none",
        borderRadius: "var(--radius-sm, 4px)",
        color: "var(--text-primary)",
        cursor: "pointer",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--text-small-size, 0.8125rem)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{node.title}</span>
      {node.layer && node.layer !== "unset" && node.layer !== "default" && (
        <span
          title={`overridden at ${node.layer} scope`}
          style={{
            color: "var(--accent)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            textTransform: "uppercase",
          }}
        >
          {node.layer}
        </span>
      )}
      <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
        [{node.ownerFile}]
      </span>
    </button>
  );
}

/** The §2.1 Settings tree with a JetBrains-style search filter. */
export function SettingsTree({ nodes, selectedId, onSelect }: SettingsTreeProps): ReactElement {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => (query ? filterNodes(nodes, query) : null), [nodes, query]);

  const renderTree = (list: readonly SettingsNodeView[], depth: number): ReactElement[] =>
    list.flatMap((n) => [
      <Row key={n.id} node={n} depth={depth} selected={n.id === selectedId} onSelect={onSelect} />,
      ...(n.children ? renderTree(n.children, depth + 1) : []),
    ]);

  return (
    <Panel title="Settings" elevation="e1">
      <input
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        placeholder="search settings…"
        aria-label="Search settings"
        style={{
          width: "100%",
          marginBottom: "var(--space-3, 6px)",
          background: "var(--bg-inset)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-sm, 4px)",
          padding: "var(--space-2, 4px)",
          fontFamily: "var(--font-ui)",
        }}
      />
      <div role="tree" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {filtered
          ? filtered.map((n) => (
              <Row
                key={n.id}
                node={n}
                depth={0}
                selected={n.id === selectedId}
                onSelect={onSelect}
              />
            ))
          : renderTree(nodes, 0)}
        {filtered?.length === 0 && (
          <div
            style={{
              color: "var(--text-secondary)",
              padding: "var(--space-3, 6px)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            no settings match “{query}”
          </div>
        )}
      </div>
    </Panel>
  );
}

export default SettingsTree;
