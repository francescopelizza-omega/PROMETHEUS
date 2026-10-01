#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_testmgr.py — exercise testmgr.py's run/rerun-failed verbs (APP-013).

The load-bearing paths are the ARG GUARDS (option-injection / shell-metachar
rejection BEFORE any spawn) and the OUTPUT PARSERS (pytest ``-v`` node-id lines,
unittest ``-v`` dotted-id lines) — so the subprocess seam (``testmgr._spawn``) is
monkeypatched with a fake Popen and NOTHING is ever executed. Events are captured
by redirecting stdout: all lines but the last are JSON test events, the last line
is the one terminal envelope (the bridge's last-to-first scan contract).
"""
from __future__ import annotations

import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import testmgr  # noqa: E402


class FakePopen:
    """A minimal Popen double: canned merged-output lines + an exit code."""

    def __init__(self, lines: list[str], exit_code: int = 0) -> None:
        self.stdout = io.StringIO("".join(ln + "\n" for ln in lines))
        self._exit = exit_code

    def wait(self) -> int:
        return self._exit


class RunVerbBase(unittest.TestCase):
    """Monkeypatch the _spawn seam; capture the argv it was handed + the stream."""

    def setUp(self) -> None:
        self.spawned: list[tuple[list[str], str]] = []
        self.fake_lines: list[str] = []
        self.fake_exit = 0
        self._orig_spawn = testmgr._spawn

        def fake_spawn(argv, cwd):
            self.spawned.append((list(argv), cwd))
            return FakePopen(self.fake_lines, self.fake_exit)

        testmgr._spawn = fake_spawn

    def tearDown(self) -> None:
        testmgr._spawn = self._orig_spawn

    def run_verb(self, handler, argv: list[str]) -> tuple[list[dict], dict, int]:
        """Invoke a handler; return (event lines, terminal envelope, exit code)."""
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = handler(argv)
        lines = [ln for ln in buf.getvalue().splitlines() if ln.strip()]
        self.assertGreaterEqual(len(lines), 1, f"no stdout at all: {buf.getvalue()!r}")
        events = [json.loads(ln) for ln in lines[:-1]]
        envelope = json.loads(lines[-1])
        return events, envelope, code


class TestRunPytest(RunVerbBase):
    def test_streams_events_and_summary(self) -> None:
        self.fake_lines = [
            "tests/test_a.py::test_one PASSED [ 33%]",
            "tests/test_a.py::TestC::test_two FAILED [ 66%]",
            "tests/test_a.py::test_p[a-b] SKIPPED (why) [100%]",
            "== short test summary info ==",
            "FAILED tests/test_a.py::TestC::test_two - assert 0",
        ]
        self.fake_exit = 1
        events, env, code = self.run_verb(
            testmgr._run,
            ["--path", str(HERE), "--framework", "pytest",
             "--id", "tests/test_a.py::test_one",
             "--id", "tests/test_a.py::TestC::test_two",
             "--id", "tests/test_a.py::test_p[a-b]"],
        )
        # ordered per-test events; the summary line at column 0 is NOT double-counted
        self.assertEqual(
            [(e["id"], e["status"]) for e in events],
            [("tests/test_a.py::test_one", "pass"),
             ("tests/test_a.py::TestC::test_two", "fail"),
             ("tests/test_a.py::test_p[a-b]", "skip")],
        )
        self.assertTrue(all(e["event"] == "test" for e in events))
        self.assertTrue(env["ok"])
        self.assertEqual(env["command"], "run")
        self.assertEqual(env["summary"]["total"], 3)
        self.assertEqual(env["summary"]["passed"], 1)
        self.assertEqual(env["summary"]["failed"], 1)
        self.assertEqual(env["summary"]["skipped"], 1)
        self.assertEqual(env["summary"]["exitCode"], 1)
        self.assertEqual(code, 0)

    def test_failure_carries_output_and_file_line(self) -> None:
        # APP-040: a FAILURES section → a follow-up event with captured output + file:line.
        self.fake_lines = [
            "tests/test_a.py::TestC::test_two FAILED [100%]",
            "=================================== FAILURES ===================================",
            "_______________________________ TestC.test_two ________________________________",
            "tests/test_a.py:42: in test_two",
            "    assert x == y",
            "E   AssertionError: 1 != 2",
            "----------------------------- Captured stdout call -----------------------------",
            "hello from the test",
            "=========================== short test summary info ============================",
            "FAILED tests/test_a.py::TestC::test_two",
            "========================= 1 failed in 0.10s ==========================",
        ]
        self.fake_exit = 1
        events, _env, _code = self.run_verb(
            testmgr._run,
            ["--path", str(HERE), "--framework", "pytest",
             "--id", "tests/test_a.py::TestC::test_two"],
        )
        self.assertEqual(events[0]["status"], "fail")  # live status event first
        update = [e for e in events if "file" in e][-1]  # then the follow-up update
        self.assertEqual(update["id"], "tests/test_a.py::TestC::test_two")
        self.assertEqual(update["file"], "tests/test_a.py")
        self.assertEqual(update["line"], 42)
        self.assertTrue(any("hello from the test" in ln for ln in update["output"]))

    def test_argv_has_separator_and_only_given_ids(self) -> None:
        self.fake_lines = ["tests/test_a.py::test_one PASSED"]
        self.run_verb(testmgr._run, ["--path", str(HERE), "--framework", "pytest",
                                     "--id", "tests/test_a.py::test_one"])
        argv, cwd = self.spawned[0]
        self.assertEqual(cwd, str(HERE))
        self.assertEqual(argv[:4], [sys.executable, "-u", "-m", "pytest"])
        sep = argv.index("--")
        self.assertEqual(argv[sep + 1:], ["tests/test_a.py::test_one"])

    def test_exit_5_is_soft_collected_zero(self) -> None:
        self.fake_lines = ["no tests ran in 0.01s"]
        self.fake_exit = 5
        _events, env, code = self.run_verb(
            testmgr._run, ["--path", str(HERE), "--framework", "pytest", "--id", "x.py::t"])
        self.assertTrue(env["ok"])
        self.assertEqual(env["summary"]["collected"], 0)
        self.assertEqual(code, 0)

    def test_missing_pytest_fails_soft(self) -> None:
        self.fake_lines = [f"{sys.executable}: No module named pytest"]
        self.fake_exit = 1
        _events, env, code = self.run_verb(
            testmgr._run, ["--path", str(HERE), "--framework", "pytest", "--id", "x.py::t"])
        self.assertFalse(env["ok"])
        self.assertIn("pytest is not installed", env["error"])
        self.assertNotEqual(code, 0)

    def test_usage_error_fails_soft(self) -> None:
        self.fake_lines = ["ERROR: usage: pytest ..."]
        self.fake_exit = 4
        _events, env, _code = self.run_verb(
            testmgr._run, ["--path", str(HERE), "--framework", "pytest", "--id", "x.py::t"])
        self.assertFalse(env["ok"])
        self.assertIn("exit 4", env["error"])


class TestRunUnittest(RunVerbBase):
    def test_dotted_ids_no_separator(self) -> None:
        self.fake_lines = [
            "test_one (pkg.mod.Cls.test_one) ... ok",
            "test_two (pkg.mod.Cls.test_two) ... FAIL",
            "test_three (pkg.mod.Cls.test_three) ... skipped 'why'",
        ]
        self.fake_exit = 1
        events, env, _code = self.run_verb(
            testmgr._run,
            ["--path", str(HERE), "--framework", "unittest",
             "--id", "pkg.mod.Cls.test_one", "--id", "pkg.mod.Cls.test_two",
             "--id", "pkg.mod.Cls.test_three"],
        )
        argv, _cwd = self.spawned[0]
        self.assertEqual(argv[:4], [sys.executable, "-u", "-m", "unittest"])
        self.assertNotIn("--", argv)  # -m unittest has NO `--` support
        self.assertEqual(argv[-3:], ["pkg.mod.Cls.test_one", "pkg.mod.Cls.test_two",
                                     "pkg.mod.Cls.test_three"])
        self.assertEqual(
            [(e["id"], e["status"]) for e in events],
            [("pkg.mod.Cls.test_one", "pass"),
             ("pkg.mod.Cls.test_two", "fail"),
             ("pkg.mod.Cls.test_three", "skip")],
        )
        self.assertEqual(events[2]["message"], "why")
        self.assertTrue(env["ok"])
        self.assertEqual(env["summary"]["failed"], 1)

    def test_pre311_class_only_paren_gets_method_appended(self) -> None:
        self.fake_lines = ["test_one (pkg.mod.Cls) ... ok"]
        events, _env, _code = self.run_verb(
            testmgr._run, ["--path", str(HERE), "--framework", "unittest",
                           "--id", "pkg.mod.Cls.test_one"])
        self.assertEqual(events[0]["id"], "pkg.mod.Cls.test_one")


    def test_unittest_failure_carries_file_line(self) -> None:
        # APP-040: unittest FAIL block → a follow-up event with the traceback file:line.
        self.fake_lines = [
            "test_two (pkg.mod.Cls.test_two) ... FAIL",
            "======================================================================",
            "FAIL: test_two (pkg.mod.Cls.test_two)",
            "----------------------------------------------------------------------",
            "Traceback (most recent call last):",
            '  File "/proj/tests/test_x.py", line 12, in test_two',
            "    self.assertEqual(1, 2)",
            "AssertionError: 1 != 2",
            "----------------------------------------------------------------------",
            "Ran 1 test in 0.001s",
            "FAILED (failures=1)",
        ]
        self.fake_exit = 1
        events, _env, _code = self.run_verb(
            testmgr._run,
            ["--path", str(HERE), "--framework", "unittest", "--id", "pkg.mod.Cls.test_two"],
        )
        update = [e for e in events if "file" in e][-1]
        self.assertEqual(update["id"], "pkg.mod.Cls.test_two")
        self.assertEqual(update["file"], "/proj/tests/test_x.py")
        self.assertEqual(update["line"], 12)


class TestArgGuards(RunVerbBase):
    def assert_rejected(self, node_id: str) -> None:
        _events, env, code = self.run_verb(
            testmgr._run, ["--path", str(HERE), "--framework", "pytest", "--id", node_id])
        self.assertFalse(env["ok"], f"id {node_id!r} must be rejected")
        self.assertIn("unsafe test id", env["error"])
        self.assertNotEqual(code, 0)
        self.assertEqual(self.spawned, [], f"id {node_id!r} must never reach a spawn")

    def test_malicious_ids_rejected_before_spawn(self) -> None:
        self.assert_rejected("-x")
        self.assert_rejected("--collect-only")
        self.assert_rejected("; rm -rf /")
        self.assert_rejected("a.py::t`whoami`")
        self.assert_rejected("a.py::t$(x)")
        self.assert_rejected("a.py::t|tee")

    def test_parametrized_ids_are_allowed(self) -> None:
        # a too-strict pattern would silently drop every parametrized id
        self.assertTrue(testmgr._safe_id("tests/test_a.py::TestC::test_p[a-b]"))
        self.assertTrue(testmgr._safe_id("tests/test_a.py::test_p[1.5, x]"))
        self.assertTrue(testmgr._safe_id("pkg.mod.Cls.test_one"))

    def test_bad_framework_and_missing_ids_rejected(self) -> None:
        _e, env, _c = self.run_verb(
            testmgr._run, ["--path", str(HERE), "--framework", "nose", "--id", "a.py::t"])
        self.assertFalse(env["ok"])
        self.assertIn("unknown framework", env["error"])
        _e, env, _c = self.run_verb(testmgr._run, ["--path", str(HERE), "--framework", "pytest"])
        self.assertFalse(env["ok"])
        self.assertIn("no test ids", env["error"])

    def test_bad_path_rejected(self) -> None:
        _e, env, _c = self.run_verb(
            testmgr._run, ["--path", "/definitely/not/a/dir", "--id", "a.py::t"])
        self.assertFalse(env["ok"])
        self.assertIn("not a directory", env["error"])

    def test_option_shaped_path_rejected(self) -> None:
        # CLI-006: a --path value that is itself a flag (`--path=--help`, or `--path`
        # swallowing the next flag) must be refused BEFORE any spawn — fail-closed.
        for argv in (
            ["--path=--help", "--framework", "pytest", "--id", "a.py::t"],
            ["--path", "--help", "--framework", "pytest", "--id", "a.py::t"],
        ):
            _e, env, code = self.run_verb(testmgr._run, argv)
            self.assertFalse(env["ok"])
            self.assertIn("option-shaped", env["error"])
            self.assertNotEqual(code, 0)
            self.assertEqual(self.spawned, [], "an option-shaped path must never reach a spawn")

    def test_bad_timeout_rejected(self) -> None:
        _e, env, _c = self.run_verb(
            testmgr._run,
            ["--path", str(HERE), "--framework", "pytest", "--id", "a.py::t", "--timeout", "soon"])
        self.assertFalse(env["ok"])
        self.assertIn("invalid --timeout", env["error"])


class TestFrameworkAuto(RunVerbBase):
    """CLI-006: --framework auto picks pytest when available, else unittest."""

    def setUp(self) -> None:
        super().setUp()
        self._orig_probe = testmgr._pytest_available

    def tearDown(self) -> None:
        testmgr._pytest_available = self._orig_probe
        super().tearDown()

    def test_auto_uses_pytest_when_available(self) -> None:
        testmgr._pytest_available = lambda: True
        self.fake_lines = ["a.py::t PASSED"]
        self.run_verb(testmgr._run, ["--path", str(HERE), "--framework", "auto", "--id", "a.py::t"])
        argv, _cwd = self.spawned[0]
        self.assertEqual(argv[:4], [sys.executable, "-u", "-m", "pytest"])

    def test_auto_falls_back_to_unittest(self) -> None:
        testmgr._pytest_available = lambda: False
        self.fake_lines = ["test_t (pkg.Cls.test_t) ... ok"]
        self.run_verb(testmgr._run, ["--path", str(HERE), "--framework", "auto",
                                     "--id", "pkg.Cls.test_t"])
        argv, _cwd = self.spawned[0]
        self.assertEqual(argv[:4], [sys.executable, "-u", "-m", "unittest"])


class TestTimeoutReal(unittest.TestCase):
    """CLI-006: a --timeout group-kills a real sleeping run — the caller never hangs."""

    def test_sleeper_is_killed_within_the_timeout(self) -> None:
        import json as _json
        import os as _os
        import subprocess as _sp
        import tempfile as _tf
        import time as _time

        sleeper = (
            "import time, unittest\n"
            "class SleepTests(unittest.TestCase):\n"
            "    def test_slow(self):\n"
            "        time.sleep(30)\n"
        )
        with _tf.TemporaryDirectory() as d:
            with open(_os.path.join(d, "test_sleep.py"), "w") as fh:
                fh.write(sleeper)
            started = _time.monotonic()
            proc = _sp.run(
                [sys.executable, str(HERE / "testmgr.py"), "run", "--path", d,
                 "--framework", "unittest", "--id", "test_sleep.SleepTests.test_slow",
                 "--timeout", "1"],
                capture_output=True, text=True, timeout=20,
            )
            elapsed = _time.monotonic() - started
            self.assertLess(elapsed, 8.0, "a --timeout 1 run must not block for the 30s sleep")
            env = None
            for line in proc.stdout.splitlines():
                line = line.strip()
                if line.startswith("{") and '"ok"' in line:
                    env = _json.loads(line)
            self.assertIsNotNone(env, f"no envelope on stdout: {proc.stdout!r}")
            self.assertFalse(env["ok"])
            self.assertTrue(env["summary"]["timedOut"])
            self.assertEqual(env["summary"]["timedOutId"], "test_sleep.SleepTests.test_slow")


class TestRerunFailed(RunVerbBase):
    def test_argv_contains_only_the_supplied_failed_ids(self) -> None:
        self.fake_lines = ["tests/test_a.py::test_two PASSED"]
        _events, env, _code = self.run_verb(
            testmgr._rerun_failed,
            ["--path", str(HERE), "--framework", "pytest",
             "--failed", "tests/test_a.py::test_two",
             "--failed", "tests/test_a.py::test_p[a-b]"],
        )
        argv, _cwd = self.spawned[0]
        sep = argv.index("--")
        # ONLY the supplied failures — appending the prior full set would re-run everything
        self.assertEqual(argv[sep + 1:],
                         ["tests/test_a.py::test_two", "tests/test_a.py::test_p[a-b]"])
        self.assertTrue(env["ok"])
        self.assertEqual(env["command"], "rerun-failed")

    def test_failed_ids_are_guarded_too(self) -> None:
        _events, env, _code = self.run_verb(
            testmgr._rerun_failed,
            ["--path", str(HERE), "--framework", "pytest", "--failed", "-x"])
        self.assertFalse(env["ok"])
        self.assertEqual(self.spawned, [])


class TestVerbTable(unittest.TestCase):
    def test_run_verbs_registered_and_discover_untouched(self) -> None:
        self.assertIn("run", testmgr.HANDLERS)
        self.assertIn("rerun-failed", testmgr.HANDLERS)
        self.assertIn("discover", testmgr.HANDLERS)
        self.assertIn("version", testmgr.HANDLERS)


if __name__ == "__main__":
    unittest.main()
