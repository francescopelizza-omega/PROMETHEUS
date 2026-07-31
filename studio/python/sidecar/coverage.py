#!/usr/bin/env python3
"""coverage.py — coverage runner sidecar (APP-086).

Runs a target suite under coverage.py and emits the Studio `CoverageReport` shape
`{perFile:{<path>:{lines:[executed], missed:[missing], branchPct?}}, totalPct}`. Also
merges Studio reports and imports a raw coverage.py JSON.

Pure-stdlib + `_envelope` dispatch (file-14 contract, like testmgr.py). CRITICAL: this
file's name collides with the pip `coverage` package — it NEVER `import coverage`; it
shells out to `python3 -m coverage` in the TARGET project's env (execution is by explicit
user IPC only, like APP-013's run verb) and keeps its own logic pure-stdlib.

Verbs:
  run    --path DIR --framework pytest|unittest [--python BIN] [--id NODEID]...
                                                 → run the suite → CoverageReport JSON
  merge  --in REPORT.json...                     → union-merge Studio reports
  import --in COVERAGE.json                       → reshape a raw coverage.py JSON
"""
from __future__ import annotations

import json
import os
import subprocess  # noqa: S404 — argv list, shell=False, safe-env; execution is user-gated
import sys
import tempfile
from typing import List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _envelope import dispatch, emit, fail, opt_value  # noqa: E402


def _opt_multi(argv: List[str], name: str) -> List[str]:
    """Every value of a repeated `--name V` option (in argv order)."""
    out: List[str] = []
    i = 0
    while i < len(argv):
        if argv[i] == name and i + 1 < len(argv):
            out.append(argv[i + 1])
            i += 2
        else:
            i += 1
    return out


def _reshape(cov: dict) -> dict:
    """Raw coverage.py JSON → Studio CoverageReport (PURE). `lines` = executed_lines,
    `missed` = missing_lines; branchPct from the summary when branch data is present."""
    per_file: dict = {}
    files = cov.get("files")
    if isinstance(files, dict):
        for path, fentry in files.items():
            if not isinstance(fentry, dict):
                continue
            executed = [n for n in fentry.get("executed_lines", []) if isinstance(n, int)]
            missing = [n for n in fentry.get("missing_lines", []) if isinstance(n, int)]
            entry = {"lines": sorted(set(executed)), "missed": sorted(set(missing))}
            summary = fentry.get("summary", {})
            if isinstance(summary, dict) and "num_branches" in summary:
                nb = summary.get("num_branches") or 0
                cb = summary.get("covered_branches") or 0
                if nb:
                    entry["branchPct"] = round(cb / nb * 1000) / 10
            per_file[path] = entry
    total = 0.0
    totals = cov.get("totals")
    if isinstance(totals, dict) and isinstance(totals.get("percent_covered"), (int, float)):
        total = round(float(totals["percent_covered"]) * 10) / 10
    else:
        total = _total_pct(per_file)
    return {"perFile": per_file, "totalPct": total}


def _total_pct(per_file: dict) -> float:
    covered = total = 0
    for entry in per_file.values():
        covered += len(entry.get("lines", []))
        total += len(entry.get("lines", [])) + len(entry.get("missed", []))
    return 100.0 if total == 0 else round(covered / total * 1000) / 10


def _merge(reports: List[dict]) -> dict:
    """Union-merge Studio CoverageReports (PURE). A line covered in ANY report is covered
    in the merge; missed only if missed somewhere AND executed nowhere. Totals recomputed."""
    per_file: dict = {}
    for rep in reports:
        pf = rep.get("perFile", {})
        if not isinstance(pf, dict):
            continue
        for path, entry in pf.items():
            if not isinstance(entry, dict):
                continue
            acc = per_file.setdefault(path, {"executed": set(), "missed": set(), "branchPct": None})
            for n in entry.get("lines", []):
                if isinstance(n, int):
                    acc["executed"].add(n)
            for n in entry.get("missed", []):
                if isinstance(n, int):
                    acc["missed"].add(n)
            bp = entry.get("branchPct")
            if isinstance(bp, (int, float)):
                acc["branchPct"] = bp if acc["branchPct"] is None else max(acc["branchPct"], bp)
    out: dict = {}
    for path, acc in per_file.items():
        executed = acc["executed"]
        missed = sorted(m for m in acc["missed"] if m not in executed)
        entry = {"lines": sorted(executed), "missed": missed}
        if acc["branchPct"] is not None:
            entry["branchPct"] = acc["branchPct"]
        out[path] = entry
    return {"perFile": out, "totalPct": _total_pct(out)}


