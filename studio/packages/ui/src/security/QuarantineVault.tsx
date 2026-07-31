/**
 * QuarantineVault.tsx — the quarantine table (file 03 §9.2).
 *
 * Lists the items nemesis sidelined (a `QuarantineListResult` the renderer
 * parses into `SecQuarantineItem[]`). Each row offers two exits:
 *   - Restore — REVERSIBLE: puts the file back where it came from.
 *   - Purge   — IRREVERSIBLE: deletes it for good (the row hands off to the
 *               §9.3 PurgeDialog via `onPurge`, which performs the typed-name
 *               confirm — this table never deletes directly).
 * Multi-select drives a small bulk-action bar.
 *
 * Presentational only — it emits the chosen action + ids and renders engine
 * strings (path, rule id, source) as inert text. No decision logic (C5).
 */

import { type ReactElement, useState } from "react";
import { Button } from "../components/Button.js";
import type { SecQuarantineItem } from "./types.js";
import { inertText } from "./util.js";

export interface QuarantineVaultProps {
  items: SecQuarantineItem[];
  /** Restore one item (reversible). */
  onRestore?: (id: string) => void;
  /** Purge one item (irreversible) — the renderer opens the PurgeDialog. */
  onPurge?: (id: string) => void;
  /** Bulk restore the current selection. */
  onRestoreSelected?: (ids: string[]) => void;
  /** Bulk purge the current selection (renderer confirms each / batch). */
  onPurgeSelected?: (ids: string[]) => void;
  className?: string;
}

function shortDate(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? inertText(at) : d.toLocaleString();
}

const cellStyle = {
  paddingBlock: "var(--space-3, 6px)",
  paddingInline: "var(--space-4, 8px)",
  textAlign: "left" as const,
  fontWeight: 400,
};

export function QuarantineVault({
  items,
  onRestore,
  onPurge,
  onRestoreSelected,
  onPurgeSelected,
  className,
}: QuarantineVaultProps): ReactElement {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)));
  };
  const selectedIds = items.filter((i) => selected.has(i.id)).map((i) => i.id);

  return (
    <div
      className={className}
      style={{ fontFamily: "var(--font-ui)", color: "var(--text-primary)" }}
    >
      {selectedIds.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-4, 8px)",
            paddingBlock: "var(--space-3, 6px)",
            paddingInline: "var(--space-4, 8px)",
            background: "var(--bg-surface-2)",
            borderRadius: "var(--radius-md, 6px)",
            marginBottom: "var(--space-4, 8px)",
          }}
        >
          <span style={{ fontSize: "var(--text-small-size, 0.8125rem)" }}>
            {selectedIds.length} selected
          </span>
          <Button size="sm" variant="secondary" onClick={() => onRestoreSelected?.(selectedIds)}>
            Restore selected
          </Button>
          <Button size="sm" variant="danger" onClick={() => onPurgeSelected?.(selectedIds)}>
            Purge selected
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <p
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          Quarantine is empty.
        </p>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <thead>
            <tr
              style={{
                color: "var(--text-secondary)",
                borderBottom: "1px solid var(--border-strong)",
              }}
            >
              <th style={{ ...cellStyle, width: "2rem" }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all quarantined items"
                />
              </th>
              <th style={cellStyle}>Path</th>
              <th style={cellStyle}>Rule</th>
              <th style={cellStyle}>Source</th>
              <th style={cellStyle}>Quarantined</th>
              <th style={{ ...cellStyle, textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                <td style={cellStyle}>
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    aria-label={`Select ${item.path}`}
                  />
                </td>
                <td
                  style={{ ...cellStyle, fontFamily: "var(--font-mono)" }}
                  title={inertText(item.path)}
                >
                  {inertText(item.path)}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {inertText(item.rule_id)}
                </td>
                <td style={{ ...cellStyle, color: "var(--text-secondary)" }}>
                  {item.from ? inertText(item.from) : "—"}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {shortDate(item.quarantined_at)}
                </td>
                <td style={{ ...cellStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                  <Button size="sm" variant="secondary" onClick={() => onRestore?.(item.id)}>
                    Restore
                  </Button>{" "}
                  <Button size="sm" variant="danger" onClick={() => onPurge?.(item.id)}>
                    Purge
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default QuarantineVault;
