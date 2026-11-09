# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""Every `--json` run puts exactly ONE JSON object on stdout — refusals included.

Handlers refuse bad input with `Log.err(...); return 2`, which writes only to stderr. Under
--json that left stdout empty, and the engine bridge / MCP server reported "prometheus.py
produced no JSON" instead of the reason (`models install` with no id, an unknown app, an
unknown service, `services cap` without a size, …). main() now emits the envelope itself when
a handler returned without writing one, carrying the last error line.
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent / "prometheus.py"


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(ENGINE), "--json", *args],
                          capture_output=True, text=True, timeout=120)


class FallbackEnvelope(unittest.TestCase):
    CASES = [
        (("models", "install"), "models", "install", "usage: models install"),
        (("apps", "logs", "zz-not-an-app"), "apps", "logs", "unknown app"),
        (("worldsim", "install"), "worldsim", "install", "usage: worldsim install"),
        (("services", "stop", "zz-not-a-service"), "services", "stop", "zz-not-a-service"),
        (("services", "cap", "zz-not-a-service"), "services", "cap", "usage: services cap"),
    ]

    def test_refusals_emit_one_envelope_with_the_reason(self) -> None:
        for argv, command, action, needle in self.CASES:
            with self.subTest(argv=argv):
                proc = _run(*argv)
                lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
                self.assertEqual(len(lines), 1, msg=f"stdout: {proc.stdout!r}")
                env = json.loads(lines[0])
                self.assertEqual(env["command"], command)
                self.assertEqual(env.get("action"), action)
                self.assertFalse(env["ok"])
                self.assertEqual(proc.returncode, 2)
                self.assertIn(needle, env["error"])

    def test_a_handler_that_emits_is_not_doubled(self) -> None:
        proc = _run("describe", "zz-not-a-tool")
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, msg=proc.stdout)
        self.assertFalse(json.loads(lines[0])["ok"])


if __name__ == "__main__":
    unittest.main()
