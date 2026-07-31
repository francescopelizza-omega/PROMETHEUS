#!/usr/bin/env python3
"""test_profile.py — profile.py sidecar tests (APP-046).

Pure-unit (argv guard, fold determinism) + subprocess (envelope shape, guard refusal,
timeout partial) tiers. Stdlib only — cProfile/pstats/runpy are always present.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from typing import Any, Dict, List, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.path.join(HERE, "profile.py")

sys.path.insert(0, HERE)
import profile as profmod  # noqa: E402  (the sidecar file, not stdlib — HERE is first)


def _run(args: List[str], env_extra: Dict[str, str] | None = None) -> Tuple[int, Dict[str, Any]]:
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        [sys.executable, PROFILE, *args],
        input="",
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    obj: Dict[str, Any] = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
    return proc.returncode, obj


def _write(text: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".py", prefix="proftarget_")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


TOY = """
def inner(n):
    s = 0
    for i in range(n):
        s += i * i
    return s

def outer():
    t = 0
    for _ in range(300):
        t += inner(400)
    return t

if __name__ == "__main__":
    print("done", outer())
"""


class TestPure(unittest.TestCase):
    def test_split_target_args_after_double_dash(self) -> None:
        head, target, err = profmod.split_target_args(["--path", "x.py", "--", "-rf", "--danger"])
        self.assertIsNone(err)
        self.assertEqual(target, ["-rf", "--danger"])

    def test_split_target_args_rejects_pre_dash_injection(self) -> None:
        _head, _target, err = profmod.split_target_args(["--path", "x.py", "--evil"])
        self.assertIsNotNone(err)
        self.assertIn("option-injection", err)

    def test_split_target_args_known_flags_ok(self) -> None:
        _h, target, err = profmod.split_target_args(["--path", "x.py", "--cwd", "/d", "--timeout", "5"])
        self.assertIsNone(err)
        self.assertEqual(target, [])

    def test_guard_force_and_skip(self) -> None:
        os.environ["PROMETHEUS_PROFILE_FORCE_LOAD"] = "1"
        try:
            self.assertEqual(profmod.guard_reason(), "forced load (test hook)")
        finally:
            os.environ.pop("PROMETHEUS_PROFILE_FORCE_LOAD", None)
        os.environ["PROMETHEUS_PROFILE_SKIP_GUARD"] = "1"
        try:
            self.assertIsNone(profmod.guard_reason())
        finally:
            os.environ.pop("PROMETHEUS_PROFILE_SKIP_GUARD", None)

    def test_frame_name_format(self) -> None:
        self.assertEqual(profmod._frame_name(("/a/b/toy.py", 3, "inner")), "toy:inner")
        self.assertEqual(profmod._frame_name(("~", 0, "<built-in>")), "<built-in>")


class _FakeFrame:
    def __init__(self, filename: str, lineno: int) -> None:
        self.filename = filename
        self.lineno = lineno


class _FakeStat:
    def __init__(self, size: int, frames: List[_FakeFrame]) -> None:
        self.size = size
        self.traceback = frames  # iterable, most-recent-call LAST


class _FakeSnapshot:
    def __init__(self, stats: List[_FakeStat]) -> None:
        self._stats = stats

    def statistics(self, key: str) -> List[_FakeStat]:  # noqa: ARG002
        return self._stats


class TestFoldAndDelta(unittest.TestCase):
    """APP-089 fold (memory) + delta (compare) math — pure, no live run needed."""

    def test_fold_tracemalloc_byte_weighted_reversed(self) -> None:
        # traceback frames are most-recent-call LAST → outermost→innermost after reverse.
        snap = _FakeSnapshot(
            [
                _FakeStat(4096, [_FakeFrame("/a/app.py", 10), _FakeFrame("/a/lib.py", 3)]),
                _FakeStat(1024, [_FakeFrame("/a/app.py", 10), _FakeFrame("/a/lib.py", 3)]),
                _FakeStat(0, [_FakeFrame("/a/app.py", 99)]),  # zero-size dropped
            ]
        )
        folded, total, truncated = profmod.fold_tracemalloc(snap)
        self.assertFalse(truncated)
        self.assertEqual(total, 5120)
        self.assertEqual(folded[0]["stack"], ["app:10", "lib:3"])  # outermost→innermost
        self.assertEqual(folded[0]["value"], 5120)  # merged same path

    def test_delta_samples_signed_and_new_call_site(self) -> None:
        a = [{"stack": ["main", "hot"], "value": 100}, {"stack": ["main", "warm"], "value": 50}]
        b = [
            {"stack": ["main", "hot"], "value": 160},  # +60 regression
            {"stack": ["main", "warm"], "value": 20},  # -30 improvement
            {"stack": ["main", "new"], "value": 40},  # a=0 → pure regression
        ]
        d = profmod.delta_samples(a, b)
        by = {"\x00".join(s["stack"]): s["value"] for s in d}
        self.assertEqual(by["main\x00hot"], 60)
        self.assertEqual(by["main\x00warm"], -30)
        self.assertEqual(by["main\x00new"], 40)  # new call site present only in b
        # sorted by |value| desc → +60 first
        self.assertEqual(d[0]["value"], 60)

    def test_delta_summary_regressions_and_improvements(self) -> None:
        d = [{"stack": ["m", "hot"], "value": 60}, {"stack": ["m", "warm"], "value": -30}]
        summ = profmod._delta_summary(d)
        self.assertEqual(summ["regressions"][0], {"name": "hot", "delta": 60})
        self.assertEqual(summ["improvements"][0], {"name": "warm", "delta": -30})

    def test_fold_async_counts(self) -> None:
        counts = {"task:A\x00m:run": 3, "task:B\x00m:run": 1}
        folded, total, _t = profmod.fold_async_counts(counts)
        self.assertEqual(total, 4)
        self.assertEqual(folded[0]["value"], 3)  # hot-first

    def test_safe_id_rejects_traversal(self) -> None:
        self.assertIsNone(profmod._snapshot_path("/tmp/snaps", "../../etc/passwd"))
        self.assertIsNone(profmod._snapshot_path("/tmp/snaps", "a/b"))
        self.assertTrue(profmod._snapshot_path("/tmp/snaps", "cpu-123").endswith("cpu-123.json"))


class TestSubprocess(unittest.TestCase):
    def test_envelope_shape_consumable_by_flame(self) -> None:
        path = _write(TOY)
        try:
            code, obj = _run(["run", "--path", path])
            self.assertEqual(code, 0)
            self.assertTrue(obj["ok"])
            self.assertEqual(obj["command"], "run")
            self.assertTrue(obj["approx"])
            self.assertGreater(len(obj["samples"]), 0)
            self.assertGreater(obj["totalUs"], 0)
            # each sample matches ProfileSample: {stack: string[], value: int}
            for s in obj["samples"]:
                self.assertIsInstance(s["stack"], list)
                self.assertTrue(all(isinstance(f, str) for f in s["stack"]))
                self.assertIsInstance(s["value"], int)
            # the hot leaf (…:inner) is present somewhere in the folds
            self.assertTrue(any(any(f.endswith(":inner") for f in s["stack"]) for s in obj["samples"]))
        finally:
            os.unlink(path)

    def test_fold_is_deterministic(self) -> None:
        path = _write(TOY)
        try:
            _c1, a = _run(["run", "--path", path])
            _c2, b = _run(["run", "--path", path])
            # both runs produce a sorted-desc-by-value list (deterministic ordering:
            # value desc, then stack key — so equal-value ties are stable).
            for env in (a, b):
                vals = [s["value"] for s in env["samples"]]
                self.assertEqual(vals, sorted(vals, reverse=True))
        finally:
            os.unlink(path)

    def test_guard_refuses_under_forced_load(self) -> None:
        path = _write(TOY)
        try:
            code, obj = _run(["run", "--path", path], {"PROMETHEUS_PROFILE_FORCE_LOAD": "1"})
            self.assertEqual(code, 2)
            self.assertFalse(obj["ok"])
            self.assertEqual(obj["error"], "load")
        finally:
            os.unlink(path)

    def test_argv_injection_rejected(self) -> None:
        path = _write(TOY)
        try:
            _code, obj = _run(["run", "--path", path, "--evil"])
            self.assertFalse(obj["ok"])
            self.assertIn("option-injection", obj["error"])
        finally:
            os.unlink(path)

    def test_timeout_partial_no_zombie(self) -> None:
        path = _write("import time\nwhile True:\n    x = 1\n")
        try:
            code, obj = _run(["run", "--path", path, "--timeout", "0.3"])
            self.assertEqual(code, 0)
            self.assertTrue(obj["ok"])
            self.assertTrue(obj["timedOut"])
        finally:
            os.unlink(path)

    def test_missing_target(self) -> None:
        code, obj = _run(["run", "--path", "/nonexistent/nope.py"])
        self.assertEqual(code, 2)
        self.assertFalse(obj["ok"])
        self.assertIn("not found", obj["error"])


MEM_TARGET = """
_HELD = []
def build():
    # retain a big list so tracemalloc sees NET memory (alloc-then-free would show ~0).
    data = [i for i in range(200000)]
    _HELD.append(data)
    return data

