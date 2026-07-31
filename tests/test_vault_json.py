"""test_vault_json.py — CLI-048: vault invoke/invoke-all/rollback over --json.

Exercises the machine channel (dry-run default, --yes gating, --target validation, fail-closed
missing-root) with the network + real downloads stubbed offline, plus a guard that the human
(non-JSON) path still routes through the interactive prompt.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import prometheus as P  # noqa: E402


def _args(action, target=None):
    return types.SimpleNamespace(action=action, target=target)


def _run_json(action, target=None):
    """Call cmd_vault under JSON_OUT and return (exit_code, parsed_stdout_json)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = P.cmd_vault(_args(action, target), None)
    return code, json.loads(buf.getvalue())


class VaultJsonTest(unittest.TestCase):
    def setUp(self):
        self._saved = {k: getattr(P, k) for k in ("JSON_OUT", "ASSUME_YES")}
        self._saved_online = P._online
        self._saved_getroot = P._vault_get_root
        self._saved_stream = P.Log.STREAM
        self.tmp = tempfile.mkdtemp(prefix="vault_json_")
        P.JSON_OUT = True
        P.Log.STREAM = sys.stderr  # --json reroutes human/log text off stdout
        P._online = lambda: False  # never touch the network in tests
        P._vault_get_root = lambda: Path(self.tmp)  # a configured (empty) vault root

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(P, k, v)
        P._online = self._saved_online
        P._vault_get_root = self._saved_getroot
        P.Log.STREAM = self._saved_stream
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_invoke_dry_run_default_touches_nothing(self):
        P.ASSUME_YES = False
        before = os.listdir(self.tmp)
        code, env = _run_json("invoke")
        self.assertEqual(env["command"], "vault")
        self.assertTrue(env["ok"])
        self.assertTrue(env["dry_run"])
        self.assertFalse(env["yes"])
        self.assertIn("planned", env)
        self.assertEqual(os.listdir(self.tmp), before)  # zero disk writes on the dry-run path

    def test_invoke_yes_offline_returns_results_envelope(self):
        P.ASSUME_YES = True
        code, env = _run_json("invoke-all")
        self.assertEqual(code, 0)  # offline → everything skipped, no failures → exit 0
        self.assertTrue(env["ok"])
        self.assertTrue(env["yes"])
        self.assertIn("results", env)
        # offline: no repo is "downloaded" and none "failed"
        self.assertTrue(all(r["status"] in ("skipped", "downloaded") for r in env["results"]))

    def test_rollback_bad_target_is_refused_with_valid_ids(self):
        P.ASSUME_YES = True
        code, env = _run_json("rollback", target="definitely-not-a-repo-xyz")
        self.assertEqual(code, 2)
        self.assertFalse(env["ok"])
        self.assertIn("valid_targets", env)

    def test_rollback_without_target_is_refused(self):
        P.ASSUME_YES = True
        code, env = _run_json("rollback", target=None)
        self.assertEqual(code, 2)
        self.assertFalse(env["ok"])
        self.assertIn("valid_targets", env)

    def test_missing_vault_root_fails_closed(self):
        P._vault_get_root = lambda: None
        for action in ("invoke", "invoke-all", "rollback"):
            code, env = _run_json(action)
            self.assertEqual(code, 2, action)
            self.assertFalse(env["ok"], action)
            self.assertIn("not configured", env["error"], action)

    def test_no_input_reachable_under_json(self):
        # a scripter's stdin must NEVER be read on any vault JSON action.
        P.ASSUME_YES = True
        saved_input = P.__builtins__["input"] if isinstance(P.__builtins__, dict) else __builtins__.input
        called = {"n": 0}

        def _boom(*_a, **_k):
            called["n"] += 1
            raise AssertionError("input() reached under JSON_OUT")

        import builtins
        builtins.input = _boom
        try:
            _run_json("invoke-all")
            _run_json("rollback", target="x")
        finally:
            builtins.input = saved_input
        self.assertEqual(called["n"], 0)

    def test_human_path_still_prompts_for_root(self):
        # regression guard: with JSON off, `vault invoke` routes through _vault_prompt_root.
        P.JSON_OUT = False
        P.Log.STREAM = self._saved_stream
        prompted = {"n": 0}
        saved = P._vault_prompt_root
        P._vault_prompt_root = lambda: (prompted.__setitem__("n", prompted["n"] + 1) or None)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                P.cmd_vault(_args("invoke"), None)
        finally:
            P._vault_prompt_root = saved
        self.assertEqual(prompted["n"], 1)  # the interactive prompt was reached


if __name__ == "__main__":
    unittest.main()
