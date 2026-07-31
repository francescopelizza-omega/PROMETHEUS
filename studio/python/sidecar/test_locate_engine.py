#!/usr/bin/env python3
"""test_locate_engine.py — prove locate_engine.py finds the real sibling engine.

Two layers of coverage:

  * SUBPROCESS tests run ``python3 locate_engine.py --json`` exactly like the
    bridge will, asserting stdout is EXACTLY ONE JSON object, that human logs go
    to stderr, and that env overrides win / missing binaries fail-closed.
  * UNIT tests call ``locate()`` / ``find_sibling_root()`` directly with crafted
    environments and a temp filesystem (cheap, no real engine needed).

Stdlib ``unittest`` + ``subprocess`` only — runnable after a plain checkout, no
third-party deps.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCATE = HERE / "locate_engine.py"
ENVELOPE = HERE / "_envelope.py"

# The real sibling engine: …/PROMETHEUS/studio/python/sidecar → up 3 → …/PROMETHEUS
REAL_ROOT = HERE.parent.parent.parent
REAL_PROM = REAL_ROOT / "prometheus.py"
REAL_NEMESIS = REAL_ROOT / "nemesis"

# Import the module under test directly for the unit-level assertions.
sys.path.insert(0, str(HERE))
import locate_engine  # noqa: E402


def run_cli(*args: str, env: dict | None = None, cwd: str | None = None) -> tuple[dict, str, int]:
    """Run `python3 locate_engine.py <args>`; return (parsed_stdout_obj, stderr, exitcode).

    Asserts stdout is exactly ONE JSON-object line (the bridge contract).
    """
    full_env = dict(os.environ)
    if env is not None:
        full_env.update({k: v for k, v in env.items() if v is not None})
        for k, v in env.items():
            if v is None:
                full_env.pop(k, None)
    proc = subprocess.run(
        [sys.executable, str(LOCATE), *args],
        capture_output=True, text=True, timeout=120, env=full_env, cwd=cwd,
    )
    out = proc.stdout.strip()
    lines = [ln for ln in out.splitlines() if ln.strip()]
    assert len(lines) == 1, f"expected ONE stdout line, got {len(lines)}: {out!r}"
    obj = json.loads(lines[0])
    return obj, proc.stderr, proc.returncode


class LocateEnvelopeTests(unittest.TestCase):
    """The JSON envelope shape and stdout/stderr discipline."""

    def _assert_envelope_keys(self, obj: dict) -> None:
        self.assertEqual(obj["command"], "locate_engine")
        for k in ("ok", "prometheus_py", "nemesis_bin", "python_bin", "root", "sources"):
            self.assertIn(k, obj)
        self.assertIsInstance(obj["sources"], dict)
        for k in ("prometheus_py", "nemesis_bin", "python_bin"):
            self.assertIn(k, obj["sources"])

    def test_finds_real_sibling_engine(self) -> None:
        # Sanity: the real engine must exist for this assertion to be meaningful.
        self.assertTrue(REAL_PROM.is_file(), f"missing real engine at {REAL_PROM}")
        self.assertTrue(REAL_NEMESIS.is_file(), f"missing real nemesis at {REAL_NEMESIS}")

        # Run from an UNRELATED cwd to prove CWD-independence; scrub overrides.
        clean = {"PROMETHEUS_PY": None, "NEMESIS_BIN": None, "PYTHON": None, "PYTHON_BIN": None}
        obj, stderr, code = run_cli("--json", env=clean, cwd=tempfile.gettempdir())
        self._assert_envelope_keys(obj)
        self.assertTrue(obj["ok"], msg=obj.get("reason"))
        self.assertEqual(code, 0)
        self.assertEqual(Path(obj["prometheus_py"]).resolve(), REAL_PROM.resolve())
        self.assertEqual(Path(obj["nemesis_bin"]).resolve(), REAL_NEMESIS.resolve())
        self.assertEqual(Path(obj["root"]).resolve(), REAL_ROOT.resolve())
        self.assertEqual(obj["sources"]["prometheus_py"], "sibling-root")
        self.assertEqual(obj["sources"]["nemesis_bin"], "sibling-root")
        # python always resolves
        self.assertTrue(obj["python_bin"])
        # human logs (if any) never pollute stdout — stderr only.
        self.assertNotIn("{", stderr.split("\n")[0] if stderr else "")

    def test_default_flag_is_json(self) -> None:
        # No args behaves identically to --json (JSON-only sidecar).
        obj, _stderr, code = run_cli(env={"PROMETHEUS_PY": None, "NEMESIS_BIN": None})
        self._assert_envelope_keys(obj)
        self.assertEqual(code, 0)

    def test_unexpected_arg_fails_closed(self) -> None:
        obj, _stderr, code = run_cli("--bogus")
        self.assertFalse(obj["ok"])
        self.assertEqual(obj["command"], "locate_engine")
        self.assertIn("error", obj)
        self.assertEqual(code, 2)


class LocateEnvOverrideTests(unittest.TestCase):
    """Env overrides win over sibling-root discovery (subprocess + unit)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="locate_test_"))
        self.fake_prom = self.tmp / "fake_prom.py"
        self.fake_nem = self.tmp / "fake_nemesis"
        self.fake_prom.write_text("# fake engine\n")
        self.fake_nem.write_text("#!/bin/sh\n")
        self.fake_nem.chmod(0o755)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_env_overrides_win_subprocess(self) -> None:
        obj, _stderr, code = run_cli(
            "--json",
            env={
                "PROMETHEUS_PY": str(self.fake_prom),
                "NEMESIS_BIN": str(self.fake_nem),
            },
        )
        self.assertTrue(obj["ok"], msg=obj.get("reason"))
        self.assertEqual(code, 0)
        self.assertEqual(Path(obj["prometheus_py"]).resolve(), self.fake_prom.resolve())
        self.assertEqual(Path(obj["nemesis_bin"]).resolve(), self.fake_nem.resolve())
        self.assertEqual(obj["sources"]["prometheus_py"], "env:PROMETHEUS_PY")
        self.assertEqual(obj["sources"]["nemesis_bin"], "env:NEMESIS_BIN")

    def test_env_overrides_win_unit(self) -> None:
        # Directly exercise locate() with a patched environ — env beats sibling root.
        saved = dict(os.environ)
        try:
            os.environ["PROMETHEUS_PY"] = str(self.fake_prom)
            os.environ["NEMESIS_BIN"] = str(self.fake_nem)
            payload = locate_engine.locate()
        finally:
            os.environ.clear()
            os.environ.update(saved)
        self.assertTrue(payload["ok"])
        self.assertEqual(Path(str(payload["prometheus_py"])).resolve(), self.fake_prom.resolve())
        self.assertEqual(payload["sources"]["prometheus_py"], "env:PROMETHEUS_PY")  # type: ignore[index]

    def test_broken_env_override_falls_through(self) -> None:
        # PROMETHEUS_PY set to a non-existent path must fall through to sibling root,
        # and report the override as missing in sources (only when nothing else found).
        obj, _stderr, code = run_cli(
            "--json",
            env={"PROMETHEUS_PY": str(self.tmp / "nope.py"), "NEMESIS_BIN": None},
            cwd=str(HERE),  # so sibling-root discovery still works
        )
        # The real sibling prometheus.py exists from HERE → falls through to it.
        self.assertTrue(obj["ok"], msg=obj.get("reason"))
        self.assertEqual(obj["sources"]["prometheus_py"], "sibling-root")

    def test_python_env_override_unit(self) -> None:
        saved = dict(os.environ)
        try:
            os.environ["PYTHON"] = sys.executable  # existing file → wins
            py, src = locate_engine._resolve_python()
            self.assertEqual(Path(py).resolve(), Path(sys.executable).resolve())
            self.assertEqual(src, "env:PYTHON")
        finally:
            os.environ.clear()
            os.environ.update(saved)


