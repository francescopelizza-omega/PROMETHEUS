#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_disk_space_e2e.py — the disk-space TUIs driven through a REAL pseudo-terminal.

Every other disk-space test replaces the terminal, the child or the clock. These run the real
CLI from source on a real pty, the real `pty_host.py` relay and the real `disk_space.py` curses
TUI, and press the real keys:

  * `prometheus disk-space DIR` straight from a shell: the tool takes the screen; Ctrl+] is its
    own key (nothing to minimise to); Ctrl+D ends it; Prometheus exits 0 and leaves the
    alternate screen.
  * `/disk-space DIR` inside the full Prometheus TUI (opt-in, PROMETHEUS_E2E_TUI=1 — it boots
    the whole session): the overlay opens, Ctrl+] minimises it, Ctrl+] resumes it, Ctrl+D ends it.

Nothing here can reach a model. The environment is built from scratch: a temporary HOME and
PROMETHEUS_HOME, no API-key variables, every local runner pointed at a closed port, a PATH with
no `ollama` or `lms` (so nothing autostarts) and a `security` that finds no keychain entry.

Run: python3 tests/test_disk_space_e2e.py
     PROMETHEUS_E2E_TUI=1 python3 tests/test_disk_space_e2e.py
"""
from __future__ import annotations

import os
import pty
import re
import select
import shutil
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CLI = REPO / "studio" / "apps" / "cli"
NODE = shutil.which("node")
CTRL_D = b"\x04"
CTRL_RB = b"\x1d"
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_=>]")


def _exe(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o755)


class Pty:
    """One child on a real pty, with a growing transcript and an expect()."""

    def __init__(self, argv: list[str], env: dict[str, str], cwd: str, cols: int = 120, rows: int = 36):
        self.out = b""
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            import fcntl, struct, termios  # noqa: E401 — child only
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.execve(argv[0], argv, env)
        self.pid, self.fd = pid, fd
        self.status: int | None = None

    def pump(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                self.out += data

    def text(self) -> str:
        return ANSI.sub(b"", self.out).decode("utf-8", "replace")

    def expect(self, pattern: bytes | str, timeout: float, since: int = 0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            hay = self.out[since:] if isinstance(pattern, bytes) else self.text()
            if (pattern in hay) if isinstance(pattern, bytes) else re.search(pattern, hay):
                return True
            self.pump(0.2)
        return False

    def send(self, data: bytes) -> None:
        os.write(self.fd, data)

    def alive(self) -> bool:
        if self.status is not None:
            return False
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        if pid == 0:
            return True
        self.status = status
        return False

    def wait(self, timeout: float) -> int | None:
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.1)
            if not self.alive():
                return os.waitstatus_to_exitcode(self.status)  # type: ignore[arg-type]
        return None

    def kill(self) -> None:
        if self.alive():
            os.kill(self.pid, signal.SIGKILL)  # this child's pid only — never a group
            self.wait(5)
        try:
            os.close(self.fd)
        except OSError:
            pass


def offline_env(tmp: Path) -> dict[str, str]:
    fake = tmp / "fakebin"
    fake.mkdir()
    # macOS keychain lookups go through `security`: this one finds nothing (exit 44 = not found)
    _exe(fake / "security", "#!/bin/sh\nexit 44\n")
    home = tmp / "home"
    home.mkdir()
    dead = "http://127.0.0.1:9/v1"
    return {
        "HOME": str(home),
        "PROMETHEUS_HOME": str(home / ".prometheus"),
        "PATH": f"{fake}:/usr/bin:/bin",
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
        "PROMETHEUS_PY": str(REPO / "prometheus.py"),
        "NEMESIS_BIN": str(REPO / "nemesis"),
        "PROMETHEUS_PYTHON": sys.executable,
        "PROMETHEUS_RUNNER_OLLAMA_URL": dead,
        "PROMETHEUS_RUNNER_LMSTUDIO_URL": dead,
        "PROMETHEUS_RUNNER_LLAMACPP_URL": dead,
        "PROMETHEUS_RUNNER_VLLM_URL": dead,
        "NO_COLOR": "",
    }


def sample_tree(tmp: Path) -> Path:
    root = tmp / "e2e-disk"
    for sub, size in (("big-folder", 3 << 20), ("small-folder", 64 << 10)):
        (root / sub).mkdir(parents=True)
        (root / sub / "data.bin").write_bytes(b"\0" * size)
    return root


def cli_argv(*args: str) -> list[str]:
    return [str(NODE), "--import", str(CLI / "dev-register.mjs"), str(CLI / "src" / "bin.ts"), *args]


@unittest.skipUnless(NODE and (REPO / "studio" / "node_modules").is_dir(), "needs node and studio/node_modules")
class OneShot(unittest.TestCase):
    def test_disk_space_from_the_shell_runs_full_screen_and_ctrl_d_exits_prometheus(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="prom-e2e-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        tree = sample_tree(tmp)
        p = Pty(cli_argv("disk-space", str(tree)), offline_env(tmp), str(tmp))
        self.addCleanup(p.kill)
        self.assertTrue(p.expect(b"\x1b[?1049h", 60), "the tool never took the screen:\n" + p.text()[-2000:])
        self.assertTrue(p.expect(r"big-folder", 60), "the map of DIR never drew:\n" + p.text()[-2000:])
        mark = len(p.out)
        p.send(CTRL_RB)  # the tool's own key here — nothing to minimise to
        p.pump(1.0)
        self.assertTrue(p.alive(), "Ctrl+] ended a one-shot run")
        self.assertNotIn(b"\x1b[?1049l", p.out[mark:], "Ctrl+] left the tool's screen")
        p.send(CTRL_D)
        code = p.wait(15)
        self.assertEqual(code, 0, "Prometheus did not exit cleanly after Ctrl+D:\n" + p.text()[-2000:])
        self.assertIn(b"\x1b[?1049l", p.out[mark:], "the alternate screen was not left")


@unittest.skipUnless(os.environ.get("PROMETHEUS_E2E_TUI") == "1", "opt-in: PROMETHEUS_E2E_TUI=1")
@unittest.skipUnless(NODE and (REPO / "studio" / "node_modules").is_dir(), "needs node and studio/node_modules")
class Overlay(unittest.TestCase):
    def test_overlay_minimise_resume_terminate(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="prom-e2e-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        tree = sample_tree(tmp)
        p = Pty(cli_argv(), offline_env(tmp), str(tmp))
        self.addCleanup(p.kill)
        p.pump(25)  # the session boots: onboarding, model discovery against closed ports
        boot = p.text()
        p.send(f"/disk-space {tree}".encode())
        p.pump(0.5)
        p.send(b"\r")
        self.assertTrue(p.expect(r"big-folder", 60), "the overlay never drew the map:\n" + boot[-1500:] + "\n----\n" + p.text()[-2500:])
        mark = len(p.out)
        p.send(CTRL_RB)
        self.assertTrue(p.expect(b"\x1b[?1049l", 10, since=mark), "Ctrl+] did not hand the screen back")
        self.assertTrue(p.expect(r"minimi[sz]ed", 10), "no notice that it is still running")
        mark = len(p.out)
        p.send(CTRL_RB)
        self.assertTrue(p.expect(b"\x1b[?1049h", 10, since=mark), "Ctrl+] at the prompt did not resume it")
        mark = len(p.out)
        p.send(CTRL_D)
        self.assertTrue(p.expect(b"\x1b[?1049l", 15, since=mark), "Ctrl+D did not end it")
        self.assertTrue(p.alive(), "ending the tool must not end the session")


if __name__ == "__main__":
    unittest.main()
