#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""profile.py — the Python profiler backend sidecar (APP-046, file 14 §3.28).

Runs a target script IN-PROCESS under ``cProfile`` (via ``runpy.run_path``) and converts
the flat pstats table into flame FOLD samples ``{stack:["mod:fn", …], value:<µs>}`` that
the renderer's ``flameSamplesToTree`` consumes unchanged. Pure stdlib (cProfile/pstats/
runpy/signal); ``py-spy`` is DETECTED and reported when present but NEVER required and
NEVER pip-installed.

IMPORTANT (honesty about the data): cProfile does NOT record call STACKS — its stats are a
flat ``{(file,line,func): (cc,nc,tt,ct,callers)}`` table with only immediate caller edges.
So the folds here are **edge-reconstructed (approximate)**: each function's self-time is
attributed along its dominant caller path. The envelope says ``approx:true`` so it is never
judged as exact-sampled stacks (only py-spy gives those).

In-process by design: a subprocess + outer SIGKILL loses ALL profile data, so we arm
``signal.setitimer(ITIMER_REAL, timeout)`` (POSIX) whose handler disables the profiler and
lets us dump a PARTIAL fold — ``timedOut:true`` — with no zombie child (there is no child).

Guards (fail-closed): refuse to start (``ok:false, error:"load"``) when CPU load ≥ 90% or
free RAM < 10% (mirrors the JS telemetry/system-probe thresholds).
"""
from __future__ import annotations

import os
import shutil
import signal
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

from _envelope import emit, fail, log, opt_value

# CRITICAL name-shadow fix: this file is literally `profile.py`, and stdlib `cProfile`
# does `import profile` at import time. With the sidecar dir on sys.path THIS file
# shadows the stdlib `profile` module and cProfile fails to import. `_envelope` is
# already loaded, so drop the sidecar dir now — later `import cProfile` resolves stdlib.
_SIDECAR_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _SIDECAR_DIR]

PROG = "profile"

GUARD_CPU_PCT = 90.0
GUARD_FREE_RAM_MIN_PCT = 10.0
DEFAULT_TIMEOUT_S = 120.0
TOP_N = 2000


class _TimeUp(Exception):
    """Raised from the SIGALRM handler when the wall-clock cap fires (partial dump)."""


# --------------------------------------------------------------------------- #
# Resource guard (stdlib; mirrors kernel.py / system-probe thresholds).
# --------------------------------------------------------------------------- #


def _free_ram_pct() -> Optional[float]:
    try:
        if sys.platform == "linux":
            total = avail = None
            with open("/proc/meminfo", "r", encoding="ascii", errors="replace") as fh:
                for ln in fh:
                    if ln.startswith("MemTotal:"):
                        total = float(ln.split()[1])
                    elif ln.startswith("MemAvailable:"):
                        avail = float(ln.split()[1])
                    if total is not None and avail is not None:
                        break
            if total and avail is not None and total > 0:
                return max(0.0, min(100.0, avail / total * 100.0))
        elif sys.platform == "darwin":
            import subprocess

            total = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=4)
            vm = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=4)
            total_bytes = float((total.stdout or "0").strip() or 0)
            page = 4096.0
            free_pages = 0.0
            for ln in (vm.stdout or "").splitlines():
                low = ln.lower()
                if "page size of" in low:
                    digits = "".join(ch for ch in ln if ch.isdigit())
                    if digits:
                        page = float(digits)
                for key in ("pages free", "pages inactive", "pages speculative"):
                    if low.startswith(key):
                        free_pages += float(ln.rsplit(":", 1)[1].strip().rstrip("."))
            if total_bytes > 0:
                return max(0.0, min(100.0, free_pages * page / total_bytes * 100.0))
    except Exception:  # noqa: BLE001 — guard math is best-effort
        return None
    return None


def _cpu_load_pct() -> Optional[float]:
    try:
        load1 = os.getloadavg()[0]  # AttributeError on Windows — guarded
        cores = os.cpu_count() or 1
        return max(0.0, min(100.0, load1 / cores * 100.0))
    except (OSError, AttributeError):
        return None


def guard_reason() -> Optional[str]:
    """Return a refusal reason when the host is too busy, else None (fail-closed)."""
    if os.environ.get("PROMETHEUS_PROFILE_FORCE_LOAD") == "1":
        return "forced load (test hook)"
    if os.environ.get("PROMETHEUS_PROFILE_SKIP_GUARD") == "1":
        return None
    cpu = _cpu_load_pct()
    if cpu is not None and cpu >= GUARD_CPU_PCT:
        return f"CPU load {cpu:.0f}% ≥ {GUARD_CPU_PCT:.0f}%"
    free = _free_ram_pct()
    if free is not None and free < GUARD_FREE_RAM_MIN_PCT:
        return f"free RAM {free:.0f}% < {GUARD_FREE_RAM_MIN_PCT:.0f}%"
    return None


# --------------------------------------------------------------------------- #
# argv: split target args off after a literal `--`; reject option-injection.
# --------------------------------------------------------------------------- #

_KNOWN_FLAGS = {"--path", "--cwd", "--timeout", "--mode"}

# The three profiling MODES share the FlameNode tree currency — only the value + unit
# change (never the shape), so flameSamplesToTree/flattenFlame/hottestPath keep working.
MODE_UNIT = {"cpu": "us", "memory": "bytes", "async": "samples"}
# a snapshot id is a bare filename stem — no path separators / traversal (it indexes the
# MAIN-supplied --dir, never a renderer path).
_ID_OK = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")


def split_target_args(argv: Sequence[str]) -> Tuple[List[str], List[str], Optional[str]]:
    """(head, target_args, error). Target args are everything after a literal ``--``.

    A leading-dash token in the HEAD that is not a known flag (or its value) is an
    option-injection attempt → error. This keeps a hostile ``--args`` from smuggling
    flags into the sidecar itself.
    """
    args = list(argv)
    target: List[str] = []
    if "--" in args:
        idx = args.index("--")
        head = args[:idx]
        target = args[idx + 1 :]
    else:
        head = args
    # scan head, skipping known flag+value pairs; any other leading-dash token is bad.
    i = 0
    while i < len(head):
        tok = head[i]
        if tok in _KNOWN_FLAGS:
            i += 2  # skip its value
            continue
        if tok.startswith("--") and "=" in tok and tok.split("=", 1)[0] in _KNOWN_FLAGS:
            i += 1
            continue
        if tok.startswith("-"):
            return head, target, f"option-injection: unexpected flag '{tok}' (use '--' before target args)"
        i += 1
    return head, target, None


# --------------------------------------------------------------------------- #
# profiling core (in-process runpy under cProfile, wall-clock capped).
# --------------------------------------------------------------------------- #


def _frame_name(key: Any) -> str:
    """(filename, lineno, funcname) → "mod:fn" (builtins → just the funcname)."""
    if not isinstance(key, tuple) or len(key) < 3:
        return str(key)
    filename, _lineno, funcname = key[0], key[1], key[2]
    if not filename or filename in ("~", "<string>"):
        return str(funcname)
    mod = os.path.basename(str(filename))
    if mod.endswith(".py"):
        mod = mod[:-3]
    return f"{mod}:{funcname}"


def _approx_stack(key: Any, entries: Dict[Any, Any]) -> List[str]:
    """Greedy dominant-caller walk → an approximate root→leaf stack for `key`."""
    path = [_frame_name(key)]
    seen = {key}
    cur = key
    while True:
        callers = entries[cur][4] if cur in entries and len(entries[cur]) >= 5 else {}
        best = None
        best_ct = -1.0
        for ck, cval in (callers or {}).items():
            if ck in seen or ck not in entries:
                continue
            ct = float(cval[3]) if isinstance(cval, tuple) and len(cval) >= 4 else 0.0
            if ct > best_ct:
                best_ct = ct
                best = ck
        if best is None:
            break
        path.append(_frame_name(best))
        seen.add(best)
        cur = best
    path.reverse()
    return path


def _profile_target(
    path: str, cwd: Optional[str], timeout: float, target_args: Sequence[str]
) -> Tuple[Any, bool, Optional[str]]:
    import cProfile
    import pstats
    import runpy

    prof = cProfile.Profile()
    timed_out = [False]
    run_error: Optional[str] = None

    def _on_alarm(_signo: int, _frame: Any) -> None:
        timed_out[0] = True
        prof.disable()
        raise _TimeUp()

    abs_path = os.path.abspath(path)
    target_dir = os.path.dirname(abs_path)
    old_argv, old_cwd = sys.argv[:], os.getcwd()
    has_alarm = hasattr(signal, "setitimer")
    try:
        # let the target import its own siblings (its dir first); the sidecar dir was
        # already stripped at module load, so no sibling of ours can be resolved.
        sys.path.insert(0, target_dir)
        os.chdir(cwd or target_dir)
        sys.argv = [abs_path, *target_args]
        if has_alarm:
            signal.signal(signal.SIGALRM, _on_alarm)
            signal.setitimer(signal.ITIMER_REAL, max(0.001, timeout))
        prof.enable()
        # The target's own stdout/stderr must NOT pollute the one-JSON-object envelope —
        # redirect both to devnull while it runs (we only want the profile).
        import contextlib

        try:
            with open(os.devnull, "w", encoding="utf-8") as devnull:
                with contextlib.redirect_stdout(devnull), contextlib.redirect_stderr(devnull):
                    runpy.run_path(abs_path, run_name="__main__")
        except _TimeUp:
            pass
        except SystemExit:
            pass  # a target may sys.exit()
        except Exception as exc:  # noqa: BLE001 — record but still dump the partial profile
            run_error = f"{type(exc).__name__}: {exc}"
        finally:
            prof.disable()
            if has_alarm:
                signal.setitimer(signal.ITIMER_REAL, 0)
    finally:
        sys.argv = old_argv
        os.chdir(old_cwd)
        try:
            sys.path.remove(target_dir)
        except ValueError:
            pass
    return pstats.Stats(prof), timed_out[0], run_error


def fold_stats(stats: Any, top_n: int = TOP_N) -> Tuple[List[Dict[str, Any]], int, bool]:
    """pstats → (folded samples, totalUs, truncated). Deterministic ordering."""
    entries: Dict[Any, Any] = getattr(stats, "stats", {}) or {}
    merged: Dict[str, int] = {}
    total_us = 0
    for key, val in entries.items():
        # val = (cc, nc, tt, ct, callers); tt = SELF time (float seconds).
        tt = float(val[2]) if len(val) >= 3 else 0.0
        self_us = int(round(tt * 1e6))
        if self_us <= 0:
            continue
        total_us += self_us
        stack = _approx_stack(key, entries)
        merged_key = "\x00".join(stack)
        merged[merged_key] = merged.get(merged_key, 0) + self_us
    folded = [{"stack": k.split("\x00"), "value": v} for k, v in merged.items()]
    # deterministic: cumulative µs desc, then the joined stack key as tiebreak.
    folded.sort(key=lambda s: (-s["value"], "\x00".join(s["stack"])))
    truncated = len(folded) > top_n
    return folded[:top_n], total_us, truncated


# --------------------------------------------------------------------------- #
# memory mode: tracemalloc — fold allocation tracebacks into the FlameNode tree.
# --------------------------------------------------------------------------- #


def _mem_frame_name(frame: Any) -> str:
    """A tracemalloc Frame(filename,lineno) → "mod:lineno" (no funcname is available)."""
    filename = getattr(frame, "filename", None) or "<unknown>"
    lineno = getattr(frame, "lineno", 0)
    mod = os.path.basename(str(filename))
    if mod.endswith(".py"):
        mod = mod[:-3]
    return f"{mod}:{lineno}"


def fold_tracemalloc(snapshot: Any, top_n: int = TOP_N) -> Tuple[List[Dict[str, Any]], int, bool]:
    """tracemalloc snapshot → (folds value=bytes, totalBytes, truncated).

    Uses ``statistics("traceback")`` (``"lineno"`` loses the call chain so cannot build a
    tree). A tracemalloc ``Traceback`` is ordered oldest→most-recent (outermost frame
    first, the allocation site LAST) — already the root→leaf FlameNode convention, so it
    is folded AS-IS. Net-RETAINED bytes only (a tracemalloc invariant): allocate-then-free
    shows near-zero.
    """
    stats = snapshot.statistics("traceback")
    merged: Dict[str, int] = {}
    total = 0
    for st in stats:
        size = int(getattr(st, "size", 0) or 0)
        if size <= 0:
            continue
        tb = getattr(st, "traceback", None)
        frames = list(tb) if tb is not None else []
        stack = [_mem_frame_name(f) for f in frames] or ["<unknown>"]
        total += size
        key = "\x00".join(stack)
        merged[key] = merged.get(key, 0) + size
    folded = [{"stack": k.split("\x00"), "value": v} for k, v in merged.items()]
    folded.sort(key=lambda s: (-s["value"], "\x00".join(s["stack"])))
    return folded[:top_n], total, len(folded) > top_n


def _profile_memory_target(
    path: str, cwd: Optional[str], timeout: float, target_args: Sequence[str]
) -> Tuple[Any, bool, Optional[str]]:
    import contextlib
    import runpy
    import tracemalloc

    timed_out = [False]
    run_error: Optional[str] = None
    abs_path = os.path.abspath(path)
    target_dir = os.path.dirname(abs_path)
    old_argv, old_cwd = sys.argv[:], os.getcwd()
    has_alarm = hasattr(signal, "setitimer")

    def _on_alarm(_signo: int, _frame: Any) -> None:
        timed_out[0] = True
        raise _TimeUp()

    tracemalloc.start(25)  # keep ≥25 frames so allocation call-chains survive
    try:
        sys.path.insert(0, target_dir)
        os.chdir(cwd or target_dir)
        sys.argv = [abs_path, *target_args]
        if has_alarm:
            signal.signal(signal.SIGALRM, _on_alarm)
            signal.setitimer(signal.ITIMER_REAL, max(0.001, timeout))
        try:
            with open(os.devnull, "w", encoding="utf-8") as devnull:
                with contextlib.redirect_stdout(devnull), contextlib.redirect_stderr(devnull):
                    runpy.run_path(abs_path, run_name="__main__")
        except _TimeUp:
            pass
        except SystemExit:
            pass
        except Exception as exc:  # noqa: BLE001 — record but still snapshot what retained
            run_error = f"{type(exc).__name__}: {exc}"
        finally:
            if has_alarm:
                signal.setitimer(signal.ITIMER_REAL, 0)
        snapshot = tracemalloc.take_snapshot()
    finally:
        tracemalloc.stop()
        sys.argv = old_argv
        os.chdir(old_cwd)
        try:
            sys.path.remove(target_dir)
        except ValueError:
            pass
    return snapshot, timed_out[0], run_error


# --------------------------------------------------------------------------- #
# async mode: a daemon sampler walks asyncio.all_tasks() at a fixed interval.
# --------------------------------------------------------------------------- #


def _async_frame_name(frame: Any) -> str:
    """A live frame → "mod:fn" using its code object (co_filename / co_name)."""
    code = getattr(frame, "f_code", None)
    if code is None:
        return "<frame>"
    return _frame_name((code.co_filename, getattr(frame, "f_lineno", 0), code.co_name))


def fold_async_counts(counts: Dict[str, int], top_n: int = TOP_N) -> Tuple[List[Dict[str, Any]], int, bool]:
    """{stackKey→ticks} → (folds value=samples, totalSamples, truncated). Pure/testable."""
    folded = [{"stack": k.split("\x00"), "value": v} for k, v in counts.items() if v > 0]
    total = sum(s["value"] for s in folded)
    folded.sort(key=lambda s: (-s["value"], "\x00".join(s["stack"])))
    return folded[:top_n], total, len(folded) > top_n


def _profile_async_target(
    path: str, cwd: Optional[str], timeout: float, target_args: Sequence[str]
) -> Tuple[Dict[str, int], bool, Optional[str], bool]:
    """Run the target and sample asyncio tasks from a daemon thread.

    Returns (stack→ticks, timedOut, runError, sawTasks). ``sawTasks`` False = the target
    ran no asyncio tasks (a sync program) → the caller emits the fail-soft note.
    """
    import asyncio
    import asyncio.events as _ev
    import contextlib
    import runpy
    import threading
    import time

    counts: Dict[str, int] = {}
    saw_tasks = [False]
    run_error: Optional[str] = None
    timed_out = [False]
    captured: Dict[str, Any] = {"loop": None}

    # capture the loop the target starts running (asyncio calls _set_running_loop on entry).
    orig_set_running = _ev._set_running_loop

    def _cap(loop: Any) -> Any:
        if loop is not None:
            captured["loop"] = loop
        return orig_set_running(loop)

    interval = min(0.005, max(0.0005, timeout / 400.0))
    stop_flag = threading.Event()

    def _sampler() -> None:
        while not stop_flag.is_set():
            loop = captured["loop"]
            if loop is not None:
                try:
                    for task in asyncio.all_tasks(loop):
                        if task.done():
                            continue
                        saw_tasks[0] = True
                        try:
                            label = task.get_name()
                        except Exception:  # noqa: BLE001
                            label = "task"
                        frames = task.get_stack(limit=64)
                        stack = [f"task:{label}"] + [_async_frame_name(f) for f in reversed(frames)]
                        key = "\x00".join(stack)
                        counts[key] = counts.get(key, 0) + 1
                except Exception:  # noqa: BLE001 — sampling is best-effort, never fatal
                    pass
            stop_flag.wait(interval)

    abs_path = os.path.abspath(path)
    target_dir = os.path.dirname(abs_path)
    old_argv, old_cwd = sys.argv[:], os.getcwd()
    has_alarm = hasattr(signal, "setitimer")

    def _on_alarm(_signo: int, _frame: Any) -> None:
        timed_out[0] = True
        raise _TimeUp()

    sampler = threading.Thread(target=_sampler, name="prom-async-sampler", daemon=True)
    _ev._set_running_loop = _cap
    try:
        sys.path.insert(0, target_dir)
        os.chdir(cwd or target_dir)
        sys.argv = [abs_path, *target_args]
        if has_alarm:
            signal.signal(signal.SIGALRM, _on_alarm)
            signal.setitimer(signal.ITIMER_REAL, max(0.001, timeout))
        sampler.start()
        try:
            with open(os.devnull, "w", encoding="utf-8") as devnull:
                with contextlib.redirect_stdout(devnull), contextlib.redirect_stderr(devnull):
                    runpy.run_path(abs_path, run_name="__main__")
        except _TimeUp:
            pass
        except SystemExit:
            pass
        except Exception as exc:  # noqa: BLE001
            run_error = f"{type(exc).__name__}: {exc}"
        finally:
            if has_alarm:
                signal.setitimer(signal.ITIMER_REAL, 0)
    finally:
        stop_flag.set()
        sampler.join(timeout=1.0)
        _ev._set_running_loop = orig_set_running
        sys.argv = old_argv
        os.chdir(old_cwd)
        try:
            sys.path.remove(target_dir)
        except ValueError:
            pass
    return counts, timed_out[0], run_error, saw_tasks[0]


# --------------------------------------------------------------------------- #
# snapshot persistence + compare (delta math). Files live under a MAIN-supplied --dir.
# --------------------------------------------------------------------------- #


def _safe_id(raw: Optional[str]) -> Optional[str]:
    """A user NAME → a filename-safe stem (sanitizes separators away), or None if empty."""
    if not raw:
        return None
    stem = "".join(ch if ch in _ID_OK else "-" for ch in str(raw)).strip("-.")
    return stem or None


def _valid_id(raw: Optional[str]) -> Optional[str]:
    """A snapshot ID for path resolution — REJECTED (None) if it carries a separator, a
    ``..`` sequence, or any non-``[A-Za-z0-9._-]`` char (no sanitize-and-proceed for a
    path that indexes the filesystem)."""
    if not raw:
        return None
    s = str(raw)
    if "/" in s or "\\" in s or ".." in s:
        return None
    if any(ch not in _ID_OK for ch in s):
        return None
    return s


def _snapshot_path(dir_path: str, snap_id: str) -> Optional[str]:
    """Resolve <dir>/<id>.json and confirm it stays inside <dir> (no traversal)."""
    safe = _valid_id(snap_id)
    if safe is None:
        return None
    root = os.path.abspath(dir_path)
    full = os.path.abspath(os.path.join(root, f"{safe}.json"))
    if full != os.path.join(root, f"{safe}.json"):
        return None
    return full


def delta_samples(
    a: Sequence[Dict[str, Any]], b: Sequence[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Signed per-call-path delta (b − a). A path only in b is a pure regression (a=0);
    only in a is an improvement (b=0). Keys are the FULL stack path (function identity +
    parent chain), never an index — the same fn under two callers stays two nodes."""
    map_a: Dict[str, int] = {}
    map_b: Dict[str, int] = {}
    for s in a:
        map_a["\x00".join(s["stack"])] = map_a.get("\x00".join(s["stack"]), 0) + int(s["value"])
    for s in b:
        map_b["\x00".join(s["stack"])] = map_b.get("\x00".join(s["stack"]), 0) + int(s["value"])
    out: List[Dict[str, Any]] = []
    for key in set(map_a) | set(map_b):
        d = map_b.get(key, 0) - map_a.get(key, 0)
        if d != 0:
            out.append({"stack": key.split("\x00"), "value": d})
    out.sort(key=lambda s: (-abs(s["value"]), "\x00".join(s["stack"])))
    return out


