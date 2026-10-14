#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_disk_space_sidecar.py — the disk_map.py sidecar (a JSON face on disk_space.py).

SAFETY: no test here ever runs a confirmed delete against a real protected path. Protected
paths are exercised as PLANS only (no --confirm); the "confirm refuses a protected path" case
runs in-process with the tool's delete functions replaced by recorders, so even a protection
regression could not remove anything. Every real delete targets a fresh temp directory.

Run: python3 tests/test_disk_space_sidecar.py
"""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "studio" / "python" / "sidecar"
SCRIPT = SIDECAR / "disk_map.py"
TOOL = ROOT / "studio" / "python" / "tools" / "disk_space.py"


def run(*argv: str, cwd: str | None = None) -> dict:
    p = subprocess.run(
        [sys.executable, str(SCRIPT), *argv],
        capture_output=True, text=True, timeout=120, cwd=cwd,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    lines = [ln for ln in p.stdout.strip().splitlines() if ln.strip()]
    assert lines, f"no JSON on stdout; stderr: {p.stderr[-2000:]}"
    env = json.loads(lines[-1])
    env["_rc"] = p.returncode
    return env


def load_sidecar():
    """Import disk_map.py in-process (its own dir first on sys.path, like a real launch)."""
    sys.path.insert(0, str(SIDECAR))
    spec = importlib.util.spec_from_file_location("disk_map_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def du_bytes(path: str) -> int:
    out = subprocess.run(["du", "-sk", path], capture_output=True, text=True, check=True).stdout
    return int(out.split()[0]) * 1024


def write(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(os.urandom(size))


class Sandbox(unittest.TestCase):
    def setUp(self) -> None:
        # realpath: on macOS the temp dir lives behind the /var → /private/var link
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="prom-disk-")))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)


class Envelope(Sandbox):
    def test_every_verb_is_namespaced_and_unknown_verbs_fail_closed(self):
        self.assertEqual(run("mounts")["command"], "disk.mounts")
        self.assertEqual(run("map", str(self.tmp), "--min-node", "0")["command"], "disk.map")
        self.assertEqual(run("levels", str(self.tmp))["command"], "disk.levels")
        self.assertEqual(run("largest-files", str(self.tmp))["command"], "disk.files")
        self.assertEqual(run("delete", str(self.tmp / "nope"))["command"], "disk.delete")
        self.assertEqual(run("cleanup-plan")["command"], "disk.cleanup-plan")
        self.assertEqual(run("privileged-rescan", str(self.tmp))["command"], "disk.privileged-rescan")
        bad = run("format-the-disk")
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["_rc"], 2)

    def test_a_missing_folder_is_an_error_not_an_empty_map(self):
        env = run("map", str(self.tmp / "absent"))
        self.assertFalse(env["ok"])
        self.assertEqual(env["_rc"], 2)

    def test_it_refuses_to_run_as_root(self):
        mod = load_sidecar()
        buf = io.StringIO()
        with mock.patch.object(os, "geteuid", return_value=0), redirect_stdout(buf):
            rc = mod.main(["map", str(self.tmp)])
        self.assertEqual(rc, 2)
        env = json.loads(buf.getvalue().strip().splitlines()[-1])
        self.assertFalse(env["ok"])
        self.assertIn("privileged gate", env["error"])


class Measuring(Sandbox):
    def test_mounts_carry_size_used_free_and_percent(self):
        env = run("mounts")
        self.assertTrue(env["ok"], env)
        self.assertTrue(env["mounts"])
        m = env["mounts"][0]
        for k in ("source", "target", "fstype", "total", "used", "free", "usePct"):
            self.assertIn(k, m)

    def test_map_sizes_match_du(self):
        write(self.tmp / "a" / "one.bin", 300_000)
        write(self.tmp / "a" / "deep" / "two.bin", 120_000)
        write(self.tmp / "b" / "three.bin", 50_000)
        env = run("map", str(self.tmp), "--min-node", "0")
        self.assertTrue(env["ok"], env)
        tree = env["tree"]
        self.assertEqual(tree["size"], du_bytes(str(self.tmp)))
        kids = {c["name"]: c for c in tree["children"]}
        self.assertEqual(kids["a"]["size"], du_bytes(str(self.tmp / "a")))
        self.assertEqual(kids["b"]["size"], du_bytes(str(self.tmp / "b")))
        # biggest first, the way every view draws it
        self.assertEqual(tree["children"][0]["name"], "a")
        s = env["summary"]
        for k in ("survey_dirs", "max_depth", "unreadable", "engine", "seconds"):
            self.assertIn(k, s)

    def test_the_payload_is_capped_and_says_so(self):
        for i in range(30):
            write(self.tmp / f"d{i:02d}" / "f.bin", 8192 + i)
        env = run("map", str(self.tmp), "--min-node", "0", "--max-nodes", "5")
        self.assertTrue(env["ok"], env)
        self.assertTrue(env["truncated"])
        self.assertLessEqual(env["nodes"], 5)

    def test_levels_are_du_max_depth_views_biggest_first(self):
        write(self.tmp / "x" / "y" / "big.bin", 200_000)
        write(self.tmp / "z" / "small.bin", 10_000)
        env = run("levels", str(self.tmp), "--depth", "2", "--top", "5")
        self.assertTrue(env["ok"], env)
        self.assertEqual([lv["depth"] for lv in env["levels"]], [1, 2])
        first = env["levels"][0]["rows"]
        sizes = [r["size"] for r in first]
        self.assertEqual(sizes, sorted(sizes, reverse=True))

    def test_largest_files(self):
        write(self.tmp / "p" / "big.bin", 400_000)
        write(self.tmp / "q" / "mid.bin", 100_000)
        write(self.tmp / "tiny.bin", 10)
        env = run("largest-files", str(self.tmp), "--top", "2")
        self.assertTrue(env["ok"], env)
        names = [os.path.basename(f["path"]) for f in env["files"]]
        self.assertEqual(names, ["big.bin", "mid.bin"])
        self.assertIn("mtime", env["files"][0])

    def test_a_non_utf8_name_stays_valid_json_and_round_trips(self):
        raw = os.fsencode(str(self.tmp)) + b"/bad\xff.bin"
        try:
            with open(raw, "wb") as fh:
                fh.write(os.urandom(5000))
        except OSError as exc:  # APFS refuses non-UTF-8 names outright (EILSEQ)
            self.skipTest(f"this filesystem cannot hold a non-UTF-8 name: {exc}")
        env = run("largest-files", str(self.tmp))
        self.assertTrue(env["ok"], env)
        entry = env["files"][0]
        self.assertIn("rawPath", entry)
        gone = run("delete", "--permanent", "--confirm", entry["rawPath"])
        self.assertTrue(gone["ok"], gone)
        self.assertFalse(os.path.lexists(raw))


class Deleting(Sandbox):
    def test_without_confirm_it_is_only_a_plan(self):
        write(self.tmp / "cache" / "x.bin", 20_000)
        env = run("delete", str(self.tmp / "cache"))
        self.assertTrue(env["ok"], env)
        self.assertTrue(env["planned"])
        self.assertTrue((self.tmp / "cache" / "x.bin").exists())
        item = env["items"][0]
        for k in ("path", "size", "risk", "reason", "protected", "mode"):
            self.assertIn(k, item)
        self.assertEqual(item["mode"], "trash")

    def test_protected_paths_are_refused_in_the_plan(self):
        # PLAN ONLY — never with --confirm (see the module docstring).
        env = run("delete", "/", os.path.expanduser("~"), "/etc", "/usr")
        self.assertTrue(env["ok"], env)
        for item in env["items"]:
            self.assertTrue(item["protected"], item)

    def test_confirm_never_touches_a_protected_path(self):
        mod = load_sidecar()
        tool = mod.load_tool()
        calls = []
        with mock.patch.object(tool, "move_to_trash", lambda ctx, p: calls.append(p) or (True, "")), \
                mock.patch.object(tool, "delete_permanently", lambda ctx, p: calls.append(p) or (True, "")):
            ctx = tool.Context(log_path=os.devnull)
            out = mod.execute_delete(tool, ctx, ["/", os.path.expanduser("~"), "/etc"], "permanent")
        self.assertEqual(calls, [])
        self.assertTrue(all(not r["ok"] for r in out))

    def test_a_folder_with_a_mount_below_it_is_refused(self):
        mod = load_sidecar()
        tool = mod.load_tool()
        (self.tmp / "parent" / "mnt").mkdir(parents=True)
        ctx = tool.Context(log_path=os.devnull)
        ctx.all_mounts.append((str(self.tmp / "parent" / "mnt"), "nfs"))
        plan = mod.plan_delete(tool, ctx, [str(self.tmp / "parent")], "permanent")
        self.assertIn("mounted filesystem", plan["items"][0]["protected"] or "")

    def test_permanent_delete_in_a_temp_dir(self):
        write(self.tmp / "junk" / "a" / "b.bin", 30_000)
        env = run("delete", "--permanent", "--confirm", str(self.tmp / "junk"))
        self.assertTrue(env["ok"], env)
        self.assertTrue(env["executed"])
        self.assertFalse((self.tmp / "junk").exists())

    def test_trash_moves_it_and_keeps_it_recoverable(self):
        mod = load_sidecar()
        tool = mod.load_tool()
        trash = self.tmp / "Trash"
        trash.mkdir()
        write(self.tmp / "old" / "f.bin", 10_000)
        with mock.patch.object(tool, "trash_dir_for", lambda ctx, p: (str(trash), "")):
            ctx = tool.Context(log_path=os.devnull)
            out = mod.execute_delete(tool, ctx, [str(self.tmp / "old")], "trash")
        self.assertTrue(out[0]["ok"], out)
        self.assertFalse((self.tmp / "old").exists())
        found = list(trash.rglob("f.bin"))
        self.assertEqual(len(found), 1)

    def test_a_folder_swapped_for_a_symlink_after_the_plan_loses_only_the_link(self):
        write(self.tmp / "victim" / "keep.bin", 4096)
        write(self.tmp / "target" / "f.bin", 4096)
        plan = run("delete", "--permanent", str(self.tmp / "target"))
        self.assertTrue(plan["planned"])
        shutil.rmtree(self.tmp / "target")
        os.symlink(self.tmp / "victim", self.tmp / "target")
        env = run("delete", "--permanent", "--confirm", str(self.tmp / "target"))
        self.assertTrue(env["ok"], env)
        self.assertFalse(os.path.lexists(self.tmp / "target"))
        self.assertTrue((self.tmp / "victim" / "keep.bin").exists())

    def test_a_dash_named_folder_needs_double_dash_and_is_never_an_option(self):
        write(self.tmp / "-rf" / "x.bin", 4096)
        env = run("delete", "--permanent", "--confirm", "--", "-rf", cwd=str(self.tmp))
        self.assertTrue(env["ok"], env)
        self.assertFalse((self.tmp / "-rf").exists())

    def test_high_risk_needs_an_explicit_acknowledgement(self):
        mod = load_sidecar()
        tool = mod.load_tool()
        write(self.tmp / "data" / "f.bin", 4096)
        ctx = tool.Context(log_path=os.devnull)
        with mock.patch.object(tool, "path_risk", lambda c, p, s: (tool.RISK_HIGH, "test")):
            plan = mod.plan_delete(tool, ctx, [str(self.tmp / "data")], "permanent")
            self.assertTrue(plan["requiresPhrase"])
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = mod.main(["delete", "--permanent", "--confirm", str(self.tmp / "data")])
        self.assertEqual(rc, 2)
        self.assertTrue((self.tmp / "data" / "f.bin").exists())


class RootWork(Sandbox):
    def test_privileged_rescan_is_a_command_for_the_gate_never_a_run(self):
        env = run("privileged-rescan", str(self.tmp))
        self.assertTrue(env["ok"], env)
        argv = env["argv"]
        # isolated mode: root's Python must not import from the user-writable tools/ dir (a
        # planted tools/shlex.py would shadow the stdlib — the script's hash cannot see that)
        self.assertEqual(argv[1], "-I")
        self.assertEqual(argv[2], str(TOOL))
        self.assertIn("--no-sudo", argv)
        self.assertEqual(argv[argv.index("--map-json") + 1], str(self.tmp))
        self.assertTrue(os.path.isabs(argv[0]))
        self.assertNotIn("sudo", argv[0])
        digest = hashlib.sha256(TOOL.read_bytes()).hexdigest()
        self.assertEqual(env["script"]["sha256"], digest)

    def test_privileged_rescan_bounds_its_output_depth(self):
        # a root scan of / with no depth printed the WHOLE tree (to_dict depth 64) — far past
        # what a pipe capture holds; the default keeps it predictable, callers can ask for more
        argv = run("privileged-rescan", str(self.tmp))["argv"]
        self.assertEqual(argv[argv.index("--depth") + 1], "6")
        argv = run("privileged-rescan", "--depth", "3", str(self.tmp))["argv"]
        self.assertEqual(argv[argv.index("--depth") + 1], "3")

    def test_cleanup_plan_returns_commands_and_never_executes(self):
        mod = load_sidecar()
        tool = mod.load_tool()
        action = tool.Action(id="prune-safe", title="Prune", description="d",
                             commands=[["docker", "system", "prune", "-f"]])
        finding = tool.Finding(id="docker", title="Docker", category="containers", size=5 << 30,
                               reclaimable=1 << 30, mountpoint="/", summary="s", actions=[action])

        class FakeScanner:
            def __init__(self, ctx, only=None, workers=4):
                pass

            def scan(self, progress=None):
                return tool.ScanResult(findings=[finding], errors=[], skipped=[], duration=0.1)

        def no_executor(*a, **k):
            raise AssertionError("cleanup-plan must never construct an Executor")

        buf = io.StringIO()
        with mock.patch.object(mod, "IS_LINUX", True), \
                mock.patch.object(tool, "Scanner", FakeScanner), \
                mock.patch.object(tool, "Executor", no_executor), redirect_stdout(buf):
            rc = mod.main(["cleanup-plan"])
        self.assertEqual(rc, 0)
        env = json.loads(buf.getvalue().strip().splitlines()[-1])
        act = env["findings"][0]["actions"][0]
        self.assertTrue(act["needsRoot"])
        self.assertIn("--apply", act["command"])
        self.assertEqual(act["command"][1], "-I")
        self.assertIn("docker:prune-safe", act["command"])
        self.assertEqual(act["preview"], ["$ docker system prune -f"])


class EngineVerb(Sandbox):
    """`prometheus.py disk-space …` — how the MCP plugin and the core registry reach it."""

    def engine(self, *argv: str) -> dict:
        p = subprocess.run(
            [sys.executable, str(ROOT / "prometheus.py"), "--json", "--no-color", "disk-space", *argv],
            capture_output=True, text=True, timeout=180,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        lines = [ln for ln in p.stdout.strip().splitlines() if ln.strip()]
        self.assertTrue(lines, f"no JSON on stdout; stderr: {p.stderr[-2000:]}")
        env = json.loads(lines[-1])
        env["_rc"] = p.returncode
        return env

    def test_it_relays_the_sidecar_envelope(self):
        env = self.engine("mounts")
        self.assertTrue(env["ok"], env)
        self.assertEqual(env["command"], "disk.mounts")
        write(self.tmp / "a" / "f.bin", 50_000)
        env = self.engine("map", str(self.tmp), "--min-node", "0")
        self.assertTrue(env["ok"], env)
        self.assertEqual(env["tree"]["size"], du_bytes(str(self.tmp)))

    def test_failures_stay_failures(self):
        env = self.engine("map", str(self.tmp / "absent"))
        self.assertFalse(env["ok"])
        self.assertNotEqual(env["_rc"], 0)
        self.assertFalse(self.engine()["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
