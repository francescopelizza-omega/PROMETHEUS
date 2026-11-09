#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_model_acquire.py — stage-hf / ollama-gate / import-ollama, hermetic.

A local HTTP server plays Hugging Face (API with blobs + resolve/<sha>/<file>, honouring
Range); the Ollama store is a temp dir; `ollama` itself is the MODELHUB_FAKE_OLLAMA_CMD_CODE
seam. Nothing touches the network or a real model store."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELHUB = HERE / "modelhub.py"
sys.path.insert(0, str(HERE))
import _test_stores  # noqa: E402,F401 — every model store is a temp dir
import model_acquire  # noqa: E402


def gguf(template: str = "") -> bytes:
    def s(b: bytes) -> bytes:
        return len(b).to_bytes(8, "little") + b
    kvs = [(b"general.architecture", b"llama")]
    if template:
        kvs.append((b"tokenizer.chat_template", template.encode()))
    out = b"GGUF" + (3).to_bytes(4, "little") + (0).to_bytes(8, "little") + len(kvs).to_bytes(8, "little")
    for k, v in kvs:
        out += s(k) + (8).to_bytes(4, "little") + s(v)
    return out


class FakeHF:
    """repo files: {path: bytes}; `lie` maps a path to a WRONG sha256 to report."""

    def __init__(self, files: dict, lie: dict | None = None, commit: str = "c0ffee" * 6 + "abcd") -> None:
        self.files, self.lie, self.commit = files, lie or {}, commit
        self.requests: list = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def do_GET(self):
                fake.requests.append((self.path, self.headers.get("Range")))
                if self.path.startswith("/api/models/org/m/revision/"):
                    sib = [{"rfilename": p, "size": len(b),
                            "lfs": {"sha256": fake.lie.get(p, hashlib.sha256(b).hexdigest()),
                                    "size": len(b)}}
                           for p, b in fake.files.items()]
                    body = json.dumps({"sha": fake.commit, "siblings": sib}).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                pre = f"/org/m/resolve/{fake.commit}/"
                if self.path.startswith(pre):
                    name = self.path[len(pre):]
                    data = fake.files.get(name)
                    if data is None:
                        self.send_response(404)
                        self.end_headers()
                        return
                    rng = self.headers.get("Range")
                    start = int(rng.split("=")[1].split("-")[0]) if rng else 0
                    chunk = data[start:]
                    self.send_response(206 if rng else 200)
                    self.send_header("Content-Length", str(len(chunk)))
                    self.end_headers()
                    self.wfile.write(chunk)
                    return
                self.send_response(404)
                self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def run(env: dict, *args: str) -> tuple[dict, str, int]:
    e = dict(os.environ)
    e.update(env)
    p = subprocess.run([sys.executable, str(MODELHUB), *args], capture_output=True, text=True,
                       timeout=180, env=e)
    lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
    assert len(lines) == 1, (p.stdout, p.stderr[-2000:])
    return json.loads(lines[0]), p.stderr, p.returncode


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.lib = tempfile.mkdtemp(prefix="acq-lib-")
        self.addCleanup(shutil.rmtree, self.lib, True)
        for suffix in ("-hf-hub", "-lmstudio", "-llama-cache"):
            self.addCleanup(shutil.rmtree, self.lib + suffix, True)

    def env(self, hf: FakeHF | None = None, **extra: str) -> dict:
        # every runtime store is a temp dir too: an admitted fake model is PLACED into one
        e = {"PROMETHEUS_MODELS_HOME": self.lib,
             "HF_HUB_CACHE": self.lib + "-hf-hub",
             "LMSTUDIO_MODELS_DIR": self.lib + "-lmstudio",
             "LLAMA_CACHE": self.lib + "-llama-cache"}
        if hf:
            e["MODELHUB_HF_BASE"] = hf.base
        e.update(extra)
        return e


