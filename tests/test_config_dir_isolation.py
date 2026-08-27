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

    def test_default_is_still_the_xdg_style_home_path(self):
        with tempfile.TemporaryDirectory() as fake_home:
            data = _run({"HOME": fake_home})
            self.assertEqual(data["prom_dir"], str(Path(fake_home) / ".config" / "prometheus"))

    def test_source_keeps_one_definition_of_the_config_dir(self):
        src = ENGINE.read_text()
        hits = re.findall(r'HOME\s*/\s*"\.config"\s*/\s*"prometheus"', src)
        self.assertEqual(
            len(hits), 1,
            "the config dir must be spelled once, inside _resolve_prom_dir(); "
            f"found {len(hits)} copies — a second one silently ignores the override",
        )

    def test_pytest_run_is_sandboxed(self):
        # conftest.py must have redirected THIS process before prometheus was imported.
        self.assertTrue(os.environ.get("PROMETHEUS_CONFIG_DIR"),
                        "tests/conftest.py did not set PROMETHEUS_CONFIG_DIR")
        import prometheus as p
        self.assertEqual(str(p.PROM_DIR), os.environ["PROMETHEUS_CONFIG_DIR"])


if __name__ == "__main__":
    unittest.main()
