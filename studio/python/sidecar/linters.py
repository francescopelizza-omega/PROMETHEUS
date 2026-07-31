#!/usr/bin/env python3
"""linters.py — fan ruff/flake8/mypy/pylint output into ONE normalized diagnostic stream.

Stdlib-only (the C7 sidecar convention, `_envelope.py`). The four linters are the USER's
tools — invoked as SUBPROCESSES with a safe env, never imported (no pip deps here). Two
verbs:

  * ``detect --python <interp>`` — which of ruff/flake8/mypy/pylint resolve in the selected
    interpreter's env (absolute paths only); a missing tool is reported, never fatal.
  * ``run --python <interp> [--tools a,b] -- <path>...`` — execute each AVAILABLE tool on the
    given paths, parse its output, normalize to
    ``{path,line,col,ruleId,tool,severity,message}``, DE-DUPE across tools by
    (path,line,ruleId) keeping the first tool, and emit the merged list. A tool that isn't
    installed or errors is SKIPPED with a note — the run always succeeds with what it has.

Argv is built POSITIONALLY with ``--`` before the user paths (a filename like ``--fix`` must
never become a linter flag); tools are spawned with ``shell=False`` + a copied env.

The PARSERS are pure functions (parse_ruff / parse_flake8 / parse_mypy / parse_pylint) so
test_linters.py covers them with canned tool output — no live linter required.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _envelope import dispatch, emit, fail, log, opt_value, positional  # noqa: E402

TOOLS = ["ruff", "flake8", "mypy", "pylint"]
RUN_TIMEOUT_S = 120

# --- binary resolution ------------------------------------------------------- #


def resolve_tool(name: str, python: Optional[str]) -> Optional[str]:
    """Absolute path to ``name`` in the SELECTED interpreter's env, else on PATH; else None.

    A venv co-locates its console scripts beside the interpreter (``<venv>/bin/ruff``), so we
    look there first; a system tool falls back to ``shutil.which``. Absolute paths only.
    """
    if python:
        bindir = os.path.dirname(os.path.abspath(python))
        for cand in (os.path.join(bindir, name), os.path.join(bindir, name + ".exe")):
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                return cand
    found = shutil.which(name)
    return os.path.abspath(found) if found else None


def detect(argv: List[str]) -> int:
    python = opt_value(argv, "--python")
    tools: Dict[str, Dict[str, str]] = {}
    missing: List[str] = []
    for name in TOOLS:
        path = resolve_tool(name, python)
        if path:
            tools[name] = {"path": path}
        else:
            missing.append(name)
    return emit("detect", tools=tools, missing=missing)


# --- severity normalization -------------------------------------------------- #

# our normalized severities mirror the inspection-profile levels (minus "off").
_PYLINT_SEV = {
    "fatal": "error",
    "error": "error",
    "warning": "warning",
    "refactor": "hint",
    "convention": "info",
}


def _ruff_severity(_code: str) -> str:
    # ruff's JSON carries no severity; every violation is a lint warning by default.
    return "warning"


def _flake8_severity(code: str) -> str:
    c = code[:1].upper()
    if c == "F":
        return "error"  # pyflakes (undefined name, unused import) — real bugs
    if c == "W":
        return "warning"
    if c == "C":
        return "info"  # complexity
    return "warning"  # E (pycodestyle) + anything else


def _mypy_severity(sev: str) -> str:
    return "error" if sev == "error" else "info"  # "note" → info


# --- pure parsers (one per tool) --------------------------------------------- #


def parse_ruff(text: str) -> List[Dict[str, Any]]:
    """Parse ``ruff check --output-format json`` — a JSON array of violations."""
    out: List[Dict[str, Any]] = []
    try:
        rows = json.loads(text) if text.strip() else []
    except json.JSONDecodeError:
        return out
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict):
            continue
        loc = r.get("location") or {}
        code = str(r.get("code") or "")
        out.append(
            {
                "path": str(r.get("filename") or ""),
                "line": int(loc.get("row") or 1),
                "col": int(loc.get("column") or 1),
                "ruleId": code,
                "tool": "ruff",
                "severity": _ruff_severity(code),
                "message": str(r.get("message") or ""),
            }
        )
    return out


def parse_flake8(text: str) -> List[Dict[str, Any]]:
    """Parse flake8 driven by ``--format=%(path)s:%(row)d:%(col)d:%(code)s:%(text)s``.

    Split on the FIRST 4 colons only — the message may itself contain colons.
    """
    out: List[Dict[str, Any]] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            continue
        parts = line.split(":", 4)
        if len(parts) != 5:
            continue
        path, row, col, code, msg = parts
        try:
            ln, cl = int(row), int(col)
        except ValueError:
            continue
        code = code.strip()
        out.append(
            {
                "path": path,
                "line": ln,
                "col": cl,
                "ruleId": code,
                "tool": "flake8",
                "severity": _flake8_severity(code),
                "message": msg.strip(),
            }
        )
    return out


def parse_mypy(text: str) -> List[Dict[str, Any]]:
    """Parse mypy: native ``--output json`` (one object per line) with a text fallback.

    JSON line fields: file, line, column, severity, message, code (mypy 1.11+). The text
    fallback parses ``file:line:col: severity: message  [code]`` (with
    ``--show-column-numbers --no-error-summary --no-color-output``).
    """
    out: List[Dict[str, Any]] = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        if s.startswith("{"):
            try:
                r = json.loads(s)
            except json.JSONDecodeError:
                continue
            if not isinstance(r, dict) or "file" not in r:
                continue
            out.append(
                {
                    "path": str(r.get("file") or ""),
                    "line": int(r.get("line") or 1),
                    "col": int(r.get("column") or 0) + (0 if r.get("column") else 1),
                    "ruleId": str(r.get("code") or "mypy"),
                    "tool": "mypy",
                    "severity": _mypy_severity(str(r.get("severity") or "error")),
                    "message": str(r.get("message") or ""),
                }
            )
            continue
        # text fallback: file:line:col: severity: message  [code]
        head = s.split(":", 3)
        if len(head) < 4:
            continue
        path, row, col, rest = head
        try:
            ln, cl = int(row), int(col)
        except ValueError:
            continue
        rest = rest.strip()
        sev = "error"
        for cand in ("error", "warning", "note"):
            if rest.startswith(cand + ":"):
                sev = cand
                rest = rest[len(cand) + 1 :].strip()
                break
        code = "mypy"
        if rest.endswith("]") and "[" in rest:
            code = rest[rest.rfind("[") + 1 : -1].strip() or "mypy"
            rest = rest[: rest.rfind("[")].strip()
        out.append(
            {
                "path": path,
                "line": ln,
                "col": cl,
                "ruleId": code,
                "tool": "mypy",
                "severity": _mypy_severity(sev),
                "message": rest,
            }
        )
    return out


def parse_pylint(text: str) -> List[Dict[str, Any]]:
    """Parse ``pylint --output-format=json`` — a list of message objects."""
    out: List[Dict[str, Any]] = []
    try:
        rows = json.loads(text) if text.strip() else []
    except json.JSONDecodeError:
        return out
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict):
            continue
        rule = str(r.get("symbol") or r.get("message-id") or "")
        out.append(
            {
                "path": str(r.get("path") or ""),
                "line": int(r.get("line") or 1),
                "col": int(r.get("column") or 0) + 1,
                "ruleId": rule,
                "tool": "pylint",
                "severity": _PYLINT_SEV.get(str(r.get("type") or "warning"), "warning"),
                "message": str(r.get("message") or ""),
            }
        )
    return out


_PARSERS = {
    "ruff": parse_ruff,
    "flake8": parse_flake8,
    "mypy": parse_mypy,
    "pylint": parse_pylint,
}


def _argv_for(tool: str, path: str, files: Sequence[str]) -> List[str]:
    """Build the tool's argv POSITIONALLY with ``--`` before the user paths."""
    if tool == "ruff":
        return [path, "check", "--output-format", "json", "--", *files]
    if tool == "flake8":
        return [path, "--format=%(path)s:%(row)d:%(col)d:%(code)s:%(text)s", "--", *files]
    if tool == "mypy":
        return [
            path,
            "--no-error-summary",
            "--show-column-numbers",
            "--no-color-output",
            "--output",
            "json",
            "--",
            *files,
        ]
    return [path, "--output-format=json", "--", *files]  # pylint


