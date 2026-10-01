# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""`$PROMETHEUS_CONFIG_DIR` must redirect the engine's OWN config dir.

Regression for: the engine had no config-dir override at all, so `PROM_DIR` always resolved
to the real `~/.config/prometheus`. Running the test suite therefore overwrote the user's
genuine `last-crash.log` (the crash-guard test raises on purpose), and there was no way to
point a probe or a sandbox anywhere else.

The subprocess below gets BOTH a fake HOME and a separate PROMETHEUS_CONFIG_DIR so the
assertion distinguishes the two: without the override the crash log lands under the fake
HOME; with it, under the explicit dir. Neither is the real user's dir — proving the bug
must never re-inflict it.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "prometheus.py"

_PROBE = """
import prometheus as p
p.cmd_doctor = lambda *a, **k: (_ for _ in ()).throw(ValueError("boom"))
rc = p.main(["doctor"])
import json
print("@@" + json.dumps({
    "rc": rc,
    "prom_dir": str(p.PROM_DIR),
    "skills": str(p.PROMETHEUS_SKILLS_DIR),
    "trust": str(p.TRUST_FILE),
    "url_pin_lock": str(p._URL_PIN_LOCK),
    "session_report": str(p.SESSION_REPORT),
    "purge": str(p.PURGE_DIR),
    "config": str(p.PROM_CONFIG),
}))
"""


def _run(env_extra):
    env = dict(os.environ)
    env.pop("PROMETHEUS_CONFIG_DIR", None)
    env.update(env_extra)
    out = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=180,
    )
    line = next((l for l in out.stdout.splitlines() if l.startswith("@@")), None)
    assert line, f"probe produced no payload:\nSTDOUT{out.stdout}\nSTDERR{out.stderr}"
    return json.loads(line[2:])


class TestConfigDirIsolation(unittest.TestCase):
    def test_override_redirects_every_derived_path(self):
        with tempfile.TemporaryDirectory() as fake_home, tempfile.TemporaryDirectory() as cfg:
            data = _run({"HOME": fake_home, "PROMETHEUS_CONFIG_DIR": cfg})
            self.assertEqual(data["rc"], 1)  # crash guard still returns cleanly
            # every constant derived from the config dir follows the override — a fifth
            # copy of the literal would show up here as a path under the fake HOME.
            for key in ("prom_dir", "skills", "trust", "url_pin_lock",
                        "session_report", "purge", "config"):
                self.assertTrue(
                    data[key].startswith(cfg),
                    f"{key} escaped the override: {data[key]}",
                )
            self.assertTrue(
                (Path(cfg) / "last-crash.log").exists(),
                "crash guard did not write into the overridden dir",
            )
            self.assertFalse(
                (Path(fake_home) / ".config" / "prometheus" / "last-crash.log").exists(),
                "crash guard wrote into HOME despite PROMETHEUS_CONFIG_DIR",
            )

    def test_default_is_the_one_prometheus_home(self):
        """ONE HOME: with no override and no legacy dir, the engine lives in ~/.prometheus/config.

        It used to resolve to `~/.config/prometheus` — a THIRD root beside `~/.prometheus`
        (sessions, cache, logs, models) and the Studio's `~/.config/prometheus-studio`. Three
        directories for one product is why "where does Prometheus keep my settings" had no
        answer.
        """
        with tempfile.TemporaryDirectory() as fake_home:
            data = _run({"HOME": fake_home, "PROMETHEUS_HOME": ""})
            self.assertEqual(data["prom_dir"], str(Path(fake_home) / ".prometheus" / "config"))

    def test_prometheus_home_sandboxes_the_engine_too(self):
        """$PROMETHEUS_HOME moves the engine with everything else.

        The engine ignored it outright, so the one variable that is supposed to sandbox the
        whole product moved the Studio's trees and left the engine writing to the real home.
        """
        with tempfile.TemporaryDirectory() as fake_home, tempfile.TemporaryDirectory() as ph:
            data = _run({"HOME": fake_home, "PROMETHEUS_HOME": ph})
            self.assertEqual(data["prom_dir"], str(Path(ph) / "config"))
            for key in ("skills", "trust", "url_pin_lock", "session_report", "purge", "config"):
                self.assertTrue(
                    data[key].startswith(ph),
                    f"{key} escaped $PROMETHEUS_HOME: {data[key]}",
                )

    def test_an_existing_install_keeps_its_legacy_dir(self):
        """A machine that already HAS ~/.config/prometheus keeps using it.

        Repointing the root without this would silently start an existing install from nothing:
        no trust store, no per-tier gate policy, no installed skills — exactly the "my setting
        did not survive" failure the consolidation exists to end.
        """
        with tempfile.TemporaryDirectory() as fake_home:
            legacy = Path(fake_home) / ".config" / "prometheus"
            legacy.mkdir(parents=True)
            (legacy / "trust.json").write_text("{}")
            data = _run({"HOME": fake_home, "PROMETHEUS_HOME": ""})
            self.assertEqual(data["prom_dir"], str(legacy))

            # An EMPTY new root does NOT end the fallback. The Studio creates
            # `~/.prometheus/config` for mcp-servers.json and its audit logs long before the
            # engine writes anything, so a bare `.exists()` test would have declared the move
            # complete on a machine where it had not started — orphaning trust.json, vault.json,
            # pin.key, the installed skills and the managed repos in the old tree.
            new_root = Path(fake_home) / ".prometheus" / "config"
            new_root.mkdir(parents=True)
            (new_root / "mcp-servers.json").write_text("{}")
            still = _run({"HOME": fake_home, "PROMETHEUS_HOME": ""})
            self.assertEqual(still["prom_dir"], str(legacy))

            # …the ENGINE's own state at the new root is what ends it.
            (new_root / "trust.json").write_text("{}")
            moved = _run({"HOME": fake_home, "PROMETHEUS_HOME": ""})
            self.assertEqual(moved["prom_dir"], str(new_root))
            # an explicit override still beats both
            with tempfile.TemporaryDirectory() as cfg:
                over = _run({"HOME": fake_home, "PROMETHEUS_CONFIG_DIR": cfg})
                self.assertEqual(over["prom_dir"], cfg)

    def test_source_keeps_one_definition_of_the_config_dir(self):
        src = ENGINE.read_text()
        hits = re.findall(r'HOME\s*/\s*"\.config"\s*/\s*"prometheus"', src)
        self.assertEqual(
            len(hits), 1,
            "the LEGACY config dir must be spelled once, as LEGACY_PROM_DIR; "
            f"found {len(hits)} copies — a second one silently ignores the override",
        )
        # and the CURRENT root likewise: one definition, inside _resolve_prom_home(). A second
        # `HOME / ".prometheus"` is how the model library and the effort rules came to ignore
        # $PROMETHEUS_HOME while the config dir honoured it.
        current = re.findall(r'HOME\s*/\s*"\.prometheus"', src)
        self.assertEqual(
            len(current), 1,
            f"the one Prometheus home must be spelled once; found {len(current)} copies",
        )

    def test_pytest_run_is_sandboxed(self):
        # conftest.py must have redirected THIS process before prometheus was imported.
        self.assertTrue(os.environ.get("PROMETHEUS_CONFIG_DIR"),
                        "tests/conftest.py did not set PROMETHEUS_CONFIG_DIR")
        import prometheus as p
        self.assertEqual(str(p.PROM_DIR), os.environ["PROMETHEUS_CONFIG_DIR"])


if __name__ == "__main__":
    unittest.main()
