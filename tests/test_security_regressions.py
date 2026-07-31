#!/usr/bin/env python3
"""test_security_regressions.py — regression tests for the 2026-06-29 security scout
fixes (option-injection, defang data-loss / trust-bypass, quarantine HMAC verify).
Pure stdlib (unittest). Run: python3 tests/test_security_regressions.py."""
import base64
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEMESIS = ROOT / "nemesis"


def _load_prometheus():
    spec = importlib.util.spec_from_file_location("prometheus_mod_sec", ROOT / "prometheus.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


P = _load_prometheus()


class TestTerminalCmdInjection(unittest.TestCase):
    """build_terminal_cmd must never let a prompt/model become an injected flag."""

    def test_positional_prompt_gets_ddash(self):
        argv, _env, _notes = P.build_terminal_cmd("claude", prompt="--dangerously-skip-permissions")
        self.assertIn("--", argv)
        self.assertLess(argv.index("--"), argv.index("--dangerously-skip-permissions"))

    def test_codex_positional_prompt_gets_ddash(self):
        argv, _env, _notes = P.build_terminal_cmd("codex", prompt="--yolo")
        self.assertIn("--", argv)
        self.assertLess(argv.index("--"), argv.index("--yolo"))

    def test_value_flag_cli_rejects_dash_prompt(self):
        # gemini's -p takes a VALUE; "--" would break it, so a dash-leading prompt is refused.
        with self.assertRaises(RuntimeError):
            P.build_terminal_cmd("gemini", prompt="--yolo")

    def test_dash_model_rejected(self):
        with self.assertRaises(RuntimeError):
            P.build_terminal_cmd("claude", model="-x")

    def test_normal_prompt_unaffected(self):
        argv, _env, _notes = P.build_terminal_cmd("gemini", prompt="hello there")
        self.assertIn("hello there", argv)


class TestSecureLooksRemote(unittest.TestCase):
    def test_leading_dash_not_remote(self):
        # "-x/y" must NOT be classed remote (it would be passed raw as the nemesis target).
        self.assertFalse(P._secure_looks_remote("-x/y"))

    def test_normal_owner_repo_is_remote(self):
        self.assertTrue(P._secure_looks_remote("owner/repo"))


class TestQuarantineRestoreHmac(unittest.TestCase):
    """_restore_quarantined must refuse a manifest whose HMAC doesn't verify."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        # redirect the pin/quarantine dirs into the tmp so we don't touch the real ones.
        self._saved = {k: getattr(P, k) for k in
                       ("_URL_QUARANTINE_DIR", "_URL_PIN_KEY_FILE", "_PROM_CFG_DIR")}
        P._PROM_CFG_DIR = Path(self.tmp) / "cfg"
        P._URL_QUARANTINE_DIR = P._PROM_CFG_DIR / "url_quarantine"
        P._URL_PIN_KEY_FILE = P._PROM_CFG_DIR / "pin.key"
        P._PROM_CFG_DIR.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(P, k, v)

    def _make_vault(self):
        import gzip
        qdir = P._URL_QUARANTINE_DIR / "vault1"
        qdir.mkdir(parents=True, exist_ok=True)
        orig = Path(self.tmp) / "restored_target.txt"
        stored = qdir / "blob.gz"
        stored.write_bytes(gzip.compress(b"original content\n"))
        man = {"schema": "prometheus.url_quarantine/1", "original_path": str(orig),
               "stored": str(stored), "mode": "drift-restore-blessed"}
        man["sig"] = P._sign_pin(man)
        P._write_json_atomic(qdir / "manifest.json", man)
        return qdir, orig

    def test_valid_signature_restores(self):
        qdir, orig = self._make_vault()
        # CLI-043: _restore_quarantined now returns a dict; a valid sig + clean blob (re-gates
        # 'allow') releases to the original path.
        r = P._restore_quarantined(str(qdir))
        self.assertTrue(r["ok"], r.get("error"))
        self.assertTrue(orig.exists())

    def test_tampered_path_refused(self):
        qdir, _orig = self._make_vault()
        # an attacker repoints original_path WITHOUT re-signing → must be refused.
        evil = Path(self.tmp) / "EVIL_WRITE.txt"
        man = json.loads((qdir / "manifest.json").read_text())
        man["original_path"] = str(evil)
        (qdir / "manifest.json").write_text(json.dumps(man))
        r = P._restore_quarantined(str(qdir))
        self.assertFalse(r["ok"])
        self.assertFalse(r["hmac_ok"])
        self.assertFalse(evil.exists())  # the arbitrary write never happened


class TestNemesisDefangSafety(unittest.TestCase):
    """nemesis defang must not destroy benign blobs nor spare a backslash-cloaked host."""

    def _defang(self, text, *extra):
        d = tempfile.mkdtemp()
        p = Path(d, "f.md")
        p.write_text(text)
        subprocess.run([sys.executable, str(NEMESIS), "defang", str(p), "--mode", "star",
                        "--scope", "urls", "--json", "--yes", *extra],
                       capture_output=True, text=True, timeout=120)
        return p.read_text()

    def test_benign_base64_preserved(self):
        secret = base64.b64encode(b"\x87\xa8\x82\x26http_no_scheme_marker_random_xyz").decode()
        out = self._defang(f'KEY = "{secret}"\nu = "https://evil.example.com/x"\n')
        self.assertIn(secret, out)                      # benign blob untouched
        self.assertNotIn("evil.example.com", out)       # real URL wiped

    def test_backslash_trusted_bypass_blocked(self):
        out = self._defang(
            r'a https://evil.com\@anthropic.com/p.sh b https://docs.anthropic.com/claude' + "\n",
            "--keep", "trusted")
        self.assertNotIn("evil.com", out)               # cloaked host no longer spared
        self.assertIn("docs.anthropic.com", out)        # genuine trusted kept


class TestSubprocessTimeout(unittest.TestCase):
    """CLI-077: every subprocess site is timeout-bounded; a hung child is killed cleanly."""

    def test_hung_child_killed_at_timeout(self):
        t0 = time.monotonic()
        cp = P._run_timed([sys.executable, "-c", "import time; time.sleep(30)"],
                          timeout=1, capture_output=True, text=True)
        elapsed = time.monotonic() - t0
        self.assertEqual(cp.returncode, 124)          # clean timeout sentinel, not a traceback
        self.assertLess(elapsed, 10, "child must be killed at ~1s, not run the full 30s")

    def test_no_subprocess_run_without_timeout(self):
        # acceptance: every `subprocess.run(...)` in prometheus.py carries an explicit timeout=.
        import ast
        tree = ast.parse((ROOT / "prometheus.py").read_text())
        missing = []
        for n in ast.walk(tree):
            if (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                    and n.func.attr in {"run", "check_output", "check_call", "call"}
                    and isinstance(n.func.value, ast.Name) and n.func.value.id == "subprocess"
                    and "timeout" not in {k.arg for k in n.keywords}):
                missing.append(n.lineno)
        self.assertEqual(missing, [], f"subprocess.* without timeout= at lines {missing}")


class TestOversizedInert(unittest.TestCase):
    """CLI-077: a file past the 8MiB scan window can never back an INERT claim."""

    def test_oversized_file_not_reported_inert(self):
        d = tempfile.mkdtemp()
        p = Path(d, "big.txt")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("x\n" * (5 * 1024 * 1024))               # ~10 MiB of filler
            fh.write("https://late.example/beyond-the-window\n")  # a URL PAST the scan window
        r = subprocess.run([sys.executable, str(NEMESIS), "defang", str(p),
                            "--rescan", "--json", "--yes"],
                           capture_output=True, text=True, timeout=300)
        env = json.loads(r.stdout)
        self.assertGreaterEqual(env.get("url_findings_oversized", 0), 1)
        self.assertFalse(env.get("inert", True), "an oversized file must not be claimed INERT")


class TestServeDeepGate(unittest.TestCase):
    """CLI-077: serve_steps launch is preceded by a deep tree gate; BLOCK refuses to launch."""

    def test_serve_tree_gate_blocks_launch(self):
        d = tempfile.mkdtemp()
        live = Path(d, "live")
        live.mkdir()
        (live / "x.py").write_text("print(1)\n")
        t = types.SimpleNamespace(id="ft", name="FakeTool")
        lay = types.SimpleNamespace(live=live)
        orig = P.security_gate
        try:
            P.security_gate = lambda rep, host: False        # gate BLOCK
            self.assertFalse(P._serve_tree_gate_ok(t, lay), "BLOCK must refuse the launch")
            P.security_gate = lambda rep, host: True         # gate allow
            self.assertTrue(P._serve_tree_gate_ok(t, lay))
        finally:
            P.security_gate = orig


if __name__ == "__main__":
    unittest.main(verbosity=2)
