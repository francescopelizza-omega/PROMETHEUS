#!/usr/bin/env python3
"""test_repomap.py — repomap.py sidecar tests (APP-053).

A fixture mini-repo (python + ts + a binary + an ignored dir + a broken file) pins:
extraction, ranking order (widely-referenced > one-off), ignore rules, incremental
refresh (only named files), and malformed-file resilience. Stdlib only.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from typing import Any, Dict, List, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
REPOMAP = os.path.join(HERE, "repomap.py")

sys.path.insert(0, HERE)
import repomap  # noqa: E402


def _run(args: List[str]) -> Tuple[int, Dict[str, Any]]:
    proc = subprocess.run(
        [sys.executable, REPOMAP, *args], input="", capture_output=True, text=True, timeout=60
    )
    obj: Dict[str, Any] = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
    return proc.returncode, obj


CORE_PY = "class Widget:\n    def render(self):\n        pass\n\n\ndef helper():\n    return 1\n"
APP_PY = (
    "from pkg.core import Widget, helper\n\n\n"
    "def main():\n    Widget().render()\n    helper()\n    helper()\n"
)
UTIL_TS = "export function shared() {\n  return 42;\n}\nexport class Thing {}\nconst arrow = () => shared();\n"


class TestRepomap(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="repomap_")
        os.makedirs(os.path.join(self.root, "pkg"))
        os.makedirs(os.path.join(self.root, "node_modules"))
        self._w("pkg/core.py", CORE_PY)
        self._w("pkg/app.py", APP_PY)
        self._w("util.ts", UTIL_TS)
        self._w("pkg/broken.py", "def broken(\n")  # a partial/py2 file
        self._w("node_modules/dep.js", "function ignoredFn() {}\n")
        with open(os.path.join(self.root, "pkg/blob.bin"), "wb") as fh:
            fh.write(b"\x00\x01\x02binary junk")

    def _w(self, rel: str, text: str) -> None:
        with open(os.path.join(self.root, rel), "w", encoding="utf-8") as fh:
            fh.write(text)

    def _map(self, *extra: str) -> Dict[str, Any]:
        code, obj = _run(["map", self.root, *extra])
        self.assertEqual(code, 0)
        self.assertTrue(obj["ok"])
        return obj

    def test_extracts_python_and_regex_symbols(self) -> None:
        obj = self._map()
        by_path = {f["path"]: f for f in obj["files"]}
        core = {(s["name"], s["kind"]) for s in by_path["pkg/core.py"]["symbols"]}
        self.assertIn(("Widget", "class"), core)
        self.assertIn(("helper", "function"), core)
        self.assertIn(("render", "method"), core)
        ts = {(s["name"], s["kind"]) for s in by_path["util.ts"]["symbols"]}
        self.assertIn(("shared", "function"), ts)
        self.assertIn(("Thing", "class"), ts)

    def test_ranking_surfaces_referenced_over_oneoff(self) -> None:
        obj = self._map()
        ranks = {s["name"]: s["rank"] for f in obj["files"] for s in f["symbols"]}
        # Widget/helper are referenced by app.py; main is a one-off.
        self.assertGreater(ranks["Widget"], ranks["main"])
        self.assertGreater(ranks["helper"], ranks["main"])

    def test_ignore_rules_skip_node_modules_and_binaries(self) -> None:
        obj = self._map()
        paths = [f["path"] for f in obj["files"]]
        self.assertFalse(any("node_modules" in p for p in paths), "ignored dir leaked")
        self.assertFalse(any(p.endswith(".bin") for p in paths), "binary leaked")
        names = {s["name"] for f in obj["files"] for s in f["symbols"]}
        self.assertNotIn("ignoredFn", names)

    def test_malformed_file_never_crashes_the_scan(self) -> None:
        obj = self._map()
        # broken.py falls back to the regex path (`def broken(`) — a symbol, not a crash.
        broken = next((f for f in obj["files"] if f["path"] == "pkg/broken.py"), None)
        self.assertIsNotNone(broken)
        self.assertTrue(any(s["name"] == "broken" for s in broken["symbols"]))

    def test_query_personalization_boosts_named_symbol(self) -> None:
        base = {s["name"]: s["rank"] for f in self._map()["files"] for s in f["symbols"]}
        boosted = {
            s["name"]: s["rank"]
            for f in self._map("--query", "main")["files"]
            for s in f["symbols"]
        }
        self.assertGreater(boosted["main"], base["main"])

    def test_refresh_emits_only_named_files_with_global_ranks(self) -> None:
        code, obj = _run(["refresh", self.root, "--files", "pkg/app.py"])
        self.assertEqual(code, 0)
        self.assertEqual(obj["command"], "refresh")
        self.assertEqual([f["path"] for f in obj["files"]], ["pkg/app.py"])

    def test_budget_trim_marks_truncated(self) -> None:
        obj = self._map("--budget", "1")
        self.assertTrue(obj["truncated"])

    def test_pure_extract_helpers(self) -> None:
        # the pure extractors (importable) — python ast + regex signatures.
        self.assertIn(("helper", "function", 6), repomap._extract_python(CORE_PY))
        ts = repomap._extract_regex(UTIL_TS)
        self.assertTrue(any(n == "shared" and k == "function" for (n, k, _l) in ts))
        # a broken python file → zero ast symbols (never raises)
        self.assertEqual(repomap._extract_python("def broken(\n"), [])


if __name__ == "__main__":
    unittest.main()