class StageHf(_Base):
    def test_gguf_is_downloaded_verified_scanned_and_admitted(self) -> None:
        hf = FakeHF({"m-Q4_K_M.gguf": gguf(), "README.md": b"# m"})
        self.addCleanup(hf.close)
        obj, err, code = run(self.env(hf), "stage-hf", "--id", "org/m", "--repo", "org/m",
                             "--file", "m-Q4_K_M.gguf")
        self.assertTrue(obj["ok"], obj)
        self.assertTrue(obj["admitted"])
        self.assertEqual(obj["revision"], hf.commit)          # pinned to the commit, not "main"
        self.assertTrue(Path(obj["weights"][0]).is_file())
        self.assertIn('"verb": "stage-hf"', err)              # progress on stderr

    def test_sha_mismatch_is_never_admitted(self) -> None:
        body = gguf()
        hf = FakeHF({"m.gguf": body}, lie={"m.gguf": "0" * 64})
        self.addCleanup(hf.close)
        obj, _err, code = run(self.env(hf), "stage-hf", "--id", "org/m2", "--repo", "org/m",
                              "--file", "m.gguf")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)
        self.assertIn("sha256 mismatch", obj["error"])

    def test_poisoned_template_is_blocked_and_quarantined(self) -> None:
        hf = FakeHF({"m.gguf": gguf("{{ lipsum.__globals__['os'].popen('id') }}")})
        self.addCleanup(hf.close)
        obj, _err, code = run(self.env(hf), "stage-hf", "--id", "org/m3", "--repo", "org/m",
                              "--file", "m.gguf")
        self.assertFalse(obj["ok"])
        self.assertFalse(obj.get("admitted"))
        self.assertIn("quarantined", obj)

    def test_pickle_and_code_are_refused_before_download(self) -> None:
        hf = FakeHF({"pytorch_model.bin": b"\x80\x02.", "modeling.py": b"import os"})
        self.addCleanup(hf.close)
        for f in ("pytorch_model.bin", "modeling.py", "../escape.gguf"):
            obj, _err, code = run(self.env(hf), "stage-hf", "--id", "org/m4", "--repo", "org/m",
                                  "--file", f)
            self.assertFalse(obj["ok"], f)
        self.assertFalse(any("/resolve/" in r[0] for r in hf.requests))  # nothing downloaded

    def test_split_gguf_brings_every_shard(self) -> None:
        a, b = gguf(), gguf()
        hf = FakeHF({"q/m-00001-of-00002.gguf": a, "q/m-00002-of-00002.gguf": b})
        self.addCleanup(hf.close)
        obj, _err, _code = run(self.env(hf), "stage-hf", "--id", "org/m5", "--repo", "org/m",
                               "--file", "q/m-00001-of-00002.gguf", "--plan")
        self.assertEqual(obj["files"], ["q/m-00001-of-00002.gguf", "q/m-00002-of-00002.gguf"])

    def test_resume_uses_a_range_request(self) -> None:
        body = gguf() + b"\x00" * 4096
        hf = FakeHF({"m.gguf": body})
        self.addCleanup(hf.close)
        stage = Path(self.lib) / ".stage" / "org__m6"
        stage.mkdir(parents=True)
        (stage / "m.gguf.part").write_bytes(body[:100])
        obj, _err, _code = run(self.env(hf), "stage-hf", "--id", "org/m6", "--repo", "org/m",
                               "--file", "m.gguf")
        self.assertTrue(obj["ok"], obj)
        self.assertIn("bytes=100-", [r[1] for r in hf.requests if r[1]])

    def test_snapshot_with_remote_code_is_refused(self) -> None:
        hf = FakeHF({"config.json": json.dumps({"auto_map": {"AutoModel": "x.Y"}}).encode(),
                     "model.safetensors": b"x"})
        self.addCleanup(hf.close)
        obj, _err, _code = run(self.env(hf), "stage-hf", "--id", "org/m7", "--repo", "org/m",
                               "--include", "*.safetensors", "--include", "*.json")
        self.assertFalse(obj["ok"])
        self.assertIn("trust_remote_code", obj["error"])


