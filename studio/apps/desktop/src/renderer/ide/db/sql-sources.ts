// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * db/sql-sources.ts — the SQL data-source store (file 14 §3.26, APP-043).
 *
 * Named connections {id, label, dialect, redactedConn}. The REDACTED conn (password
 * stripped via parseConnString) is what persists to localStorage AND what the UI ever
 * shows; the real password-bearing conn string lives in an in-memory map keyed by id
 * for the SESSION ONLY (never persisted plaintext, C5/§09). Pure reducers are tested;
 * the thin zustand store wires persistence + the session secret map.
 */

import { create } from "zustand";

import { parseConnString } from "./sql-view.js";

export type SqlDialect = "sqlite" | "postgresql" | "mysql";

export interface SqlSource {
  id: string;
  label: string;
  dialect: SqlDialect;
  /** password ALWAYS redacted — safe to persist + display. */
  redactedConn: string;
}

export interface SqlSourcesState {
  sources: SqlSource[];
  selectedId: string | null;
}

/** A display/persist-safe conn string: the password is replaced with `***`. */
export function redactConnString(conn: string): string {
  const p = parseConnString(conn);
  if (!p.driver) return conn.replace(/(:\/\/[^:@/]+):[^@/]+@/, "$1:***@");
  const auth = p.user ? `${p.user}${p.password ? ":***" : ""}@` : "";
  const host = p.host ?? "";
  const port = p.port ? `:${p.port}` : "";
  const db = p.database ? `/${p.database}` : "";
  return `${p.driver}://${auth}${host}${port}${db}`;
}

export function dialectOf(conn: string): SqlDialect {
  const d = parseConnString(conn).driver ?? "";
  if (d.startsWith("postgres")) return "postgresql";
  if (d.startsWith("mysql") || d.startsWith("mariadb")) return "mysql";
  return "sqlite";
}

/* ── pure reducers (immutable, node:test-ed) ───────────────────────────────────*/

/** Add a source (redacted); selects it. A duplicate id replaces in place. */
export function addSource(
  state: SqlSourcesState,
  source: { id: string; label: string; connString: string },
): SqlSourcesState {
  const entry: SqlSource = {
    id: source.id,
    label: source.label.trim() || redactConnString(source.connString),
    dialect: dialectOf(source.connString),
    redactedConn: redactConnString(source.connString),
  };
  const sources = state.sources.some((s) => s.id === entry.id)
    ? state.sources.map((s) => (s.id === entry.id ? entry : s))
    : [...state.sources, entry];
  return { sources, selectedId: entry.id };
}

export function selectSource(state: SqlSourcesState, id: string): SqlSourcesState {
  return state.sources.some((s) => s.id === id) ? { ...state, selectedId: id } : state;
}

export function removeSource(state: SqlSourcesState, id: string): SqlSourcesState {
  const sources = state.sources.filter((s) => s.id !== id);
  const selectedId = state.selectedId === id ? (sources[0]?.id ?? null) : state.selectedId;
  return { sources, selectedId };
}

/* ── the store (persists REDACTED only; real conns are session-in-memory) ───────*/

const STORAGE_KEY = "prometheus.sqlSources";

function storage(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function load(): SqlSourcesState {
  const s = storage();
  if (!s) return { sources: [], selectedId: null };
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return { sources: [], selectedId: null };
    const o = JSON.parse(raw) as Partial<SqlSourcesState>;
    const sources = Array.isArray(o.sources)
      ? o.sources.filter(
          (x): x is SqlSource =>
            !!x && typeof x.id === "string" && typeof x.redactedConn === "string",
        )
      : [];
    return { sources, selectedId: typeof o.selectedId === "string" ? o.selectedId : null };
  } catch {
    return { sources: [], selectedId: null };
  }
}

function persist(state: SqlSourcesState): void {
  const s = storage();
  if (!s) return;
  try {
    // ONLY the redacted, non-secret fields ever reach disk.
    s.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
}

let idSeq = 0;
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? `src_${c.randomUUID()}` : `src_${Date.now().toString(36)}_${idSeq++}`;
}

interface SqlSourcesStore extends SqlSourcesState {
  /** add a source; the REAL conn is held in-memory (not persisted) for the session. */
  add(label: string, connString: string): string;
  select(id: string): void;
  remove(id: string): void;
  /** the session-only real conn string (with password) for `id`, or undefined. */
  realConn(id: string): string | undefined;
}

/** in-memory session secret map (NEVER persisted). */
const realConns = new Map<string, string>();

export const useSqlSourcesStore = create<SqlSourcesStore>((set, get) => ({
  ...load(),
  add(label, connString): string {
    const id = newId();
    realConns.set(id, connString);
    const next = addSource(
      { sources: get().sources, selectedId: get().selectedId },
      {
        id,
        label,
        connString,
      },
    );
    persist(next);
    set(next);
    return id;
  },
  select(id): void {
    const next = selectSource({ sources: get().sources, selectedId: get().selectedId }, id);
    persist(next);
    set(next);
  },
  remove(id): void {
    realConns.delete(id);
    const next = removeSource({ sources: get().sources, selectedId: get().selectedId }, id);
    persist(next);
    set(next);
  },
  realConn(id): string | undefined {
    return realConns.get(id);
  },
}));
