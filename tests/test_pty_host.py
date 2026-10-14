#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_pty_host.py — the stdlib pseudo-terminal relay behind the `/disk-space` overlay.

pty_host.py lets the CLI (which has no native PTY addon) host a curses program it can hide and
show again: the program believes it owns a terminal, keystrokes arrive on its stdin, its screen
arrives on our stdout, and "resize COLS ROWS" lines on fd 3 resize it (the kernel then sends it
SIGWINCH — which is also how a minimised overlay gets the program to repaint).

Run: python3 tests/test_pty_host.py
"""
from __future__ import annotations

import os
import select
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path

_OPEN: list = []

HOST = Path(__file__).resolve().parent.parent / "studio" / "python" / "tools" / "pty_host.py"


def start(child_code: str, cols: int = 100, rows: int = 30):
    """Launch pty_host with a python child; fd 3 of the host is a control pipe we write to."""
    ctl_r, ctl_w = os.pipe()

    def hand_ctl():
        os.dup2(ctl_r, 3)

    p = subprocess.Popen(
        [sys.executable, str(HOST), str(cols), str(rows), "--", sys.executable, "-u", "-c", child_code],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        preexec_fn=hand_ctl, pass_fds=(ctl_r,),
    )
    os.close(ctl_r)
    _OPEN.append(p)
    return p, ctl_w


def read_until(p, needle: bytes, timeout: float = 10.0) -> bytes:
    buf = b""
    end = time.time() + timeout
    fd = p.stdout.fileno()
    while time.time() < end and needle not in buf:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            buf += chunk
    return buf


class PtyHost(unittest.TestCase):
    def tearDown(self) -> None:
        while _OPEN:
            p = _OPEN.pop()
            if p.poll() is None:
                p.kill()
                p.wait(timeout=10)
            for f in (p.stdin, p.stdout, p.stderr):
                if f:
                    f.close()

    def test_the_child_owns_a_terminal_of_the_requested_size(self):
        p, ctl = start("import os; print('TTY', os.isatty(0), os.get_terminal_size(0))", 100, 30)
        out = read_until(p, b"lines=30")
        os.close(ctl)
        p.wait(timeout=10)
        self.assertIn(b"TTY True", out)
        self.assertIn(b"columns=100", out)
        self.assertEqual(p.returncode, 0)

    def test_keystrokes_reach_the_child(self):
        p, ctl = start("s = input(); print('GOT', s[::-1])")
        p.stdin.write(b"abc\r")
        p.stdin.flush()
        out = read_until(p, b"GOT cba")
        os.close(ctl)
        p.wait(timeout=10)
        self.assertIn(b"GOT cba", out)

    def test_a_resize_line_on_fd3_resizes_and_signals_the_child(self):
        code = (
            "import os, signal, sys, time\n"
            "signal.signal(signal.SIGWINCH, lambda *a: print('WINCH', os.get_terminal_size(0), flush=True))\n"
            "print('ready', flush=True)\n"
            "time.sleep(8)\n"
        )
        p, ctl = start(code)
        read_until(p, b"ready")
        os.write(ctl, b"resize 90 20\n")
        out = read_until(p, b"lines=20")
        p.terminate()
        os.close(ctl)
        p.wait(timeout=10)
        self.assertIn(b"columns=90", out)

    def test_sigterm_to_the_host_ends_the_child(self):
        p, ctl = start("import time; print('up', flush=True); time.sleep(30)")
        read_until(p, b"up")
        t0 = time.time()
        p.send_signal(signal.SIGTERM)
        p.wait(timeout=10)
        os.close(ctl)
        self.assertLess(time.time() - t0, 5)
        self.assertNotEqual(p.returncode, 0)

    def test_the_exit_code_is_the_childs(self):
        p, ctl = start("raise SystemExit(7)")
        p.wait(timeout=10)
        os.close(ctl)
        self.assertEqual(p.returncode, 7)

    def test_bad_arguments_fail_fast(self):
        r = subprocess.run([sys.executable, str(HOST), "x", "y"], capture_output=True, timeout=10)
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
