/**
 * marketplace/MarketplaceView.tsx — the four-tab marketplace browser (file 09 §6).
 *
 * [Plugins] [Skills] [MCP Servers] [Extensions] + search + sort, every row carrying a
 * VerdictChip. PURE projection: rows + selection + handlers come from props; the
 * component filters/sorts the active tab's rows (cosmetic) and emits Install/Details
 * callbacks. It NEVER installs or gates — the container runs the verdict-gated flow
 * (engine dry-run → verdict card → confirm), per §6. Engine strings are inert().
 */
import { type ReactElement, useMemo } from "react";
import type { ReactNode } from "react";
import { inert } from "../patterns/util.js";
import { VerdictChip } from "./VerdictChip.js";
import {
  type MarketplaceRow,
  type MarketplaceTab,
  type SortBy,
  filterRows,
  sortRows,
  tierGlyph,
} from "./types.js";

const TABS: { id: MarketplaceTab; label: string }[] = [
  { id: "plugins", label: "Plugins" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP Servers" },
  { id: "extensions", label: "Extensions" },
];

export interface MarketplaceViewProps {
  tab: MarketplaceTab;
  onTabChange(tab: MarketplaceTab): void;
  /** which tabs to show (default: all four). The container passes only the WIRED tabs so it
   *  never advertises a Plugins/Skills tab it has no data source for (→ permanently empty). */
  tabs?: { id: MarketplaceTab; label: string }[];
  query: string;
  onQueryChange(query: string): void;
  sort: SortBy;
  onSortChange(sort: SortBy): void;
  /** rows for the ACTIVE tab (the container supplies them per tab). */
  rows: readonly MarketplaceRow[];
  selectedId?: string | null;
  onSelect(id: string | null): void;
  /** verdict-gated install flow runs in the container (§6). */
  onInstall(row: MarketplaceRow): void;
  /** optional slot the container fills with the MCP-tab body (McpServerList). */
  mcpSlot?: ReactNode;
}

export function MarketplaceView(props: MarketplaceViewProps): ReactElement {
  const { tab, rows, query, sort, selectedId } = props;
  const visible = useMemo(() => sortRows(filterRows(rows, query), sort), [rows, query, sort]);
  const selected = visible.find((r) => r.id === selectedId);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      {/* tab strip + search + sort */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-6, 12px)",
          padding: "var(--space-4, 8px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexWrap: "wrap",
        }}
      >
        <nav style={{ display: "flex", gap: "var(--space-2, 4px)" }}>
          {(props.tabs ?? TABS).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => props.onTabChange(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              style={{
                background: tab === t.id ? "var(--bg-surface-2)" : "transparent",
                border: "1px solid",
                borderColor: tab === t.id ? "var(--border-strong)" : "transparent",
                color: tab === t.id ? "var(--text-primary)" : "var(--text-secondary)",
                borderRadius: "var(--radius-md, 6px)",
                padding: "var(--space-2, 4px) var(--space-4, 8px)",
                cursor: "pointer",
                fontSize: "var(--text-small-size, 0.8125rem)",
                fontWeight: tab === t.id ? 600 : 400,
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <input
          value={query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          placeholder="search…"
          aria-label="Search the marketplace"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 120,
            background: "var(--bg-inset)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md, 6px)",
            padding: "var(--space-2, 4px) var(--space-4, 8px)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2, 4px)",
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          sort
          <select
            value={sort}
            onChange={(e) => props.onSortChange(e.target.value as SortBy)}
            style={{
              background: "var(--bg-inset)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md, 6px)",
              padding: "2px 6px",
            }}
          >
            <option value="rank">rank</option>
            <option value="name">name</option>
            <option value="verdict">verdict</option>
          </select>
        </label>
      </header>

      {/* body: the MCP tab delegates to the injected McpServerList; others list rows. */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {tab === "mcp" && props.mcpSlot ? (
          props.mcpSlot
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {visible.map((row) => (
              <li
                key={row.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-4, 8px)",
                  padding: "var(--space-4, 8px) var(--space-6, 12px)",
                  borderBottom: "1px solid var(--border-subtle)",
                  background: row.id === selectedId ? "var(--bg-surface-2)" : "transparent",
                }}
              >
                <span aria-hidden="true" style={{ color: "var(--text-secondary)" }}>
                  {tierGlyph(row.tier)}
                </span>
                <button
                  type="button"
                  onClick={() => props.onSelect(row.id === selectedId ? null : row.id)}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    fontSize: "var(--text-body-size, 0.875rem)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                    whiteSpace: "nowrap",
                  }}
                >
                  <strong>{inert(row.name)}</strong>
                  {row.repo && (
                    <span style={{ color: "var(--text-secondary)" }}> · {inert(row.repo)}</span>
                  )}
                </button>
                <VerdictChip verdict={row.worstVerdict} />
                {row.installed ? (
                  // installed rows are 'installable:false' but ARE manageable — show Manage,
                  // not the confusing "not installable" text, as the primary affordance.
                  <button
                    type="button"
                    onClick={() => props.onInstall(row)}
                    style={{
                      background: "var(--bg-surface-2)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-strong)",
                      borderRadius: "var(--radius-md, 6px)",
                      padding: "var(--space-2, 4px) var(--space-6, 12px)",
                      cursor: "pointer",
                      fontSize: "var(--text-small-size, 0.8125rem)",
                      fontWeight: 600,
                    }}
                  >
                    Manage
                  </button>
                ) : row.installable === false ? (
                  <span
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: "var(--text-small-size, 0.8125rem)",
                    }}
                  >
                    not installable
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => props.onInstall(row)}
                    style={{
                      background: "var(--brand)",
                      // The label sits ON the `--brand` fill, so it needs the computed `--on-brand`.
                      // `--brand-fg` is #ffffff on the dark scheme and measures 3.96:1 over `--brand` —
                      // under the 4.5:1 a label carries. It stays in use where it is a FILL, not a label
                      // (the Toggle knob), which is why this is a call-site change and not a token change.
                      color: "var(--on-brand)",
                      border: "none",
                      borderRadius: "var(--radius-md, 6px)",
                      padding: "var(--space-2, 4px) var(--space-6, 12px)",
                      cursor: "pointer",
                      fontSize: "var(--text-small-size, 0.8125rem)",
                      fontWeight: 600,
                    }}
                  >
                    Install
                  </button>
                )}
              </li>
            ))}
            {visible.length === 0 && (
              <li
                style={{
                  padding: "var(--space-12, 24px)",
                  color: "var(--text-secondary)",
                  textAlign: "center",
                }}
              >
                {query.trim() ? (
                  <>No matches for “{inert(query)}”.</>
                ) : (
                  <>Nothing here yet — install one to get started.</>
                )}
              </li>
            )}
          </ul>
        )}
      </div>

      {/* detail pane (§6) */}
      {selected && (
        <footer
          style={{
            borderTop: "1px solid var(--border-subtle)",
            padding: "var(--space-6, 12px)",
            background: "var(--bg-surface)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-4, 8px)",
              marginBottom: "var(--space-3, 6px)",
            }}
          >
            <strong>{inert(selected.name)}</strong>
            <VerdictChip verdict={selected.worstVerdict} />
            {selected.repo && (
              <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                {inert(selected.repo)}
              </span>
            )}
            {selected.rank != null && (
              <span style={{ color: "var(--text-secondary)" }}>rank #{selected.rank}</span>
            )}
          </div>
          {selected.summary && (
            <p style={{ margin: 0, color: "var(--text-secondary)" }}>{inert(selected.summary)}</p>
          )}
          {selected.securityNote && (
            <p style={{ margin: "var(--space-2, 4px) 0 0", color: "var(--warn)" }}>
              security: {inert(selected.securityNote)}
            </p>
          )}
        </footer>
      )}
    </div>
  );
}
