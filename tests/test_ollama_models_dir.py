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

    def test_a_configured_models_root_is_ignored_for_weights(self):
        """`models_root` is retired: it redirected ollama into a Prometheus folder, duplicating
        every model already in ~/.ollama/models. A stale value must change nothing."""
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "cfg"
            cfg.mkdir(parents=True, exist_ok=True)
            chosen = Path(td) / "my-models"
            (cfg / "config.json").write_text(json.dumps({"models_root": str(chosen)}))
            out, _ = run_engine(["models", "pull", "qwen3.6"], {}, td)
            self.assertEqual(models_dir_from(out), str((Path(td) / ".ollama" / "models").resolve()), out)
            self.assertNotIn("OLLAMA_MODELS=", out)
            self.assertFalse((chosen / "ollama").exists(), "no Prometheus model store is created")

    def test_set_root_is_retired_and_removes_a_stale_value(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "cfg"
            cfg.mkdir(parents=True, exist_ok=True)
            (cfg / "config.json").write_text(json.dumps({"models_root": str(Path(td) / "old"), "k": 1}))
            env = dict(os.environ)
            env.pop("OLLAMA_MODELS", None)
            env.update(HOME=td, PROMETHEUS_CONFIG_DIR=str(cfg))
            p = subprocess.run([sys.executable, str(ENGINE), "models", "config", "--set-root", "/x"],
                               capture_output=True, text=True, env=env, timeout=120)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("no longer keeps models", p.stdout + p.stderr)
            saved = json.loads((cfg / "config.json").read_text())
            self.assertNotIn("models_root", saved)
            self.assertEqual(saved.get("k"), 1, "other preferences are kept")

    def test_models_config_lists_each_runtimes_own_store(self):
        with tempfile.TemporaryDirectory() as td:
            env = dict(os.environ)
            env.pop("OLLAMA_MODELS", None)
            env.update(HOME=td, PROMETHEUS_CONFIG_DIR=str(Path(td) / "cfg"))
            p = subprocess.run([sys.executable, str(ENGINE), "--json", "models", "config"],
                               capture_output=True, text=True, env=env, timeout=120)
            obj = json.loads([ln for ln in p.stdout.splitlines() if ln.strip()][-1])
            stores = {s["runtime"].split(" ")[0]: s["store"] for s in obj["stores"]}
            self.assertEqual(stores["ollama"], str(Path(td) / ".ollama" / "models"))
            self.assertEqual(stores["lmstudio"], str(Path(td) / ".lmstudio" / "models"))
            self.assertTrue(stores["huggingface"].endswith(".cache/huggingface/hub"))
            self.assertNotIn(".prometheus", json.dumps(obj["stores"]))

    def test_a_models_root_inside_a_git_tree_is_refused(self):
        """Model weights must never be written into a repository (and a models_root is
        ignored altogether now): the pull targets ollama's own store."""
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "some-repo"
            (repo / ".git").mkdir(parents=True)
            cfg = Path(td) / "cfg"
            cfg.mkdir(parents=True, exist_ok=True)
            (cfg / "config.json").write_text(json.dumps({"models_root": str(repo / "inside")}))
            out, _ = run_engine(["models", "pull", "qwen3.6"], {}, td)
            self.assertEqual(models_dir_from(out), str((Path(td) / ".ollama" / "models").resolve()), out)
            self.assertFalse((repo / "inside").exists())

if __name__ == "__main__":
    unittest.main()
