// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * sql-client.ts — a thin typed marshaller over `runSidecar("sqlrunner.py", …)` for the
 * SQL console (file 14 §3.26, APP-041).
 *
 * JS never opens a DB connection: the sqlrunner.py sidecar owns every driver (sqlite/
 * postgres/mysql), the row-limit + timeout guards, and the credential redaction. This
 * wrapper only shapes the three verbs' argv (each option-value rides behind its own
 * flag; the positional connection string is guarded against a leading `-` so it can
 * never be read as a flag) and returns the sidecar's envelope verbatim.
 */

import { type SidecarEnvelope, type SidecarOptions, runSidecar } from "./sidecar-runner.js";

export interface SqlConnectResult extends SidecarEnvelope {
  dialect?: string;
  database?: string | null;
  server_version?: string;
  /** set on a fail-closed missing-driver envelope — the pip package to install. */
  driver_missing?: string;
}

export type SqlCell = string | number | boolean | null;

export interface SqlQueryResult extends SidecarEnvelope {
  columns?: string[];
  rows?: SqlCell[][];
  row_count?: number;
  truncated?: boolean;
  duration_ms?: number;
}

export interface SqlColumn {
  name: string;
  dtype: string;
  nullable: boolean;
  pk: boolean;
}

export interface SqlTable {
  name: string;
  type: "table" | "view";
  columns: SqlColumn[];
}

export interface SqlSchemaResult extends SidecarEnvelope {
  tables?: SqlTable[];
  count?: number;
}

export interface SqlQueryArgs {
  params?: SqlCell[];
  maxRows?: number;
  timeoutS?: number;
}

/** The injectable runner (defaults to the real fail-closed `runSidecar`). */
export type SidecarRunner = <T extends SidecarEnvelope>(
  script: "sqlrunner.py",
  argv: string[],
  opts?: SidecarOptions,
) => Promise<T>;

/** Reject an argv VALUE that would be read as a flag (option-injection guard). */
function guardPositional(value: string, what: string): void {
  if (value.startsWith("-")) throw new Error(`${what} must not start with '-'`);
}

export interface SqlClient {
  connect(conn: string, opts?: SidecarOptions): Promise<SqlConnectResult>;
  query(
    conn: string,
    sql: string,
    args?: SqlQueryArgs,
    opts?: SidecarOptions,
  ): Promise<SqlQueryResult>;
  schema(conn: string, table?: string, opts?: SidecarOptions): Promise<SqlSchemaResult>;
}

/** Build a SQL client over an (injectable) sidecar runner. */
export function createSqlClient(run: SidecarRunner = runSidecar): SqlClient {
  return {
    async connect(conn, opts) {
      guardPositional(conn, "connection string");
      return run<SqlConnectResult>("sqlrunner.py", ["sql.connect", conn], opts);
    },
    async query(conn, sql, args, opts) {
      guardPositional(conn, "connection string");
      const argv = ["sql.query", conn, "--sql", sql];
      if (args?.params) argv.push("--params", JSON.stringify(args.params));
      if (args?.maxRows !== undefined) argv.push("--max-rows", String(args.maxRows));
      if (args?.timeoutS !== undefined) argv.push("--timeout-s", String(args.timeoutS));
      return run<SqlQueryResult>("sqlrunner.py", argv, opts);
    },
    async schema(conn, table, opts) {
      guardPositional(conn, "connection string");
      const argv = ["sql.schema", conn];
      if (table) argv.push("--table", table);
      return run<SqlSchemaResult>("sqlrunner.py", argv, opts);
    },
  };
}

/** The default SQL client (real sidecar runner). */
export const sqlSidecar: SqlClient = createSqlClient();
