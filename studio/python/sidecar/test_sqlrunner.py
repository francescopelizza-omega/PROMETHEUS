#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_sqlrunner.py — unittest for the SQL console sidecar (APP-041).

Live sqlite (a temp DB): connect, typed rows (int/float/text/null/blob), params, row-
limit truncation, timeout envelope, schema (dtype/nullable/pk). The postgres path is
exercised only via the fail-closed MISSING-DRIVER envelope (no live pg here). No verb
ever echoes a password.
"""
from __future__ import annotations

import base64
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import sqlrunner  # noqa: E402


def run(handler, argv):
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = handler(argv)
    text = buf.getvalue().strip()
    return json.loads(text), code


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp()
        self.db = os.path.join(self.dir, "t.db")
        con = sqlite3.connect(self.db)
        con.execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, "
            "price REAL, blob BLOB, note TEXT)"
        )
        con.executemany(
            "INSERT INTO items (id,name,price,blob,note) VALUES (?,?,?,?,?)",
            [(1, "a", 1.5, b"\x00\x01", None), (2, "b", 2.0, None, "hi"), (3, "c", None, None, None)],
        )
        con.execute("CREATE VIEW v AS SELECT id, name FROM items")
        con.commit()
        con.close()
        self.conn = f"sqlite:///{self.db}"

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


class TestConnect(Base):
    def test_connect_sqlite_ok(self) -> None:
        env, code = run(sqlrunner._connect, [self.conn])
        self.assertTrue(env["ok"])
        self.assertEqual(env["command"], "sql.connect")
        self.assertEqual(env["dialect"], "sqlite")
        self.assertTrue(env["server_version"])
        self.assertEqual(code, 0)

    def test_missing_pg_driver_fails_closed_and_never_echoes_password(self) -> None:
        try:
            import psycopg2  # noqa: F401

            self.skipTest("psycopg2 present in this env")
        except ImportError:
            pass
        env, code = run(sqlrunner._connect, ["postgresql://user:secret@host:5432/db"])
        self.assertFalse(env["ok"])
        self.assertEqual(env["_exit"], 2)
        self.assertEqual(env.get("driver_missing"), "psycopg2")
        self.assertNotIn("secret", json.dumps(env))


class TestQuery(Base):
    def test_typed_rows(self) -> None:
        env, code = run(
            sqlrunner._query,
            [self.conn, "--sql", "SELECT id, name, price, blob, note FROM items ORDER BY id"],
        )
        self.assertTrue(env["ok"])
        self.assertEqual(env["columns"], ["id", "name", "price", "blob", "note"])
        self.assertEqual(env["row_count"], 3)
        self.assertFalse(env["truncated"])
        r0 = env["rows"][0]
        self.assertEqual(r0[0], 1)
        self.assertEqual(r0[1], "a")
        self.assertEqual(r0[2], 1.5)
        self.assertEqual(base64.b64decode(r0[3]), b"\x00\x01")  # blob → base64
        self.assertIsNone(r0[4])
        self.assertEqual(code, 0)

    def test_parameterized(self) -> None:
        env, _ = run(
            sqlrunner._query,
            [self.conn, "--sql", "SELECT name FROM items WHERE id = ?", "--params", "[2]"],
        )
        self.assertEqual(env["rows"], [["b"]])

    def test_row_limit_truncates(self) -> None:
        env, _ = run(
            sqlrunner._query,
            [self.conn, "--sql", "SELECT id FROM items ORDER BY id", "--max-rows", "2"],
        )
        self.assertEqual(env["row_count"], 2)
        self.assertTrue(env["truncated"])

    def test_timeout_envelope(self) -> None:
        slow = (
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 50000000) "
            "SELECT count(*) FROM c"
        )
        env, code = run(sqlrunner._query, [self.conn, "--sql", slow, "--timeout-s", "0.05"])
        self.assertFalse(env["ok"])
        self.assertEqual(env["error"], "timeout")
        self.assertTrue(env.get("truncated"))
        self.assertEqual(code, 2)

    def test_bad_sql_fails_soft(self) -> None:
        env, _ = run(sqlrunner._query, [self.conn, "--sql", "SELECT * FROM nope"])
        self.assertFalse(env["ok"])
        self.assertIn("error", env)


class TestSchema(Base):
    def test_lists_tables_views_and_columns(self) -> None:
        env, _ = run(sqlrunner._schema, [self.conn])
        self.assertTrue(env["ok"])
        by = {t["name"]: t for t in env["tables"]}
        self.assertEqual(by["items"]["type"], "table")
        self.assertEqual(by["v"]["type"], "view")
        cols = {c["name"]: c for c in by["items"]["columns"]}
        self.assertTrue(cols["id"]["pk"])  # pk rank > 0
        self.assertFalse(cols["name"]["nullable"])  # NOT NULL
        self.assertTrue(cols["price"]["nullable"])
        self.assertEqual(cols["id"]["dtype"], "INTEGER")

    def test_single_table_filter(self) -> None:
        env, _ = run(sqlrunner._schema, [self.conn, "--table", "items"])
        self.assertEqual(env["count"], 1)
        self.assertEqual(env["tables"][0]["name"], "items")

    def test_foreign_key_edges(self) -> None:
        # APP-087: a table with an FK to items → the column carries {table, to}.
        con = sqlite3.connect(self.db)
        con.execute(
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, "
            "item_id INTEGER REFERENCES items(id))"
        )
        con.commit()
        con.close()
        env, _ = run(sqlrunner._schema, [self.conn])
        cols = {c["name"]: c for t in env["tables"] if t["name"] == "orders" for c in t["columns"]}
        self.assertIn("fk", cols["item_id"])
        self.assertEqual(cols["item_id"]["fk"]["table"], "items")
        self.assertEqual(cols["item_id"]["fk"]["to"], "id")
        self.assertNotIn("fk", cols["id"])  # a plain PK is not an FK


if __name__ == "__main__":
    unittest.main()