def _delta_summary(deltas: Sequence[Dict[str, Any]], top: int = 8) -> Dict[str, Any]:
    """Per-leaf net delta → top regressions (positive) + improvements (negative)."""
    by_leaf: Dict[str, int] = {}
    for s in deltas:
        leaf = s["stack"][-1] if s["stack"] else "<root>"
        by_leaf[leaf] = by_leaf.get(leaf, 0) + int(s["value"])
    regressions = sorted(
        ({"name": n, "delta": v} for n, v in by_leaf.items() if v > 0),
        key=lambda r: -r["delta"],
    )[:top]
    improvements = sorted(
        ({"name": n, "delta": v} for n, v in by_leaf.items() if v < 0),
        key=lambda r: r["delta"],
    )[:top]
    return {"regressions": regressions, "improvements": improvements}


def _load_snapshot(dir_path: str, snap_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    full = _snapshot_path(dir_path, snap_id)
    if full is None:
        return None, f"invalid snapshot id '{snap_id}'"
    if not os.path.isfile(full):
        return None, f"snapshot not found: {snap_id}"
    try:
        with open(full, "r", encoding="utf-8") as fh:
            import json as _json

            return _json.load(fh), None
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


def _snapshot(argv: Sequence[str]) -> int:
    """snapshot --op save|list --dir <d> [--name <n>]. save reads the body from stdin."""
    import json as _json

    op = opt_value(argv, "--op") or "list"
    dir_path = opt_value(argv, "--dir")
    if not dir_path:
        return fail("snapshot", "--dir is required")
    os.makedirs(dir_path, exist_ok=True)
    if op == "save":
        try:
            body = _json.loads(sys.stdin.read() or "{}")
        except Exception as exc:  # noqa: BLE001
            return fail("snapshot", f"bad body: {type(exc).__name__}: {exc}")
        name = opt_value(argv, "--name") or str(body.get("name") or "snapshot")
        stem = _safe_id(name) or "snapshot"
        # unique, resume-safe id: name + a monotonic-ish suffix (time is fine in a real proc).
        import time as _time

        snap_id = f"{stem}-{int(_time.time() * 1000)}"
        full = _snapshot_path(dir_path, snap_id)
        if full is None:
            return fail("snapshot", "could not resolve a safe snapshot path")
        record = {
            "id": snap_id,
            "name": name,
            "mode": str(body.get("mode") or "cpu"),
            "unit": str(body.get("unit") or MODE_UNIT.get(str(body.get("mode") or "cpu"), "us")),
            "savedAt": int(_time.time() * 1000),
            "totalValue": int(body.get("totalValue") or 0),
            "samples": body.get("samples") or [],
        }
        with open(full, "w", encoding="utf-8") as fh:
            _json.dump(record, fh)
        return emit("snapshot", op="save", id=snap_id, file=os.path.basename(full))
    # op == list
    items: List[Dict[str, Any]] = []
    try:
        names = sorted(os.listdir(dir_path))
    except OSError:
        names = []
    for fn in names:
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(dir_path, fn), "r", encoding="utf-8") as fh:
                rec = _json.load(fh)
            items.append(
                {
                    "id": rec.get("id") or fn[:-5],
                    "name": rec.get("name") or fn[:-5],
                    "mode": rec.get("mode") or "cpu",
                    "unit": rec.get("unit") or "us",
                    "savedAt": int(rec.get("savedAt") or 0),
                    "totalValue": int(rec.get("totalValue") or 0),
                }
            )
        except Exception:  # noqa: BLE001 — skip a corrupt file, never crash the list
            continue
    items.sort(key=lambda it: -it["savedAt"])
    return emit("snapshot", op="list", snapshots=items)


