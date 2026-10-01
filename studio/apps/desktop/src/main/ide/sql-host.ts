// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/sql-host.ts — the MAIN-process SQL bridge over the sqlrunner.py sidecar
 * (file 14 §3.26, APP-042).
 *
 * The renderer never touches a DB driver: this host delegates connect/query/schema to
 * the engine-bridge `SqlClient` (the sole child_process owner), REDACTS the connection
 * password from every response before it leaves MAIN, and PAGES a large result WITHOUT
 * re-querying the live DB — the sidecar's capped result is cached per (conn,sql,params)
 * for a short TTL and sliced per page, so pages stay consistent (rows don't shift
 * between fetches) and one IPC message stays bounded (≤ pageSize rows).
 *
 * Injectable `SqlClient` + clock so ide-ipc handlers are testable without python3.
 */

import type {
  SqlCell,
  SqlClient,
  SqlConnectResult,
  SqlQueryResult,
  SqlSchemaResult,
} from "@prometheus/engine-bridge";

import type {
  IdeSqlConnectResult,
  IdeSqlQueryRequest,
  IdeSqlQueryResult,
  IdeSqlSchemaResult,
} from "../../shared/ipc-contract.js";

const PASS_RE = /(:\/\/[^:@/]+):[^@/]+@/g;

/** Redact `:password@` from a conn string OR a sidecar error message (never leaks). */
export function redactConn(text: string): string {
  return text ? text.replace(PASS_RE, "$1:***@") : text;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
/** The capped result the sidecar returns per query — sliced per page in MAIN. */
const MAX_CACHE_ROWS = 50_000;
const CACHE_TTL_MS = 30_000;

function clampPageSize(n: number | undefined): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(v, MAX_PAGE_SIZE));
}

interface CachedResult {
  at: number;
  columns: string[];
  rows: SqlCell[][];
  truncated: boolean;
  durationMs?: number;
}

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class SqlHost {
  private readonly cache = new Map<string, CachedResult>();
  private readonly client: SqlClient;
  private readonly now: () => number;

  constructor(client: SqlClient, now: () => number = Date.now) {
    this.client = client;
    this.now = now;
  }

  async connect(conn: string): Promise<IdeSqlConnectResult> {
    const r = await this.client
      .connect(conn)
      .catch((e): SqlConnectResult => ({ ok: false, command: "sql.connect", error: errString(e) }));
    if (!r.ok) return { ok: false, error: redactConn(r.error ?? "connect failed") };
    const out: IdeSqlConnectResult = { ok: true };
    if (r.dialect) out.dialect = r.dialect;
    if (r.database) out.database = r.database;
    if (r.server_version) out.serverVersion = r.server_version;
    if (r.driver_missing) out.driverMissing = r.driver_missing;
    return out;
  }

  async query(req: IdeSqlQueryRequest): Promise<IdeSqlQueryResult> {
    const pageSize = clampPageSize(req.pageSize);
    const page = Math.max(0, Math.floor(req.page ?? 0));
    const key = `${req.conn}\x00${req.sql}\x00${JSON.stringify(req.params ?? [])}`;
    let cached = this.cache.get(key);
    if (!cached || this.now() - cached.at > CACHE_TTL_MS) {
      const r = await this.client
        .query(req.conn, req.sql, {
          ...(req.params ? { params: req.params } : {}),
          maxRows: MAX_CACHE_ROWS,
          ...(req.timeoutS !== undefined ? { timeoutS: req.timeoutS } : {}),
        })
        .catch((e): SqlQueryResult => ({ ok: false, command: "sql.query", error: errString(e) }));
      if (!r.ok) return { ok: false, error: redactConn(r.error ?? "query failed") };
      cached = {
        at: this.now(),
        columns: r.columns ?? [],
        rows: r.rows ?? [],
        truncated: r.truncated ?? false,
        ...(r.duration_ms !== undefined ? { durationMs: r.duration_ms } : {}),
      };
      this.cache.set(key, cached);
      this.evictExpired();
    }
    const total = cached.rows.length;
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    const p = Math.min(page, maxPage);
    return {
      ok: true,
      columns: cached.columns,
      rows: cached.rows.slice(p * pageSize, p * pageSize + pageSize),
      rowCount: total,
      truncated: cached.truncated,
      page: p,
      maxPage,
      ...(cached.durationMs !== undefined ? { durationMs: cached.durationMs } : {}),
    };
  }

  async schema(conn: string, table?: string): Promise<IdeSqlSchemaResult> {
    const r = await this.client
      .schema(conn, table)
      .catch((e): SqlSchemaResult => ({ ok: false, command: "sql.schema", error: errString(e) }));
    if (!r.ok) return { ok: false, error: redactConn(r.error ?? "schema failed") };
    return { ok: true, tables: r.tables ?? [], count: r.count ?? r.tables?.length ?? 0 };
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [k, v] of this.cache) if (now - v.at > CACHE_TTL_MS) this.cache.delete(k);
  }
}
