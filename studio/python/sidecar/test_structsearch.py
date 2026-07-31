#!/usr/bin/env python3
"""test_structsearch.py — unittest for the structural search/replace sidecar (APP-076).

Runs structsearch.py as a SUBPROCESS (the real C7 envelope contract) + exercises the pure
matcher helpers directly. Pure stdlib.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "structsearch.py")


def run(*args):
    """Run the sidecar; return (exit_code, parsed_json)."""
    p = subprocess.run(
        [sys.executable, SCRIPT, *args], capture_output=True, text=True, timeout=30
    )
    obj = json.loads(p.stdout) if p.stdout.strip() else {}
    return p.returncode, obj


class StructSearch(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ssr-")
        self._write("a.py", "print('hi')\nprint(1 + 2)\nx = foo(3)\nprint(x)\n")
        self._write("b.py", "def g():\n    print('b')\n")
        self._write("bad.py", "def broken(:\n")  # SyntaxError → skipped, not fatal
        self._write("notpy.txt", "print('ignored')\n")

    def _write(self, name, text):
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    def test_version(self):
        code, o = run("version")
        self.assertEqual(code, 0)
        self.assertTrue(o["ok"])
        self.assertIn("version", o)

    def test_match_metavar_binding(self):
        code, o = run("match", "--path", self.dir, "--pattern", "print($X)")
        self.assertEqual(code, 0)
        self.assertTrue(o["ok"])
        # 3 in a.py + 1 in b.py = 4 print() calls; foo(3) is NOT matched (structural).
        self.assertEqual(o["count"], 4)
        bindings = sorted(m["bindings"]["X"] for m in o["matches"])
        self.assertIn("1 + 2", bindings)
        self.assertIn("x", bindings)
        # every match carries a position + snippet.
        for m in o["matches"]:
            self.assertGreater(m["line"], 0)
            self.assertTrue(m["snippet"].startswith("print("))

    def test_no_match(self):
        code, o = run("match", "--path", self.dir, "--pattern", "raise $E")
        self.assertEqual(code, 0)
        self.assertTrue(o["ok"])
        self.assertEqual(o["count"], 0)
        self.assertEqual(o["matches"], [])

    def test_multi_file_walk_skips_bad_and_nonpy(self):
        code, o = run("match", "--path", self.dir, "--pattern", "$F($X)")
        self.assertEqual(code, 0)
        files = {os.path.basename(m["file"]) for m in o["matches"]}
        self.assertIn("a.py", files)
        self.assertIn("b.py", files)
        self.assertNotIn("bad.py", files)  # SyntaxError skipped
        self.assertNotIn("notpy.txt", files)  # non-.py ignored

    def test_repeated_metavar_consistency(self):
        self._write("c.py", "eq(a, a)\neq(a, b)\n")
        code, o = run("match", "--path", os.path.join(self.dir, "c.py"), "--pattern", "eq($X, $X)")
        self.assertEqual(o["count"], 1)  # only eq(a, a) — repeated $X must be equal
        self.assertEqual(o["matches"][0]["bindings"]["X"], "a")

    def test_replace_plan_correct_no_write_without_confirm(self):
        before = open(os.path.join(self.dir, "a.py")).read()
        code, o = run("replace", "--path", self.dir, "--pattern", "print($X)", "--rewrite", "log($X)")
        self.assertEqual(code, 0)
        self.assertTrue(o["ok"])
        self.assertEqual(o["written"], 0)
        self.assertFalse(o["confirmed"])
        edits = [e for p in o["plan"] for e in p["edits"]]
        self.assertTrue(any(e["old"] == "print(1 + 2)" and e["new"] == "log(1 + 2)" for e in edits))
        # NOTHING on disk changed without --confirm.
        self.assertEqual(open(os.path.join(self.dir, "a.py")).read(), before)

    def test_replace_confirm_writes(self):
        code, o = run(
            "replace", "--path", os.path.join(self.dir, "b.py"),
            "--pattern", "print($X)", "--rewrite", "log($X)", "--confirm",
        )
        self.assertEqual(code, 0)
        self.assertTrue(o["confirmed"])
        self.assertEqual(o["written"], 1)
        self.assertIn("log('b')", open(os.path.join(self.dir, "b.py")).read())

    def test_malformed_template_fails_closed(self):
        code, o = run("match", "--path", self.dir, "--pattern", "def (:")
        self.assertEqual(code, 2)  # fail-closed exit
        self.assertFalse(o["ok"])
        self.assertIn("error", o)

    def test_missing_path_fails_closed(self):
        code, o = run("match", "--pattern", "print($X)")
        self.assertEqual(code, 2)
        self.assertFalse(o["ok"])


if __name__ == "__main__":
    unittest.main()