class Ollama(_Base):
    def test_tag_policy(self) -> None:
        for ok in ("qwen3:8b", "llama3.2", "gemma3:4b-it-qat", "user/model:tag"):
            self.assertIsNone(model_acquire.tag_refusal(ok), ok)
        for bad in ("hf.co/a/b:Q4", "huggingface.co/a/b", "registry.x.io/a/b", "-x", "", "a b"):
            self.assertIsNotNone(model_acquire.tag_refusal(bad), bad)

    def test_import_refuses_a_file_that_never_passed_the_gate(self) -> None:
        stray = Path(self.lib).parent / "stray-model.gguf"
        stray.write_bytes(gguf())
        self.addCleanup(stray.unlink)
        obj, _err, code = run(self.env(MODELHUB_FAKE_OLLAMA_CMD_CODE="0"), "import-ollama",
                              "--id", "x", "--path", str(stray))
        self.assertFalse(obj["ok"])
        self.assertIn("gated model library", obj["error"])

    def test_import_of_an_admitted_gguf_creates_a_prometheus_tag(self) -> None:
        hf = FakeHF({"m.gguf": gguf()})
        self.addCleanup(hf.close)
        staged, _e, _c = run(self.env(hf), "stage-hf", "--id", "org/m8", "--repo", "org/m",
                             "--file", "m.gguf")
        self.assertTrue(staged["ok"], staged)
        obj, err, code = run(self.env(MODELHUB_FAKE_OLLAMA_CMD_CODE="0"), "import-ollama",
                             "--id", "org/m8", "--path", staged["weights"][0])
        self.assertTrue(obj["ok"], obj)
        self.assertEqual(obj["tag"], "prometheus/org-m8:latest")
        self.assertIn('"create"', err)



class Hug(_Base):
    def test_pick_gguf_prefers_the_quant_and_never_a_projector(self) -> None:
        files = {"m-Q8_0.gguf": {}, "mmproj-m-Q4_K_M.gguf": {}, "m-Q4_K_M.gguf": {},
                 "big/m-Q4_K_M-00002-of-00003.gguf": {}, "README.md": {}}
        self.assertEqual(model_acquire.pick_gguf(files, "Q4_K_M"), "m-Q4_K_M.gguf")
        self.assertEqual(model_acquire.pick_gguf(files, "q8_0"), "m-Q8_0.gguf")
        self.assertIsNone(model_acquire.pick_gguf(files, "IQ1_S"))

    def test_hug_ollama_is_staged_gated_and_imported(self) -> None:
        hf = FakeHF({"m-Q4_K_M.gguf": gguf(), "mmproj-m-Q4_K_M.gguf": gguf(), "m-Q8_0.gguf": gguf()})
        self.addCleanup(hf.close)
        obj, err, code = run(self.env(hf, MODELHUB_FAKE_OLLAMA_CMD_CODE="0"), "hug-ollama",
                             "--repo", "org/m:Q4_K_M", "--id", "org/m")
        self.assertTrue(obj["ok"], obj)
        self.assertTrue(obj["admitted"])
        self.assertEqual(obj["tag"], "prometheus/org-m:latest")
        downloaded = [r[0] for r in hf.requests if "/resolve/" in r[0]]
        self.assertEqual(len(downloaded), 1)
        self.assertTrue(downloaded[0].endswith("/m-Q4_K_M.gguf"))

    def test_hug_ollama_of_a_poisoned_gguf_is_never_imported(self) -> None:
        hf = FakeHF({"m-Q4_K_M.gguf": gguf("{{ ''.__class__.__mro__ }}")})
        self.addCleanup(hf.close)
        obj, err, code = run(self.env(hf, MODELHUB_FAKE_OLLAMA_CMD_CODE="0"), "hug-ollama",
                             "--repo", "org/m", "--id", "org/m9")
        self.assertFalse(obj["ok"])
        self.assertNotIn('"create"', err)


