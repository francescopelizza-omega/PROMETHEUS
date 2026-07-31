/**
 * sql-host.test.ts — the MAIN SQL bridge (APP-042): paging (slice a cached capped
 * result, no per-page re-query), password redaction on every response, connect/schema
 * mapping. A fake SqlClient records calls — no python3 spawned.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  SqlClient,
  SqlConnectResult,
  SqlQueryResult,
  SqlSchemaResult,
} from "@prometheus/engine-bridge";

import { SqlHost, redactConn } from "./sql-host.js";

const rows250: number[][] = Array.from({ length: 250 }, (_, i) => [i]);

function makeClient(
  script: {
    connect?: SqlConnectResult;
    query?: SqlQueryResult;
    schema?: SqlSchemaResult;
  } = {},
): { client: SqlClient; calls: { connect: number; query: number; schema: number } } {
  const calls = { connect: 0, query: 0, schema: 0 };
  const client: SqlClient = {
    async connect() {
      calls.connect++;
      return (
        script.connect ?? {
          ok: true,
          command: "sql.connect",
          dialect: "sqlite",
          database: "t.db",
          server_version: "3.45",
        }
      );
    },
    async query() {
      calls.query++;
      return (
        script.query ?? {
          ok: true,
          command: "sql.query",
          columns: ["id"],
          rows: rows250,
          row_count: 250,
          truncated: false,
          duration_ms: 4,
        }
      );
    },
    async schema() {
      calls.schema++;
      return (
        script.schema ?? {
          ok: true,
          command: "sql.schema",
          tables: [{ name: "t", type: "table", columns: [] }],
          count: 1,
        }
      );
    },
  };
  return { client, calls };
}

test("connect maps the sidecar envelope to the renderer shape", async () => {
  const { client } = makeClient();
  const r = await new SqlHost(client).connect("sqlite:///t.db");
  assert.equal(r.ok, true);
  assert.equal(r.dialect, "sqlite");
  assert.equal(r.database, "t.db");
  assert.equal(r.serverVersion, "3.45");
});

test("connect error is redacted before it leaves MAIN", async () => {
  const { client } = makeClient({
    connect: {
      ok: false,
      command: "sql.connect",
      error: "could not connect to postgresql://user:secret@host/db",
    },
  });
  const r = await new SqlHost(client).connect("postgresql://user:secret@host/db");
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error ?? "", /secret/);
  assert.match(r.error ?? "", /:\*\*\*@/);
});

test("query pages the capped result and reports page/maxPage/rowCount", async () => {
  const { client } = makeClient();
  const host = new SqlHost(client);
  const p0 = await host.query({
    conn: "sqlite:///t.db",
    sql: "SELECT id FROM t",
    pageSize: 100,
    page: 0,
  });
  assert.equal(p0.rowCount, 250);
  assert.equal(p0.rows?.length, 100);
  assert.equal(p0.rows?.[0]?.[0], 0);
  assert.equal(p0.maxPage, 2);
  const p2 = await host.query({
    conn: "sqlite:///t.db",
    sql: "SELECT id FROM t",
    pageSize: 100,
    page: 2,
  });
  assert.equal(p2.rows?.length, 50); // last page
  assert.equal(p2.rows?.[0]?.[0], 200);
});

test("paging does NOT re-query the DB for the same (conn,sql,params)", async () => {
  const { client, calls } = makeClient();
  const host = new SqlHost(client);
  await host.query({ conn: "sqlite:///t.db", sql: "SELECT id FROM t", page: 0 });
  await host.query({ conn: "sqlite:///t.db", sql: "SELECT id FROM t", page: 1 });
  assert.equal(calls.query, 1); // cache hit — one query, two pages
  await host.query({ conn: "sqlite:///t.db", sql: "SELECT id FROM t2", page: 0 }); // different sql
  assert.equal(calls.query, 2);
});

test("an expired cache entry re-queries", async () => {
  const { client, calls } = makeClient();
  let clock = 1000;
  const host = new SqlHost(client, () => clock);
  await host.query({ conn: "sqlite:///t.db", sql: "SELECT id FROM t", page: 0 });
  clock += 31_000; // past the 30s TTL
  await host.query({ conn: "sqlite:///t.db", sql: "SELECT id FROM t", page: 0 });
  assert.equal(calls.query, 2);
});

test("query error is redacted; schema maps tables + count", async () => {
  const bad = makeClient({
    query: { ok: false, command: "sql.query", error: "mysql://u:hunter2@h refused" },
  });
  const q = await new SqlHost(bad.client).query({
    conn: "mysql://u:hunter2@h/db",
    sql: "SELECT 1",
  });
  assert.equal(q.ok, false);
  assert.doesNotMatch(q.error ?? "", /hunter2/);

  const { client } = makeClient();
  const s = await new SqlHost(client).schema("sqlite:///t.db");
  assert.equal(s.ok, true);
  assert.equal(s.count, 1);
  assert.equal(s.tables?.[0]?.name, "t");
});

test("redactConn strips a password from a bare conn string", () => {
  assert.equal(redactConn("postgresql://u:p@h:5432/db"), "postgresql://u:***@h:5432/db");
  assert.equal(redactConn("sqlite:///tmp/a.db"), "sqlite:///tmp/a.db");
});