def _compare(argv: Sequence[str]) -> int:
    """compare --dir <d> --a <idA> --b <idB> → a signed delta tree + regression summary."""
    dir_path = opt_value(argv, "--dir")
    a_id = opt_value(argv, "--a")
    b_id = opt_value(argv, "--b")
    if not dir_path or not a_id or not b_id:
        return fail("compare", "--dir, --a and --b are required")
    a_rec, a_err = _load_snapshot(dir_path, a_id)
    if a_err:
        return fail("compare", a_err)
    b_rec, b_err = _load_snapshot(dir_path, b_id)
    if b_err:
        return fail("compare", b_err)
    a_unit = str((a_rec or {}).get("unit") or "us")
    b_unit = str((b_rec or {}).get("unit") or "us")
    if a_unit != b_unit:
        # never subtract ms from bytes — a cross-unit compare is meaningless (fail-closed).
        return fail("compare", f"unit mismatch: '{a_unit}' vs '{b_unit}' (compare same-mode snapshots)")
    deltas = delta_samples((a_rec or {}).get("samples") or [], (b_rec or {}).get("samples") or [])
    return emit(
        "compare",
        samples=deltas,
        unit=a_unit,
        aId=a_id,
        bId=b_id,
        aMode=str((a_rec or {}).get("mode") or "cpu"),
        bMode=str((b_rec or {}).get("mode") or "cpu"),
        summary=_delta_summary(deltas),
    )


