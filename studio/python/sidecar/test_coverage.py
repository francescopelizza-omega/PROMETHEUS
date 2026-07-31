#!/usr/bin/env python3
"""test_coverage.py — the coverage runner sidecar (APP-086). Stdlib unittest."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CP = HERE / "coverage.py"


def _load():
    spec = importlib.util.spec_from_file_location("prom_coverage_mod", CP)
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


class TestReshape(unittest.TestCase):
    def test_reshape_raw_coverage_json(self):
        raw = {
            "files": {
                "a.py": {
                    "executed_lines": [1, 2, 3],
                    "missing_lines": [4, 5],
                    "summary": {"num_branches": 4, "covered_branches": 2},
                }
            },
            "totals": {"percent_covered": 60.0},
        }
        out = M._reshape(raw)
        self.assertEqual(out["perFile"]["a.py"]["lines"], [1, 2, 3])
        self.assertEqual(out["perFile"]["a.py"]["missed"], [4, 5])
        self.assertEqual(out["perFile"]["a.py"]["branchPct"], 50.0)
        self.assertEqual(out["totalPct"], 60.0)

    def test_reshape_without_branch_data(self):
        out = M._reshape({"files": {"x.py": {"executed_lines": [1], "missing_lines": []}}})
        self.assertNotIn("branchPct", out["perFile"]["x.py"])
        self.assertEqual(out["totalPct"], 100.0)


class TestMerge(unittest.TestCase):
    def test_merge_union_disjoint_halves_is_100(self):
        a = {"perFile": {"f.py": {"lines": [1, 2], "missed": [3, 4]}}, "totalPct": 50}
        b = {"perFile": {"f.py": {"lines": [3, 4], "missed": [1, 2]}}, "totalPct": 50}
        m = M._merge([a, b])
        self.assertEqual(m["perFile"]["f.py"]["lines"], [1, 2, 3, 4])
        self.assertEqual(m["perFile"]["f.py"]["missed"], [])
        self.assertEqual(m["totalPct"], 100.0)

    def test_merge_line_missed_in_both_stays_missed(self):
        a = {"perFile": {"f.py": {"lines": [1], "missed": [2, 3]}}, "totalPct": 0}
        b = {"perFile": {"f.py": {"lines": [1], "missed": [3]}}, "totalPct": 0}
        m = M._merge([a, b])
        self.assertEqual(m["perFile"]["f.py"]["missed"], [2, 3])


class TestVerbs(unittest.TestCase):
    def test_merge_verb_reads_fixture_reports(self):
        with tempfile.TemporaryDirectory() as d:
            p1 = Path(d) / "r1.json"
            p2 = Path(d) / "r2.json"
            p1.write_text(json.dumps({"perFile": {"f.py": {"lines": [1], "missed": [2]}}, "totalPct": 50}))
            p2.write_text(json.dumps({"perFile": {"f.py": {"lines": [2], "missed": [1]}}, "totalPct": 50}))
            out = _run_verb(M.verb_merge, ["--in", str(p1), "--in", str(p2)])
            self.assertTrue(out["ok"])
            self.assertEqual(out["totalPct"], 100.0)

    def test_import_verb_reshapes_raw_coverage_json(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "coverage.json"
            p.write_text(json.dumps({"files": {"a.py": {"executed_lines": [1], "missing_lines": [2]}},
                                     "totals": {"percent_covered": 50.0}}))
            out = _run_verb(M.verb_import, ["--in", str(p)])
            self.assertTrue(out["ok"])
            self.assertEqual(out["perFile"]["a.py"]["lines"], [1])
            self.assertEqual(out["totalPct"], 50.0)

    def test_run_verb_rejects_flag_shaped_id(self):
        with tempfile.TemporaryDirectory() as d:
            out = _run_verb(M.verb_run, ["--path", d, "--framework", "pytest", "--id", "-x"])
            self.assertFalse(out["ok"])
            self.assertIn("invalid --id", out.get("error", ""))

    def test_run_verb_rejects_bad_framework(self):
        with tempfile.TemporaryDirectory() as d:
            out = _run_verb(M.verb_run, ["--path", d, "--framework", "nose"])
            self.assertFalse(out["ok"])
            self.assertIn("not allowed", out.get("error", ""))

    def test_run_verb_fails_soft_when_coverage_absent(self):
        # coverage is not installed in this interpreter → a structured, fail-soft error.
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "test_x.py").write_text("def test_ok():\n    assert True\n")
            out = _run_verb(M.verb_run, ["--path", d, "--framework", "unittest"])
            # either a clean 'not installed' error, or (if coverage IS present) a valid report
            if not out["ok"]:
                self.assertIn("coverage", out.get("error", "").lower())
            else:
                self.assertIn("perFile", out)

    def test_run_verb_missing_coverage_names_the_pip_remedy(self):
        # simulate a target env with no `coverage` module → the error names the install (CLI-055).
        import types

        original = M._run_cmd
        M._run_cmd = lambda argv, cwd: types.SimpleNamespace(
            stdout="", stderr="No module named coverage", returncode=1
        )
        try:
            with tempfile.TemporaryDirectory() as d:
                out = _run_verb(M.verb_run, ["--path", d, "--framework", "pytest"])
        finally:
            M._run_cmd = original
        self.assertFalse(out["ok"])
        self.assertIn("pip install coverage", out.get("error", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