def _run_cmd(argv: List[str], cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=600, check=False)  # noqa: S603


def verb_run(argv: List[str]) -> int:
    path = opt_value(argv, "--path")
    if not path or not os.path.isdir(path):
        return fail("run", "missing or invalid --path")
    framework = opt_value(argv, "--framework", "pytest")
    if framework not in ("pytest", "unittest"):
        return fail("run", f"framework '{framework}' not allowed (pytest/unittest)")
    python = opt_value(argv, "--python", "python3") or "python3"
    ids = _opt_multi(argv, "--id")
    # option-injection guard: a leading '-' id could smuggle a pytest/unittest flag.
    for nid in ids:
        if nid.startswith("-") or not nid.strip():
            return fail("run", f"invalid --id '{nid}'")
    tmp = tempfile.mkdtemp(prefix="prom-cov-")
    data_file = os.path.join(tmp, ".coverage")
    try:
        run_argv = [python, "-m", "coverage", "run", "--branch",
                    f"--source={path}", f"--data-file={data_file}", "-m", framework]
        if framework == "unittest" and not ids:
            run_argv.append("discover")
        run_argv.extend(ids)
        try:
            r = _run_cmd(run_argv, path)
        except (OSError, subprocess.SubprocessError) as e:
            return fail("run", f"failed to launch coverage: {e}")
        if "No module named coverage" in (r.stderr or ""):
            return fail("run", "the 'coverage' package is not installed in the target env — "
                               "install it: python3 -m pip install coverage")
        # a nonzero suite exit (test failures / pytest exit 5 = no tests) is NOT a coverage
        # error — still produce the JSON from whatever was measured.
        json_argv = [python, "-m", "coverage", "json", "-o", "-", f"--data-file={data_file}"]
        try:
            j = _run_cmd(json_argv, path)
        except (OSError, subprocess.SubprocessError) as e:
            return fail("run", f"failed to emit coverage json: {e}")
        if "No module named coverage" in (j.stderr or ""):
            return fail("run", "the 'coverage' package is not installed in the target env — "
                               "install it: python3 -m pip install coverage")
        try:
            cov = json.loads(j.stdout)
        except (ValueError, TypeError):
            return fail("run", f"could not parse coverage json (suite exit {r.returncode})")
        report = _reshape(cov)
        return emit("run", perFile=report["perFile"], totalPct=report["totalPct"],
                    suiteExit=r.returncode)
    finally:
        try:
            for name in os.listdir(tmp):
                os.remove(os.path.join(tmp, name))
            os.rmdir(tmp)
        except OSError:
            pass


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path, encoding="utf-8") as fh:
            v = json.load(fh)
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
        return None


def verb_merge(argv: List[str]) -> int:
    ins = _opt_multi(argv, "--in")
    if not ins:
        return fail("merge", "missing --in")
    reports = []
    for p in ins:
        rep = _read_json(p)
        if rep is None or "perFile" not in rep:
            return fail("merge", f"could not read report: {p}")
        reports.append(rep)
    merged = _merge(reports)
    return emit("merge", perFile=merged["perFile"], totalPct=merged["totalPct"])


def verb_import(argv: List[str]) -> int:
    src = opt_value(argv, "--in")
    if not src:
        return fail("import", "missing --in")
    cov = _read_json(src)
    if cov is None:
        return fail("import", f"could not read coverage json: {src}")
    # a raw coverage.py json has "files"; a Studio report has "perFile".
    report = _merge([cov]) if "perFile" in cov else _reshape(cov)
    return emit("import", perFile=report["perFile"], totalPct=report["totalPct"])


HANDLERS = {"run": verb_run, "merge": verb_merge, "import": verb_import}


def main(argv: Optional[List[str]] = None) -> int:
    return dispatch("coverage.py", HANDLERS, list(sys.argv[1:] if argv is None else argv))


if __name__ == "__main__":
    sys.exit(main())
