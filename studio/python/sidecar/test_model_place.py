"""test_model_place.py — admitted weights end up in the runtime's OWN folder, once.

Every store is a temp dir (`_test_stores` + per-test overrides); nothing touches the real
Hugging Face cache, LM Studio folder or Ollama store."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import _test_stores  # noqa: E402,F401 — every model store is a temp dir
import model_acquire  # noqa: E402
import model_place  # noqa: E402
import nemesis_gate  # noqa: E402


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="place-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self._saved = {k: os.environ.get(k) for k in
                       ("PROMETHEUS_MODELS_HOME", "HF_HUB_CACHE", "LMSTUDIO_MODELS_DIR", "HOME",
                        "LLAMA_CACHE")}
        os.environ.update(PROMETHEUS_MODELS_HOME=f"{self.tmp}/gate", HF_HUB_CACHE=f"{self.tmp}/hf",
                          LMSTUDIO_MODELS_DIR=f"{self.tmp}/lms", LLAMA_CACHE=f"{self.tmp}/llama",
                          HOME=self.tmp)

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def admit(self, files: dict, model_id: str = "m") -> tuple[Path, dict]:
        live = nemesis_gate.models_root() / "huggingface" / model_id
        live.mkdir(parents=True)
        for rel, data in files.items():
            (live / rel).parent.mkdir(parents=True, exist_ok=True)
            (live / rel).write_bytes(data)
        nemesis_gate._write_manifest(
            live, model_id=model_id, source="huggingface", quant=None, license=None,
            verdict="allow", gate={}, format_risk={}, checksum=None, forced=False,
            files_sha256={r: hashlib.sha256(d).hexdigest() for r, d in files.items()},
        )
        rec = json.loads((live / ".prometheus_model.json").read_text())
        return live, rec


class HfCacheTests(_Base):
    def test_layout_is_hugging_faces_own(self) -> None:
        live, rec = self.admit({"w.safetensors": b"weights", "config.json": b"{}"})
        out = model_place.place("m", live, rec, "hf", "org/name", "c" * 40)
        repo = Path(self.tmp) / "hf" / "models--org--name"
        snap = repo / "snapshots" / ("c" * 40)
        self.assertEqual(out["local_path"], str(snap))
        self.assertEqual((repo / "refs" / "main").read_text(), "c" * 40)
        w = snap / "w.safetensors"
        self.assertTrue(w.is_symlink())
        self.assertFalse(os.path.isabs(os.readlink(w)), "HF snapshot links are relative")
        self.assertEqual(w.resolve().name, hashlib.sha256(b"weights").hexdigest(),
                         "an LFS blob is named by its sha256")
        cfg = (snap / "config.json").resolve()
        self.assertEqual(cfg.name, model_place.git_blob_sha1(cfg), "a small file by its git oid")
        # the gate library keeps the admission record only — no weights
        self.assertEqual(sorted(p.name for p in live.iterdir()), [".prometheus_model.json"])
        self.assertIsNotNone(model_acquire.admitted_manifest(w))
        self.assertIsNotNone(model_acquire.admitted_dir(snap))

    def test_tampering_or_an_added_file_is_not_admitted(self) -> None:
        live, rec = self.admit({"w.safetensors": b"weights", "config.json": b"{}"})
        out = model_place.place("m", live, rec, "hf", "org/name", "c" * 40)
        snap = Path(out["local_path"])
        (snap / "modeling_evil.py").write_text("import os\n")
        self.assertIsNone(model_acquire.admitted_dir(snap))
        (snap / "modeling_evil.py").unlink()
        blob = (snap / "w.safetensors").resolve()
        blob.write_bytes(b"WEIGHTS")
        self.assertIsNone(model_acquire.admitted_manifest(snap / "w.safetensors"))
        self.assertIsNone(model_acquire.admitted_dir(snap))

    def test_an_existing_identical_copy_is_reused_not_duplicated(self) -> None:
        sha = hashlib.sha256(b"weights").hexdigest()
        blob = Path(self.tmp) / "hf" / "models--org--name" / "blobs" / sha
        blob.parent.mkdir(parents=True)
        blob.write_bytes(b"weights")              # e.g. downloaded earlier by `hf download`
        live, rec = self.admit({"w.safetensors": b"weights"})
        out = model_place.place("m", live, rec, "hf", "org/name", "d" * 40)
        self.assertEqual(out["deduped"], ["w.safetensors"])
        self.assertEqual(len(list(blob.parent.iterdir())), 1, "one copy on disk")
        self.assertFalse((live / "w.safetensors").exists())

    def test_existing_refs_main_is_never_rewritten(self) -> None:
        ref = Path(self.tmp) / "hf" / "models--org--name" / "refs" / "main"
        ref.parent.mkdir(parents=True)
        ref.write_text("e" * 40)
        live, rec = self.admit({"w.safetensors": b"weights"})
        model_place.place("m", live, rec, "hf", "org/name", "c" * 40)
        self.assertEqual(ref.read_text(), "e" * 40)


class LmStudioTests(_Base):
    def test_real_files_under_publisher_repo(self) -> None:
        live, rec = self.admit({"m-Q4_K_M.gguf": b"gguf"})
        out = model_place.place("m", live, rec, "lmstudio", "bartowski/Some-GGUF", "c" * 40)
        f = Path(self.tmp) / "lms" / "bartowski" / "Some-GGUF" / "m-Q4_K_M.gguf"
        self.assertEqual(out["weights"], [str(f)])
        self.assertTrue(f.is_file() and not f.is_symlink())
        self.assertIsNotNone(model_acquire.admitted_manifest(f))

    def test_a_different_file_already_there_is_never_overwritten(self) -> None:
        f = Path(self.tmp) / "lms" / "org" / "r" / "m.gguf"
        f.parent.mkdir(parents=True)
        f.write_bytes(b"the user's own file")
        live, rec = self.admit({"m.gguf": b"gguf"})
        with self.assertRaises(FileExistsError):
            model_place.place("m", live, rec, "lmstudio", "org/r", "c" * 40)
        self.assertEqual(f.read_bytes(), b"the user's own file")
        self.assertTrue((live / "m.gguf").is_file(), "the admitted bytes stay where they were")

    def test_home_pointer_is_honoured(self) -> None:
        os.environ.pop("LMSTUDIO_MODELS_DIR")
        (Path(self.tmp) / ".lmstudio-home-pointer").write_text(f"{self.tmp}/elsewhere\n")
        self.assertEqual(model_place.lmstudio_models_root(), Path(self.tmp) / "elsewhere" / "models")


class LedgerTests(_Base):
    def test_an_unknown_or_unsigned_tampered_entry_is_refused(self) -> None:
        stray = Path(self.tmp) / "stray.gguf"
        stray.write_bytes(b"x")
        self.assertIsNone(model_place.verify_file(stray))
        live, rec = self.admit({"m.gguf": b"gguf"})
        out = model_place.place("m", live, rec, "lmstudio", "org/r", "c" * 40)
        doc = json.loads(model_place._ledger_path().read_text())
        key = next(iter(doc["files"]))
        doc["files"][key]["verdict"] = "block"
        model_place._ledger_path().write_text(json.dumps(doc))
        self.assertIsNone(model_place.verify_file(Path(out["weights"][0])))

    def test_share_hard_links_one_copy_into_a_second_store(self) -> None:
        live, rec = self.admit({"m.gguf": b"gguf"})
        out = model_place.place("m", live, rec, "hf", "org/r", "c" * 40)
        src = Path(out["weights"][0])
        dest = Path(self.tmp) / "lms" / "org" / "r" / "m.gguf"
        how = model_place.share(src, dest, "lmstudio", model_place.gate_meta(
            model_acquire.admitted_manifest(src) or {}))
        self.assertIn(how, ("linked", "copied"))
        if how == "linked":
            self.assertEqual(dest.stat().st_ino, src.resolve().stat().st_ino, "same bytes, two names")
        self.assertIsNotNone(model_acquire.admitted_manifest(dest))


class TransitTests(_Base):
    def test_ollama_transit_copy_is_removed_once_imported(self) -> None:
        live, _rec = self.admit({"m.gguf": b"gguf"})
        removed = model_acquire._drop_transit_copy(live / "m.gguf")
        self.assertEqual([Path(r).resolve() for r in removed], [(live / "m.gguf").resolve()])
        self.assertFalse((live / "m.gguf").exists())
        self.assertTrue((live / ".prometheus_model.json").exists(), "the record is kept")

    def test_a_file_outside_the_gate_library_is_never_deleted(self) -> None:
        mine = Path(self.tmp) / "mine.gguf"
        mine.write_bytes(b"x")
        self.assertEqual(model_acquire._drop_transit_copy(mine), [])
        self.assertTrue(mine.exists())


class SafetyTests(_Base):
    def test_an_old_link_to_the_admitted_file_is_replaced_never_followed_to_delete(self) -> None:
        live, rec = self.admit({"m.gguf": b"gguf"})
        dest = Path(self.tmp) / "lms" / "org" / "r" / "m.gguf"
        dest.parent.mkdir(parents=True)
        os.symlink(live / "m.gguf", dest)   # what the old install-target fallback created
        model_place.place("m", live, rec, "lmstudio", "org/r", "c" * 40)
        self.assertTrue(dest.is_file() and not dest.is_symlink())
        self.assertEqual(dest.read_bytes(), b"gguf", "the only copy survived")

    def test_block_verdicts_and_non_commit_revisions_are_never_placed(self) -> None:
        live, rec = self.admit({"m.gguf": b"gguf"})
        with self.assertRaises(PermissionError):
            model_place.place("m", live, {**rec, "nemesis_verdict": "block", "forced": True},
                              "lmstudio", "org/r", "c" * 40)
        for bad in ("main", "../../../../tmp/x", "c" * 39):
            with self.assertRaises(ValueError):
                model_place.place("m", live, rec, "hf", "org/r", bad)
        self.assertTrue((live / "m.gguf").is_file())

    def test_lfs_files_are_named_by_sha256_like_hugging_face_does(self) -> None:
        live, rec = self.admit({"w.safetensors": b"w", "tokenizer.model": b"tok", "config.json": b"{}"})
        out = model_place.place("m", live, rec, "hf", "org/name", "c" * 40,
                                lfs={"w.safetensors", "tokenizer.model"})
        snap = Path(out["local_path"])
        self.assertEqual((snap / "tokenizer.model").resolve().name, hashlib.sha256(b"tok").hexdigest())
        self.assertEqual((snap / "config.json").resolve().name,
                         model_place.git_blob_sha1((snap / "config.json").resolve()))

    def test_lm_studios_own_folder_setting_wins(self) -> None:
        os.environ.pop("LMSTUDIO_MODELS_DIR")
        cfg = Path(self.tmp) / ".lmstudio" / "apps" / "bionic" / "settings.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(json.dumps({"downloadsFolder": f"{self.tmp}/Volumes/big/models"}))
        self.assertEqual(model_place.lmstudio_models_root(), Path(self.tmp) / "Volumes" / "big" / "models")

    def test_a_refused_file_leaves_earlier_placements_recorded(self) -> None:
        live, rec = self.admit({"a.gguf": b"a", "b.gguf": b"b"})
        clash = Path(self.tmp) / "lms" / "org" / "r" / "b.gguf"
        clash.parent.mkdir(parents=True)
        clash.write_bytes(b"someone else's")
        with self.assertRaises(FileExistsError):
            model_place.place("m", live, rec, "lmstudio", "org/r", "c" * 40)
        self.assertIsNotNone(model_place.verify_file(clash.parent / "a.gguf"), "a.gguf is still vouched for")

    def test_share_across_filesystems_links_instead_of_copying(self) -> None:
        live, rec = self.admit({"m.gguf": b"gguf"})
        out = model_place.place("m", live, rec, "hf", "org/r", "c" * 40)
        src = Path(out["weights"][0])
        dest = Path(self.tmp) / "lms" / "org" / "r" / "m.gguf"
        real_link = os.link
        os.link = lambda *a, **k: (_ for _ in ()).throw(OSError(18, "cross-device"))  # type: ignore[assignment]
        try:
            how = model_place.share(src, dest, "lmstudio", model_place.gate_meta(
                model_acquire.admitted_manifest(src) or {}))
        finally:
            os.link = real_link  # type: ignore[assignment]
        self.assertEqual(how, "symlinked")
        self.assertTrue(dest.is_symlink())
        self.assertIsNotNone(model_acquire.admitted_manifest(dest))


class MigrationTests(_Base):
    def _run(self, fn, argv):
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            fn(argv)
        return json.loads(buf.getvalue().strip().splitlines()[-1])

    def test_legacy_library_weights_move_into_runtime_stores_now(self) -> None:
        os.environ["MODELHUB_HF_BASE"] = "http://127.0.0.1:9"     # no network: no commit found
        self.addCleanup(os.environ.pop, "MODELHUB_HF_BASE", None)
        g_live, _ = self.admit({"m-Q4_K_M.gguf": b"gguf"}, model_id="legacy-gguf")
        d_live, _ = self.admit({"model.safetensors": b"w", "config.json": b"{}"}, model_id="legacy-mlx")
        plan = self._run(model_acquire.v_migrate_library, ["--plan"])
        self.assertEqual(plan["moved"], 2)
        self.assertTrue((g_live / "m-Q4_K_M.gguf").is_file(), "--plan moves nothing")
        out = self._run(model_acquire.v_migrate_library, [])
        targets = {r["id"]: r["target"] for r in out["models"]}
        self.assertEqual(targets, {"legacy-gguf": "llamacpp", "legacy-mlx": "lmstudio"})
        gguf = Path(self.tmp) / "llama" / "m-Q4_K_M.gguf"
        self.assertIsNotNone(model_acquire.admitted_manifest(gguf))
        self.assertEqual(model_place.library_weights(g_live), [])
        self.assertEqual(model_place.library_weights(d_live), [])
        self.assertIsNotNone(model_acquire.admitted_dir(Path(self.tmp) / "lms" / "local" / "legacy-mlx"))
        again = self._run(model_acquire.v_migrate_library, [])
        self.assertEqual(again["models"], [], "idempotent")

    def test_old_stage_leftovers_are_swept_fresh_ones_kept(self) -> None:
        stage = nemesis_gate.models_root() / ".stage" / "x"
        stage.mkdir(parents=True)
        (stage / "old.gguf.part").write_bytes(b"0" * 10)
        os.utime(stage / "old.gguf.part", (1, 1))
        (stage / "new.gguf.part").write_bytes(b"1")
        out = self._run(model_acquire.v_discard_stage, [])
        self.assertEqual([Path(r["path"]).name for r in out["removed"]], ["old.gguf.part"])
        self.assertTrue((stage / "new.gguf.part").exists())


class ZeroCopyOllamaTests(_Base):
    """A fake daemon on loopback: the transit GGUF must END UP as Ollama's blob (same inode),
    with no copy, and the model created from its digest."""

    def setUp(self) -> None:
        super().setUp()
        import http.server
        import threading
        self.store = Path(self.tmp) / "ollama"
        (self.store / "blobs").mkdir(parents=True)
        self.created: list = []
        test = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):  # noqa: D401
                pass

            def do_GET(self):
                self.send_response(200 if self.path == "/api/version" else 404)
                self.end_headers()
                self.wfile.write(b'{"version":"0.40.13"}')

            def do_HEAD(self):
                d = self.path.rsplit("sha256:", 1)[-1]
                self.send_response(200 if (test.store / "blobs" / f"sha256-{d}").exists() else 404)
                self.end_headers()

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                test.created.append(body)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"success"}')

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.shutdown)
        for k, v in (("MODELHUB_ZERO_COPY_TEST", "1"), ("OLLAMA_HOST", f"127.0.0.1:{self.srv.server_port}"),
                     ("MODELHUB_OLLAMA_MODELS", str(self.store))):
            self._saved.setdefault(k, os.environ.get(k))
            os.environ[k] = v

    def test_transit_gguf_becomes_the_blob_without_a_copy(self) -> None:
        live, rec = self.admit({"m.gguf": b"gguf-bytes"})
        src = live / "m.gguf"
        ino = src.stat().st_ino
        mf = model_acquire.admitted_manifest(src)
        out = model_acquire.zero_copy_import(src, mf, "prometheus/m")
        digest = hashlib.sha256(b"gguf-bytes").hexdigest()
        blob = self.store / "blobs" / f"sha256-{digest}"
        self.assertEqual(out, {"method": "moved", "blob": str(blob)})
        self.assertEqual(blob.stat().st_ino, ino, "renamed, not copied")
        self.assertFalse(src.exists())
        self.assertEqual(self.created, [{"model": "prometheus/m", "files": {"m.gguf": f"sha256:{digest}"},
                                         "stream": False}])

    def test_a_file_another_runtime_uses_is_hard_linked_and_kept(self) -> None:
        live, rec = self.admit({"m.gguf": b"shared"})
        out = model_place.place("m", live, rec, "hf", "org/r", "c" * 40)
        src = Path(out["weights"][0])
        zc = model_acquire.zero_copy_import(src, model_acquire.admitted_manifest(src), "prometheus/m")
        self.assertEqual(zc["method"], "linked")
        self.assertTrue(src.exists())
        self.assertEqual(Path(zc["blob"]).stat().st_ino, src.resolve().stat().st_ino, "one set of bytes")

    def test_a_daemon_that_cannot_see_the_blob_gets_everything_undone(self) -> None:
        live, rec = self.admit({"m.gguf": b"gguf-bytes"})
        src = live / "m.gguf"
        os.environ["MODELHUB_OLLAMA_MODELS"] = str(Path(self.tmp) / "elsewhere")
        (Path(self.tmp) / "elsewhere" / "blobs").mkdir(parents=True)
        self.assertIsNone(model_acquire.zero_copy_import(src, model_acquire.admitted_manifest(src), "x"))
        self.assertTrue(src.is_file(), "moved back for the `ollama create` fallback")
        self.assertEqual(self.created, [])


class OneCopyFormatsTests(_Base):
    def test_mistral_repos_fetch_the_weights_once(self) -> None:
        got = model_acquire.drop_duplicate_formats(
            ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors",
             "consolidated.safetensors", "config.json"])
        self.assertNotIn("consolidated.safetensors", got)
        self.assertEqual(model_acquire.drop_duplicate_formats(["consolidated.safetensors"]),
                         ["consolidated.safetensors"], "the only copy is kept")

    def test_airllm_split_becomes_the_only_copy(self) -> None:
        import contextlib
        import io
        import stream_runtimes
        self._saved.setdefault("PROMETHEUS_TOOLS_DIR", os.environ.get("PROMETHEUS_TOOLS_DIR"))
        os.environ["PROMETHEUS_TOOLS_DIR"] = f"{self.tmp}/tools"
        files = {"model-00001-of-00002.safetensors": b"A" * 64, "model-00002-of-00002.safetensors": b"B" * 64,
                 "model.safetensors.index.json": b"{}", "config.json": b"{}"}
        live, rec = self.admit(files, model_id="big")
        out = model_place.place("big", live, rec, "hf", "org/big", "c" * 40,
                                lfs={"model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors"})
        snap = Path(out["local_path"])
        layers = stream_runtimes.airllm_layers_dir("big")
        (layers / "splitted_model").mkdir(parents=True)
        (layers / "splitted_model" / "model.layers.0.safetensors").write_bytes(b"L0")
        (layers / ".prometheus-layers.json").write_text(json.dumps(
            {"sha256": {"splitted_model/model.layers.0.safetensors": hashlib.sha256(b"L0").hexdigest()}}))

        def run(fn, argv):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                fn(argv)
            return json.loads(buf.getvalue().strip().splitlines()[-1])

        res = run(stream_runtimes.v_airllm_consolidate, ["--id=big", f"--model={snap}"])
        self.assertTrue(res["consolidated"], res)
        self.assertEqual(res["freed_bytes"], 128)
        self.assertEqual(list((snap.parent.parent / "blobs").glob(hashlib.sha256(b"A" * 64).hexdigest())), [])
        self.assertIsNotNone(model_acquire.admitted_dir(snap), "the slim snapshot is still vouched for")
        self.assertIsNone(stream_runtimes._split_refusal(layers, "big", snap))
        self.assertIsNotNone(stream_runtimes._split_refusal(layers, "other-id", snap))
        (layers / "splitted_model" / "model.layers.0.safetensors").write_bytes(b"XX")
        self.assertIsNotNone(stream_runtimes._split_refusal(layers, "big", snap), "a changed split is refused")


class RemovePlacedTests(_Base):
    def test_remove_deletes_exactly_what_was_placed_and_frees_the_bytes(self) -> None:
        live, rec = self.admit({"w.safetensors": b"w" * 32, "config.json": b"{}"})
        out = model_place.place("m", live, rec, "hf", "org/name", "c" * 40, lfs={"w.safetensors"})
        repo = Path(self.tmp) / "hf" / "models--org--name"
        mine = Path(self.tmp) / "hf" / "models--org--other" / "keep.txt"
        mine.parent.mkdir(parents=True)
        mine.write_text("the user's")
        res = model_place.remove_placed("m")
        self.assertEqual(len(res["removed"]), 2)
        self.assertGreaterEqual(res["freed_bytes"], 32)
        self.assertFalse(repo.exists(), "the emptied repo dir is tidied away")
        self.assertTrue(mine.exists(), "nothing that was not placed is touched")
        self.assertIsNone(model_acquire.admitted_dir(Path(out["local_path"])))
        self.assertEqual(model_place.remove_placed("m")["removed"], [])

    def test_a_hard_linked_ollama_blob_keeps_the_bytes(self) -> None:
        live, rec = self.admit({"m.gguf": b"g" * 16})
        out = model_place.place("m", live, rec, "lmstudio", "org/r", "c" * 40)
        f = Path(out["weights"][0])
        blob = Path(self.tmp) / "ollama-blob"
        os.link(f, blob)                     # what the zero-copy Ollama import does
        res = model_place.remove_placed("m")
        self.assertEqual(res["freed_bytes"], 0, "Ollama still uses those bytes")
        self.assertEqual(blob.read_bytes(), b"g" * 16)
        self.assertFalse(f.exists())


class SeamTests(unittest.TestCase):
    def test_test_seams_never_reach_a_real_run(self) -> None:
        import subprocess
        code = "import _envelope, os; print(os.environ.get('MODELHUB_FAKE_INSTALL_LINES'), _envelope.under_test_harness())"
        env = {**os.environ, "MODELHUB_FAKE_INSTALL_LINES": "x"}
        inside = subprocess.run([sys.executable, "-c", code], cwd=HERE, env=env, capture_output=True, text=True)
        self.assertEqual(inside.stdout.split(), ["x", "True"])
        env.pop("MODELHUB_TEST_TOKEN")
        outside = subprocess.run([sys.executable, "-c", code], cwd=HERE, env=env, capture_output=True, text=True)
        self.assertEqual(outside.stdout.split(), ["None", "False"], "stripped without the harness marker")
        env["MODELHUB_TEST_TOKEN"] = "forged"
        forged = subprocess.run([sys.executable, "-c", code], cwd=HERE, env=env, capture_output=True, text=True)
        self.assertEqual(forged.stdout.split(), ["None", "False"])


if __name__ == "__main__":
    unittest.main()