if __name__ == "__main__":
    build()
"""

ASYNC_TARGET = """
import asyncio
async def worker(n):
    total = 0
    for _ in range(2000):
        total += sum(i*i for i in range(200))
        await asyncio.sleep(0)
    return total

async def main():
    await asyncio.gather(worker(1), worker(2))

if __name__ == "__main__":
    asyncio.run(main())
"""


class TestModes(unittest.TestCase):
    def test_memory_mode_byte_weighted_tree(self) -> None:
        path = _write(MEM_TARGET)
        try:
            code, obj = _run(["run", "--path", path, "--mode", "memory"])
            self.assertEqual(code, 0)
            self.assertTrue(obj["ok"])
            self.assertEqual(obj["mode"], "memory")
            self.assertEqual(obj["unit"], "bytes")
            self.assertGreater(len(obj["samples"]), 0)
            self.assertGreater(obj["totalUs"], 0)  # net-retained bytes
        finally:
            os.unlink(path)

    def test_async_mode_attributes_tasks(self) -> None:
        path = _write(ASYNC_TARGET)
        try:
            code, obj = _run(["run", "--path", path, "--mode", "async", "--timeout", "20"])
            self.assertEqual(code, 0)
            self.assertTrue(obj["ok"])
            self.assertEqual(obj["mode"], "async")
            self.assertEqual(obj["unit"], "samples")
            # the sampler saw asyncio tasks and labelled at least one "task:*" root.
            self.assertTrue(obj["sawTasks"])
            self.assertTrue(any(s["stack"] and s["stack"][0].startswith("task:") for s in obj["samples"]))
        finally:
            os.unlink(path)

    def test_async_mode_on_sync_target_fails_soft(self) -> None:
        path = _write(TOY)
        try:
            code, obj = _run(["run", "--path", path, "--mode", "async"])
            self.assertEqual(code, 0)
            self.assertTrue(obj["ok"])  # not an error — a soft note
            self.assertFalse(obj["sawTasks"])
            self.assertIn("not an asyncio program", obj["note"])
        finally:
            os.unlink(path)

    def test_unknown_mode_rejected(self) -> None:
        path = _write(TOY)
        try:
            _c, obj = _run(["run", "--path", path, "--mode", "bogus"])
            self.assertFalse(obj["ok"])
            self.assertIn("unknown mode", obj["error"])
        finally:
            os.unlink(path)


class TestSnapshotCompare(unittest.TestCase):
    def _save(self, d: str, name: str, mode: str, unit: str, samples: List[Dict[str, Any]]) -> str:
        body = json.dumps({"name": name, "mode": mode, "unit": unit, "samples": samples, "totalValue": sum(s["value"] for s in samples)})
        proc = subprocess.run(
            [sys.executable, PROFILE, "snapshot", "--op", "save", "--dir", d, "--name", name],
            input=body, capture_output=True, text=True, timeout=30,
        )
        obj = {}
        for line in proc.stdout.splitlines():
            if line.strip().startswith("{"):
                obj = json.loads(line)
        self.assertTrue(obj.get("ok"))
        return obj["id"]

    def test_snapshot_save_list_and_compare(self) -> None:
        d = tempfile.mkdtemp(prefix="profsnap_")
        try:
            a_samples = [{"stack": ["main", "hot"], "value": 100}]
            b_samples = [{"stack": ["main", "hot"], "value": 160}, {"stack": ["main", "new"], "value": 40}]
            a_id = self._save(d, "before", "cpu", "us", a_samples)
            b_id = self._save(d, "after", "cpu", "us", b_samples)

            # list shows both, newest-first.
            code, obj = _run(["snapshot", "--op", "list", "--dir", d])
            self.assertEqual(code, 0)
            ids = {s["id"] for s in obj["snapshots"]}
            self.assertIn(a_id, ids)
            self.assertIn(b_id, ids)

            # compare a→b: signed delta tree + summary.
            code, cmp_obj = _run(["compare", "--dir", d, "--a", a_id, "--b", b_id])
            self.assertEqual(code, 0)
            self.assertTrue(cmp_obj["ok"])
            self.assertEqual(cmp_obj["unit"], "us")
            by = {"\x00".join(s["stack"]): s["value"] for s in cmp_obj["samples"]}
            self.assertEqual(by["main\x00hot"], 60)
            self.assertEqual(by["main\x00new"], 40)
            self.assertEqual(cmp_obj["summary"]["regressions"][0]["name"], "hot")
        finally:
            import shutil as _sh

            _sh.rmtree(d, ignore_errors=True)

    def test_compare_rejects_cross_unit(self) -> None:
        d = tempfile.mkdtemp(prefix="profsnap_")
        try:
            a_id = self._save(d, "cpu", "cpu", "us", [{"stack": ["x"], "value": 1}])
            b_id = self._save(d, "mem", "memory", "bytes", [{"stack": ["x"], "value": 1}])
            _code, obj = _run(["compare", "--dir", d, "--a", a_id, "--b", b_id])
            self.assertFalse(obj["ok"])
            self.assertIn("unit mismatch", obj["error"])
        finally:
            import shutil as _sh

            _sh.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