class LocateFailClosedTests(unittest.TestCase):
    """A non-locatable engine reports null + ok:false + reason, NEVER throws."""

    def test_isolated_dir_fails_closed_subprocess(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="locate_iso_"))
        try:
            # Copy the sidecar (+ its _envelope dep) somewhere with NO engine ancestor.
            shutil.copy2(LOCATE, tmp / "locate_engine.py")
            shutil.copy2(ENVELOPE, tmp / "_envelope.py")
            proc = subprocess.run(
                [sys.executable, str(tmp / "locate_engine.py"), "--json"],
                capture_output=True, text=True, timeout=60,
                env={k: v for k, v in os.environ.items()
                     if k not in ("PROMETHEUS_PY", "NEMESIS_BIN")},
                cwd=str(tmp),
            )
            lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
            self.assertEqual(len(lines), 1, proc.stdout)
            obj = json.loads(lines[0])
            self.assertFalse(obj["ok"])
            self.assertIsNone(obj["prometheus_py"])
            self.assertIsNone(obj["nemesis_bin"])
            self.assertIsNone(obj["root"])
            self.assertIn("reason", obj)
            self.assertEqual(proc.returncode, 2)
            # python still resolves even with no engine present.
            self.assertTrue(obj["python_bin"])
            # reason mentions both missing binaries + how to fix.
            self.assertIn("prometheus.py", obj["reason"])
            self.assertIn("nemesis", obj["reason"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_find_sibling_root_returns_none_off_tree(self) -> None:
        tmp = tempfile.mkdtemp(prefix="locate_root_")
        try:
            self.assertIsNone(locate_engine.find_sibling_root(start=tmp))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_find_sibling_root_finds_real(self) -> None:
        root = locate_engine.find_sibling_root(start=str(HERE))
        self.assertIsNotNone(root)
        self.assertEqual(Path(str(root)).resolve(), REAL_ROOT.resolve())

    def test_locate_never_raises(self) -> None:
        # Even from "/" (no engine), locate() returns a dict and never throws.
        payload = locate_engine.locate(start="/")
        self.assertIsInstance(payload, dict)
        self.assertIn("ok", payload)
        self.assertIn("python_bin", payload)  # always present


if __name__ == "__main__":
    unittest.main(verbosity=2)
