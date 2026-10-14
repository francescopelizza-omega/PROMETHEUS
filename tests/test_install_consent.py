#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_install_consent.py — install.sh shows the human EXACTLY the command it then runs.

Prometheus's rule for privileged commands is "shown verbatim, run only as shown". The installer
asks before it uses the system package manager, so the line in that question must be the line
that runs — the same elevator (sudo, doas, or none when already root), the same environment, the
same arguments. It used to show `sudo apt-get …` and then run `env DEBIAN_FRONTEND=… apt-get …`
through whichever elevator it found (doas included), which is a different command.

The real functions are lifted out of install.sh and run under sh with the system stubbed:
`run` records what would execute and `allow_system` records what was shown. Nothing installs.

Run: python3 tests/test_install_consent.py
"""
from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

INSTALL = Path(__file__).resolve().parent.parent / "install.sh"
FUNCS = ("pkg_name", "pkg_cmd", "root_prefix", "detect_pm", "pkg_install")


def lift(src: str, name: str) -> str:
    m = re.search(rf"^{name}\(\) \{{.*?^\}}\n", src, re.S | re.M)
    if not m:  # a one-line definition
        m = re.search(rf"^{name}\(\) \{{[^\n]*\}}\n", src, re.M)
    return m.group(0) if m else ""


def scenario(pm: str, uid: str, sudo: bool, doas: bool) -> tuple[list[str], list[str]]:
    src = INSTALL.read_text()
    stubs = f"""
find_cmd() {{
  case $1 in
  sudo) {"echo /usr/bin/sudo" if sudo else "return 1"} ;;
  doas) {"echo /usr/bin/doas" if doas else "return 1"} ;;
  {pm}) echo /usr/bin/{pm} ;;
  *) return 1 ;;
  esac
}}
id() {{ echo {uid}; }}
run() {{ printf 'RUN:%s\\n' "$*"; }}
step() {{ :; }}
warn() {{ :; }}
allow_system() {{ printf 'SHOWN:%s\\n' "$2"; return 0; }}
SYSTEM_DEPS=yes
"""
    body = "\n".join(lift(src, f) for f in FUNCS)
    script = stubs + body + '\npkg_install "git, for the source checkout" git\n'
    out = subprocess.run(["sh", "-c", script], capture_output=True, text=True, timeout=30).stdout
    shown = [ln[6:] for ln in out.splitlines() if ln.startswith("SHOWN:")]
    ran = [ln[4:] for ln in out.splitlines() if ln.startswith("RUN:")]
    return shown, ran


class Consent(unittest.TestCase):
    def check(self, pm: str, uid: str = "1000", sudo: bool = True, doas: bool = False) -> None:
        shown, ran = scenario(pm, uid, sudo, doas)
        self.assertEqual(len(shown), 1, (shown, ran))
        self.assertTrue(ran, "nothing ran")
        self.assertEqual(shown[0], " && ".join(ran), f"{pm} uid={uid} sudo={sudo} doas={doas}")

    def test_apt_through_sudo(self):
        self.check("apt-get")

    def test_apt_through_doas_when_there_is_no_sudo(self):
        self.check("apt-get", sudo=False, doas=True)
        shown, _ = scenario("apt-get", "1000", False, True)
        self.assertIn("/usr/bin/doas", shown[0])

    def test_already_root_shows_no_elevator(self):
        self.check("apk", uid="0")
        shown, _ = scenario("apk", "0", True, False)
        self.assertNotIn("sudo", shown[0])

    def test_the_other_managers(self):
        for pm in ("dnf", "zypper", "pacman", "apk", "pkg", "xbps-install"):
            with self.subTest(pm=pm):
                self.check(pm)

    def test_no_elevator_at_all_installs_nothing(self):
        shown, ran = scenario("apt-get", "1000", False, False)
        self.assertEqual(ran, [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
