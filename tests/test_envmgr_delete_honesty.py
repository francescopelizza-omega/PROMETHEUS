# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""`env.delete --confirm` must not report success for a delete that did not happen.

Regression: the body was `shutil.rmtree(path, ignore_errors=True)` followed by an unconditional
`executed=True`. One unremovable subtree (`chmod 555 <env>/lib`) was enough for the verb to
return `{"ok": true, "executed": true}` with the whole environment still on disk — the same
swallow fixed in `repo.py::_promote`, in the verb whose ENTIRE job is removal.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENVMGR = ROOT / "studio" / "python" / "sidecar" / "envmgr.py"


def _run(*args):
    out = subprocess.run(
        [sys.executable, str(ENVMGR), *args], capture_output=True, text=True, timeout=300
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


class TestEnvDeleteHonesty(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="prom-envdel-"))
        self.env = self.tmp / "myenv"
        subprocess.run(
            [sys.executable, "-m", "venv", str(self.env)], capture_output=True, timeout=300
        )

    def tearDown(self):
        for base, dirs, _f in os.walk(self.tmp):
            for d in dirs:
                try:
                    os.chmod(Path(base, d), stat.S_IRWXU)
                except OSError:
                    pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_blocked_delete_is_reported_as_a_FAILURE_with_a_reason(self):
        os.chmod(self.env / "lib", 0o555)  # rmtree cannot unlink inside it
        env = _run("env.delete", str(self.env), "--confirm")
        self.assertFalse(env.get("ok"), f"a blocked delete reported success: {env}")
        self.assertNotEqual(env.get("executed"), True)
        self.assertIn("could not fully remove", env.get("error", ""))
        self.assertTrue(self.env.exists(), "the fixture did not actually block the delete")

    def test_a_clean_delete_still_succeeds_and_really_removes_the_tree(self):
        env = _run("env.delete", str(self.env), "--confirm")
        self.assertTrue(env.get("ok"), env)
        self.assertTrue(env.get("executed"))
        self.assertFalse(self.env.exists())

    def test_plan_mode_still_previews_without_deleting(self):
        env = _run("env.delete", str(self.env))
        self.assertTrue(env.get("ok"))
        self.assertTrue(env.get("planned"))
        self.assertTrue(self.env.exists(), "the preview deleted the environment")


if __name__ == "__main__":
    unittest.main()
