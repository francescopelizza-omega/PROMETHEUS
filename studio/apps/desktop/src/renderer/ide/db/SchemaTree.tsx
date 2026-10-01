// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * db/SchemaTree.tsx — the schema explorer (file 14 §3.26, APP-043).
 *
 * Presentational: a collapsible tables→columns tree fed by `sql.schema`. Clicking a
 * table seeds `SELECT * FROM <quoted> LIMIT 100` into the console (dialect-aware
 * identifier quoting so a mixed-case / reserved-word table doesn't break). No IPC here.
 */

import { type ReactElement, useState } from "react";

import type { IdeSqlTable } from "../../../shared/ipc-contract.js";
import type { SqlDialect } from "./sql-sources.js";

export interface SchemaTreeProps {
  tables: IdeSqlTable[];
  dialect: SqlDialect;
  onSeedQuery?: (sql: string) => void;
  /** APP-087: clicking a column inserts its quoted identifier into the query editor. */
  onInsertIdent?: (ident: string) => void;
}

/** Dialect-aware identifier quoting for the table-click seed. */
export function quoteIdent(name: string, dialect: SqlDialect): string {
  return dialect === "mysql" ? `\`${name.replace(/`/g, "")}\`` : `"${name.replace(/"/g, "")}"`;
}

export function SchemaTree({
  tables,
  dialect,
  onSeedQuery,
  onInsertIdent,
}: SchemaTreeProps): ReactElement {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (name: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  if (tables.length === 0) {
    return (
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          padding: "var(--space-2, 4px)",
        }}
      >
        no schema (connect a data source)
      </p>
    );
  }

  return (
    <div style={{ fontSize: "var(--text-small-size, 0.8125rem)", fontFamily: "var(--font-ui)" }}>
      {tables.map((t) => {
        const isOpen = open.has(t.name);
        return (
          <div key={t.name}>
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button
                type="button"
                aria-label={isOpen ? "collapse table" : "expand table"}
                onClick={() => toggle(t.name)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  width: 14,
                }}
              >
                {isOpen ? "▾" : "▸"}
              </button>
              <button
                type="button"
                title={`Seed SELECT * FROM ${t.name}`}
                onClick={() =>
                  onSeedQuery?.(`SELECT * FROM ${quoteIdent(t.name, dialect)} LIMIT 100`)
                }
                style={{
                  flex: 1,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  fontFamily: "var(--font-ui)",
                }}
              >
                {t.name}
                <span style={{ color: "var(--text-secondary)" }}>
                  {t.type === "view" ? " · view" : ""}
                </span>
              </button>
            </div>
            {isOpen &&
              t.columns.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  title={
                    c.fk ? `FK → ${c.fk.table}.${c.fk.to} · click to insert` : "click to insert"
                  }
                  onClick={() => onInsertIdent?.(quoteIdent(c.name, dialect))}
                  style={{
                    display: "flex",
                    gap: 6,
                    width: "100%",
                    textAlign: "left",
                    padding: "0 6px 0 24px",
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-mono, monospace)",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ color: c.pk ? "var(--accent)" : "var(--text-primary)" }}>
                    {c.pk ? "🔑 " : ""}
                    {c.name}
                  </span>
                  <span>{c.dtype}</span>
                  {!c.nullable && <span title="NOT NULL">*</span>}
                  {c.fk && (
                    <span style={{ color: "var(--warn)" }} title={`FK → ${c.fk.table}.${c.fk.to}`}>
                      🔗
                    </span>
                  )}
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
}

export default SchemaTree;
