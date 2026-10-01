#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_skills_integrate.py — CLI-078: the background skills-integrate status/log surface.
Proves every run persists a status cache, `--status` reads it back via the SAME renderer, and a
missing/corrupt cache is a clean 'never run yet' (not a crash). Pure stdlib (unittest)."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_prometheus():
    spec = importlib.util.spec_from_file_location("prometheus_mod_integ", ROOT / "prometheus.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


P = _load_prometheus()

FIXTURE = {
    "integrated": [{"name": "skA", "host": "claude", "verdict": "allow"}],
    "already": [{"name": "skB", "host": "codex"}],
    "skipped_unsafe": [{"name": "skC", "host": "claude", "verdict": "critical",
                        "reasons": ["curl|sh"]}],
    "errors": [],
}


class TestSkillsIntegrateStatus(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.skills_dir = Path(self.tmp, "prometheus_skills")
        self.skills_dir.mkdir()
        self._save = (P.PROMETHEUS_SKILLS_DIR, P._INTEGRATE_STATUS_FILE, P.JSON_OUT)
        P.PROMETHEUS_SKILLS_DIR = self.skills_dir
        P._INTEGRATE_STATUS_FILE = self.skills_dir / ".last-integrate.json"

    def tearDown(self):
        P.PROMETHEUS_SKILLS_DIR, P._INTEGRATE_STATUS_FILE, P.JSON_OUT = self._save

    def test_run_persists_status_then_status_reads_it_back(self):
        orig = P.integrate_green_skills
        P.integrate_green_skills = lambda dry_run=False, limit=None: dict(FIXTURE)
        P.JSON_OUT = False
        try:
            rc = P.cmd_skills_integrate(types.SimpleNamespace(status=False, dry_run=False), None)
        finally:
            P.integrate_green_skills = orig
        self.assertEqual(rc, 0)
        # the status cache was written atomically, parses, and carries the fixture + a timestamp.
        data = json.loads(P._INTEGRATE_STATUS_FILE.read_text())
        self.assertIn("at", data)
        self.assertEqual(data["integrated"], FIXTURE["integrated"])
        self.assertEqual(data["skipped_unsafe"], FIXTURE["skipped_unsafe"])
        # --status read-back renders the SAME items via the shared helper. Log methods write to
        # Log.STREAM (bound to the real stdout at import), so capture THAT, not sys.stdout.
        buf = io.StringIO()
        save_stream = P.Log.STREAM
        P.Log.STREAM = buf
        try:
            rc2 = P.cmd_skills_integrate(types.SimpleNamespace(status=True, dry_run=False), None)
        finally:
            P.Log.STREAM = save_stream
        out = buf.getvalue()
        self.assertEqual(rc2, 0)
        self.assertIn("skA", out)   # the integrated item
        self.assertIn("skC", out)   # the skipped-unsafe item

    def test_json_status_shape_matches_live_plus_at(self):
        P._write_integrate_status(dict(FIXTURE))
        P.JSON_OUT = True
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            P.cmd_skills_integrate(types.SimpleNamespace(status=True, dry_run=False), None)
        env = json.loads(buf.getvalue())
        self.assertTrue(env["ok"])
        self.assertIn("at", env)                                   # the extra timestamp
        self.assertEqual(env["result"]["integrated"], FIXTURE["integrated"])  # same result shape

    def test_missing_status_file_is_clean_never_run(self):
        P.JSON_OUT = True
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = P.cmd_skills_integrate(types.SimpleNamespace(status=True, dry_run=False), None)
        env = json.loads(buf.getvalue())
        self.assertEqual(rc, 0)
        self.assertEqual(env.get("status"), "never-run")           # clear, not a false-success

    def test_corrupt_status_file_is_the_no_status_case(self):
        P._INTEGRATE_STATUS_FILE.write_text("{ this is not valid json")
        self.assertIsNone(P._read_integrate_status())              # partial read → None, no crash

    def test_dry_run_does_not_overwrite_the_last_real_status(self):
        P._write_integrate_status(dict(FIXTURE))
        before = P._INTEGRATE_STATUS_FILE.read_text()
        orig = P.integrate_green_skills
        P.integrate_green_skills = lambda dry_run=False, limit=None: {
            "integrated": [], "already": [], "skipped_unsafe": [], "errors": []}
        P.JSON_OUT = True
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                P.cmd_skills_integrate(types.SimpleNamespace(status=False, dry_run=True), None)
        finally:
            P.integrate_green_skills = orig
        self.assertEqual(P._INTEGRATE_STATUS_FILE.read_text(), before)  # dry-run kept the real status


if __name__ == "__main__":
    unittest.main()
