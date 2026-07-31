#!/usr/bin/env python3
"""testmgr.py — test discovery + gated run sidecar (file 14 §3.19, APP-013).

Discovers pytest/unittest/doctest-style tests by **AST scan** (never imports the target
code — discovery must not execute project code; the first actual *run* crosses the
run-gate upstream, C4/C5). Emits a ``TestNode`` tree the Test Explorer renders.

Verbs:
  discover --path <dir>   walk *.py, AST-scan for tests → {ok, command, tree}
  run --path <dir> --framework pytest|unittest|auto --id <nodeid> [--id …]
                          [--timeout <sec>]
                          EXECUTE exactly the given node ids (subprocess, no shell,
                          cwd=path). `auto` picks pytest when available, else unittest.
                          Streams one JSON-line per test event on stdout, then the
                          terminal {ok, command, summary} envelope LAST. A positive
                          --timeout group-kills the run on expiry (summary.timedOut).
  rerun-failed --path <dir> --framework … --failed <nodeid> [--failed …]
                          re-run ONLY the supplied failed ids (same run path).
  version                 {ok, command, version}

Pure stdlib (ast, os, subprocess). Contract: ``discover``/``version`` emit exactly one
JSON object on stdout (C2/C7). ``run``/``rerun-failed`` are the ONE sanctioned
exception: they stream ``{"event":"test",…}`` JSON-lines (flushed per line — stdout
is a pipe) followed by the envelope as the LAST line, which the bridge's last-to-first
object scan still recovers. Running tests EXECUTES project code BY DESIGN — but only
via the explicit, user-initiated IPC path; discovery stays never-execute.
"""
from __future__ import annotations

import ast
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Sequence

from _envelope import dispatch, emit, fail, log, opt_value

PROG = "testmgr"
VERSION = "1.0.0"

_SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".tox", ".mypy_cache"}