class ConvertSource(_Base):
    def test_code_refusal(self) -> None:
        d = Path(tempfile.mkdtemp(prefix="conv-src-"))
        self.addCleanup(shutil.rmtree, d, True)
        (d / "model.safetensors").write_bytes(b"x")
        self.assertIsNone(model_acquire.code_refusal(d))
        (d / "config.json").write_text(json.dumps({"auto_map": {"AutoModel": "m.M"}}))
        self.assertIn("auto_map", model_acquire.code_refusal(d) or "")
        (d / "config.json").write_text("{}")
        (d / "modeling_x.py").write_text("import os")
        self.assertIn("code", model_acquire.code_refusal(d) or "")

    def test_gate_marker_is_bound_to_the_exact_bytes(self) -> None:
        d = Path(tempfile.mkdtemp(prefix="conv-src-"))
        self.addCleanup(shutil.rmtree, d, True)
        (d / "config.json").write_text("{}")
        g = model_acquire.gate_dir(d)
        self.assertTrue(g["ok"], g)
        self.assertTrue(model_acquire.gate_marker_valid(d))
        (d / "config.json").write_text('{"changed": true}')
        self.assertFalse(model_acquire.gate_marker_valid(d))   # a later edit voids the scan


class Runtimes(_Base):
    def test_vendor_scripts_are_never_automatic(self) -> None:
        for rid, spec in model_acquire.RUNTIME_INSTALL.items():
            for fam in ("macos", "linux"):
                m = spec.get(fam)
                if m:
                    # official package channels, or Prometheus's own gated paths: pip wheels
                    # through nemesis into its venv (pip-venv), a pinned commit scanned by
                    # nemesis and built locally (source-build) — never a vendor script
                    self.assertIn(m[0], ("brew-formula", "brew-cask", "npm-global", "pip-venv",
                                         "source-build"), rid)
                    self.assertNotIn("|", m[1], rid)
                    if m[0] in ("pip-venv", "source-build"):
                        self.assertIn(rid, ("airllm", "colibri"), rid)

    def test_hermes_on_macos_is_manual_and_nothing_runs(self) -> None:
        obj, err, code = run({"MODELHUB_FORCE_OS": "macos", "MODELHUB_FORCE_NOT_INSTALLED": "1",
                              "MODELHUB_FAKE_INSTALL_CODE": "0"}, "install-runtime", "--runtime", "hermes")
        self.assertFalse(obj["ok"])
        self.assertTrue(obj["manual"])
        self.assertIn("install.sh", obj["install"])

    def test_plan_shows_the_exact_official_command(self) -> None:
        obj, _e, _c = run({"MODELHUB_FORCE_OS": "macos", "MODELHUB_FORCE_NOT_INSTALLED": "1"},
                          "install-runtime", "--runtime", "lmstudio", "--plan")
        if obj.get("manual"):
            self.skipTest("no Homebrew here")
        self.assertEqual(obj["argv"][1:], ["install", "--cask", "--require-sha", "lm-studio"])

    def test_unknown_runtime_fails_closed(self) -> None:
        obj, _e, code = run({}, "install-runtime", "--runtime", "evil;rm")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)