def _run_tool(tool: str, tool_path: str, files: Sequence[str]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Spawn ``tool`` on ``files`` (shell=False, copied env), parse stdout → diagnostics.

    Returns (diagnostics, skip_reason). ruff/flake8/mypy/pylint all exit NON-ZERO when they
    merely find violations — a nonzero exit is NOT a failure; only a spawn error or empty
    parse-on-crash is. ruff exit 2 = internal error → skip.
    """
    argv = _argv_for(tool, tool_path, files)
    env = dict(os.environ)
    env["NO_COLOR"] = "1"
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT_S,
            env=env,
            shell=False,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return [], f"{tool}: {type(exc).__name__}: {exc}"
    if tool == "ruff" and proc.returncode == 2:
        return [], f"ruff: internal error (exit 2): {proc.stderr.strip()[:200]}"
    try:
        diags = _PARSERS[tool](proc.stdout)
    except Exception as exc:  # noqa: BLE001 — a bad parse must not crash the run
        return [], f"{tool}: parse failed: {exc}"
    return diags, None


def _dedupe(diags: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Collapse duplicate findings by (path,line,ruleId), keeping the FIRST tool's row."""
    seen: set = set()
    out: List[Dict[str, Any]] = []
    for d in diags:
        key = (d["path"], d["line"], d["ruleId"])
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    return out


def _files_after_dashdash(argv: Sequence[str]) -> List[str]:
    """User paths are ALWAYS passed after ``--`` (the IPC handler enforces it), so opt
    VALUES (``--python <p>`` / ``--tools a,b``) can never be mistaken for a path."""
    if "--" in argv:
        return list(argv[list(argv).index("--") + 1 :])
    return positional(argv)  # defensive fallback


def run(argv: List[str]) -> int:
    python = opt_value(argv, "--python")
    tools_arg = opt_value(argv, "--tools")
    wanted = [t for t in (tools_arg.split(",") if tools_arg else TOOLS) if t in TOOLS]
    files = _files_after_dashdash(argv)  # user paths (already path-guarded upstream; absolute)
    if not files:
        return fail("run", "no paths given")

    diagnostics: List[Dict[str, Any]] = []
    ran: List[str] = []
    skipped: List[Dict[str, str]] = []
    for tool in wanted:
        tool_path = resolve_tool(tool, python)
        if not tool_path:
            skipped.append({"tool": tool, "reason": "not installed in the selected interpreter"})
            continue
        found, reason = _run_tool(tool, tool_path, files)
        if reason:
            skipped.append({"tool": tool, "reason": reason})
            log("linters:", reason)
            continue
        ran.append(tool)
        diagnostics.extend(found)
    return emit(
        "run",
        diagnostics=_dedupe(diagnostics),
        ran=ran,
        skipped=skipped,
    )


def main(argv: Sequence[str]) -> int:
    return dispatch("linters", {"detect": detect, "run": run}, argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
