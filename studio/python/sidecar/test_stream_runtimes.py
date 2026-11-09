"""test_stream_runtimes.py — AirLLM / colibri set up by Prometheus, hermetic.

No pip, git, make or network runs: the MODELHUB_FAKE_INSTALL_LINES seam replaces every install
subprocess, MODELHUB_FAKE_GIT replaces git, NEMESIS_BIN is a stand-in that prints one verdict
(the gate's real fail-closed parsing still runs on it), and every path lives in a temp dir."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELHUB = HERE / "modelhub.py"
sys.path.insert(0, str(HERE))
import _test_stores  # noqa: E402,F401 — every model store is a temp dir
import model_acquire  # noqa: E402
import nemesis_gate  # noqa: E402


def fake_nemesis(dirpath: str, verdict: str = "allow") -> str:
    code = {"allow": 0, "warn": 10, "block": 20, "error": 2}[verdict]
    p = Path(dirpath) / f"fake_nemesis_{verdict}.py"
    p.write_text(
        "import json, sys\n"
        f"print(json.dumps({{'verdict': {verdict!r}, 'risk_score': 0, 'blocking_reasons': []}}))\n"
        f"sys.exit({code})\n",
        encoding="utf-8",
    )
    return str(p)


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="stream-rt-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.tools = os.path.join(self.tmp, "tools")
        self.lib = os.path.join(self.tmp, "lib")
        os.makedirs(self.lib)

    def env(self, verdict: str = "allow", **extra: str) -> dict:
        e = {
            "PROMETHEUS_TOOLS_DIR": self.tools,
            "PROMETHEUS_MODELS_HOME": self.lib,
            "HF_HUB_CACHE": os.path.join(self.tmp, "hf-hub"),
            "LMSTUDIO_MODELS_DIR": os.path.join(self.tmp, "lms-models"),
            "LLAMA_CACHE": os.path.join(self.tmp, "llama-cache"),
            "MODELHUB_FAKE_INSTALL_LINES": "fake line",
            "MODELHUB_FAKE_GIT": "/fake/bin/git",
            "MODELHUB_FORCE_OS": "macos",
            "NEMESIS_BIN": fake_nemesis(self.tmp, verdict),
            # no real HMAC key from the developer's home leaks into the run
            "HOME": self.tmp,
        }
        e.update(extra)
        return e

    def run_verb(self, env: dict, *args: str) -> tuple[dict, int]:
        e = dict(os.environ)
        e.update(env)
        p = subprocess.run([sys.executable, str(MODELHUB), *args], capture_output=True, text=True,
                           timeout=120, env=e)
        lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, (p.stdout, p.stderr[-1500:]))
        return json.loads(lines[0]), p.returncode


class AirllmInstallTests(_Base):
    def test_plan_names_the_pinned_packages_and_prometheus_venv(self) -> None:
        obj, code = self.run_verb(self.env(), "install-runtime", "--runtime", "airllm", "--plan")
        self.assertEqual(code, 0, obj)
        self.assertIn("airllm==4.0.0", obj["packages"])
        self.assertIn("torch>=2.6", obj["packages"])
        self.assertIn("mlx", obj["packages"], "AirLLM's Apple Silicon path needs mlx")
        self.assertTrue(obj["venv"].startswith(self.tools))

    def test_allow_installs_once_and_runtimes_reports_it(self) -> None:
        obj, code = self.run_verb(self.env(), "install-runtime", "--runtime", "airllm")
        self.assertEqual(code, 0, obj)
        self.assertTrue(obj["installed"])
        again, _ = self.run_verb(self.env(), "install-runtime", "--runtime", "airllm")
        self.assertEqual(again.get("note"), "already installed")
        rows, _ = self.run_verb(self.env(), "runtimes")
        row = next(r for r in rows["runtimes"] if r["id"] == "airllm")
        self.assertTrue(row["installed"])

    def test_warn_needs_typed_acceptance_and_block_never_installs(self) -> None:
        obj, code = self.run_verb(self.env("warn"), "install-runtime", "--runtime", "airllm")
        self.assertNotEqual(code, 0)
        self.assertTrue(obj.get("needs_confirm"), obj)
        self.assertFalse((Path(self.tools) / "airllm-venv" / ".prometheus-airllm.json").exists())
        ok, code = self.run_verb(self.env("warn"), "install-runtime", "--runtime", "airllm",
                                 "--accept-warn")
        self.assertEqual(code, 0, ok)
        shutil.rmtree(self.tools)
        blk, code = self.run_verb(self.env("block"), "install-runtime", "--runtime", "airllm",
                                  "--accept-warn")
        self.assertNotEqual(code, 0)
        self.assertTrue(blk.get("blocked"), blk)


class ColibriInstallTests(_Base):
    def test_pinned_source_is_scanned_built_and_recorded(self) -> None:
        obj, code = self.run_verb(self.env(), "install-runtime", "--runtime", "colibri")
        self.assertEqual(code, 0, obj)
        launcher = Path(obj["path"])
        self.assertEqual(launcher.name, "coli")
        root = launcher.parent.parent
        rec = json.loads((root / ".prometheus-colibri.json").read_text())
        self.assertEqual(rec["commit"], "704a3f68184b78367a04cb5526e428dc2f90f05b")
        self.assertIn("c/coli", rec["sha256"])
        # an edited launcher is no longer Prometheus's colibri
        launcher.write_text("print('tampered')\n")
        rows, _ = self.run_verb(self.env(), "runtimes")
        self.assertIsNone(next(r for r in rows["runtimes"] if r["id"] == "colibri")["installed"])

    def test_block_on_the_source_builds_nothing(self) -> None:
        obj, code = self.run_verb(self.env("block"), "install-runtime", "--runtime", "colibri")
        self.assertNotEqual(code, 0)
        self.assertTrue(obj.get("blocked"), obj)
        self.assertFalse((Path(self.tools) / "colibri-v2.1.0" / "c" / "coli").exists())

    def test_a_moved_tag_is_refused(self) -> None:
        obj, code = self.run_verb(self.env(MODELHUB_FAKE_GIT_HEAD="deadbeef"), "install-runtime",
                                  "--runtime", "colibri")
        self.assertNotEqual(code, 0)
        self.assertIn("not the pinned commit", obj["error"])


class RuntimeArgvTests(_Base):
    def test_refusals(self) -> None:
        e = self.env()
        obj, code = self.run_verb(e, "runtime-argv", "--runtime=airllm", "--model=/x", "--id=m")
        self.assertNotEqual(code, 0)
        self.assertIn("not installed", obj["error"])
        self.run_verb(e, "install-runtime", "--runtime", "airllm")
        plain = Path(self.tmp) / "plain"
        plain.mkdir()
        (plain / "model.safetensors").write_bytes(b"x")
        obj, code = self.run_verb(e, "runtime-argv", "--runtime=airllm", f"--model={plain}", "--id=m")
        self.assertNotEqual(code, 0)
        self.assertIn("admitted", obj["error"])
        obj, code = self.run_verb(e, "runtime-argv", "--runtime=airllm", f"--model={plain}",
                                  "--id=../evil")
        self.assertNotEqual(code, 0)
        self.run_verb(e, "install-runtime", "--runtime", "colibri")
        obj, code = self.run_verb(e, "runtime-argv", "--runtime=colibri", f"--model={plain}", "--id=m")
        self.assertNotEqual(code, 0)
        self.assertIn("colibri-import", obj["error"])

    def test_airllm_argv_for_an_admitted_directory_is_offline_loopback_and_outside_it(self) -> None:
        e = self.env()
        self.run_verb(e, "install-runtime", "--runtime", "airllm")
        live = Path(self.lib) / "huggingface" / "llama-x"
        live.mkdir(parents=True)
        files = {"model.safetensors": b"weights", "config.json": b"{}", "tokenizer.json": b"{}"}
        for name, data in files.items():
            (live / name).write_bytes(data)
        os.environ["PROMETHEUS_MODELS_HOME"] = self.lib
        old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.tmp
        try:
            nemesis_gate._write_manifest(
                live, model_id="llama-x", source="huggingface", quant=None, license=None,
                verdict="allow", gate={}, format_risk=None, checksum=None, forced=False,
                files_sha256={n: hashlib.sha256(d).hexdigest() for n, d in files.items()},
            )
        finally:
            if old_home is not None:
                os.environ["HOME"] = old_home
        obj, code = self.run_verb(e, "runtime-argv", "--runtime=airllm", f"--model={live}",
                                  "--id=llama-x")
        self.assertEqual(code, 0, obj)
        self.assertIn("--host=127.0.0.1", obj["argv"])
        self.assertEqual(obj["env"]["HF_HUB_OFFLINE"], "1")
        layers = next(a for a in obj["argv"] if a.startswith("--layers="))[len("--layers="):]
        self.assertNotIn(str(live), layers, "AirLLM's layer split never lands in the admitted dir")


class AdmittedDirTests(_Base):
    def _admit(self, files: dict) -> Path:
        live = Path(self.lib) / "huggingface" / "m"
        live.mkdir(parents=True)
        for name, data in files.items():
            (live / name).write_bytes(data)
        nemesis_gate._write_manifest(
            live, model_id="m", source="huggingface", quant=None, license=None, verdict="allow",
            gate={}, format_risk=None, checksum=None, forced=False,
            files_sha256={n: hashlib.sha256(d).hexdigest() for n, d in files.items()},
        )
        return live

    def setUp(self) -> None:
        super().setUp()
        self._env = {k: os.environ.get(k) for k in ("PROMETHEUS_MODELS_HOME", "HOME")}
        os.environ["PROMETHEUS_MODELS_HOME"] = self.lib
        os.environ["HOME"] = self.tmp

    def tearDown(self) -> None:
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_every_file_must_be_listed_and_unchanged(self) -> None:
        live = self._admit({"a.safetensors": b"w", "config.json": b"{}"})
        self.assertIsNotNone(model_acquire.admitted_dir(live))
        (live / "modeling_evil.py").write_text("import os\n")
        self.assertIsNone(model_acquire.admitted_dir(live), "a file added after the admit")
        (live / "modeling_evil.py").unlink()
        (live / "a.safetensors").write_bytes(b"X")
        self.assertIsNone(model_acquire.admitted_dir(live), "a file rewritten in place")

    def test_only_the_library_dir_counts(self) -> None:
        live = self._admit({"a.safetensors": b"w"})
        self.assertIsNone(model_acquire.admitted_dir(live.parent))
        outside = Path(self.tmp) / "elsewhere"
        shutil.copytree(live, outside)
        self.assertIsNone(model_acquire.admitted_dir(outside))


class AirllmShimRefusalTests(unittest.TestCase):
    def test_code_auto_map_and_pickles_are_refused_before_load(self) -> None:
        import airllm_serve
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            self.assertIn("no .safetensors", airllm_serve.refusal(p) or "")
            (p / "model.safetensors").write_bytes(b"w")
            (p / "config.json").write_text(json.dumps({"auto_map": {"AutoModel": "x.Y"}}))
            self.assertIn("auto_map", airllm_serve.refusal(p) or "")
            (p / "config.json").write_text("{}")
            self.assertIsNone(airllm_serve.refusal(p))
            (p / "pytorch_model.bin").write_bytes(b"pickle")
            self.assertIn("pickle", airllm_serve.refusal(p) or "")
            (p / "pytorch_model.bin").unlink()
            (p / "modeling.py").write_text("x")
            self.assertIn("code", airllm_serve.refusal(p) or "")

    def test_offline_before_import_and_loopback_only(self) -> None:
        import airllm_serve
        self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "1")
        self.assertEqual(airllm_serve.main(["--model=/x", "--alias=a", "--layers=/y",
                                            "--host=0.0.0.0"]), 2)


if __name__ == "__main__":
    unittest.main()


class LmStudioLinkTests(AdmittedDirTests):
    """`install-target --target lmstudio --link`: every shard of a split GGUF, or a whole admitted
    MLX folder — and nothing the gate did not admit."""

    def _link(self, *args: str) -> tuple[dict, int]:
        lms = os.path.join(self.tmp, "lms-models")
        return self.run_verb({"PROMETHEUS_MODELS_HOME": self.lib, "HOME": self.tmp,
                              "LMSTUDIO_MODELS_DIR": lms, "MODELHUB_FORCE_NO_LMS": "1"},
                             "install-target", "--target", "lmstudio", "--id", "prometheus/m", *args)

    def test_split_gguf_links_every_shard(self) -> None:
        names = [f"m-0000{i}-of-00003.gguf" for i in (1, 2, 3)]
        live = self._admit({n: f"shard{i}".encode() for i, n in enumerate(names)})
        obj, code = self._link("--gguf", str(live / names[0]), "--link")
        self.assertEqual(code, 0, obj)
        linked = sorted(p.name for p in (Path(self.tmp) / "lms-models" / "prometheus" / "m").iterdir())
        self.assertEqual(linked, names)

    def test_split_gguf_with_an_unadmitted_shard_is_refused(self) -> None:
        names = [f"m-0000{i}-of-00002.gguf" for i in (1, 2)]
        live = self._admit({names[0]: b"a"})
        (live / names[1]).write_bytes(b"planted")
        obj, code = self._link("--gguf", str(live / names[0]), "--link")
        self.assertNotEqual(code, 0)
        self.assertIn("every shard", obj["error"])

    def test_mlx_folder_is_placed_in_lm_studio_as_real_files_and_reverified(self) -> None:
        live = self._admit({"model.safetensors": b"w", "config.json": b"{}"})
        obj, code = self._link(f"--mlx-dir={live}", "--link")
        self.assertEqual(code, 0, obj)
        dest = Path(self.tmp) / "lms-models" / "prometheus" / "m"
        self.assertFalse(dest.is_symlink(), "never a symlink back into a Prometheus folder")
        self.assertEqual((dest / "model.safetensors").read_bytes(), b"w")
        self.assertFalse((live / "model.safetensors").exists(), "the library keeps no weights")
        # the placed folder is vouched for by the ledger, file by file
        again, code = self._link(f"--mlx-dir={dest}", "--link")
        self.assertEqual(code, 0, again)
        self.assertEqual(again["method"], "in-place")
        (dest / "extra.py").write_text("x")
        obj, code = self._link(f"--mlx-dir={dest}", "--link")
        self.assertNotEqual(code, 0, "a file added after placement is refused")
