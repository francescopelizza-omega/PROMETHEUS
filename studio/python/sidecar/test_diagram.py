#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_diagram.py — the ER-diagram verb of the diagram sidecar (APP-087)."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DP = HERE / "diagram.py"


def _load():
    spec = importlib.util.spec_from_file_location("prom_diagram_mod", DP)
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


M = _load()


def _run_verb(handler, argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        handler(argv)
    return json.loads(buf.getvalue().strip().splitlines()[-1])


SCHEMA = {
    "tables": [
        {"name": "items", "columns": [
            {"name": "id", "dtype": "INTEGER", "pk": True},
            {"name": "name", "dtype": "TEXT", "pk": False},
        ]},
        {"name": "orders", "columns": [
            {"name": "id", "dtype": "INTEGER", "pk": True},
            {"name": "item_id", "dtype": "INTEGER", "pk": False, "fk": {"table": "items", "to": "id"}},
            {"name": "parent_id", "dtype": "INTEGER", "pk": False, "fk": {"table": "orders", "to": "id"}},
            {"name": "ext", "dtype": "INTEGER", "pk": False, "fk": {"table": "not_exported", "to": "id"}},
        ]},
    ]
}


class TestErMermaid(unittest.TestCase):
    def test_entities_pk_fk_and_edges(self):
        m = M._er_mermaid(SCHEMA["tables"])
        self.assertTrue(m.startswith("erDiagram"))
        self.assertIn("INTEGER id PK", m)
        self.assertIn("INTEGER item_id FK", m)
        # FK edge items → orders on item_id
        self.assertIn('||--o{', m)
        self.assertIn('"item_id"', m)
        # self-referential FK (orders → orders) renders a loop edge
        self.assertIn("orders ||--o{ orders", m)
        # FK to a table NOT in the exported set → no edge (never a dangling ref)
        self.assertNotIn("not_exported", m)

    def test_safe_names_escape(self):
        m = M._er_mermaid([{"name": "schema.weird tbl", "columns": [{"name": "a b", "dtype": "int"}]}])
        # entity + column names are sanitized (no spaces/dots that break the parse)
        self.assertNotIn("schema.weird tbl", m)
        self.assertIn("schema_weird_tbl", m)


class TestErVerb(unittest.TestCase):
    def test_er_verb_reads_schema_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "schema.json"
            p.write_text(json.dumps(SCHEMA))
            out = _run_verb(M._er, ["--schema", str(p)])
            self.assertTrue(out["ok"])
            self.assertEqual(out["tableCount"], 2)
            self.assertIn("erDiagram", out["mermaid"])

    def test_er_verb_bad_schema(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "bad.json"
            p.write_text("{ not json")
            out = _run_verb(M._er, ["--schema", str(p)])
            self.assertFalse(out["ok"])


class TestUmlDeps(unittest.TestCase):
    """CLI-008: the uml + deps verbs on a 2-module fixture package."""

    def _fixture(self, d):
        p = Path(d)
        (p / "__init__.py").write_text("")
        (p / "mod_a.py").write_text("import mod_b\n\n\ndef go():\n    return mod_b.Foo()\n")
        (p / "mod_b.py").write_text("class Foo:\n    def bar(self):\n        return 1\n")

    def test_uml_mermaid_classdiagram_names_the_class(self):
        with tempfile.TemporaryDirectory() as d:
            self._fixture(d)
            out = _run_verb(M._uml, ["--path", d])
            self.assertTrue(out["ok"])
            self.assertTrue(out["mermaid"].startswith("classDiagram"))
            self.assertIn("Foo", out["mermaid"])
            self.assertGreaterEqual(out["classCount"], 1)

    def test_deps_contains_the_cross_import_edge(self):
        with tempfile.TemporaryDirectory() as d:
            self._fixture(d)
            out = _run_verb(M._deps, ["--path", d])
            self.assertTrue(out["ok"])
            self.assertEqual(out["moduleCount"], 3)  # __init__, mod_a, mod_b
            self.assertIn('"mod_a" -> "mod_b"', out["dot"])  # DOT double-quotes node ids

    def test_nonexistent_path_fails_soft(self):
        with tempfile.TemporaryDirectory() as d:
            out = _run_verb(M._uml, ["--path", str(Path(d) / "nope")])
            self.assertFalse(out["ok"])
            self.assertIn("not a directory", out["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
