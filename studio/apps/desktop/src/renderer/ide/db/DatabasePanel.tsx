/**
 * db/DatabasePanel.tsx — the Database bottom-tab container (file 14 §3.26, APP-043).
 *
 * Owns ALL SQL state + IPC (the controlled SqlConsole/DataSourcePanel/SchemaTree stay
 * presentational — the panel-crash lesson: no fetch logic in a controlled child). A
 * three-zone layout: data-source rail | console + paged grid | schema tree. Paging is
 * SERVER-paged through APP-042 (`sql.query {page,pageSize}`) — never a whole-result
 * client slice. Degrades to an actionable notice when the preload bridge is absent.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the sources store + window.prometheus.
 */

import { Panel } from "@prometheus/ui";
import { type ReactElement, useCallback, useMemo, useState } from "react";

import type {
  IdeSqlConnectResult,
  IdeSqlQueryResult,
  IdeSqlSchemaResult,
  IdeSqlTable,
} from "../../../shared/ipc-contract.js";
import { StreamPausedError, streamChat } from "../ai/ai-client.js";
import { useActiveEndpoint } from "../ai/endpoint-hook.js";
import { useTabsStore } from "../state/stores.js";
import { DataSourcePanel, type SourceStatus } from "./DataSourcePanel.js";
import { SchemaTree } from "./SchemaTree.js";
import { SqlConsole } from "./SqlConsole.js";
import { type SqlDialect, useSqlSourcesStore } from "./sql-sources.js";
import { type SqlResult, tablesToErMermaid, toCsv, toJson } from "./sql-view.js";

function ideApi(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** A single SQL statement extracted from an untrusted local-model reply — the first
 *  ```sql fenced block, else the first line that begins a statement. NEVER executed. */
function extractSql(text: string): string {
  const fenced = /```(?:sql)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  return body.split(/;\s*\n/)[0]?.trim() ?? "";
}

function sqlApi(): Window["prometheus"]["sql"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.sql : undefined;
}

const PAGE_SIZE = 100;

