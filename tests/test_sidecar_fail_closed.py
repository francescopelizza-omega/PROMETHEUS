#!/usr/bin/env python3
"""test_sidecar_fail_closed.py — a sidecar must not report success for work it never did.

Two sidecars answered `ok:true` for inputs they had not actually processed, and in both cases the
successful-looking answer is indistinguishable from a real one:

  structsearch match --path <missing>  → {"count": 0, "matches": [], "ok": true}
      identical to "I searched and this symbol does not exist". Measured: the same pattern
      against a real file returns 32 matches.

  sqlrunner sql.connect sqlite:////missing.db → {"ok": true, "dialect": "sqlite", …}
      AND it CREATED a 0-byte database, so every later query reports "no such table" against a
      database the user never made. Pointing it at a plain text file also answered ok:true.

Run: python3 tests/test_sidecar_fail_closed.py."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "studio" / "python" / "sidecar"


def run(script, *argv):
    """Run a sidecar verb and return its parsed envelope (the LAST stdout line)."""
    p = subprocess.run(
        [sys.executable, str(SIDECAR / script), *argv],
        capture_output=True, text=True, timeout=120,
    )
    line = [l for l in p.stdout.strip().splitlines() if l.strip()][-1]
    return json.loads(line)


class TestStructSearchFailsClosed(unittest.TestCase):
    def test_a_missing_path_is_an_ERROR_not_zero_matches(self):
        for missing in ["/tmp/prom-r8-no-such-file.py", "/tmp/prom-r8-no-such-dir"]:
            env = run("structsearch.py", "match", "--path", missing, "--pattern", "return $X")
            self.assertFalse(env["ok"], f"{missing} reported success")
            self.assertIn("does not exist", env["error"])

    def test_replace_refuses_a_missing_path_too(self):
        env = run(
            "structsearch.py", "replace",
            "--path", "/tmp/prom-r8-no-such-file.py",
            "--pattern", "return $X", "--replacement", "return $X",
        )
        self.assertFalse(env["ok"])
        self.assertIn("does not exist", env["error"])

    def test_a_real_file_still_searches(self):
        # self-validating: the guard must not have turned match into a verb that always fails.
        d = Path(tempfile.mkdtemp(prefix="prom-ss-"))
        (d / "m.py").write_text("def f():\n    return 1\n\ndef g():\n    return 2\n")
        env = run("structsearch.py", "match", "--path", str(d / "m.py"), "--pattern", "return $X")
        self.assertTrue(env["ok"], env.get("error"))
        self.assertEqual(env["count"], 2)


class TestSqlRunnerFailsClosed(unittest.TestCase):
    def _db(self):
        d = Path(tempfile.mkdtemp(prefix="prom-sql-"))
        p = d / "real.sqlite"
        c = sqlite3.connect(p)
        c.execute("create table t(a int)")
        c.commit()
        c.close()
        return d, p

    def test_a_missing_database_is_refused_and_NOT_created(self):
        d, _ = self._db()
        missing = d / "nope.sqlite"
        env = run("sqlrunner.py", "sql.connect", f"sqlite:///{missing}")
        self.assertFalse(env["ok"], "connecting to a missing database reported success")
        self.assertIn("no such database", env["error"])
        self.assertFalse(missing.exists(), "the connect created a phantom empty database")

    def test_a_file_that_is_not_a_database_is_refused(self):
        d, _ = self._db()
        text = d / "notadb.txt"
        text.write_text("this is definitely not a database, just text\n")
        env = run("sqlrunner.py", "sql.connect", f"sqlite:///{text}")
        self.assertFalse(env["ok"], "a text file reported a successful connection")
        self.assertIn("not a database", env["error"])

    def test_a_directory_is_refused(self):
        d, _ = self._db()
        env = run("sqlrunner.py", "sql.connect", f"sqlite:///{d}")
        self.assertFalse(env["ok"])
        self.assertIn("not a database file", env["error"])

    def test_a_real_database_and_memory_still_connect(self):
        # self-validating, both directions: the guard must not refuse legitimate targets.
        _, p = self._db()
        env = run("sqlrunner.py", "sql.connect", f"sqlite:///{p}")
        self.assertTrue(env["ok"], env.get("error"))
        self.assertEqual(env["dialect"], "sqlite")

        mem = run("sqlrunner.py", "sql.connect", "sqlite://")
        self.assertTrue(mem["ok"], mem.get("error"))
        self.assertEqual(mem["database"], ":memory:")


if __name__ == "__main__":
    unittest.main()
