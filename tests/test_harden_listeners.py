#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_harden_listeners.py — `harden`'s "listening on ALL interfaces" check.

The check used to substring-search the whole line for "0.0.0.0", "*:" or ":::". `ss -tlnp`
prints a Peer Address:Port column that is `0.0.0.0:*` (or `*:*` on older iproute2) for EVERY
IPv4 LISTEN socket, so every loopback-bound service was reported as public; and a genuinely
public IPv6 listener renders as `[::]:8080`, which matches none of those needles, so it was
silently missed. `harden` is a defensive-posture verb whose output the user (and the
`prometheus_harden` MCP consumer) act on, so it was wrong in both directions.

Pure stdlib (unittest). Run: python3 tests/test_harden_listeners.py."""
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_prometheus():
    spec = importlib.util.spec_from_file_location("prometheus_mod_harden", ROOT / "prometheus.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


P = _load_prometheus()

# Real `ss -tlnp` shape, including the header row and both peer-column dialects.
SS = """State  Recv-Q Send-Q Local Address:Port   Peer Address:Port  Process
LISTEN 0      128    127.0.0.1:6379       0.0.0.0:*          users:(("redis-server",pid=1,fd=6))
LISTEN 0      4096   127.0.0.1:5432       0.0.0.0:*          users:(("postgres",pid=2,fd=5))
LISTEN 0      128    127.0.0.1:6379       *:*
LISTEN 0      4096   [::1]:7000           [::]:*
LISTEN 0      4096   0.0.0.0:9090         0.0.0.0:*          users:(("prom",pid=3,fd=7))
LISTEN 0      4096   [::]:8080            [::]:*             users:(("svc",pid=4,fd=9))
LISTEN 0      4096   *:8443               *:*
"""

# Real `lsof -nP -iTCP -sTCP:LISTEN` shape.
LSOF = """COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node       1   fp  20u  IPv4    0x1      0t0  TCP *:8080 (LISTEN)
redis      2   fp   6u  IPv4    0x2      0t0  TCP 127.0.0.1:6379 (LISTEN)
svc        3   fp   7u  IPv6    0x3      0t0  TCP [::]:9000 (LISTEN)
svc        4   fp   8u  IPv6    0x4      0t0  TCP [::1]:9001 (LISTEN)
"""


def _locals(rows, tool):
    """The LOCAL address of each flagged row — what the check is supposed to judge on."""
    return [r.split()[3] if tool == "ss" else r.split()[-2] for r in rows]


class TestPublicListeners(unittest.TestCase):
    def test_ss_peer_column_does_not_make_a_loopback_listener_public(self):
        flagged = _locals(P._public_listeners(SS, "ss"), "ss")
        # the loopback rows must NOT be here even though their PEER column reads 0.0.0.0:* / *:*
        self.assertNotIn("127.0.0.1:6379", flagged)
        self.assertNotIn("127.0.0.1:5432", flagged)
        self.assertNotIn("[::1]:7000", flagged)
        # …and the genuinely public ones must ALL be here, IPv6 included
        self.assertEqual(sorted(flagged), sorted(["0.0.0.0:9090", "[::]:8080", "*:8443"]))

    def test_ipv6_wildcard_is_not_missed_by_lsof_either(self):
        flagged = _locals(P._public_listeners(LSOF, "lsof"), "lsof")
        self.assertEqual(sorted(flagged), sorted(["*:8080", "[::]:9000"]))

    def test_a_loopback_only_host_reaches_the_ok_branch(self):
        loopback_only = "\n".join(SS.splitlines()[:5]) + "\n"
        self.assertEqual(P._public_listeners(loopback_only, "ss"), [])

    def test_header_and_junk_rows_are_ignored_without_raising(self):
        self.assertEqual(P._public_listeners("", "ss"), [])
        self.assertEqual(P._public_listeners("Netid State\n\n   \n", "ss"), [])
        self.assertEqual(P._public_listeners("(LISTEN)\n", "lsof"), [])
        # a non-LISTEN ss row (e.g. from `ss -tan`) is not a listener at all
        self.assertEqual(P._public_listeners("ESTAB 0 0 0.0.0.0:22 1.2.3.4:5\n", "ss"), [])

    def test_listen_host_splits_ipv6_brackets_from_the_port(self):
        self.assertEqual(P._listen_host("[::]:8080"), "[::]")
        self.assertEqual(P._listen_host("[::1]:8080"), "[::1]")
        self.assertEqual(P._listen_host("0.0.0.0:9090"), "0.0.0.0")
        self.assertEqual(P._listen_host("*:8443"), "*")
        self.assertEqual(P._listen_host("127.0.0.1:6379"), "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
