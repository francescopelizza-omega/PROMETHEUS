"""Follow-up round: engine verbs that answered confidently about work they had not done.

Each of these was reported by a hunt whose verification stage never ran, and each was then
re-confirmed here by execution before being fixed.
"""

import http.server
import importlib.util
import json
import subprocess
import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _engine():
    spec = importlib.util.spec_from_file_location("prom_mod", ROOT / "prometheus.py")
    m = importlib.util.module_from_spec(spec)
    sys.modules["prom_mod"] = m
    spec.loader.exec_module(m)
    return m


class TestSshdDirectiveParsing(unittest.TestCase):
    """`harden` read sshd_config with a substring match, so the COMMENTED default matched."""

    def setUp(self):
        self.f = _engine()._sshd_directive

    def test_a_commented_default_is_not_a_finding(self):
        # every stock sshd_config ships `#PasswordAuthentication yes`; reporting it is a FALSE
        # security alarm, which is worse than silence because it teaches the user to ignore output
        self.assertIsNone(self.f("#PasswordAuthentication yes\n", "passwordauthentication"))

    def test_a_genuinely_enabled_directive_IS_still_detected(self):
        # the control: if everything became None the check would be silently disabled
        self.assertEqual(self.f("PasswordAuthentication yes\n", "passwordauthentication"), "yes")

    def test_first_occurrence_wins_as_sshd_does(self):
        text = "PasswordAuthentication no\nPasswordAuthentication yes\n"
        self.assertEqual(self.f(text, "passwordauthentication"), "no")

    def test_equals_and_whitespace_forms(self):
        self.assertEqual(self.f("PasswordAuthentication=yes\n", "passwordauthentication"), "yes")
        self.assertEqual(self.f("   PasswordAuthentication   yes \n", "passwordauthentication"), "yes")

    def test_a_Match_block_is_conditional_and_not_read_as_global(self):
        text = "Match User bob\nPasswordAuthentication yes\n"
        self.assertIsNone(self.f(text, "passwordauthentication"))


class TestGithubRateLimitIsNotOffline(unittest.TestCase):
    """A 403 'rate limit exceeded' made a fully-online machine report itself OFFLINE."""

    def setUp(self):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                b = json.dumps({"message": "API rate limit exceeded"}).encode()
                self.send_response(403)
                self.send_header("X-RateLimit-Remaining", "0")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def log_message(self, *a):
                pass

        self.srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        self.m = _engine()
        self._orig = self.m.urllib.request.urlopen
        port = self.port

        def fake(url, *a, **k):
            return self._orig(f"http://127.0.0.1:{port}/", *a, **k)

        self.m.urllib.request.urlopen = fake

    def tearDown(self):
        self.m.urllib.request.urlopen = self._orig
        self.srv.shutdown()

    def test_a_rate_limited_github_still_counts_as_ONLINE(self):
        self.assertTrue(self.m._online(), "a 403 proves we reached GitHub; it is not 'offline'")

    def test_gh_api_RAISES_on_a_rate_limit_instead_of_looking_like_not_found(self):
        # "there is no newer version" and "I was not allowed to look" are opposite facts, and
        # only one of them is safe to act on. They both used to be `None`.
        with self.assertRaises(RuntimeError) as ctx:
            self.m._gh_api("repos/x/y")
        self.assertIn("quota", str(ctx.exception).lower())


class TestNonInteractiveInstallPath(unittest.TestCase):
    """`apps versions` exited 0 with ok:true after printing a chooser nobody could answer."""

    def _run(self, *args):
        out = subprocess.run(
            [sys.executable, str(ROOT / "prometheus.py"), "--json", *args],
            capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL,
            cwd=str(ROOT),
        )
        return out

    def test_no_tty_and_no_path_is_a_failure_with_a_JSON_envelope(self):
        out = self._run("apps", "versions", "yt-dlp")
        self.assertNotEqual(out.returncode, 0, "reported success having done nothing")
        payload = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertIn("--path", payload["error"])
        # and it must NOT name a different verb than the one the user ran
        self.assertNotIn("models install", payload["error"])


class TestSkillsNoNameEmitsAnEnvelope(unittest.TestCase):
    def test_missing_skill_name_is_a_usage_error_not_a_reported_crash(self):
        out = subprocess.run(
            [sys.executable, str(ROOT / "prometheus.py"), "--json", "skills", "enable"],
            capture_output=True, text=True, timeout=300, cwd=str(ROOT),
        )
        payload = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertIn("needs a skill name", payload["error"])


class TestDossierDecoding(unittest.TestCase):
    def test_a_non_utf8_dossier_still_reads(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            Path(d, "yt-dlp.md").write_bytes(
                "# yt-dlp\n\n## Install\n\npip install yt-dlp caf\xe8\n".encode("latin-1")
            )
            import os

            env = dict(os.environ, PROMETHEUS_DOSSIER_DIR=d)
            out = subprocess.run(
                [sys.executable, str(ROOT / "prometheus.py"), "--json", "tutorial", "yt-dlp"],
                capture_output=True, text=True, timeout=300, env=env, cwd=str(ROOT),
            )
            payload = json.loads(out.stdout.strip().splitlines()[-1])
            self.assertTrue(payload["ok"], f"a stray byte killed the tutorial: {payload}")
            self.assertIn("pip install yt-dlp", payload["text"])


if __name__ == "__main__":
    unittest.main()