def _clamp_timeout(raw: Optional[str]) -> float:
    try:
        t = float(raw) if raw is not None else DEFAULT_TIMEOUT_S
    except (TypeError, ValueError):
        t = DEFAULT_TIMEOUT_S
    return max(0.001, min(t, 3600.0))


def _run(argv: Sequence[str]) -> int:
    path = opt_value(argv, "--path")
    if not path:
        return fail("run", "--path is required")
    _head, target_args, arg_err = split_target_args(argv)
    if arg_err:
        return fail("run", arg_err)
    reason = guard_reason()
    if reason:
        return fail("run", "load", detail=reason)
    abs_path = os.path.abspath(path)
    if not os.path.isfile(abs_path):
        return fail("run", f"target not found: {path}")
    cwd = opt_value(argv, "--cwd")
    timeout = _clamp_timeout(opt_value(argv, "--timeout"))
    mode = (opt_value(argv, "--mode") or "cpu").lower()
    if mode not in MODE_UNIT:
        return fail("run", f"unknown mode '{mode}'; expected: {', '.join(MODE_UNIT)}")

    if mode == "memory":
        try:
            snapshot, timed_out, run_error = _profile_memory_target(abs_path, cwd, timeout, target_args)
        except Exception as exc:  # noqa: BLE001
            return fail("run", f"{type(exc).__name__}: {exc}")
        samples, total, truncated = fold_tracemalloc(snapshot)
        return emit(
            "run",
            mode="memory",
            unit=MODE_UNIT["memory"],
            samples=samples,
            totalUs=total,  # totalUs is the generic "total value" field (here: bytes)
            exit=0,
            approx=False,
            note="tracemalloc net-retained bytes (alloc-then-free shows near-zero)",
            truncated=truncated,
            timedOut=timed_out,
            runError=run_error,
        )

    if mode == "async":
        try:
            counts, timed_out, run_error, saw_tasks = _profile_async_target(
                abs_path, cwd, timeout, target_args
            )
        except Exception as exc:  # noqa: BLE001
            return fail("run", f"{type(exc).__name__}: {exc}")
        samples, total, truncated = fold_async_counts(counts)
        note = (
            "asyncio task sampling (one tick per active task)"
            if saw_tasks
            else "not an asyncio program (no active tasks sampled)"
        )
        return emit(
            "run",
            mode="async",
            unit=MODE_UNIT["async"],
            samples=samples,
            totalUs=total,  # generic total value (here: sample ticks)
            exit=0,
            approx=True,
            note=note,
            sawTasks=saw_tasks,
            truncated=truncated,
            timedOut=timed_out,
            runError=run_error,
        )

    # mode == cpu (default)
    try:
        stats, timed_out, run_error = _profile_target(abs_path, cwd, timeout, target_args)
    except Exception as exc:  # noqa: BLE001 — never crash without an envelope
        return fail("run", f"{type(exc).__name__}: {exc}")
    samples, total_us, truncated = fold_stats(stats)
    return emit(
        "run",
        mode="cpu",
        unit=MODE_UNIT["cpu"],
        samples=samples,
        totalUs=total_us,
        exit=0,
        approx=True,
        note="cProfile edge-reconstructed (approximate) folds; py-spy gives true sampled stacks",
        truncated=truncated,
        timedOut=timed_out,
        pyspy=shutil.which("py-spy") is not None,
        runError=run_error,
    )


def _version(_argv: Sequence[str]) -> int:
    return emit("version", version="1.1.0")


HANDLERS = {
    "run": _run,
    "snapshot": _snapshot,
    "compare": _compare,
    "version": _version,
}


def main(argv: Sequence[str]) -> int:
    args = list(argv)
    if not args:
        return fail(PROG, "no verb given; expected: run, snapshot, compare, version")
    verb = args[0]
    handler = HANDLERS.get(verb)
    if handler is None:
        return fail(verb, f"unknown verb '{verb}'; expected: run, snapshot, compare, version")
    try:
        return handler(args[1:])
    except Exception as exc:  # noqa: BLE001 — fail-closed
        import traceback as _tb

        log("traceback:", _tb.format_exc())
        return fail(verb, f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