def _is_test_file(name: str) -> bool:
    return name.endswith(".py") and (name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py")


def _node(node_id: str, kind: str, label: str, file: str, line: Optional[int] = None) -> Dict[str, Any]:
    out: Dict[str, Any] = {"id": node_id, "kind": kind, "label": label, "file": file}
    if line is not None:
        out["line"] = line
    return out


def _scan_file(path: str, rel: str) -> Optional[Dict[str, Any]]:
    """AST-scan one test file → a file TestNode with class/case children (no import)."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), filename=path)
    except (OSError, SyntaxError, ValueError) as exc:
        log(f"skip {rel}: {type(exc).__name__}: {exc}")
        return None

    children: List[Dict[str, Any]] = []
    for item in tree.body:
        # top-level test functions
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name.startswith("test"):
            children.append(_node(f"{rel}::{item.name}", "case", item.name, rel, item.lineno))
        # test classes (Test* or unittest.TestCase subclasses) with test_* methods
        elif isinstance(item, ast.ClassDef) and (item.name.startswith("Test") or _looks_like_testcase(item)):
            cases = [
                _node(f"{rel}::{item.name}::{m.name}", "case", m.name, rel, m.lineno)
                for m in item.body
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m.name.startswith("test")
            ]
            if cases:
                cls = _node(f"{rel}::{item.name}", "class", item.name, rel, item.lineno)
                cls["children"] = cases
                children.append(cls)
    if not children:
        return None
    file_node = _node(rel, "file", os.path.basename(rel), rel)
    file_node["children"] = children
    return file_node


def _looks_like_testcase(cls: ast.ClassDef) -> bool:
    for base in cls.bases:
        if isinstance(base, ast.Attribute) and base.attr == "TestCase":
            return True
        if isinstance(base, ast.Name) and base.id == "TestCase":
            return True
    return False


def _discover(argv: Sequence[str]) -> int:
    root = opt_value(argv, "--path", ".") or "."
    if not os.path.isdir(root):
        return fail("discover", f"not a directory: {root}")
    files: List[Dict[str, Any]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for name in sorted(filenames):
            if _is_test_file(name) and name != "conftest.py":
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, root)
                node = _scan_file(full, rel)
                if node is not None:
                    files.append(node)
    files.sort(key=lambda n: n["id"])
    case_count = sum(_count_cases(n) for n in files)
    return emit("discover", root=os.path.abspath(root), tree=files, fileCount=len(files), caseCount=case_count)


def _count_cases(node: Dict[str, Any]) -> int:
    if node.get("kind") == "case":
        return 1
    return sum(_count_cases(c) for c in node.get("children", []))


# --- run / rerun-failed (APP-013) ------------------------------------------- #

# Shell metachars are rejected even though the argv is exec'd without a shell —
# defense in depth, mirrored by the ide-validate.ts zod layer. pytest node ids
# legitimately contain :: [ ] . - / and spaces inside [params], so this is a
# BLOCKLIST, not a too-strict allowlist that would drop parametrized ids.
_FORBIDDEN_ID_CHARS = set(";|&$`<>\\")


def _safe_id(node_id: str) -> bool:
    if not node_id or node_id.startswith("-"):
        return False
    if any(c in _FORBIDDEN_ID_CHARS for c in node_id):
        return False
    return all(ord(c) >= 32 for c in node_id)


def _collect_values(argv: Sequence[str], name: str) -> List[str]:
    """All values for repeated ``--name VALUE`` / ``--name=VALUE``, in order."""
    out: List[str] = []
    pref = name + "="
    args = list(argv)
    i = 0
    while i < len(args):
        a = args[i]
        if a == name and i + 1 < len(args):
            out.append(args[i + 1])
            i += 2
            continue
        if a.startswith(pref):
            out.append(a[len(pref):])
        i += 1
    return out


def _build_run_argv(framework: str, ids: Sequence[str]) -> List[str]:
    """Per-framework argv. pytest REQUIRES the ``--`` separator before positional
    node ids; ``-m unittest`` takes dotted ids and has NO ``--`` support."""
    if framework == "pytest":
        return [
            sys.executable, "-u", "-m", "pytest",
            "-v", "--tb=short", "-p", "no:cacheprovider", "--no-header",
            "--", *ids,
        ]
    return [sys.executable, "-u", "-m", "unittest", "-v", *ids]


def _pytest_available() -> bool:
    """Probe pytest by RUNNING it (``-m pytest --version``), not shutil.which — pytest
    may be importable but not on PATH as a script. Absent ⇒ fall back to unittest."""
    try:
        r = subprocess.run(
            [sys.executable, "-m", "pytest", "--version"],
            capture_output=True, timeout=20,
        )
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _resolve_framework(framework: str) -> str:
    """`auto` → pytest when available, else unittest; explicit names pass through."""
    if framework == "auto":
        return "pytest" if _pytest_available() else "unittest"
    return framework


def _spawn(argv: Sequence[str], cwd: str) -> "subprocess.Popen[str]":
    """The subprocess seam (tests monkeypatch this). No shell; stderr merged into
    stdout because unittest's ``-v`` result lines go to stderr. Spawns into its OWN
    process group/session so a ``--timeout`` can reap the WHOLE tree (a test-spawned
    grandchild that inherited the stdout pipe would otherwise keep the caller blocked)."""
    kwargs: Dict[str, Any] = {}
    if os.name == "posix":
        kwargs["start_new_session"] = True
    elif os.name == "nt":  # pragma: no cover - exercised on Windows only
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    return subprocess.Popen(
        list(argv), cwd=cwd, shell=False,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, **kwargs,
    )


def _kill_group(proc: "subprocess.Popen[str]") -> None:
    """SIGKILL the whole process group (POSIX) so a grandchild can't outlive the
    timeout and hang the caller's pipe read; fall back to a plain kill elsewhere."""
    try:
        if hasattr(os, "getpgid"):
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        else:  # pragma: no cover - non-POSIX fallback
            proc.kill()
    except (ProcessLookupError, OSError):
        pass  # already gone


def _emit_event(obj: Dict[str, Any]) -> None:
    """One JSON-line per test event, flushed per line — stdout is a pipe, so without
    the flush every event would arrive at once at process exit (not live)."""
    sys.stdout.write(json.dumps(obj, sort_keys=True, ensure_ascii=False) + "\n")
    sys.stdout.flush()


_PYTEST_STATUS = {
    "PASSED": "pass", "XPASS": "pass",
    "FAILED": "fail", "ERROR": "fail",
    "SKIPPED": "skip", "XFAIL": "skip",
}
_PYTEST_RESULT_RE = re.compile(r"\s(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b")
_UNITTEST_RESULT_RE = re.compile(
    r"^(\w+) \(([^)]+)\) \.\.\. "
    r"(ok|FAIL|ERROR|skipped(?: .*)?|expected failure|unexpected success)\s*$"
)


def _parse_pytest_line(line: str) -> Optional[Dict[str, Any]]:
    """A ``-v`` result line: ``<nodeid> STATUS [ 33%]``. The node id may contain
    spaces inside ``[params]``, so the STATUS token is matched, not the id shape.
    Summary lines (``FAILED x`` at column 0) don't match — no double counting."""
    m = _PYTEST_RESULT_RE.search(line)
    if m is None:
        return None
    node_id = line[: m.start()].strip()
    if "::" not in node_id:
        return None
    return {"id": node_id, "status": _PYTEST_STATUS[m.group(1)]}


def _parse_unittest_line(line: str) -> Optional[Dict[str, Any]]:
    """A ``-v`` result line: ``test_m (pkg.mod.Cls.test_m) ... ok|FAIL|ERROR|…``.
    3.11+ parenthesizes the full dotted id; older Pythons only the class — append
    the method name in that case so the id round-trips to a runnable dotted id."""
    m = _UNITTEST_RESULT_RE.match(line)
    if m is None:
        return None
    name, qual, verdict = m.group(1), m.group(2), m.group(3)
    node_id = qual if qual == name or qual.endswith("." + name) else f"{qual}.{name}"
    if verdict == "ok":
        status = "pass"
    elif verdict.startswith("skipped") or verdict == "expected failure":
        status = "skip"
    else:  # FAIL / ERROR / unexpected success
        status = "fail"
    ev: Dict[str, Any] = {"id": node_id, "status": status}
    if verdict.startswith("skipped "):
        ev["message"] = verdict[len("skipped "):].strip("'\"")
    return ev


# --- per-failure output + file:line (APP-040) ------------------------------- #

_MAX_OUTPUT_LINES = 120  # per-test captured-output cap (a chatty failure can't flood IPC)
_MAX_SCAN_LINES = 6000   # bounded full-output retention for the post-run failures scan


def _in_workspace_frame(path: str) -> bool:
    """A traceback frame worth navigating to: a project .py, never a dependency."""
    return path.endswith(".py") and "site-packages" not in path and "/lib/python" not in path


def _cap_output(block: List[str]) -> List[str]:
    if len(block) <= _MAX_OUTPUT_LINES:
        return block
    return [*block[:_MAX_OUTPUT_LINES], f"… ({len(block) - _MAX_OUTPUT_LINES} more lines truncated)"]


def _pytest_block_info(block: List[str]) -> Dict[str, Any]:
    """A FAILURES block → {output, file?, line?}. The LAST in-workspace `path:line:`
    frame (nearest the assertion) is the navigation target."""
    info: Dict[str, Any] = {"output": _cap_output(block)}
    frame_re = re.compile(r"^(\S.*?):(\d+): ")
    for ln in block:
        m = frame_re.match(ln)
        if m and _in_workspace_frame(m.group(1)):
            info["file"], info["line"] = m.group(1), int(m.group(2))
    return info


def _pytest_failures(lines: Sequence[str]) -> Dict[str, Dict[str, Any]]:
    """Parse the ``= FAILURES =`` / ``= ERRORS =`` section into {display-key → info}.
    A block header is ``____ TestX.test_foo[param] ____``; the key is that name."""
    out: Dict[str, Dict[str, Any]] = {}
    sep_re = re.compile(r"^=+ (FAILURES|ERRORS) =+\s*$")
    boundary_re = re.compile(r"^=+.*=+\s*$")
    header_re = re.compile(r"^_+ (.+?) _+\s*$")
    in_section = False
    key: Optional[str] = None
    block: List[str] = []

    def flush() -> None:
        nonlocal key, block
        if key is not None:
            out[key] = _pytest_block_info(block)
        key, block = None, []

    for line in lines:
        if sep_re.match(line):
            flush()
            in_section = True
            continue
        if in_section and boundary_re.match(line):
            flush()
            in_section = False
            continue
        if not in_section:
            continue
        h = header_re.match(line)
        if h:
            flush()
            key = h.group(1).strip()
            continue
        if key is not None:
            block.append(line)
    flush()
    return out


def _unittest_failures(lines: Sequence[str]) -> Dict[str, Dict[str, Any]]:
    """Parse unittest ``FAIL:/ERROR: test (dotted.id)`` blocks → {dotted-id → info}."""
    out: Dict[str, Dict[str, Any]] = {}
    head_re = re.compile(r"^(?:FAIL|ERROR): \S+ \(([^)]+)\)")
    frame_re = re.compile(r'^\s*File "(.+?)", line (\d+), in ')
    key: Optional[str] = None
    block: List[str] = []

    def flush() -> None:
        nonlocal key, block
        if key is not None:
            info: Dict[str, Any] = {"output": _cap_output(block)}
            for ln in block:
                m = frame_re.match(ln)
                if m and _in_workspace_frame(m.group(1)):
                    info["file"], info["line"] = m.group(1), int(m.group(2))
            out[key] = info
        key, block = None, []

    for line in lines:
        if line.startswith("Ran "):
            flush()
            continue
        h = head_re.match(line)
        if h:
            flush()
            key = h.group(1)
            continue
        if key is not None:
            block.append(line)
    flush()
    return out


def _failure_key(framework: str, node_id: str) -> str:
    """Map an emitted node id to its FAILURES-block key. pytest ids drop the file
    path and join the rest with '.'; unittest ids ARE the dotted key already."""
    if framework == "pytest":
        return ".".join(node_id.split("::")[1:]) or node_id
    return node_id


def _run_ids(command: str, argv: Sequence[str], ids: List[str], flag: str) -> int:
    root = opt_value(argv, "--path", ".") or "."
    # option-injection guard: an option-shaped --path value (e.g. `--path=--help`,
    # or `--path` swallowing the next flag) must never reach subprocess as a path.
    if root.startswith("-"):
        return fail(command, f"refusing option-shaped --path value: {root!r}")
    framework = (opt_value(argv, "--framework", "pytest") or "pytest").lower()
    timeout_raw = opt_value(argv, "--timeout", "0") or "0"
    if not os.path.isdir(root):
        return fail(command, f"not a directory: {root}")
    if framework not in ("pytest", "unittest", "auto"):
        return fail(command, f"unknown framework '{framework}' (expected pytest|unittest|auto)")
    try:
        timeout = max(0, int(float(timeout_raw)))  # 0 = unlimited (caller opts in)
    except ValueError:
        return fail(command, f"invalid --timeout (seconds expected): {timeout_raw!r}")
    if not ids:
        return fail(command, f"no test ids given (repeat {flag} <nodeid>)")
    bad = [i for i in ids if not _safe_id(i)]
    if bad:
        return fail(command, f"rejected unsafe test id(s): {', '.join(bad[:5])}")

    framework = _resolve_framework(framework)  # `auto` → pytest-or-unittest
    run_argv = _build_run_argv(framework, ids)
    parse = _parse_pytest_line if framework == "pytest" else _parse_unittest_line
    started = time.monotonic()
    try:
        proc = _spawn(run_argv, root)
    except OSError as exc:
        return fail(command, f"failed to launch {run_argv[0]}: {exc}")

    # hard timeout: a watchdog thread group-kills the run on expiry, which closes the
    # stdout pipe and unblocks the read loop below — the caller never hangs.
    timed_out = {"flag": False}
    timer: Optional[threading.Timer] = None
    if timeout > 0:
        def _on_timeout() -> None:
            timed_out["flag"] = True
            _kill_group(proc)

        timer = threading.Timer(timeout, _on_timeout)
        timer.daemon = True
        timer.start()

    counts = {"pass": 0, "fail": 0, "skip": 0}
    tail: List[str] = []  # bounded raw-output tail for soft-error diagnostics
    scan: List[str] = []  # bounded FULL output retained for the post-run failures parse
    failed_ids: List[str] = []
    assert proc.stdout is not None
    try:
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            tail.append(line)
            if len(tail) > 50:
                tail.pop(0)
            if len(scan) < _MAX_SCAN_LINES:
                scan.append(line)
            ev = parse(line)
            if ev is None:
                continue
            counts[ev["status"]] += 1
            if ev["status"] == "fail":
                failed_ids.append(ev["id"])
            _emit_event({"event": "test", **ev})
    finally:
        if timer is not None:
            timer.cancel()
    exit_code = proc.wait()

    # APP-040: after the live status events, attach captured output + the failing
    # file:line to each FAILED test as a follow-up update (the renderer merges by id).
    if failed_ids:
        failures = _pytest_failures(scan) if framework == "pytest" else _unittest_failures(scan)
        for fid in failed_ids:
            info = failures.get(_failure_key(framework, fid))
            if info:
                _emit_event({"event": "test", "id": fid, "status": "fail", **info})
    duration_ms = int((time.monotonic() - started) * 1000)
    total = sum(counts.values())
    summary: Dict[str, Any] = {
        "total": total,
        "passed": counts["pass"],
        "failed": counts["fail"],
        "skipped": counts["skip"],
        "exitCode": exit_code,
        "durationMs": duration_ms,
    }
    # timeout short-circuit: partial results are already streamed; the terminal
    # envelope is fail-closed with timedOut + the offending id (null if killed mid-
    # collection, i.e. more than one id was requested and none finished).
    if timed_out["flag"]:
        summary["timedOut"] = True
        summary["timedOutId"] = ids[0] if len(ids) == 1 else None
        return fail(command, f"run timed out after {timeout}s", summary=summary)
    # pytest exits: 0 pass, 1 tests-failed, 2 interrupted, 3 internal, 4 usage,
    # 5 nothing collected. 1 with zero parsed results is `-m pytest` failing to
    # import pytest itself — fail SOFT (structured), never a traceback.
    if framework == "pytest":
        if exit_code == 5:
            summary["collected"] = 0
            return emit(command, summary=summary)
        if exit_code == 1 and total == 0 and any("No module named pytest" in ln for ln in tail):
            return fail(command, "pytest is not installed in the target environment "
                                 "(python3 -m pytest failed with ModuleNotFoundError)")
        if exit_code in (2, 3, 4):
            return fail(command, f"pytest aborted (exit {exit_code}): {' | '.join(tail[-3:])}")
    elif total == 0 and exit_code != 0:
        return fail(command, f"unittest produced no results (exit {exit_code}): "
                             f"{' | '.join(tail[-3:])}")
    return emit(command, summary=summary)


def _run(argv: Sequence[str]) -> int:
    return _run_ids("run", argv, _collect_values(argv, "--id"), "--id")


def _rerun_failed(argv: Sequence[str]) -> int:
    # the built argv contains ONLY the supplied failed ids — same run path.
    return _run_ids("rerun-failed", argv, _collect_values(argv, "--failed"), "--failed")


def _version(_argv: Sequence[str]) -> int:
    return emit("version", version=VERSION)


HANDLERS = {
    "discover": _discover,
    "run": _run,
    "rerun-failed": _rerun_failed,
    "version": _version,
}


if __name__ == "__main__":
    raise SystemExit(dispatch(PROG, HANDLERS, sys.argv[1:]))
