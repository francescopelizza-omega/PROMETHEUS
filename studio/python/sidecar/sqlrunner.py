#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""sqlrunner.py — the SQL console backend sidecar (file 14 §3.26, APP-041).

Stateless per-invocation DB access for the SQL console: connect (dialect probe), run
parameterized queries, introspect schema. sqlite via stdlib ``sqlite3``; postgres/
mysql via OPTIONAL env drivers imported LAZILY inside the verb — a missing driver is a
fail-closed envelope naming the pip package, never a traceback. Credentials arrive in
the conn-string argv and are NEVER echoed back (redacted like ``sql-view.ts``).

Guards (fail-closed): default 1000 rows (hard ceiling 50_000, ``fetchmany``-chunked so a
huge table never materializes whole), a statement timeout (driver-native + a wall-clock
progress-handler fallback for sqlite). Pure-stdlib import surface; the optional drivers
resolve from the user's active env at runtime.

Verbs (see CONTRACT.md ## sqlrunner.py):
  sql.connect <conn>                                  → {dialect, database, server_version}
  sql.query <conn> --sql T [--params J] [--max-rows N] [--timeout-s N]
  sql.schema <conn> [--table T]
"""
from __future__ import annotations

import base64
import decimal
import json
import math
import re
import contextlib
import os
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

from _envelope import dispatch, emit, fail, log, opt_value

PROG = "sqlrunner"

DEFAULT_MAX_ROWS = 1000
HARD_MAX_ROWS = 50_000
DEFAULT_TIMEOUT_S = 30.0
FETCH_CHUNK = 500

_PASS_RE = re.compile(r"(://[^:@/]+):[^@/]+@")


class _MissingDriver(Exception):
    """A dialect's optional driver is not importable from the active env."""

    def __init__(self, dialect: str, pip_pkg: str) -> None:
        super().__init__(f"{dialect} driver not installed — pip install {pip_pkg}")
        self.dialect = dialect
        self.pip_pkg = pip_pkg


class _QueryTimeout(Exception):
    """The statement exceeded its wall-clock budget."""


def _redact(text: str) -> str:
    """Strip a `:password@` from a conn string OR a driver exception message."""
    return _PASS_RE.sub(r"\1:***@", text or "")


# --- dialect / conn-string parsing ----------------------------------------- #


def _parse_conn(conn: str) -> Dict[str, Any]:
    m = re.match(
        r"^([a-z0-9+]+)://(?:([^:@/]+)(?::([^@/]+))?@)?([^:/?]+)?(?::(\d+))?(?:/([^?]+))?",
        conn.strip(),
        re.I,
    )
    if not m:
        return {}
    return {
        "driver": (m.group(1) or "").lower(),
        "user": m.group(2),
        "host": m.group(4),
        "port": int(m.group(5)) if m.group(5) else None,
        "database": m.group(6),
    }


def _dialect(driver: str) -> str:
    if driver.startswith("sqlite"):
        return "sqlite"
    if driver.startswith(("postgres", "postgresql", "pg")):
        return "postgres"
    if driver.startswith(("mysql", "mariadb")):
        return "mysql"
    return driver


def _sqlite_path(conn: str) -> str:
    """`sqlite:///rel/path` → relative; `sqlite:////abs/path` → absolute; `:memory:` when empty.

    Absolute-vs-relative is decided by the AUTHORITY slashes only — three means relative, four
    means absolute — never by counting slashes in the whole URL. The previous test was
    `conn.count("/") >= 4`, which counts every separator in the path as well, so any relative
    path containing a subdirectory reached four and was silently promoted: `sqlite:///data/app.db`
    became `/data/app.db`. sqlite3 then either failed with a confusing "unable to open database
    file", or — where that directory happened to exist — CREATED an empty database at the
    filesystem root, so queries returned "no such table" against a database the user never named
    while their real `./data/app.db` sat untouched. Single-segment relatives like
    `sqlite:///app.db` happened to work, which is what kept it hidden.
    """
    if "://" not in conn:
        return conn or ":memory:"
    rest = conn.split("://", 1)[1]
    # after the scheme, `/path` is relative and `//path` is absolute
    if rest.startswith("//"):
        return rest[1:] or ":memory:"          # sqlite:////abs/path → /abs/path
    return rest.lstrip("/") or ":memory:"      # sqlite:///rel/path  → rel/path


class _Conn:
    def __init__(self, raw: Any, dialect: str, server_version: str, database: Optional[str]) -> None:
        self.raw = raw
        self.dialect = dialect
        self.server_version = server_version
        self.database = database

    def close(self) -> None:
        try:
            self.raw.close()
        except Exception:  # noqa: BLE001 — close is best-effort
            pass


def _assert_sqlite_target(path: str) -> None:
    """Refuse a sqlite path that is not already a database file.

    `sqlite3.connect()` CREATES the file when it is missing, and it is lazy — nothing touches the
    bytes until a statement runs — so `sql.connect` answered `{"ok": true, "dialect": "sqlite",
    "server_version": "3.53.4"}` for a path that did not exist, and left a 0-byte database behind.
    Every later query then reports "no such table" against a database the user never made, while
    their real one sits untouched. That is the same silent-phantom-database failure
    `_sqlite_path`'s own docstring describes for the relative-path bug — reached here by a typo
    instead.

    `:memory:` is a real, deliberate target and is always allowed.
    """
    if not path or path == ":memory:":
        return
    if os.path.isdir(path):
        raise ValueError(f"not a database file (it is a directory): {path}")
    if not os.path.exists(path):
        raise ValueError(
            f"no such database: {path} — connecting would have created an empty one. "
            "Check the path, or create the database first."
        )


def _assert_really_a_database(raw: "sqlite3.Connection", path: str) -> None:
    """Force sqlite to read the file header, so a NON-database is refused at connect time.

    Connecting is lazy, so pointing at an ordinary text file also answered `ok: true` — a
    "successful connection" to something that is not a database at all. Measured on a file
    containing one line of prose. One cheap pragma settles it.
    """
    try:
        raw.execute("PRAGMA schema_version").fetchone()
    except sqlite3.DatabaseError as exc:
        with contextlib.suppress(Exception):
            raw.close()
        raise ValueError(f"not a database: {path} ({exc})") from exc


def _open(conn: str, timeout_s: float) -> _Conn:
    parsed = _parse_conn(conn)
    dialect = _dialect(parsed.get("driver", ""))
    if dialect == "sqlite":
        path = _sqlite_path(conn)
        _assert_sqlite_target(path)
        raw = sqlite3.connect(path, timeout=timeout_s)
        _assert_really_a_database(raw, path)
        return _Conn(raw, "sqlite", sqlite3.sqlite_version, parsed.get("database") or path)
    if dialect == "postgres":
        drv, _pkg = _import_first([("psycopg2", "psycopg2"), ("psycopg", "psycopg")], "postgres", "psycopg2")
        raw = drv.connect(conn, options=f"-c statement_timeout={int(timeout_s * 1000)}")
        info = getattr(raw, "info", None)
        ver = str(getattr(info, "server_version", "") or getattr(raw, "server_version", "") or "")
        return _Conn(raw, "postgres", ver, parsed.get("database"))
    if dialect == "mysql":
        drv, _pkg = _import_first([("pymysql", "pymysql")], "mysql", "pymysql")
        raw = drv.connect(
            host=parsed.get("host") or "localhost",
            port=parsed.get("port") or 3306,
            user=parsed.get("user"),
            password=_conn_password(conn),
            database=parsed.get("database"),
            read_timeout=int(timeout_s),
            connect_timeout=int(timeout_s),
        )
        return _Conn(raw, "mysql", str(raw.get_server_info()), parsed.get("database"))
    raise ValueError(f"unsupported dialect '{parsed.get('driver')}' (expected sqlite/postgres/mysql)")


def _conn_password(conn: str) -> Optional[str]:
    m = re.match(r"^[a-z0-9+]+://[^:@/]+:([^@/]+)@", conn.strip(), re.I)
    return m.group(1) if m else None


def _import_first(candidates: Sequence[Tuple[str, str]], dialect: str, name_in_error: str) -> Tuple[Any, str]:
    for module_name, pip_pkg in candidates:
        try:
            return __import__(module_name), pip_pkg
        except ImportError:
            continue
    raise _MissingDriver(dialect, name_in_error)


# --- JSON-safe row coercion ------------------------------------------------ #


def _jsonify(v: Any) -> Any:
    if v is None or isinstance(v, (str, int, bool)):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else None  # NaN/Inf are not valid JSON
    if isinstance(v, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(v)).decode("ascii")
    if isinstance(v, decimal.Decimal):
        return str(v)
    if hasattr(v, "isoformat"):  # datetime/date/time
        return v.isoformat()
    return str(v)


# --- timeout (sqlite: progress-handler wall-clock; drivers: native) -------- #


def _install_sqlite_timeout(raw: Any, deadline: float) -> None:
    def handler() -> int:  # returns non-zero → abort the current statement
        return 1 if time.monotonic() > deadline else 0

    raw.set_progress_handler(handler, 10_000)


# --- verbs ----------------------------------------------------------------- #


def _clamp_rows(raw: Optional[str]) -> int:
    try:
        n = int(raw) if raw is not None else DEFAULT_MAX_ROWS
    except (TypeError, ValueError):
        n = DEFAULT_MAX_ROWS
    return max(1, min(n, HARD_MAX_ROWS))


def _clamp_timeout(raw: Optional[str]) -> float:
    try:
        t = float(raw) if raw is not None else DEFAULT_TIMEOUT_S
    except (TypeError, ValueError):
        t = DEFAULT_TIMEOUT_S
    return max(0.001, min(t, 3600.0))


def _connect(argv: Sequence[str]) -> int:
    conns = [a for a in argv if not a.startswith("-")]
    if not conns:
        return fail("sql.connect", "no connection string given")
    conn = conns[0]
    timeout = _clamp_timeout(opt_value(argv, "--timeout-s"))
    c: Optional[_Conn] = None
    try:
        c = _open(conn, timeout)
        return emit(
            "sql.connect",
            dialect=c.dialect,
            database=c.database,
            server_version=c.server_version,
        )
    except _MissingDriver as exc:
        return fail("sql.connect", str(exc), driver_missing=exc.pip_pkg)
    except Exception as exc:  # noqa: BLE001 — never leak a traceback / the DSN
        return fail("sql.connect", _redact(f"{type(exc).__name__}: {exc}"))
    finally:
        if c is not None:
            c.close()


def _query(argv: Sequence[str]) -> int:
    conns = [a for a in argv if not a.startswith("-")]
    sql = opt_value(argv, "--sql")
    if not conns:
        return fail("sql.query", "no connection string given")
    if not sql:
        return fail("sql.query", "no --sql text given")
    max_rows = _clamp_rows(opt_value(argv, "--max-rows"))
    timeout = _clamp_timeout(opt_value(argv, "--timeout-s"))
    params: List[Any] = []
    raw_params = opt_value(argv, "--params")
    if raw_params:
        try:
            parsed = json.loads(raw_params)
            if not isinstance(parsed, list):
                return fail("sql.query", "--params must be a JSON array")
            params = parsed
        except json.JSONDecodeError as exc:
            return fail("sql.query", f"--params is not valid JSON: {exc}")

    c: Optional[_Conn] = None
    started = time.monotonic()
    try:
        c = _open(conns[0], timeout)
        if c.dialect == "sqlite":
            _install_sqlite_timeout(c.raw, started + timeout)
        cur = c.raw.cursor()
        try:
            cur.execute(sql, params)
        except sqlite3.OperationalError as exc:
            if "interrupted" in str(exc).lower():
                return fail("sql.query", "timeout", truncated=True)
            raise
        columns = [d[0] for d in cur.description] if cur.description else []
        rows: List[List[Any]] = []
        truncated = False
        if columns:
            while len(rows) < max_rows:
                chunk = cur.fetchmany(min(FETCH_CHUNK, max_rows - len(rows)))
                if not chunk:
                    break
                for r in chunk:
                    rows.append([_jsonify(v) for v in r])
            # anything left → truncated (peek one more)
            if cur.fetchone() is not None:
                truncated = True
        duration_ms = round((time.monotonic() - started) * 1000, 3)
        return emit(
            "sql.query",
            columns=columns,
            rows=rows,
            row_count=len(rows),
            truncated=truncated,
            duration_ms=duration_ms,
        )
    except _MissingDriver as exc:
        return fail("sql.query", str(exc), driver_missing=exc.pip_pkg)
    except _QueryTimeout:
        return fail("sql.query", "timeout", truncated=True)
    except Exception as exc:  # noqa: BLE001
        return fail("sql.query", _redact(f"{type(exc).__name__}: {exc}"))
    finally:
        if c is not None:
            c.close()


def _schema(argv: Sequence[str]) -> int:
    conns = [a for a in argv if not a.startswith("-")]
    if not conns:
        return fail("sql.schema", "no connection string given")
    only_table = opt_value(argv, "--table")
    timeout = _clamp_timeout(opt_value(argv, "--timeout-s"))
    c: Optional[_Conn] = None
    try:
        c = _open(conns[0], timeout)
        tables = _sqlite_schema(c.raw, only_table) if c.dialect == "sqlite" else _sql_schema(c, only_table)
        return emit("sql.schema", tables=tables, count=len(tables))
    except _MissingDriver as exc:
        return fail("sql.schema", str(exc), driver_missing=exc.pip_pkg)
    except Exception as exc:  # noqa: BLE001
        return fail("sql.schema", _redact(f"{type(exc).__name__}: {exc}"))
    finally:
        if c is not None:
            c.close()


def _sqlite_schema(raw: Any, only_table: Optional[str]) -> List[Dict[str, Any]]:
    cur = raw.cursor()
    cur.execute(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    out: List[Dict[str, Any]] = []
    for name, kind in cur.fetchall():
        if only_table and name != only_table:
            continue
        # the name came from sqlite_master; strip any quote so the interpolated PRAGMA
        # (which cannot be parametrized) can never break out (double-quote-escape, APP-087).
        safe = name.replace(chr(34), "")
        info = raw.cursor()
        info.execute(f'PRAGMA table_info("{safe}")')
        # APP-087: FK edges — map the "from" column → its referenced table+column.
        fk_by_col: Dict[str, Dict[str, str]] = {}
        try:
            fkc = raw.cursor()
            fkc.execute(f'PRAGMA foreign_key_list("{safe}")')
            for fk in fkc.fetchall():
                # row = (id, seq, table, from, to, on_update, on_delete, match)
                fk_by_col[str(fk[3])] = {"table": str(fk[2]), "to": str(fk[4] or "")}
        except sqlite3.Error:
            pass  # a view / no FKs → no edges
        columns = []
        for row in info.fetchall():
            col: Dict[str, Any] = {
                "name": row[1],
                "dtype": row[2] or "",  # affinity may be empty for untyped columns
                "nullable": row[3] == 0,  # notnull is 0/1
                "pk": row[5] > 0,  # pk is an INTEGER rank, not a bool
            }
            fk = fk_by_col.get(str(row[1]))
            if fk:
                col["fk"] = fk
            columns.append(col)
        out.append({"name": name, "type": kind, "columns": columns})
    return out


def _sql_schema(c: _Conn, only_table: Optional[str]) -> List[Dict[str, Any]]:
    """postgres/mysql schema via information_schema (best-effort, current database)."""
    cur = c.raw.cursor()
    ph = "%s"
    tbl_sql = (
        "SELECT table_name, table_type FROM information_schema.tables "
        "WHERE table_schema NOT IN ('pg_catalog','information_schema','mysql','performance_schema','sys') "
        + (f"AND table_name = {ph} " if only_table else "")
        + "ORDER BY table_name"
    )
    cur.execute(tbl_sql, ([only_table] if only_table else []))
    tables = cur.fetchall()
    out: List[Dict[str, Any]] = []
    for name, kind in tables:
        col = c.raw.cursor()
        col.execute(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            f"WHERE table_name = {ph} ORDER BY ordinal_position",
            [name],
        )
        columns = [
            {"name": r[0], "dtype": r[1], "nullable": str(r[2]).upper() == "YES", "pk": False}
            for r in col.fetchall()
        ]
        out.append({"name": name, "type": "view" if "VIEW" in str(kind).upper() else "table", "columns": columns})
    return out


def _version(_argv: Sequence[str]) -> int:
    return emit("version", version="1.0.0")


HANDLERS = {
    "sql.connect": _connect,
    "sql.query": _query,
    "sql.schema": _schema,
    "version": _version,
}


if __name__ == "__main__":
    import sys

    raise SystemExit(dispatch(PROG, HANDLERS, sys.argv[1:]))
