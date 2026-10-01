# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""Prometheus must use ollama's OWN model store, not invent a second one.

Regression for a measured, costly defect. `_ollama_env()` exported
`OLLAMA_MODELS=<models_root>/ollama`, where `models_root` defaulted to `~/.prometheus/models`.
Measured on the machine this was written for, 2026-10-01:

    ~/.ollama/models       29 GB   gemma4, qwen3.6     <- the daemon's real store
    ~/.prometheus/models    0 B    created 2 Jul       <- what Prometheus pointed ollama at

So `models pull` would have downloaded into an empty directory while every model the user
already had stayed invisible, and `ollama list` in their own terminal would have disagreed with
Prometheus about what was installed. Pulling a 23 GB model they already owned would have cost
23 GB of disk and an hour, to produce a duplicate. That is exactly the duplicate-install failure
`updates/conflicts.ts` exists to detect, inflicted by Prometheus on itself with model weights.

The same machine also carried a STALE legacy config pointing models_root at a source directory
inside the repository -- a pull would have written model weights into the working tree, where
the auto-committer (`git add -A`) would have tried to commit them.

Each test below runs the engine in a subprocess with a controlled environment, because the
precedence is resolved at module import and from `os.environ`.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent / "prometheus.py"


def run_engine(args, env_overrides, home):
    """Run the engine with an isolated HOME and config dir; return (stdout+stderr, returncode)."""
    env = dict(os.environ)
    env.pop("OLLAMA_MODELS", None)
    env["HOME"] = str(home)
    env["PROMETHEUS_CONFIG_DIR"] = str(Path(home) / "cfg")
    env.update(env_overrides)
    p = subprocess.run(
        [sys.executable, str(ENGINE), "--dry-run", *args],
        capture_output=True, text=True, env=env, timeout=120,
    )
    return p.stdout + p.stderr, p.returncode


def models_dir_from(text):
    """The directory the dry-run says the pull would land in, whichever phrasing it used.

    Resolved, because macOS reports a temp dir as both /var/... and /private/var/... and the
    engine calls .resolve() on a configured root. Comparing unresolved strings would fail on a
    symlink difference that has nothing to do with the behaviour under test.
    """
    m = re.search(r"ollama's own store: ([^\s)]+)", text) or re.search(r"OLLAMA_MODELS=(\S+)", text)
    return str(Path(m.group(1)).resolve()) if m else None


class OllamaModelsDir(unittest.TestCase):
    def test_defaults_to_ollamas_own_store_not_a_prometheus_one(self):
        """With nothing configured, the pull must target ~/.ollama/models."""
        with tempfile.TemporaryDirectory() as td:
            out, _ = run_engine(["models", "pull", "qwen3.6"], {}, td)
            got = models_dir_from(out)
            self.assertIsNotNone(got, f"no models dir in output:\n{out}")
            self.assertEqual(got, str((Path(td) / ".ollama" / "models").resolve()), out)
            # The regression, named: Prometheus must not invent a store of its own here.
            self.assertNotIn(".prometheus/models", got)

    def test_an_exported_OLLAMA_MODELS_is_respected(self):
        """The user (or their daemon) already decided; Prometheus is a guest."""
        with tempfile.TemporaryDirectory() as td:
            out, _ = run_engine(
                ["models", "pull", "qwen3.6"], {"OLLAMA_MODELS": "/tmp/somewhere-else"}, td
            )
            self.assertEqual(models_dir_from(out), str(Path("/tmp/somewhere-else").resolve()), out)

    def test_an_explicit_models_root_still_wins(self):
        """An explicit `models config --set-root` is an instruction, and is obeyed."""
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "cfg"
            cfg.mkdir(parents=True, exist_ok=True)
            chosen = Path(td) / "my-models"
            (cfg / "config.json").write_text(json.dumps({"models_root": str(chosen)}))
            out, _ = run_engine(["models", "pull", "qwen3.6"], {}, td)
            self.assertEqual(models_dir_from(out), str((chosen / "ollama").resolve()), out)

    def test_a_models_root_inside_a_git_tree_is_refused(self):
        """Model weights must never be written into a repository.

        The real config found on this machine pointed at a source directory inside the
        Prometheus checkout. Honouring it would have put tens of gigabytes where `git add -A`
        would try to commit them, so an obviously-wrong value is refused loudly and the
        resolution falls through to ollama's own store.
        """
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "some-repo"
            (repo / ".git").mkdir(parents=True)
            cfg = Path(td) / "cfg"
            cfg.mkdir(parents=True, exist_ok=True)
            (cfg / "config.json").write_text(json.dumps({"models_root": str(repo / "inside")}))
            out, _ = run_engine(["models", "pull", "qwen3.6"], {}, td)
            self.assertIn("git working tree", out, out)
            # Refused AND recovered — not refused and then broken.
            self.assertEqual(models_dir_from(out), str((Path(td) / ".ollama" / "models").resolve()), out)


if __name__ == "__main__":
    unittest.main()
