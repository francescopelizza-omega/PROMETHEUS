#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""pty_host.py — run one command on a pseudo-terminal, relayed over plain pipes.

    pty_host.py COLS ROWS -- ARGV...

The Prometheus CLI has no native PTY addon, yet `/disk-space` hosts a curses program it must be
able to hide and show again without stopping it. This stdlib relay is the missing piece:

  * the child runs on a real pty, so curses works and believes it owns a terminal;
  * our stdin  → the pty master (keystrokes, byte for byte);
  * the master → our stdout (screen bytes, byte for byte);
  * fd 3, when open, carries control lines — ``resize COLS ROWS`` sets the pty's window size,
    and the kernel then delivers SIGWINCH to the child, which is also how a hidden program is
    made to repaint when it is shown again;
  * SIGTERM / SIGHUP / SIGINT sent to this process are forwarded to the child;
  * the exit code is the child's (128 + N when a signal ended it).

Nothing is interpreted, logged or kept: this process only moves bytes.
"""
from __future__ import annotations

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd: int, data: bytes) -> None:
    while data:
        try:
            n = os.write(fd, data)
        except InterruptedError:
            continue
        data = data[n:]


def usage() -> int:
    sys.stderr.write("usage: pty_host.py COLS ROWS -- ARGV...\n")
    return 2


def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[2] != "--":
        return usage()
    try:
        cols, rows = max(1, int(argv[0])), max(1, int(argv[1]))
    except ValueError:
        return usage()
    cmd = argv[3:]

    pid, master = pty.fork()
    if pid == 0:  # the child: the pty slave is its stdin/stdout/stderr
        try:
            set_size(0, cols, rows)
            os.execvp(cmd[0], cmd)
        except OSError as exc:
            os.write(2, f"pty_host: cannot run {cmd[0]}: {exc}\n".encode())
        os._exit(127)

    def forward(sig, _frame) -> None:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, forward)

    try:
        os.fstat(3)
        ctl = 3
    except OSError:
        ctl = -1
    ctl_buf = b""
    stdin_open = True

    while True:
        fds = [master] + ([0] if stdin_open else []) + ([ctl] if ctl >= 0 else [])
        try:
            ready, _, _ = select.select(fds, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as exc:
                if exc.errno in (errno.EIO, errno.EBADF):  # the slave closed: the child is gone
                    break
                raise
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if data:
                write_all(master, data)
            else:
                stdin_open = False
        if ctl >= 0 and ctl in ready:
            data = os.read(ctl, 4096)
            if not data:
                ctl = -1
                continue
            ctl_buf += data
            while b"\n" in ctl_buf:
                line, ctl_buf = ctl_buf.split(b"\n", 1)
                parts = line.decode("ascii", "replace").split()
                if len(parts) == 3 and parts[0] == "resize":
                    try:
                        set_size(master, max(1, int(parts[1])), max(1, int(parts[2])))
                    except (ValueError, OSError):
                        pass

    while True:
        try:
            _, status = os.waitpid(pid, 0)
            break
        except InterruptedError:
            continue
        except ChildProcessError:
            return 0
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
