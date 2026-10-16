#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_launcher_root.py — `sudo prometheus …` never rebuilds the checkout as root.

The launcher rebuilds the CLI bundle with pnpm when the sources are newer than it. Run through
`sudo prometheus disk-space`, that rebuild would run as ROOT inside the user's checkout and leave
root-owned `node_modules` and `dist/` behind, which the user's next ordinary run cannot replace.
As root it refuses a stale bundle (it predates the current sources) and says how to rebuild.

A throwaway copy of the launcher runs against a fake checkout, with fake `id`, `pnpm` and `node`
on PATH, so nothing here needs root or touches the real tree.

Run: python3 tests/test_launcher_root.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

LAUNCHER = Path(__file__).resolve().parent.parent / "bin" / "prometheus"


def _exe(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o755)


class LauncherRoot(unittest.TestCase):
    def run_as(self, uid: int) -> tuple[subprocess.CompletedProcess, Path, Path]:
        tmp = Path(tempfile.mkdtemp(prefix="prom-launch-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        (tmp / "bin").mkdir()
        shutil.copy(LAUNCHER, tmp / "bin" / "prometheus")
        dist = tmp / "studio" / "apps" / "cli" / "dist"
        src = tmp / "studio" / "apps" / "cli" / "src"
        dist.mkdir(parents=True)
        src.mkdir(parents=True)
        (dist / "bin.js").write_text("")
        old = time.time() - 3600
        os.utime(dist / "bin.js", (old, old))
        (src / "edited.ts").write_text("")  # newer than the bundle: stale
        fake = tmp / "fake"
        fake.mkdir()
        marker = tmp / "pnpm-ran"
        _exe(fake / "id", f'#!/bin/sh\n[ "$1" = "-u" ] && {{ echo {uid}; exit 0; }}\nexec /usr/bin/id "$@"\n')
        _exe(fake / "pnpm", f'#!/bin/sh\necho "$*" >> "{marker}"\n')
        _exe(fake / "node", '#!/bin/sh\n[ "$1" = "--version" ] && { echo v22.9.0; exit 0; }\necho "NODE-RAN $*"\n')
        env = {
            "PATH": f"{fake}:/usr/bin:/bin",
            "HOME": str(tmp / "home"),
            "PROMETHEUS_TOOLCHAIN": str(tmp / "tc"),
            "PROMETHEUS_NODE": str(fake / "node"),
        }
        p = subprocess.run([str(tmp / "bin" / "prometheus"), "disk-space"], capture_output=True,
                           text=True, env=env, timeout=60, stdin=subprocess.DEVNULL)
        return p, marker, tmp

    def test_root_neither_rebuilds_nor_runs_a_stale_bundle(self) -> None:
        # a stale bundle predates the current sources — including whatever keeps a root run's
        # state out of the user's home — so running it as root is refused, with the remedy
        p, marker, _ = self.run_as(0)
        self.assertFalse(marker.exists(), "pnpm ran as root inside the user's checkout")
        self.assertNotIn("NODE-RAN", p.stdout, "a stale bundle ran as root")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("as root", p.stderr)
        self.assertIn("as yourself", p.stderr)

    def test_a_normal_user_still_rebuilds(self) -> None:
        p, marker, _ = self.run_as(501)
        self.assertTrue(marker.exists(), p.stderr)


if __name__ == "__main__":
    unittest.main()
