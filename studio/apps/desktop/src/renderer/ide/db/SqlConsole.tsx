// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * SqlConsole.tsx — the SQL query console (file 14 §3.26).
 *
 * NOT DataGrip — a pragmatic subset: a `.sql` console + a paged read-only results grid +
 * a connection chip (password ALWAYS redacted). Presentational + controlled: the query
 * runs via the sqlrunner.py sidecar over window.prometheus (runtime seam; credentials in
 * the 09 keychain, never plaintext). Results stream paged (never a whole table). No raw hex.
 */
import { Button, Panel } from "@prometheus/ui";
import { type ReactElement, useMemo, useState } from "react";

import { type SqlResult, paginate, parseConnString, resultSummary } from "./sql-view.js";

export interface SqlConsoleProps {
  connString?: string;
  query: string;
  result?: SqlResult;
  executing?: boolean;
  error?: string;
  pageSize?: number;
  /** APP-043 server paging: when `onPageChange` is set the grid renders `result.rows`
   *  AS the current page and the pager calls back (the container re-queries via IPC —
   *  no client-side slicing, so APP-041's row cap is never defeated). */
  serverPage?: number;
  serverMaxPage?: number;
  onPageChange?: (page: number) => void;
  onQueryChange?: (q: string) => void;
  onRun?: (q: string) => void;
  /** APP-087: export the current result. */
  onExport?: (format: "csv" | "json") => void;
  /** APP-087: the ER diagram (mermaid) of the connected schema — shown in a copyable pre. */
  erMermaid?: string;
  /** APP-087: NL-to-SQL copilot. `onAsk` places generated SQL into the editor (never runs
   *  it). When `nlAvailable` is false the row shows an actionable no-backend notice. */
  onAsk?: (question: string) => void;
  nlAvailable?: boolean;
  nlBusy?: boolean;
}

