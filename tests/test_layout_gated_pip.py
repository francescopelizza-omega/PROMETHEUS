# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""An isolated tool's python dependencies go through the gate, like everything else it fetches.

`_install_into_layout` gated the git tree and then ran `pip install -r requirements` — the whole
transitive closure from PyPI, source packages BUILT (their setup.py executed) before anything was
scanned, every failure ignored. `_gated_pip_install` stages wheels only, gates the staged bytes,
and installs exactly those offline; any failure stops the install.
"""
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import prometheus as p  # noqa: E402


class GatedLayoutPip(unittest.TestCase):
    def setUp(self) -> None:
        self.calls: list[list[str]] = []
        self.gate_answer = True
        self._run, self._gate = p.run, p.enforce_gate

        def fake_run(cmd, check=True, timeout=None):
            self.calls.append(list(cmd))
            return CompletedProcess(cmd, 0, "", "")

        def fake_gate(target, label, tier="default", stdin_text=None):
            self.calls.append(["GATE", target])
            return self.gate_answer

        p.run, p.enforce_gate = fake_run, fake_gate

    def tearDown(self) -> None:
        p.run, p.enforce_gate = self._run, self._gate

    def test_download_wheels_then_gate_then_offline_install(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            ok = p._gated_pip_install("pip", ["somepkg"], Path(d) / "wheels", "t deps")
            self.assertTrue(ok)
            self.assertEqual(self.calls[0][:2], ["pip", "download"])
            self.assertIn("--only-binary=:all:", self.calls[0])
            self.assertNotIn("--no-deps", self.calls[0], "the WHOLE closure is staged and scanned")
            self.assertEqual(self.calls[1][0], "GATE")
            self.assertEqual(self.calls[2][:2], ["pip", "install"])
            self.assertIn("--no-index", self.calls[2])

    def test_a_refused_gate_installs_nothing(self) -> None:
        self.gate_answer = False
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(p._gated_pip_install("pip", ["x"], Path(d) / "w", "t"))
            self.assertFalse(any(c[:2] == ["pip", "install"] for c in self.calls))

    def test_requirements_that_bypass_the_gate_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            for line in ["-e .", "git+https://x/y.git", "pkg @ https://x/y.whl", "file:./local"]:
                req = Path(d) / "requirements.txt"
                req.write_text(f"numpy\n{line}\n")
                self.calls.clear()
                ok = p._gated_pip_install("pip", ["-r", str(req)], Path(d) / "w", "t")
                self.assertFalse(ok, msg=line)
                self.assertEqual(self.calls, [], msg=f"nothing may run for {line!r}")
            req.write_text("numpy==2.2.6  # pinned\n--extra-index-url https://download.pytorch.org/whl/cpu\n")
            self.assertTrue(p._gated_pip_install("pip", ["-r", str(req)], Path(d) / "w", "t"))


if __name__ == "__main__":
    unittest.main()