class Hardening(_Base):
    """Review findings 2026-11-02: forged admission records, WARN adopted as OK, a blob
    overwritten through a hard link, ledger hits that outlived a ruleset or an in-place rewrite."""

    def _store(self, layers: dict) -> tuple:
        """A fake Ollama store holding `x/y:latest` with the given {mediaType: [bytes,…]}."""
        store = Path(tempfile.mkdtemp(prefix="acq-ollama-"))
        self.addCleanup(shutil.rmtree, store, True)
        (store / "blobs").mkdir()
        entries, paths = [], []
        for media, bodies in layers.items():
            for body in bodies:
                dg = hashlib.sha256(body).hexdigest()
                blob = store / "blobs" / ("sha256-" + dg)
                blob.write_bytes(body)
                paths.append(blob)
                entries.append({"mediaType": media, "digest": "sha256:" + dg, "size": len(body)})
        mp = model_acquire.manifest_path("x/y:latest", store)
        mp.parent.mkdir(parents=True)
        mp.write_text(json.dumps({"layers": entries}))
        return store, paths

    def _gate(self, store: Path, verdict: dict, **kw) -> dict:
        from unittest import mock
        import nemesis_gate
        with mock.patch.dict(os.environ, {"MODELHUB_OLLAMA_MODELS": str(store),
                                          "PROMETHEUS_MODELS_HOME": self.lib,
                                          "MODELHUB_FAKE_OLLAMA_CMD_CODE": "0"}), \
                mock.patch.object(nemesis_gate, "nemesis_gate", return_value=dict(verdict)):
            return model_acquire.gate_ollama_model("x/y:latest", **kw)

    def test_a_linux_service_store_is_found_without_ollama_models(self) -> None:
        from unittest import mock
        home, svc = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, home, True)
        self.addCleanup(shutil.rmtree, svc, True)
        mp = model_acquire.manifest_path("qwen3:8b", svc)
        mp.parent.mkdir(parents=True)
        mp.write_text("{}")
        env = {k: v for k, v in os.environ.items() if k not in ("OLLAMA_MODELS", "MODELHUB_OLLAMA_MODELS")}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(model_acquire, "_OLLAMA_STORE_CANDIDATES", (home, svc)):
            self.assertEqual(model_acquire.ollama_store_for("qwen3:8b"), svc)
            self.assertEqual(model_acquire.ollama_models_dir(), svc)

    def test_hidden_and_control_character_paths_are_refused(self) -> None:
        for bad in (".prometheus_model.json", "sub/.prometheus_gate.json", ".hidden/m.gguf",
                    "m.gguf\nFROM /etc/passwd"):
            self.assertIsNotNone(model_acquire.file_refusal(bad), bad)
        self.assertIsNone(model_acquire.file_refusal("sub/m-Q4_K_M.gguf"))

    def test_a_record_planted_under_stage_or_quarantine_admits_nothing(self) -> None:
        for where in (".stage/org__x", ".stage/.quarantine/org__x.1"):
            d = Path(self.lib) / where
            d.mkdir(parents=True)
            (d / "m.gguf").write_bytes(gguf())
            (d / ".prometheus_model.json").write_text(json.dumps({"nemesis_verdict": "allow"}))
            obj, err, _code = run(self.env(MODELHUB_FAKE_OLLAMA_CMD_CODE="0"), "import-ollama",
                                  "--id", "x", "--path", str(d / "m.gguf"))
            self.assertFalse(obj["ok"], where)
            self.assertNotIn('"create"', err)

    def test_a_record_without_this_files_digest_admits_nothing(self) -> None:
        d = Path(self.lib) / "huggingface" / "org__forged"
        d.mkdir(parents=True)
        (d / "m.gguf").write_bytes(gguf())
        (d / ".prometheus_model.json").write_text(json.dumps({"nemesis_verdict": "allow"}))
        obj, _err, _code = run(self.env(MODELHUB_FAKE_OLLAMA_CMD_CODE="0"), "import-ollama",
                               "--id", "x", "--path", str(d / "m.gguf"))
        self.assertFalse(obj["ok"])

    def test_a_second_stage_of_an_admitted_model_downloads_nothing(self) -> None:
        hf = FakeHF({"m.gguf": gguf()})
        self.addCleanup(hf.close)
        first, _e, _c = run(self.env(hf), "stage-hf", "--id", "org/m11", "--repo", "org/m",
                            "--file", "m.gguf")
        self.assertTrue(first["ok"], first)
        n = len([r for r in hf.requests if "/resolve/" in r[0]])
        again, _e, _c = run(self.env(hf), "stage-hf", "--id", "org/m11", "--repo", "org/m",
                            "--file", "m.gguf")
        self.assertTrue(again["ok"] and again.get("cached"), again)
        self.assertEqual(len([r for r in hf.requests if "/resolve/" in r[0]]), n)
        # a changed upstream digest is NOT the admitted copy
        hf.lie["m.gguf"] = "f" * 64
        third, _e, _c = run(self.env(hf), "stage-hf", "--id", "org/m11", "--repo", "org/m",
                            "--file", "m.gguf")
        self.assertFalse(third.get("cached"), third)

    def test_a_file_changed_after_admission_is_not_imported(self) -> None:
        hf = FakeHF({"m.gguf": gguf()})
        self.addCleanup(hf.close)
        staged, _e, _c = run(self.env(hf), "stage-hf", "--id", "org/m10", "--repo", "org/m",
                             "--file", "m.gguf")
        self.assertTrue(staged["ok"], staged)
        Path(staged["weights"][0]).write_bytes(gguf("{{ swapped }}"))
        obj, err, _code = run(self.env(MODELHUB_FAKE_OLLAMA_CMD_CODE="0"), "import-ollama",
                              "--id", "org/m10", "--path", staged["weights"][0])
        self.assertFalse(obj["ok"], obj)
        self.assertNotIn('"create"', err)

    def test_a_planted_record_in_a_download_blocks_the_admission(self) -> None:
        import nemesis_gate
        from unittest import mock
        stage = Path(self.lib) / ".stage" / "org__p"
        stage.mkdir(parents=True)
        (stage / "m.gguf").write_bytes(gguf())
        (stage / ".prometheus_model.json").write_text("{}")
        with mock.patch.dict(os.environ, {"PROMETHEUS_MODELS_HOME": self.lib}):
            res = nemesis_gate.admit("org/p", staging=stage)
        self.assertFalse(res["admitted"])
        self.assertIn("record files", res["message"])

    def test_warn_is_not_adopted_unless_forced(self) -> None:
        store, _ = self._store({"application/vnd.ollama.image.model": [gguf()]})
        res = self._gate(store, {"verdict": "warn", "blocking_reasons": ["x"]}, keep=True)
        self.assertFalse(res["ok"], res)
        self.assertTrue(res.get("needs_confirm"))
        res = self._gate(store, {"verdict": "warn"}, keep=True, force=True)
        self.assertTrue(res["ok"], res)

    def test_model_findings_escalate_a_warn_to_block(self) -> None:
        store, _ = self._store({"application/vnd.ollama.image.model": [gguf()]})
        res = self._gate(store, {"verdict": "warn", "rule_ids": ["GGUF-TEMPLATE-INCLUDE"]}, keep=True)
        self.assertFalse(res["ok"])
        self.assertEqual(res["verdict"], "block")
        self.assertIn("GGUF-TEMPLATE-INCLUDE", res.get("model_findings", []))

    def test_two_template_layers_never_write_through_a_blob(self) -> None:
        from unittest import mock
        store, paths = self._store({"application/vnd.ollama.image.model": [gguf()],
                                    "application/vnd.ollama.image.template": [b"T1 {{ .Prompt }}",
                                                                              b"T2 {{ .System }}"]})
        before = {p: p.read_bytes() for p in paths}
        with mock.patch.object(model_acquire.os, "link", side_effect=OSError("cross-device")):
            res = self._gate(store, {"verdict": "allow"}, keep=True)
        self.assertTrue(res["ok"], res)
        for p, body in before.items():
            self.assertEqual(p.read_bytes(), body, f"{p.name} was rewritten")

    def test_a_ledger_allow_does_not_survive_an_in_place_rewrite(self) -> None:
        store, paths = self._store({"application/vnd.ollama.image.model": [gguf()]})
        first = self._gate(store, {"verdict": "allow"}, keep=True)
        self.assertTrue(first["ok"])
        again = self._gate(store, {"verdict": "allow"}, keep=True)
        self.assertTrue(again["scans"][0].get("cached"), again)
        st = paths[0].stat()
        paths[0].write_bytes(paths[0].read_bytes()[:-1] + b"X")
        os.utime(paths[0], ns=(st.st_atime_ns, st.st_mtime_ns))     # mtime put back
        third = self._gate(store, {"verdict": "allow"}, keep=True)
        self.assertFalse(third["scans"][0].get("cached"), "an in-place rewrite rode the old ALLOW")