/** The §3.26 SQL console + results grid. */
export function SqlConsole({
  connString,
  query,
  result,
  executing,
  error,
  pageSize = 50,
  serverPage,
  serverMaxPage,
  onPageChange,
  onQueryChange,
  onRun,
  onExport,
  erMermaid,
  onAsk,
  nlAvailable,
  nlBusy,
}: SqlConsoleProps): ReactElement {
  const [page, setPage] = useState(0);
  const [showEr, setShowEr] = useState(false);
  const [question, setQuestion] = useState("");
  const conn = useMemo(() => (connString ? parseConnString(connString) : undefined), [connString]);
  const paged = useMemo(
    () => (result ? paginate(result.rows, pageSize, page) : undefined),
    [result, pageSize, page],
  );
  // APP-043: server paging renders result.rows AS the current page (no client slice).
  const serverPaged = onPageChange !== undefined;
  const gridRows = serverPaged ? (result?.rows ?? []) : (paged?.rows ?? []);
  const curPage = serverPaged ? (serverPage ?? 0) : (paged?.page ?? 0);
  const curMax = serverPaged ? (serverMaxPage ?? 0) : (paged?.maxPage ?? 0);
  const gotoPage = (p: number): void => {
    if (serverPaged) onPageChange?.(p);
    else setPage(p);
  };

  return (
    <Panel title="SQL Console" elevation="e1">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3, 6px)",
          marginBottom: "var(--space-2, 4px)",
          fontSize: "var(--text-small-size, 0.8125rem)",
        }}
      >
        {conn && (
          <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
            {conn.driver}://{conn.user ? `${conn.user}@` : ""}
            {conn.host}
            {conn.port ? `:${conn.port}` : ""}/{conn.database} {conn.password ? "🔒" : ""}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {erMermaid && (
          <Button variant="ghost" aria-pressed={showEr} onClick={() => setShowEr((v) => !v)}>
            {showEr ? "hide ER" : "◫ ER"}
          </Button>
        )}
        <Button variant="primary" disabled={executing} onClick={() => onRun?.(query)}>
          {executing ? "running…" : "▶ Run"}
        </Button>
      </div>

      {showEr && erMermaid && (
        <pre
          aria-label="ER diagram (mermaid)"
          style={{
            margin: "0 0 var(--space-2, 4px)",
            maxHeight: 220,
            overflow: "auto",
            background: "var(--bg-app)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md, 6px)",
            padding: "var(--space-2, 4px)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            color: "var(--text-primary)",
            whiteSpace: "pre",
          }}
        >
          {erMermaid}
        </pre>
      )}

      <textarea
        value={query}
        onChange={(e) => onQueryChange?.(e.currentTarget.value)}
        aria-label="SQL query"
        placeholder="SELECT * FROM …"
        rows={4}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "var(--bg-app)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-md, 6px)",
          padding: "var(--space-2, 4px)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-code-size, 0.78125rem)",
          resize: "vertical",
          outline: "none",
        }}
      />

      {/* APP-087: NL-to-SQL copilot — generated SQL is placed in the editor, NEVER run. */}
      {onAsk && (
        <div
          style={{ display: "flex", gap: "var(--space-2, 4px)", marginTop: "var(--space-2, 4px)" }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.currentTarget.value)}
            aria-label="ask the database"
            placeholder={
              nlAvailable
                ? "Ask the database (local model)…"
                : "start a local model in Model Hub to enable"
            }
            disabled={!nlAvailable || nlBusy}
            style={{
              flex: 1,
              background: "var(--bg-app)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md, 6px)",
              padding: "var(--space-2, 4px)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          />
          <Button
            variant="ghost"
            disabled={!nlAvailable || nlBusy || !question.trim()}
            title="Generate SQL into the editor for review (never auto-run)"
            onClick={() => onAsk?.(question.trim())}
          >
            {nlBusy ? "…" : "✦ Ask"}
          </Button>
        </div>
      )}

      {error && (
        <p
          style={{
            color: "var(--danger)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            margin: "var(--space-2, 4px) 0",
          }}
        >
          {error}
        </p>
      )}

      {result && (
        <div style={{ marginTop: "var(--space-2, 4px)" }}>
          <div
            style={{
              overflow: "auto",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md, 6px)",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-small-size, 0.8125rem)",
              }}
            >
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th
                      key={c}
                      style={{
                        textAlign: "left",
                        padding: "var(--space-1, 2px) var(--space-2, 4px)",
                        color: "var(--text-secondary)",
                        borderBottom: "1px solid var(--border-subtle)",
                      }}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gridRows.map((row, ri) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no stable id; index is the row identity within a page
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td
                        key={`${ri}-${result.columns[ci] ?? ci}`}
                        style={{
                          padding: "var(--space-1, 2px) var(--space-2, 4px)",
                          color: cell === null ? "var(--text-disabled)" : "var(--text-primary)",
                          borderBottom: "1px solid var(--border-subtle)",
                        }}
                      >
                        {cell === null ? "NULL" : String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2, 4px)",
              marginTop: "var(--space-2, 4px)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              color: "var(--text-secondary)",
            }}
          >
            <span>{resultSummary(result)}</span>
            <span style={{ flex: 1 }} />
            {onExport && (
              <>
                <Button
                  variant="ghost"
                  onClick={() => onExport("csv")}
                  title="Export result as CSV"
                >
                  ⭳ CSV
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => onExport("json")}
                  title="Export result as JSON"
                >
                  ⭳ JSON
                </Button>
              </>
            )}
            <Button variant="ghost" disabled={curPage <= 0} onClick={() => gotoPage(curPage - 1)}>
              ‹
            </Button>
            <span>
              {curPage + 1} / {curMax + 1}
            </span>
            <Button
              variant="ghost"
              disabled={curPage >= curMax}
              onClick={() => gotoPage(curPage + 1)}
            >
              ›
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

export default SqlConsole;
