#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_lai_consent.py — studio/lai.sh never runs sudo without showing the command and a yes.

It used to set SUDO=sudo whenever /usr/local/bin was not writable and then run `sudo cp`,
`sudo chmod` and `sudo mv` without asking. Every privileged step now goes through `admin`, which
prints the exact command and asks on the terminal (Enter, anything but y, or no terminal = no).

Run: python3 tests/test_lai_consent.py
"""
from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

LAI = Path(__file__).resolve().parent.parent / "studio" / "lai.sh"


def lift(src: str, name: str) -> str:
    m = re.search(rf"^{name}\(\) \{{.*?^\}}\n", src, re.S | re.M)
    if not m:
        m = re.search(rf"^{name}\(\) \{{[^\n]*\}}\n", src, re.M)
    return m.group(0) if m else ""


def run_admin(sudo_var: str) -> str:
    src = LAI.read_text()
    script = (
        "say() { printf 'SAY:%s\\n' \"$*\"; }\n"
        "sudo() { printf 'SUDO-RAN:%s\\n' \"$*\"; }\n"
        "cp() { printf 'CP-RAN:%s\\n' \"$*\"; }\n"
        + lift(src, "quote") + lift(src, "admin")
        + f'SUDO="{sudo_var}"\nadmin cp "/tmp/x y" /usr/local/bin/local-ai.new || echo DECLINED\n'
    )
    # setsid: no controlling terminal, so there is nobody to ask
    p = subprocess.run(["setsid", "sh", "-c", script] if Path("/usr/bin/setsid").exists() else ["sh", "-c", script],
                       capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL, start_new_session=True)
    return p.stdout


class LaiConsent(unittest.TestCase):
    def test_without_sudo_the_step_just_runs_as_you(self):
        out = run_admin("")
        self.assertIn("CP-RAN:/tmp/x y /usr/local/bin/local-ai.new", out)

    def test_with_sudo_and_nobody_to_ask_nothing_runs_and_the_command_is_shown(self):
        out = run_admin("sudo")
        self.assertNotIn("SUDO-RAN", out)
        self.assertIn("DECLINED", out)
        self.assertIn("sudo cp '/tmp/x y' /usr/local/bin/local-ai.new", out)

    def test_no_privileged_step_bypasses_admin(self):
        src = LAI.read_text()
        body = "\n".join(
            ln for ln in src.replace(lift(src, "admin"), "").splitlines() if not ln.lstrip().startswith("#")
        )
        self.assertNotRegex(body, r"\$SUDO\s+\w")
        self.assertNotRegex(body, r"^\s*sudo\s", "a bare sudo call outside admin()")


if __name__ == "__main__":
    unittest.main(verbosity=1)
