#!/usr/bin/env python3
"""test_kernel.py — kernel.py sidecar tests (APP-044).

Three tiers, so the suite is meaningful on a bare box AND on a full one:
  * PURE unit tests (protocol parsing, output caps, repr clamp, guard math) — no deps.
  * ONE-SHOT subprocess tests (probe / guard / serve-refusal / missing-dep) — stdlib only.
  * LIVE round-trip (execute / incremental streaming / interrupt / restart) —
    skipped unless jupyter_client + ipykernel + a python3 kernelspec are present.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import unittest
from typing import Any, Callable, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
KERNEL = os.path.join(HERE, "kernel.py")

sys.path.insert(0, HERE)
import kernel  # noqa: E402  (import after sys.path tweak — same pattern as siblings)


def _jupyter_ready() -> bool:
    try:
        import ipykernel  # noqa: F401
        import jupyter_client  # noqa: F401
        from jupyter_client.kernelspec import KernelSpecManager

        return "python3" in KernelSpecManager().find_kernel_specs()
    except Exception:
        return False


JUPYTER_READY = _jupyter_ready()


# --------------------------------------------------------------------------- #
# PURE unit tests
# --------------------------------------------------------------------------- #


class TestPure(unittest.TestCase):
    def test_parse_request_valid(self) -> None:
        self.assertEqual(kernel.parse_request('{"op":"execute","id":"c1","code":"1"}')["op"], "execute")

    def test_parse_request_blank_and_garbage(self) -> None:
        self.assertIsNone(kernel.parse_request(""))
        self.assertIsNone(kernel.parse_request("   \n"))
        self.assertIsNone(kernel.parse_request("not json"))
        self.assertIsNone(kernel.parse_request('{"no":"op"}'))
        self.assertIsNone(kernel.parse_request("[1,2,3]"))

    def test_truncate_text(self) -> None:
        text, cut = kernel.truncate_text("hello", 100)
        self.assertEqual((text, cut), ("hello", False))
        big = "x" * 5000
        text, cut = kernel.truncate_text(big, 100)
        self.assertTrue(cut)
        self.assertLessEqual(len(text.encode("utf-8")), 100)

    def test_clamp_repr(self) -> None:
        self.assertEqual(kernel.clamp_repr(123), "123")
        long = kernel.clamp_repr("a" * 500)
        self.assertLessEqual(len(long), kernel.REPR_CAP)
        self.assertTrue(long.endswith("…"))

    def test_clamp_repr_broken(self) -> None:
        class Bad:
            def __repr__(self) -> str:
                raise RuntimeError("boom")

        self.assertIn("unreprable", kernel.clamp_repr(Bad()))

    def test_guard_forced_pressure_trips(self) -> None:
        os.environ["PROMETHEUS_KERNEL_FORCE_PRESSURE"] = "95"
        try:
            v = kernel.guard_verdict()
            self.assertFalse(v["allow"])
            self.assertEqual(set(v["tripped"]), {"cpu", "ram"})
            self.assertIn("heavy load", v["reason"])
        finally:
            os.environ.pop("PROMETHEUS_KERNEL_FORCE_PRESSURE", None)

    def test_guard_skip_allows(self) -> None:
        os.environ["PROMETHEUS_KERNEL_SKIP_GUARD"] = "1"
        try:
            self.assertTrue(kernel.guard_verdict()["allow"])
        finally:
            os.environ.pop("PROMETHEUS_KERNEL_SKIP_GUARD", None)

    def test_guard_none_reading_does_not_trip(self) -> None:
        # A host we cannot measure (None readings) must ALLOW — can't-measure ≠ busy.
        orig_cpu, orig_ram = kernel._cpu_pressure_pct, kernel._ram_pressure_pct
        kernel._cpu_pressure_pct = lambda: None  # type: ignore[assignment]
        kernel._ram_pressure_pct = lambda: None  # type: ignore[assignment]
        try:
            v = kernel.guard_verdict()
            self.assertTrue(v["allow"])
            self.assertEqual(v["tripped"], [])
        finally:
            kernel._cpu_pressure_pct, kernel._ram_pressure_pct = orig_cpu, orig_ram

    def test_vars_code_compiles(self) -> None:
        compile(kernel._VARS_CODE, "<vars>", "exec")
        compile(kernel._VARS_READ, "<vars-read>", "eval")
        compile(kernel._inspect_expr("x"), "<inspect>", "eval")

    def test_decode_user_expression(self) -> None:
        payload = json.dumps([{"name": "x", "type": "int", "repr": "1"}])
        content = {"user_expressions": {"vars": {"status": "ok", "data": {"text/plain": repr(payload)}}}}
        out = kernel._decode_user_expression(content, "vars")
        self.assertEqual(out[0]["name"], "x")


# --------------------------------------------------------------------------- #
# ONE-SHOT subprocess tests (stdlib only)
# --------------------------------------------------------------------------- #


def _run_oneshot(args: List[str], env_extra: Optional[Dict[str, str]] = None) -> Tuple[int, Dict[str, Any]]:
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        [sys.executable, KERNEL, *args],
        input="",
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    # last JSON object line
    obj: Dict[str, Any] = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
    return proc.returncode, obj


class TestOneShot(unittest.TestCase):
    def test_probe(self) -> None:
        code, obj = _run_oneshot(["probe"])
        self.assertEqual(code, 0)
        self.assertTrue(obj["ok"])
        self.assertEqual(obj["command"], "kernel.probe")
        self.assertIn("jupyter_client", obj)
        self.assertIn("ipykernel", obj)
        self.assertEqual(obj["ready"], JUPYTER_READY)

    def test_guard_verb(self) -> None:
        code, obj = _run_oneshot(["guard"], {"PROMETHEUS_KERNEL_SKIP_GUARD": "1"})
        self.assertEqual(code, 0)
        self.assertTrue(obj["allow"])

    def test_serve_refuses_under_pressure(self) -> None:
        code, obj = _run_oneshot(["serve"], {"PROMETHEUS_KERNEL_FORCE_PRESSURE": "99"})
        self.assertEqual(code, 2)
        self.assertEqual(obj["event"], "error")
        self.assertTrue(obj["fatal"])
        self.assertIn("heavy load", obj["error"])

    @unittest.skipIf(JUPYTER_READY, "jupyter_client present — missing-dep path not exercised here")
    def test_serve_missing_dep(self) -> None:
        code, obj = _run_oneshot(["serve"], {"PROMETHEUS_KERNEL_SKIP_GUARD": "1"})
        self.assertEqual(code, 2)
        self.assertEqual(obj["event"], "error")
        self.assertTrue(obj["fatal"])
        self.assertIn("pip install jupyter_client ipykernel", obj["hint"])

    def test_unknown_verb(self) -> None:
        code, obj = _run_oneshot(["frobnicate"])
        self.assertEqual(code, 2)
        self.assertFalse(obj["ok"])


# --------------------------------------------------------------------------- #
# LIVE round-trip (requires jupyter_client + ipykernel)
# --------------------------------------------------------------------------- #


class _KernelProc:
    """Drive `kernel.py serve` over pipes, collecting NDJSON events in order."""

    def __init__(self) -> None:
        env = os.environ.copy()
        env["PROMETHEUS_KERNEL_SKIP_GUARD"] = "1"
        self.p = subprocess.Popen(
            [sys.executable, KERNEL, "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        self._events: List[Tuple[float, Dict[str, Any]]] = []
        self._cursor = 0
        self._cv = threading.Condition()
        self._t = threading.Thread(target=self._read, daemon=True)
        self._t.start()

    def _read(self) -> None:
        assert self.p.stdout is not None
        for line in self.p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            with self._cv:
                self._events.append((time.monotonic(), obj))
                self._cv.notify_all()

    def send(self, **req: Any) -> None:
        assert self.p.stdin is not None
        self.p.stdin.write(json.dumps(req) + "\n")
        self.p.stdin.flush()

    def read_next(self, pred: Callable[[Dict[str, Any]], bool], timeout: float = 30.0) -> Tuple[float, Dict[str, Any]]:
        end = time.monotonic() + timeout
        with self._cv:
            while True:
                while self._cursor < len(self._events):
                    ts, obj = self._events[self._cursor]
                    self._cursor += 1
                    if pred(obj):
                        return ts, obj
                rem = end - time.monotonic()
                if rem <= 0:
                    seen = [e[1].get("event") for e in self._events]
                    raise TimeoutError(f"timeout; events so far: {seen}")
                self._cv.wait(rem)

    def close(self) -> None:
        try:
            self.send(op="shutdown")
        except Exception:
            pass
        try:
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()
        finally:
            for stream in (self.p.stdin, self.p.stdout, self.p.stderr):
                try:
                    if stream is not None:
                        stream.close()
                except Exception:
                    pass


@unittest.skipUnless(JUPYTER_READY, "requires jupyter_client + ipykernel + python3 kernelspec")
class TestLive(unittest.TestCase):
    def setUp(self) -> None:
        self.k = _KernelProc()
        self.k.read_next(lambda o: o.get("event") == "ready")  # wait for the kernel

    def tearDown(self) -> None:
        self.k.close()
        # no orphan: the ipykernel child must be gone once serve exits.
        self.assertIsNotNone(self.k.p.poll())

    def test_execute_streams_then_done_ok(self) -> None:
        self.k.send(op="execute", id="c1", code="print(1+1)")
        _, s = self.k.read_next(lambda o: o.get("event") == "stream" and o.get("id") == "c1")
        self.assertIn("2", s["text"])
        _, d = self.k.read_next(lambda o: o.get("event") == "done" and o.get("id") == "c1")
        self.assertEqual(d["status"], "ok")

    def test_incremental_streaming(self) -> None:
        self.k.send(op="execute", id="c2", code="import time\nprint('a')\ntime.sleep(0.6)\nprint('b')")
        ta, _ = self.k.read_next(lambda o: o.get("event") == "stream" and "a" in o.get("text", ""))
        tb, _ = self.k.read_next(lambda o: o.get("event") == "stream" and "b" in o.get("text", ""))
        self.assertGreaterEqual(tb - ta, 0.3, "second output should arrive noticeably later")
        self.k.read_next(lambda o: o.get("event") == "done" and o.get("id") == "c2")

    def test_interrupt_aborts_and_kernel_survives(self) -> None:
        self.k.send(op="execute", id="c3", code="import time\ntime.sleep(60)")
        time.sleep(1.0)  # let the cell actually start running
        self.k.send(op="interrupt")
        _, d = self.k.read_next(lambda o: o.get("event") == "done" and o.get("id") == "c3", timeout=20)
        self.assertIn(d["status"], ("aborted", "error"))
        # the supervisor + kernel stay alive: the next cell still runs.
        self.k.send(op="execute", id="c4", code="print(42)")
        _, s = self.k.read_next(lambda o: o.get("event") == "stream" and o.get("id") == "c4")
        self.assertIn("42", s["text"])

    def test_restart_clears_state(self) -> None:
        self.k.send(op="execute", id="c5", code="x = 123")
        self.k.read_next(lambda o: o.get("event") == "done" and o.get("id") == "c5")
        self.k.send(op="restart")
        self.k.read_next(lambda o: o.get("event") == "ready")  # fresh kernel
        self.k.send(op="execute", id="c6", code="print(x)")
        _, d = self.k.read_next(lambda o: o.get("event") == "done" and o.get("id") == "c6")
        self.assertEqual(d["status"], "error")
        self.assertEqual(d.get("ename"), "NameError")

    def test_vars_and_inspect(self) -> None:
        self.k.send(op="execute", id="c7", code="myvar = [1, 2, 3]")
        self.k.read_next(lambda o: o.get("event") == "done" and o.get("id") == "c7")
        self.k.send(op="vars")
        _, v = self.k.read_next(lambda o: o.get("event") == "vars")
        names = {x["name"]: x for x in v["variables"]}
        self.assertIn("myvar", names)
        self.assertEqual(names["myvar"]["type"], "list")
        self.k.send(op="inspect", name="myvar")
        _, i = self.k.read_next(lambda o: o.get("event") == "inspect")
        self.assertTrue(i["found"])
        self.assertEqual(i["type"], "list")


class TestIntrospect(unittest.TestCase):
    """APP-088: exec the generated introspection code in a real namespace (no live kernel)."""

    def _run_df(self, ns_setup: str, name: str, offset: int, limit: int) -> dict:
        g: dict = {}
        exec(ns_setup, g)  # noqa: S102 — trusted test fixture code
        exec(kernel._dataframe_code(name, offset, limit), g)  # noqa: S102
        return g["__prom_df"]

    def test_dataframe_list_of_dicts(self) -> None:
        page = self._run_df(
            "df = [{'a':1,'b':2},{'a':3,'b':4},{'a':5,'b':6}]", "df", 1, 2
        )
        self.assertTrue(page["found"])
        self.assertEqual(page["columns"], ["a", "b"])
        self.assertEqual(page["rows"], [[3, 4], [5, 6]])  # offset 1, limit 2
        self.assertEqual(page["totalRows"], 3)

    def test_dataframe_2d_list_and_scalar(self) -> None:
        grid = self._run_df("g = [[1,2],[3,4]]", "g", 0, 10)
        self.assertEqual(grid["columns"], ["0", "1"])
        self.assertEqual(grid["rows"], [[1, 2], [3, 4]])
        scal = self._run_df("x = 42", "x", 0, 10)
        self.assertEqual(scal["columns"], ["value"])
        self.assertEqual(scal["rows"], [[42]])

    def test_dataframe_nan_becomes_none_and_not_found(self) -> None:
        page = self._run_df("import math\nd=[{'v':float('nan')},{'v':1.0}]", "d", 0, 10)
        self.assertEqual(page["rows"], [[None], [1.0]])  # NaN → None (JSON-safe)
        missing = self._run_df("z = 1", "nope", 0, 10)
        self.assertFalse(missing["found"])

    def _run_vars(self, ns: dict) -> list:
        exec(kernel._VARS_CODE, ns)  # noqa: S102 — trusted fixture (the kernel's own code)
        return json.loads(eval(kernel._VARS_READ, ns))  # noqa: S307

    def test_vars_snapshot_with_size_and_filter(self) -> None:
        import math as _math  # a module → must be filtered out

        g: dict = {"visible": 5, "s": "hi", "_hidden": 9, "mod": _math, "fn": len}
        by = {v["name"]: v for v in self._run_vars(g)}
        self.assertIn("visible", by)
        self.assertNotIn("_hidden", by)  # underscore-prefixed filtered
        self.assertNotIn("mod", by)  # modules filtered
        self.assertNotIn("fn", by)  # builtins/functions filtered
        self.assertEqual(by["visible"]["type"], "int")
        self.assertEqual(by["s"]["repr"], "'hi'")
        self.assertIsInstance(by["visible"]["size"], int)  # size present

    def test_vars_repr_capped_no_multi_mb_payload(self) -> None:
        rep = next(v["repr"] for v in self._run_vars({"big": "x" * 5_000_000}) if v["name"] == "big")
        self.assertLessEqual(len(rep), 201)  # capped at 200 in the code block

    def test_vars_repr_that_raises_still_yields_row(self) -> None:
        # a __repr__ that raises must NOT drop the whole snapshot — the row survives.
        setup = (
            "class __Boom:\n"
            "    def __repr__(self): raise RuntimeError('nope')\n"
            "boom = __Boom()\n"
            "ok = 1\n"
        )
        g: dict = {}
        exec(setup, g)  # noqa: S102
        by = {v["name"]: v for v in self._run_vars(g)}
        self.assertIn("boom", by)  # row present despite the raising repr
        self.assertIn("ok", by)  # and the snapshot is not aborted
        self.assertIsInstance(by["boom"]["repr"], str)

    def test_vars_size_duck_types_nbytes(self) -> None:
        # an object exposing `.nbytes` (numpy-like) reports that, not shallow getsizeof.
        setup = "class __Arr:\n    nbytes = 4096\narr = __Arr()\n"
        g: dict = {}
        exec(setup, g)  # noqa: S102
        by = {v["name"]: v for v in self._run_vars(g)}
        self.assertEqual(by["arr"]["size"], 4096)

    def test_plot_capture_code_no_matplotlib_is_empty(self) -> None:
        # exec the capture block in a namespace WITHOUT matplotlib → [] (fail-soft).
        g: dict = {}
        exec(kernel._PLOT_CAPTURE_CODE, g)  # noqa: S102
        self.assertEqual(g["__prom_plots"], [])


if __name__ == "__main__":
    unittest.main()
