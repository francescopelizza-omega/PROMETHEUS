# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""`models pull/run` and the warn-approval identity: four defects found in review, 2026-11-02.

1. The host-qualified-tag refusal ran only on the real path, so `--dry-run`/`--json` answered
   `ok: true` with an argv the real run then refused.
2. `models run` always pulled first. A model imported from a gated GGUF (`prometheus/<id>`)
   exists in no registry, so the pull 404'd and `run` refused a model sitting on disk.
3. The post-pull nemesis gate inherited os.environ while the pull ran with `_ollama_env()`; with
   a configured models_root the sidecar looked in ~/.ollama/models, found no manifest, and
   refused every pull into the configured store AFTER the download had finished.
4. `_tree_ident` returned git HEAD for a checkout (blind to every working-tree edit) and the
   constant "unreadable" on an error (one approval then covered every unreadable tree).
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ENGINE = Path(__file__).resolve().parent.parent / "prometheus.py"
_HOME = tempfile.mkdtemp(prefix="prom-tag-gate-")


def _load_engine():
    with mock.patch.dict(os.environ, {"HOME": _HOME, "PROMETHEUS_CONFIG_DIR": str(Path(_HOME) / "cfg"),
                                      "PROMETHEUS_HOME": str(Path(_HOME) / ".prometheus")}):
        spec = importlib.util.spec_from_file_location("prom_tag_gate_engine", ENGINE)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
    return mod


P = _load_engine()


def run_json(*args):
    env = dict(os.environ, HOME=_HOME, PROMETHEUS_CONFIG_DIR=str(Path(_HOME) / "cfg"))
    env.pop("OLLAMA_MODELS", None)
    p = subprocess.run([sys.executable, str(ENGINE), "--json", "--dry-run", *args],
                       capture_output=True, text=True, env=env, timeout=120)
    line = [l for l in p.stdout.splitlines() if l.startswith("{")][-1]
    return json.loads(line), p.returncode


class TagPolicyBeforeDryRun(unittest.TestCase):
    def test_host_tag_refused_under_dry_run_json(self):
        out, rc = run_json("models", "pull", "hf.co/someone/evil-GGUF:Q4_K_M")
        self.assertFalse(out["ok"], out)
        self.assertEqual(rc, 2)
        self.assertIn("names a host", out["error"])

    def test_malformed_tag_refused_under_dry_run_json(self):
        out, rc = run_json("models", "run", "Not A Tag")
        self.assertFalse(out["ok"], out)
        self.assertEqual(rc, 2)

    def test_library_tag_still_planned(self):
        out, rc = run_json("models", "pull", "qwen3:8b")
        self.assertTrue(out["ok"], out)
        self.assertEqual(rc, 0)

    def test_catalogue_tags_all_pass_the_policy(self):
        cat = json.loads((ENGINE.parent / "studio" / "config" / "open-models.json").read_text())
        bad = [m["ollama"] for m in cat["models"] if m.get("ollama") and P._ollama_tag_refusal(m["ollama"])]
        self.assertEqual(bad, [])


class RunSkipsPullForLocalModel(unittest.TestCase):
    def _run(self, store, tag):
        calls = []

        class Done(Exception):
            pass

        def fake_exec(*a):
            raise Done()

        with mock.patch.object(P, "DRY_RUN", False), mock.patch.object(P, "JSON_OUT", False), \
                mock.patch.object(P, "_ollama_models_dir", return_value=store), \
                mock.patch.object(P, "_ollama_env", return_value={}), \
                mock.patch.object(P.shutil, "which", return_value="/usr/bin/true"), \
                mock.patch.object(P, "_run_timed", side_effect=lambda argv, **k: calls.append(argv) or
                                  subprocess.CompletedProcess(argv, 0)), \
                mock.patch.object(P, "_ollama_post_gate", return_value=(True, "")) as gate, \
                mock.patch.object(P.os, "execvpe", side_effect=fake_exec):
            with self.assertRaises(Done):
                P._models_pull_run("run", tag)
        return calls, gate

    def test_local_manifest_is_not_pulled_again_but_is_gated(self):
        with tempfile.TemporaryDirectory() as td:
            store = Path(td)
            mp = P._ollama_manifest_path("prometheus/tiny:latest", store)
            mp.parent.mkdir(parents=True)
            mp.write_text("{}")
            calls, gate = self._run(store, "prometheus/tiny")
            self.assertEqual(calls, [], "a local model must not be pulled from the registry")
            gate.assert_called_once()

    def test_missing_model_is_pulled(self):
        with tempfile.TemporaryDirectory() as td:
            calls, gate = self._run(Path(td), "qwen3:8b")
            self.assertEqual(calls, [["ollama", "pull", "--", "qwen3:8b"]])
            gate.assert_called_once()


class PostGateReadsThePulledStore(unittest.TestCase):
    def test_sidecar_gets_the_store_the_pull_used(self):
        seen = {}

        def fake_run(argv, **kw):
            seen["env"] = kw.get("env")
            return subprocess.CompletedProcess(argv, 0, stdout='{"ok": true}\n', stderr="")

        with mock.patch.object(P, "_ollama_env",
                               return_value={"PATH": "/usr/bin", "OLLAMA_MODELS": "/models/custom"}), \
                mock.patch.object(P.subprocess, "run", side_effect=fake_run):
            ok, _ = P._ollama_post_gate("qwen3:8b", Path("/models/custom"))
        self.assertTrue(ok)
        self.assertEqual(seen["env"]["OLLAMA_MODELS"], "/models/custom")
        # and when Prometheus did NOT choose the store, it does not invent one
        with mock.patch.object(P, "_ollama_env", return_value={"PATH": "/usr/bin"}), \
                mock.patch.object(P.subprocess, "run", side_effect=fake_run):
            P._ollama_post_gate("qwen3:8b", Path("/home/u/.ollama/models"))
        self.assertNotIn("OLLAMA_MODELS", seen["env"])


class TreeIdentity(unittest.TestCase):
    def test_same_size_edit_and_symlink_change_identity(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "a").write_text("aa\n")
            first = P._tree_ident(td)
            self.assertEqual(first, P._tree_ident(td))
            (Path(td) / "a").write_text("bb\n")
            second = P._tree_ident(td)
            self.assertNotEqual(first, second)
            os.symlink("/etc/hosts", Path(td) / "l")
            self.assertNotEqual(second, P._tree_ident(td))

    def test_git_checkout_edits_change_identity(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / ".git").mkdir()
            (Path(td) / "x.sh").write_text("echo hi\n")
            with mock.patch.object(P, "_git_identity", return_value="0123456789abcdef"):
                before = P._tree_ident(td)
                (Path(td) / "x.sh").write_text("echo HI\n")
                self.assertNotEqual(before, P._tree_ident(td))

    @unittest.skipIf(os.geteuid() == 0, "root reads everything")
    def test_unreadable_tree_never_reuses_an_identity(self):
        with tempfile.TemporaryDirectory() as td:
            sub = Path(td) / "sub"
            sub.mkdir()
            (sub / "f").write_text("x")
            sub.chmod(0)
            try:
                a, b = P._tree_ident(td), P._tree_ident(td)
            finally:
                sub.chmod(0o755)
            self.assertTrue(a.startswith("unreadable:"), a)
            self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main()
