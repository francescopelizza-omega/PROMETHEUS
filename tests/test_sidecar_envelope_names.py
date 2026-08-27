#!/usr/bin/env python3
"""test_sidecar_envelope_names.py — a sidecar's `command` must identify the verb UNAMBIGUOUSLY.

`command` exists so a consumer can tell one envelope from another. `repo.py` emitted bare verb
names (`list`, `rescan`, `pin`, …) while its sibling sidecars namespace theirs (`env.list`,
`pkg.list`, `cuda.info` in envmgr.py; `model.list`, `model.search` in modelhub.py). So:

    prometheus list --json       → {"command": "list", "catalog": [...]}
    prometheus repo list --json  → {"command": "list", "repos": [...]}

Two completely different payloads under one label — the field could not do its job. Measured
through the built CLI binary.

Run: python3 tests/test_sidecar_envelope_names.py."""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "studio" / "python" / "sidecar"


class TestRepoEnvelopeNames(unittest.TestCase):
    def _run(self, *argv):
        home = tempfile.mkdtemp(prefix="prom-env-names-")
        p = subprocess.run(
            [sys.executable, str(SIDECAR / "repo.py"), *argv],
            capture_output=True, text=True, timeout=120,
            env={**dict(__import__("os").environ), "PROMETHEUS_HOME": home},
        )
        line = [l for l in p.stdout.strip().splitlines() if l.strip()][-1]
        return json.loads(line)

    def test_every_repo_envelope_is_namespaced(self):
        cases = [
            (("list",), "repo.list"),
            (("rescan", "--id", "no-such"), "repo.rescan"),
            (("pin", "--id", "no-such", "--sha", "abc"), "repo.pin"),
            (("branch", "--id", "no-such", "--branch", "main"), "repo.branch"),
            (("update", "--id", "no-such"), "repo.update"),
            (("remove",), "repo.remove"),
            (("clone",), "repo.clone"),
        ]
        for argv, expected in cases:
            env = self._run(*argv)
            self.assertEqual(
                env["command"], expected,
                f"repo.py {argv[0]} reported {env['command']!r}, which does not identify the verb",
            )

    def test_no_bare_verb_names_remain_in_the_source(self):
        """A new verb added later must not reintroduce a bare label."""
        src = (SIDECAR / "repo.py").read_text()
        bare = sorted(set(re.findall(r'(?:emit|fail)\("([a-z][a-z-]*)"', src)))
        self.assertEqual(
            bare, [],
            f"these envelopes are not namespaced and can collide with another verb: {bare}",
        )

    def test_the_sibling_sidecars_already_do_this(self):
        """Self-validating: the convention being matched is real, not invented here."""
        envmgr = (SIDECAR / "envmgr.py").read_text()
        modelhub = (SIDECAR / "modelhub.py").read_text()
        self.assertIn('emit("env.list"', envmgr)
        self.assertIn('emit("pkg.list"', envmgr)
        self.assertIn('emit("model.list"', modelhub)


if __name__ == "__main__":
    unittest.main()
