#!/usr/bin/env python3
"""test_dossier_dir.py — `tutorial` / `methods` / `describe` must be pointable at the dossiers.

`DOSSIER_DIR` was a hardcoded `<repo>/AI_SKILLS_WONDERLAND`. That is right for a checkout that
still carries the docs and wrong for one where they were relocated — on this machine a
repo-hygiene pass had moved all 106 dossiers to `~/ALPHA_local_only/PROMETHEUS/
AI_SKILLS_WONDERLAND/`, leaving the engine pointed at a directory with zero `*.md` files. Every
catalog id then answered "no tutorial/dossier found for '<id>'" (6/6 real ids measured), which
reads as "you typed the wrong id" rather than "the docs are not here".

Two things are fixed and pinned here: an env override so the engine can be pointed at them, and
a message that names the real cause. The content itself is the maintainer's and is never invented.

Pure stdlib (unittest). Run: python3 tests/test_dossier_dir.py."""
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load(env_dir=None):
    """Load prometheus.py fresh, optionally with PROMETHEUS_DOSSIER_DIR set."""
    prev = os.environ.get("PROMETHEUS_DOSSIER_DIR")
    if env_dir is None:
        os.environ.pop("PROMETHEUS_DOSSIER_DIR", None)
    else:
        os.environ["PROMETHEUS_DOSSIER_DIR"] = str(env_dir)
    try:
        spec = importlib.util.spec_from_file_location(
            f"prometheus_dossier_{id(env_dir)}", ROOT / "prometheus.py"
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        if prev is None:
            os.environ.pop("PROMETHEUS_DOSSIER_DIR", None)
        else:
            os.environ["PROMETHEUS_DOSSIER_DIR"] = prev


class TestDossierDir(unittest.TestCase):
    def test_the_directory_is_overridable(self):
        d = Path(tempfile.mkdtemp(prefix="prom-dossier-"))
        (d / "29-ollama-ollama.md").write_text("# ollama — run LLMs locally\n")
        mod = _load(d)
        self.assertEqual(mod.DOSSIER_DIR, d)
        # …and the resolver finds a dossier there by fuzzy id match, exactly as it would in-repo
        self.assertEqual(mod._dossier_for("ollama", {}), (d / "29-ollama-ollama.md"))

    def test_a_tilde_in_the_override_is_expanded(self):
        # the natural way to write it is `~/somewhere`, and an unexpanded `~` silently misses.
        mod = _load("~/definitely-not-here-prom-test")
        self.assertFalse(str(mod.DOSSIER_DIR).startswith("~"))
        self.assertTrue(str(mod.DOSSIER_DIR).startswith(str(Path.home())))

    def test_the_default_is_still_beside_the_engine(self):
        mod = _load(None)
        self.assertEqual(mod.DOSSIER_DIR, ROOT / "AI_SKILLS_WONDERLAND")

    def test_an_EMPTY_dossier_dir_blames_the_catalog_not_the_id(self):
        """The case this machine was actually in: the directory exists and holds no dossiers."""
        d = Path(tempfile.mkdtemp(prefix="prom-dossier-empty-"))
        mod = _load(d)
        msg = mod._no_dossier_message("skills")
        self.assertIn("no dossiers in it", msg)
        self.assertIn("PROMETHEUS_DOSSIER_DIR", msg, "the message must say how to fix it")
        # it must NOT read as a per-id failure
        self.assertNotIn("no tutorial/dossier found for", msg)

    def test_a_populated_dir_with_a_genuinely_unknown_id_still_says_so(self):
        # self-validating: the catalog-level message must not swallow a real per-id miss.
        d = Path(tempfile.mkdtemp(prefix="prom-dossier-full-"))
        (d / "29-ollama-ollama.md").write_text("# ollama\n")
        mod = _load(d)
        self.assertIn("no tutorial/dossier found for", mod._no_dossier_message("nope-not-real"))


if __name__ == "__main__":
    unittest.main()