export function DatabasePanel(): ReactElement {
  const sources = useSqlSourcesStore((s) => s.sources);
  const selectedId = useSqlSourcesStore((s) => s.selectedId);
  const [statuses, setStatuses] = useState<Record<string, SourceStatus>>({});
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SqlResult | undefined>(undefined);
  const [pageInfo, setPageInfo] = useState<{ page: number; maxPage: number }>({
    page: 0,
    maxPage: 0,
  });
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tables, setTables] = useState<IdeSqlTable[]>([]);
  const [nlBusy, setNlBusy] = useState(false);
  const { active: aiEndpoint, neverSendToCloud } = useActiveEndpoint();

  const selected = sources.find((s) => s.id === selectedId);
  const dialect: SqlDialect = selected?.dialect ?? "sqlite";
  const erMermaid = useMemo(
    () => (tables.length > 0 ? tablesToErMermaid(tables) : undefined),
    [tables],
  );

  /** APP-087: export the current result to the workspace via the path-guarded fs IPC. */
  const exportResult = useCallback(
    async (format: "csv" | "json"): Promise<void> => {
      if (!result) return;
      const root = useTabsStore.getState().workspaceRoot;
      const api = ideApi();
      if (!root || !api) {
        setError("open a folder to export");
        return;
      }
      const text = format === "csv" ? toCsv(result) : toJson(result);
      const uri = `file://${root}/query-export.${format}`;
      const w = await api.fsWrite(uri, text).catch(() => undefined);
      setError(w?.ok ? undefined : (w?.error ?? "export failed"));
    },
    [result],
  );

  /** APP-087: NL→SQL via the LOCAL model — the generated SQL is placed in the editor for
   *  review and NEVER auto-executed. No endpoint → the row shows the no-backend notice. */
  const askDb = useCallback(
    async (question: string): Promise<void> => {
      if (!aiEndpoint) return;
      setNlBusy(true);
      setError(undefined);
      try {
        const schemaText = tables
          .map(
            (t) =>
              `${t.name}(${t.columns.map((c) => `${c.name} ${c.dtype}${c.pk ? " PK" : ""}`).join(", ")})`,
          )
          .join("\n");
        const messages = [
          {
            role: "system" as const,
            content:
              "Translate the question into ONE SQL query for the given schema. Output only the SQL, no prose.",
          },
          { role: "user" as const, content: `Schema:\n${schemaText}\n\nQuestion: ${question}` },
        ];
        let acc = "";
        let paused = false;
        try {
          for await (const chunk of streamChat(aiEndpoint, messages, { neverSendToCloud })) {
            acc += chunk;
          }
        } catch (e) {
          if (!(e instanceof StreamPausedError)) throw e;
          // A pause (idle watchdog), not a failure — whatever streamed before the model went
          // quiet may already be a complete, usable query; `extractSql` below decides.
          paused = true;
        }
        const sql = extractSql(acc);
        if (sql) setQuery(sql);
        else if (paused) setError("the model went idle — paused before returning any SQL. Retry.");
        else setError("the model returned no SQL");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setNlBusy(false);
      }
    },
    [aiEndpoint, neverSendToCloud, tables],
  );

  const introspect = useCallback(async (id: string): Promise<void> => {
    const a = sqlApi();
    const conn = useSqlSourcesStore.getState().realConn(id);
    if (!a || !conn) {
      setStatuses((s) => ({
        ...s,
        [id]: { ok: false, error: "re-enter the connection (session secret cleared)" },
      }));
      setTables([]);
      return;
    }
    const c = await a
      .connect(conn)
      .catch((e): IdeSqlConnectResult => ({ ok: false, error: String(e) }));
    setStatuses((s) => ({
      ...s,
      [id]: {
        ok: c.ok,
        ...(c.error ? { error: c.error } : {}),
        ...(c.dialect ? { dialect: c.dialect } : {}),
      },
    }));
    if (c.ok) {
      const sc = await a.schema(conn).catch((): IdeSqlSchemaResult => ({ ok: false }));
      setTables(sc.ok ? (sc.tables ?? []) : []);
    } else {
      setTables([]);
    }
  }, []);

  const onAdd = useCallback(
    (label: string, conn: string): void => {
      const id = useSqlSourcesStore.getState().add(label, conn);
      void introspect(id);
    },
    [introspect],
  );

  const onSelect = useCallback(
    (id: string): void => {
      useSqlSourcesStore.getState().select(id);
      setResult(undefined);
      setError(undefined);
      void introspect(id);
    },
    [introspect],
  );

  const onRemove = useCallback((id: string): void => {
    useSqlSourcesStore.getState().remove(id);
    setStatuses((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
  }, []);

  // the SQL that produced the CURRENT result — the pager must page against THIS, not the
  // live editor buffer (which the user may have edited after running).
  const [ranSql, setRanSql] = useState("");
  const runPage = useCallback(
    async (sqlText: string, page: number): Promise<void> => {
      const a = sqlApi();
      const conn = selectedId ? useSqlSourcesStore.getState().realConn(selectedId) : undefined;
      if (!a) {
        setError("no backend");
        return;
      }
      if (!conn) {
        setError("select a connected data source first");
        return;
      }
      if (!sqlText.trim()) return;
      setRanSql(sqlText);
      setExecuting(true);
      setError(undefined);
      const r = await a
        .query({ conn, sql: sqlText, page, pageSize: PAGE_SIZE })
        .catch((e): IdeSqlQueryResult => ({ ok: false, error: String(e) }));
      setExecuting(false);
      if (!r.ok) {
        setError(r.error ?? "query failed");
        setResult(undefined);
        return;
      }
      setResult({
        columns: r.columns ?? [],
        rows: (r.rows ?? []) as SqlResult["rows"],
        rowCount: r.rowCount ?? 0,
        ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
      });
      setPageInfo({ page: r.page ?? 0, maxPage: r.maxPage ?? 0 });
    },
    [selectedId],
  );

  if (!sqlApi()) {
    return (
      <Panel title="Database" elevation="e1">
        <p style={{ color: "var(--text-secondary)", padding: "var(--space-3, 8px)" }}>
          The SQL backend is unavailable in this build (no preload bridge). Launch the desktop app
          to use the Database tab.
        </p>
      </Panel>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", gap: "var(--space-2, 4px)" }}>
      <div
        style={{
          width: 220,
          minWidth: 160,
          overflow: "auto",
          borderRight: "1px solid var(--border-subtle)",
          padding: "var(--space-2, 4px)",
        }}
      >
        <DataSourcePanel
          sources={sources}
          selectedId={selectedId}
          statuses={statuses}
          onSelect={onSelect}
          onAdd={onAdd}
          onRemove={onRemove}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
        <SqlConsole
          connString={selected?.redactedConn}
          query={query}
          result={result}
          executing={executing}
          error={error}
          pageSize={PAGE_SIZE}
          serverPage={pageInfo.page}
          serverMaxPage={pageInfo.maxPage}
          onPageChange={(p) => void runPage(ranSql, p)}
          onQueryChange={setQuery}
          onRun={(q) => void runPage(q, 0)}
          onExport={(fmt) => void exportResult(fmt)}
          erMermaid={erMermaid}
          onAsk={(q) => void askDb(q)}
          nlAvailable={!!aiEndpoint}
          nlBusy={nlBusy}
        />
      </div>
      <div
        style={{
          width: 240,
          minWidth: 180,
          overflow: "auto",
          borderLeft: "1px solid var(--border-subtle)",
          padding: "var(--space-2, 4px)",
        }}
      >
        <SchemaTree
          tables={tables}
          dialect={dialect}
          onSeedQuery={setQuery}
          onInsertIdent={(id) => setQuery((q) => (q ? `${q} ${id}` : id))}
        />
      </div>
    </div>
  );
}

export default DatabasePanel;
