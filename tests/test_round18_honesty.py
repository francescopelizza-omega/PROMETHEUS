"""Round-18 regressions: three verbs that answered confidently about work they had not done.

* `model serve <any-string>` built a runnable ServeProfile with a FITS verdict for a model that
  does not exist (`params_b` fell back to 0.0, so a zero-byte model "fits").
* `nemesis verify <non-utf8-file>` printed a raw Python traceback and exited 1 ("signature
  INVALID") for a file it had never managed to read.
* `structsearch match` silently dropped files it could not decode or parse, so a genuine
  no-match and "2 of your 3 files were never searched" were the same envelope.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "studio" / "python" / "sidecar"
NEMESIS = ROOT / "nemesis"


def _sidecar(script, *args):
    out = subprocess.run(
        [sys.executable, str(SIDECAR / script), *args],
        capture_output=True, text=True, timeout=300, cwd=str(ROOT),
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


class TestModelServeRefusesUnknownIds(unittest.TestCase):
    def test_an_unknown_id_is_refused_not_fabricated(self):
        env = _sidecar("modelhub.py", "serve", "--id", "zzz-not-a-model")
        self.assertFalse(env.get("ok"), f"a nonexistent model produced a profile: {env}")
        self.assertIn("unknown model id", env.get("error", ""))
        self.assertNotIn("fit", env, "no fit verdict may be computed for a model we cannot size")

    def test_a_path_shaped_id_is_refused_the_same_way(self):
        env = _sidecar("modelhub.py", "serve", "--id", "../../etc/passwd")
        self.assertFalse(env.get("ok"))
        self.assertIn("unknown model id", env.get("error", ""))

    def test_an_explicit_gguf_path_is_still_allowed(self):
        with tempfile.TemporaryDirectory() as d:
            gguf = Path(d, "local.gguf")
            gguf.write_bytes(b"x")
            env = _sidecar("modelhub.py", "serve", "--id", "my-local-thing", "--gguf", str(gguf))
            self.assertTrue(env.get("ok"), f"the --gguf escape hatch was refused: {env}")
            self.assertIn("profile", env)


class TestNemesisVerifyCannotRead(unittest.TestCase):
    def _run(self, path):
        return subprocess.run(
            [sys.executable, str(NEMESIS), "verify", str(path)],
            capture_output=True, text=True, timeout=300, cwd=str(ROOT),
        )

    def test_a_non_utf8_file_is_cannot_read_exit_2_with_no_traceback(self):
        with tempfile.TemporaryDirectory() as d:
            binf = Path(d, "bin.dat")
            binf.write_bytes(os.urandom(4096))
            out = self._run(binf)
            self.assertNotIn("Traceback", out.stdout + out.stderr, "a raw traceback reached the user")
            self.assertEqual(out.returncode, 2, "cannot-read must be 2, not 1 (signature invalid)")
            self.assertIn("cannot read verdict", out.stderr)

    def test_a_missing_file_is_also_cannot_read(self):
        out = self._run("/tmp/prom-r18-definitely-not-here.json")
        self.assertEqual(out.returncode, 2)
        self.assertIn("cannot read verdict", out.stderr)

    def test_a_READABLE_but_unsigned_verdict_is_still_signature_invalid(self):
        # self-validating: if everything became 2, the two outcomes would be indistinguishable.
        with tempfile.TemporaryDirectory() as d:
            v = Path(d, "v.json")
            v.write_text('{"verdict":"allow","target":"x"}')
            out = self._run(v)
            self.assertEqual(out.returncode, 1, "a readable-but-unsigned verdict is exit 1")


class TestStructsearchReportsUnreadableFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="prom-ssx-"))
        (self.tmp / "good.py").write_text(
            "class A:\n    def m(self,x): return x\ndef f(a):\n    return A().m(a)\n"
        )
        # WOULD match if it parsed — so dropping it silently makes the count wrong, not just thin.
        (self.tmp / "broken.py").write_text("def broken(:\n  A().m(1)\n")
        (self.tmp / "binary.py").write_bytes(os.urandom(4096))

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_files_that_could_not_be_read_or_parsed_are_reported(self):
        env = _sidecar("structsearch.py", "match", "--path", str(self.tmp), "--pattern", "A().m($X)")
        self.assertTrue(env.get("ok"))
        self.assertEqual(env["count"], 1)
        names = sorted(Path(u["file"]).name for u in env.get("unreadable", []))
        self.assertEqual(names, ["binary.py", "broken.py"], f"unreported skips: {env}")
        for u in env["unreadable"]:
            self.assertTrue(u.get("reason"), "a skip must say WHY")

    def test_a_clean_tree_reports_an_EMPTY_list_not_a_missing_key(self):
        clean = self.tmp / "clean"
        clean.mkdir()
        (clean / "a.py").write_text("def f():\n    pass\n")
        env = _sidecar("structsearch.py", "match", "--path", str(clean), "--pattern", "A().m($X)")
        self.assertEqual(env.get("unreadable"), [], "the key must always ride the envelope")

    def test_replace_carries_it_too(self):
        env = _sidecar(
            "structsearch.py", "replace", "--path", str(self.tmp),
            "--pattern", "A().m($X)", "--rewrite", "A().n($X)",
        )
        self.assertEqual(len(env.get("unreadable", [])), 2)


if __name__ == "__main__":
    unittest.main()
