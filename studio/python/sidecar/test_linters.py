#!/usr/bin/env python3
"""test_linters.py — the linter fan-in parsers + dedupe + resolution (APP-062).

Canned tool output only — no live ruff/flake8/mypy/pylint required.
"""
from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest

import linters


class TestParsers(unittest.TestCase):
    def test_ruff_json(self) -> None:
        raw = json.dumps(
            [
                {
                    "filename": "/w/a.py",
                    "code": "F401",
                    "message": "`os` imported but unused",
                    "location": {"row": 3, "column": 1},
                }
            ]
        )
        d = linters.parse_ruff(raw)
        self.assertEqual(len(d), 1)
        self.assertEqual(d[0]["ruleId"], "F401")
        self.assertEqual(d[0]["tool"], "ruff")
        self.assertEqual(d[0]["line"], 3)
        self.assertEqual(d[0]["severity"], "warning")
        # malformed json → [] (fail-soft, never raises)
        self.assertEqual(linters.parse_ruff("{not json"), [])
        self.assertEqual(linters.parse_ruff(""), [])

    def test_flake8_format_splits_first_four_colons(self) -> None:
        # a message containing a colon must survive the split.
        raw = "/w/a.py:10:5:E501:line too long: really: long"
        d = linters.parse_flake8(raw)
        self.assertEqual(len(d), 1)
        self.assertEqual(d[0]["ruleId"], "E501")
        self.assertEqual(d[0]["line"], 10)
        self.assertEqual(d[0]["col"], 5)
        self.assertEqual(d[0]["message"], "line too long: really: long")
        # F codes (pyflakes) map to error severity.
        self.assertEqual(linters.parse_flake8("/w/a.py:1:1:F401:x")[0]["severity"], "error")

    def test_mypy_json_and_text_fallback(self) -> None:
        js = json.dumps(
            {"file": "/w/a.py", "line": 5, "column": 2, "severity": "error", "message": "bad", "code": "assignment"}
        )
        d = linters.parse_mypy(js)
        self.assertEqual(d[0]["ruleId"], "assignment")
        self.assertEqual(d[0]["severity"], "error")
        # text fallback with a trailing [code]
        txt = "/w/a.py:5:3: error: Incompatible types  [assignment]"
        d2 = linters.parse_mypy(txt)
        self.assertEqual(d2[0]["ruleId"], "assignment")
        self.assertEqual(d2[0]["line"], 5)
        self.assertEqual(d2[0]["severity"], "error")
        # a note → info
        self.assertEqual(linters.parse_mypy("/w/a.py:1:1: note: hi")[0]["severity"], "info")

    def test_pylint_json(self) -> None:
        raw = json.dumps(
            [
                {
                    "type": "convention",
                    "symbol": "missing-docstring",
                    "message-id": "C0114",
                    "line": 1,
                    "column": 0,
                    "path": "/w/a.py",
                    "message": "Missing module docstring",
                }
            ]
        )
        d = linters.parse_pylint(raw)
        self.assertEqual(d[0]["ruleId"], "missing-docstring")
        self.assertEqual(d[0]["severity"], "info")  # convention → info
        self.assertEqual(d[0]["col"], 1)  # 0-based column → 1-based

    def test_dedupe_collapses_same_path_line_rule_keeping_first_tool(self) -> None:
        diags = [
            {"path": "/w/a.py", "line": 3, "ruleId": "F401", "tool": "ruff", "severity": "warning", "col": 1, "message": "m1"},
            {"path": "/w/a.py", "line": 3, "ruleId": "F401", "tool": "flake8", "severity": "error", "col": 1, "message": "m2"},
            {"path": "/w/a.py", "line": 9, "ruleId": "F401", "tool": "flake8", "severity": "error", "col": 1, "message": "m3"},
        ]
        out = linters._dedupe(diags)
        self.assertEqual(len(out), 2)  # the two F401 on line 3 collapsed
        self.assertEqual(out[0]["tool"], "ruff")  # first tool kept


class TestResolution(unittest.TestCase):
    def test_argv_has_double_dash_before_paths(self) -> None:
        argv = linters._argv_for("ruff", "/bin/ruff", ["/w/--fix.py"])
        self.assertIn("--", argv)
        # the user path comes AFTER the -- separator (never a flag)
        self.assertGreater(argv.index("/w/--fix.py"), argv.index("--"))
        self.assertEqual(argv[0], "/bin/ruff")

    def test_resolve_tool_prefers_the_interpreter_bindir(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            bindir = os.path.join(d, "bin")
            os.makedirs(bindir)
            interp = os.path.join(bindir, "python3")
            tool = os.path.join(bindir, "ruff")
            for p in (interp, tool):
                with open(p, "w") as f:
                    f.write("#!/bin/sh\n")
                os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
            self.assertEqual(linters.resolve_tool("ruff", interp), os.path.abspath(tool))
            # a tool absent from the bindir → None (unless on PATH; use a clearly-absent name)
            self.assertIsNone(linters.resolve_tool("definitely-not-a-real-linter-xyz", interp))


if __name__ == "__main__":
    unittest.main()