class ReviewTwo(_Base):
    """Third review (2026-11-03): flag smuggling, WARN-only acceptance, stale reuse."""

    def test_a_flag_shaped_value_never_doubles_as_a_flag(self) -> None:
        for argv in (["pull", "--id", "--no-gate", "--tag", "qwen3:8b"],
                     ["pull", "--id", "x", "--tag", "--accept-warn"],
                     ["stage-hf", "--id", "--force", "--repo", "org/m", "--file", "m.gguf"]):
            obj, _e, code = run(self.env(), *argv)
            self.assertFalse(obj["ok"], argv)
            self.assertIn("needs a value", obj["error"])
            self.assertEqual(code, 2)

    def test_accept_warn_admits_a_warn_and_nothing_else(self) -> None:
        from unittest import mock
        import nemesis_gate
        for verdict, admitted in (("warn", True), ("block", False), ("error", False)):
            stage = Path(self.lib) / ".stage" / f"org__aw-{verdict}"
            stage.mkdir(parents=True)
            (stage / "m.gguf").write_bytes(gguf())
            with mock.patch.dict(os.environ, {"PROMETHEUS_MODELS_HOME": self.lib}), \
                    mock.patch.object(nemesis_gate, "nemesis_gate",
                                      return_value={"verdict": verdict, "risk_score": 10}):
                r = nemesis_gate.admit(f"org/aw-{verdict}", staging=stage, accept_warn=True)
            self.assertEqual(bool(r.get("admitted")), admitted, (verdict, r))

    def test_a_repo_with_no_gguf_at_all_says_so(self) -> None:
        hf = FakeHF({"model.safetensors": b"x", "config.json": b"{}"})
        self.addCleanup(hf.close)
        obj, _e, _c = run(self.env(hf), "stage-hf", "--id", "org/ng", "--repo", "org/m",
                          "--quant", "Q4_K_M")
        self.assertFalse(obj["ok"])
        self.assertTrue(obj.get("no_gguf"), obj)
        hf2 = FakeHF({"m-Q8_0.gguf": gguf()})
        self.addCleanup(hf2.close)
        obj, _e, _c = run(self.env(hf2), "stage-hf", "--id", "org/ng2", "--repo", "org/m",
                          "--quant", "Q4_K_M")
        self.assertFalse(obj.get("no_gguf"), "it HAS a GGUF, just not this quant")

    def test_reuse_of_an_admitted_copy_rehashes_and_needs_the_same_nemesis(self) -> None:
        """The copy PLACED in the Hugging Face cache is reused only while its bytes, its
        upstream digest and the nemesis that admitted it are all unchanged."""
        from unittest import mock
        import model_place
        import nemesis_gate
        hf = FakeHF({"m.gguf": gguf()})
        self.addCleanup(hf.close)
        first, _e, _c = run(self.env(hf), "stage-hf", "--id", "org/re", "--repo", "org/m",
                            "--file", "m.gguf")
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["placed"], "hf")
        want = {"m.gguf": hashlib.sha256(gguf()).hexdigest()}
        env = {k: v for k, v in self.env().items() if k != "MODELHUB_HF_BASE"}
        with mock.patch.dict(os.environ, env):
            hit = model_place.placed_for("org/re", ["m.gguf"], "org/m", first["revision"], want)
            self.assertIsNotNone(hit)
            self.assertIsNone(model_place.placed_for("org/re", ["m.gguf"], "org/m",
                                                     first["revision"], {"m.gguf": "f" * 64}))
            with mock.patch.object(nemesis_gate, "nemesis_identity", return_value="other"):
                self.assertIsNone(model_place.placed_for("org/re", ["m.gguf"], "org/m",
                                                         first["revision"], want))
            p = Path(first["weights"][0]).resolve()
            os.chmod(p, 0o644)
            body = bytearray(p.read_bytes())
            body[-1] ^= 1                          # same size, different bytes
            p.write_bytes(bytes(body))
            self.assertIsNone(model_place.placed_for("org/re", ["m.gguf"], "org/m",
                                                     first["revision"], want))

    def test_an_accepted_warn_is_remembered_for_the_same_bytes_only(self) -> None:
        h = Hardening()
        h.lib = self.lib
        h.addCleanup = self.addCleanup
        store, paths = h._store({"application/vnd.ollama.image.model": [gguf()]})
        self.assertFalse(h._gate(store, {"verdict": "warn"}, keep=True)["ok"])
        self.assertTrue(h._gate(store, {"verdict": "warn"}, keep=True, force=True)["ok"])
        again = h._gate(store, {"verdict": "warn"}, keep=True)
        self.assertTrue(again["ok"] and again.get("accepted_warn"), again)
        paths[0].write_bytes(paths[0].read_bytes() + b"\x00")
        self.assertFalse(h._gate(store, {"verdict": "warn"}, keep=True)["ok"])



class Placement(_Base):
    """The admitted bytes end up in the serving software's OWN folder, never the gate's."""

    def test_default_placement_is_the_hugging_face_cache(self) -> None:
        hf = FakeHF({"m.gguf": gguf()})
        self.addCleanup(hf.close)
        obj, _e, _c = run(self.env(hf), "stage-hf", "--id", "org/p1", "--repo", "org/m",
                          "--file", "m.gguf")
        self.assertTrue(obj["ok"], obj)
        self.assertEqual(obj["placed"], "hf")
        w = Path(obj["weights"][0])
        hub = Path(self.lib + "-hf-hub")
        self.assertIn(hub.resolve(), w.resolve().parents)
        self.assertEqual(w.resolve().name, hashlib.sha256(gguf()).hexdigest())
        # nothing left in the gate's library but the admission record
        live = Path(self.lib) / "huggingface" / "org__p1"
        self.assertEqual([p.name for p in live.iterdir()], [".prometheus_model.json"])

    def test_lm_studio_placement_is_a_real_file_in_its_folder(self) -> None:
        hf = FakeHF({"m.gguf": gguf()})
        self.addCleanup(hf.close)
        obj, _e, _c = run(self.env(hf), "stage-hf", "--id", "org/p2", "--repo", "org/m",
                          "--file", "m.gguf", "--place=lmstudio")
        self.assertTrue(obj["ok"], obj)
        w = Path(obj["weights"][0])
        self.assertEqual(w, Path(self.lib + "-lmstudio") / "org" / "m" / "m.gguf")
        self.assertTrue(w.is_file() and not w.is_symlink())
        verified, _e, code = run(self.env(), "verify-admitted", f"--path={w}")
        self.assertEqual(code, 0, verified)

    def test_ollama_route_keeps_one_copy_in_ollamas_store(self) -> None:
        hf = FakeHF({"m.gguf": gguf()})
        self.addCleanup(hf.close)
        staged, _e, _c = run(self.env(hf), "stage-hf", "--id", "org/p3", "--repo", "org/m",
                             "--file", "m.gguf", "--place=ollama")
        self.assertTrue(staged["ok"] and staged.get("transit"), staged)
        path = staged["weights"][0]
        obj, _err, _code = run(self.env(MODELHUB_FAKE_OLLAMA_CMD_CODE="0"), "import-ollama",
                               "--id", "org/p3", "--path", path)
        self.assertTrue(obj["ok"], obj)
        self.assertTrue(obj.get("transit_removed"), obj)
        self.assertFalse(Path(path).exists(), "after `ollama create` the transit copy is gone")

    def test_a_bad_place_is_refused(self) -> None:
        obj, _e, code = run(self.env(), "stage-hf", "--id", "x", "--repo", "org/m",
                            "--file", "m.gguf", "--place=prometheus")
        self.assertNotEqual(code, 0)
        self.assertIn("--place", obj["error"])

if __name__ == "__main__":
    unittest.main()
