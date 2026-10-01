#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""envmgr.py — Studio environment-manager sidecar (C7/C9, file 04).

Detects and (under ``--confirm``) mutates Python environments: venv/virtualenv,
conda/Anaconda, and the system interpreter. Each verb emits EXACTLY ONE JSON object
on stdout via ``_envelope.emit``/``fail``; human logs go to stderr.

THE GATE SPINE (file 04 §0/§6 — non-negotiable, fail-closed): no third-party code is
*fetched or executed* without first passing the REAL nemesis gate. A ``pip install`` is
a remote-code-execution primitive (``setup.py`` / build backends / ``pyproject`` hooks
run arbitrary code). So every fetching verb routes through ``_gate_install``:

    pip download --no-deps <spec> → TEMP staging dir   (brings the ACTUAL artifact,
                                                         incl. setup.py, onto disk — NOT run)
    nemesis gate <staging>        → ONE verdict object  (the SAME binary prometheus.py
                                                         uses; same flags; fail-closed)
    verdict allow  → pip install --no-index --find-links <staging>   (install the EXACT
                                                                       vetted bytes — no
                                                                       TOCTOU re-fetch)
    verdict warn   → return the verdict (no install) for the GUI to confirm
    verdict block  → REFUSE (§8 blocked envelope); ``force:true`` (typed confirm collected
                     by the GUI) overrides + flags the result with ``forced_danger``
    verdict error  → FAIL-CLOSED → BLOCK (scanner missing / timeout / exit2 / unparseable)

We do NOT reimplement the security decision in Python: ``_gate_install`` shells the real
``nemesis gate`` (located like prometheus.py: ``$NEMESIS_BIN`` → sibling PROMETHEUS root →
``which('nemesis')``) with ``--sandbox auto --jail auto --sign --timeout 840`` and reads
its ``nemesis.verdict/1`` object. The append-only signed audit log (``~/.nemesis/
gate-audit.jsonl``) is the scanner's own — shared, not duplicated.

Read-only verbs implemented for real (run now):
    env.list  env.use  env.export  env.doctor  pkg.list
    cuda.info  conda.env-list  template.list

Gated fetching verbs (stage → scan → gated install; ``force:true`` overrides block):
    pkg.install  pkg.update  pkg.upgrade  env.import  template.commit

Other mutating verbs (real subprocess, guarded by --confirm):
    env.create  env.delete  env.clone  pkg.uninstall  pkg.remove
    pkg.enable  pkg.disable  cuda.torch

Python 3 stdlib only (subprocess for pip/conda/nemesis ok). Target 3.9+ (dev host 3.14).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _envelope import (  # noqa: E402
    dispatch,
    emit,
    fail,
    has_flag,
    log,
    opt_value,
    positional,
)

PROG = "envmgr"

# Roots commonly holding venvs. Kept conservative; cwd .venv/venv handled separately.
_VENV_ROOTS = [
    Path.home() / ".virtualenvs",
    Path.home() / ".venvs",
    Path.home() / "venvs",
    Path.home() / ".local" / "share" / "virtualenvs",  # pipenv
]

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

# nemesis gate flags — mirror prometheus.py's enforce_gate()/nemesis_gate() so the
# verdict, signing and policy tiers are identical to the engine's gated installs.
_NEMESIS_GATE_FLAGS = ["--sandbox", "auto", "--jail", "auto", "--sign"]
#: per-scan self-abort (seconds); the outer subprocess timeout sits ABOVE this so
#: nemesis emits a clean fail-closed verdict JSON before we'd ever SIGKILL it.
_NEMESIS_GATE_TIMEOUT = int(os.environ.get("PROMETHEUS_GATE_TIMEOUT", "840"))
_NEMESIS_SUBPROCESS_TIMEOUT = _NEMESIS_GATE_TIMEOUT + 60
_PIP_DOWNLOAD_TIMEOUT = int(os.environ.get("PROMETHEUS_PIP_DOWNLOAD_TIMEOUT", "900"))
_PIP_INSTALL_TIMEOUT = int(os.environ.get("PROMETHEUS_PIP_INSTALL_TIMEOUT", "1800"))


# --- helpers ---------------------------------------------------------------- #

def _bin_dir(env_path: Path) -> Path:
    """venv executables live in Scripts/ on Windows, bin/ elsewhere."""
    return env_path / ("Scripts" if os.name == "nt" else "bin")


def _python_exe(env_path: Path) -> Optional[Path]:
    for name in ("python3", "python", "python.exe"):
        cand = _bin_dir(env_path) / name
        if cand.exists():
            return cand
    return None


def _is_venv(p: Path) -> bool:
    return (p / "pyvenv.cfg").exists() and _python_exe(p) is not None


def _python_version(py: Path) -> Optional[str]:
    try:
        out = subprocess.run(
            [str(py), "-c", "import sys;print('.'.join(map(str,sys.version_info[:3])))"],
            capture_output=True, text=True, timeout=15,
        )
        v = out.stdout.strip()
        return v or None
    except Exception as exc:  # noqa: BLE001
        log("version probe failed for", py, exc)
        return None


def _packages_count(py: Path) -> Optional[int]:
    """Count installed dists via importlib.metadata in the TARGET interpreter."""
    code = (
        "import json,sys\n"
        "try:\n"
        " from importlib.metadata import distributions\n"
        " print(len(list(distributions())))\n"
        "except Exception:\n"
        " print(-1)\n"
    )
    try:
        out = subprocess.run([str(py), "-c", code], capture_output=True, text=True, timeout=30)
        n = int(out.stdout.strip())
        return n if n >= 0 else None
    except Exception as exc:  # noqa: BLE001
        log("pkg count failed for", py, exc)
        return None


def _conda_present() -> Optional[str]:
    return shutil.which("conda")


def _conda_envs() -> List[Dict[str, Any]]:
    conda = _conda_present()
    if not conda:
        return []
    try:
        out = subprocess.run([conda, "env", "list", "--json"], capture_output=True, text=True, timeout=30)
        data = json.loads(out.stdout or "{}")
    except Exception as exc:  # noqa: BLE001
        log("conda env list failed:", exc)
        return []
    envs = []
    for p in data.get("envs", []):
        path = Path(p)
        py = _python_exe(path) or (path / "bin" / "python3")
        envs.append({
            "name": path.name,
            "path": str(path),
            "kind": "conda",
            "python_version": _python_version(py) if py.exists() else None,
            "packages_count": None,  # lazy: conda pkg listing is heavy; pkg.list resolves it
        })
    return envs


def _discover_venvs() -> List[Dict[str, Any]]:
    seen: set[str] = set()
    found: List[Dict[str, Any]] = []

    candidates: List[Path] = []
    for root in _VENV_ROOTS:
        if root.is_dir():
            for child in sorted(root.iterdir()):
                if child.is_dir():
                    candidates.append(child)
    cwd = Path.cwd()
    for local in (cwd / ".venv", cwd / "venv", cwd / "env"):
        candidates.append(local)

    for p in candidates:
        rp = str(p.resolve())
        if rp in seen or not _is_venv(p):
            continue
        seen.add(rp)
        py = _python_exe(p)
        found.append({
            "name": p.name,
            "path": rp,
            "kind": "venv",
            "python_version": _python_version(py) if py else None,
            "packages_count": _packages_count(py) if py else None,
        })
    return found


def _system_python() -> Dict[str, Any]:
    py = Path(sys.executable)
    return {
        "name": "system",
        "path": str(py.parent.parent),
        "kind": "system",
        "python_version": ".".join(map(str, sys.version_info[:3])),
        "packages_count": None,
    }


def _resolve_env(token: str) -> Optional[Dict[str, Any]]:
    """Resolve an env by name or absolute path from venvs + conda + system."""
    if token in ("system", sys.executable):
        return _system_python()
    p = Path(token).expanduser()
    if p.is_dir() and _is_venv(p):
        py = _python_exe(p)
        return {"name": p.name, "path": str(p.resolve()), "kind": "venv",
                "python_version": _python_version(py) if py else None}
    for env in _discover_venvs() + _conda_envs():
        if env["name"] == token or env["path"] == token or env["path"] == str(p):
            return env
    return None


def _pip_for(env: Dict[str, Any]) -> List[str]:
    """Build the pip invocation for an env (conda envs use `conda run -n`)."""
    if env.get("kind") == "conda":
        return [_conda_present() or "conda", "run", "-n", env["name"], "python", "-m", "pip"]
    py = _python_exe(Path(env["path"]))
    base = str(py) if py else (env.get("python_version") and sys.executable or sys.executable)
    if env.get("kind") == "system":
        base = sys.executable
    return [str(base), "-m", "pip"]


# --- the nemesis gate spine (file 04 §6) ------------------------------------ #

def _find_nemesis() -> Optional[str]:
    """Locate the REAL nemesis binary, SAME precedence as prometheus.py / locate_engine.

    ``$NEMESIS_BIN`` → sibling PROMETHEUS root (walk up from this file) →
    ``which('nemesis')`` → None. Never raises. A None result means the gate
    fails closed (verdict 'error' → BLOCK) — the scanner is never silently skipped.
    """
    env = os.environ.get("NEMESIS_BIN")
    if env and Path(env).is_file():
        return env
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        cand = parent / "nemesis"
        if cand.is_file():
            return str(cand)
        if (parent / "prometheus.py").is_file():
            break  # reached the engine root without a sibling nemesis
    return shutil.which("nemesis")


def _error_verdict(reason: str) -> Dict[str, Any]:
    """The synthetic fail-closed verdict (C5): error ⇒ BLOCK. risk 100, safe_to all false."""
    return {
        "verdict": "error",
        "risk_score": 100,
        "exit_code": 2,
        "error": reason,
        "blocking_reasons": [f"scanner failure: {reason}"],
        "recommendation": "Scanner unavailable — treat as UNSAFE. Refuse (fail-closed).",
        "safe_to": {"install": False, "run_plug_and_play": False, "use_as_ai_cli_agent": False},
        "top_findings": [],
        "severity_counts": {"CRITICAL": 1, "HIGH": 0, "MEDIUM": 0, "LOW": 0, "INFO": 0},
    }


def nemesis_gate(target: str) -> Dict[str, Any]:
    """Run the REAL nemesis as a pre-install gate on ``target`` (a staging dir).

    Returns the parsed ``nemesis.verdict/1`` dict. FAIL-CLOSED by construction: a
    missing binary, spawn failure, timeout, non-existent target, or unparseable
    stdout all return an ``error`` verdict (which the caller treats as BLOCK). This
    is "literally the same code" prometheus.py gates installs with — we shell the
    same binary with the same flags, we do NOT re-implement the decision.
    """
    nem = _find_nemesis()
    if not nem:
        return _error_verdict(
            "nemesis not found (env NEMESIS_BIN, sibling PROMETHEUS root, PATH). "
            "Place `nemesis` next to prometheus.py or set NEMESIS_BIN."
        )
    cmd = [sys.executable, nem, "gate", target,
           *_NEMESIS_GATE_FLAGS, "--timeout", str(_NEMESIS_GATE_TIMEOUT)]
    if os.environ.get("PROMETHEUS_GATE_FRESH"):
        cmd.append("--no-cache")
    log("nemesis gate:", " ".join(cmd))
    try:
        p = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=_NEMESIS_SUBPROCESS_TIMEOUT)
    except subprocess.TimeoutExpired:
        return _error_verdict(f"nemesis timed out after {_NEMESIS_SUBPROCESS_TIMEOUT}s")
    except (OSError, subprocess.SubprocessError) as exc:  # noqa: BLE001
        return _error_verdict(f"nemesis could not run: {exc}")
    try:
        verdict = json.loads(p.stdout)
    except (json.JSONDecodeError, ValueError):
        tail = (p.stderr or p.stdout or f"exit {p.returncode}").strip()[-200:]
        return _error_verdict(f"unparseable nemesis verdict ({tail})")
    if not isinstance(verdict, dict) or "verdict" not in verdict:
        return _error_verdict("nemesis returned a non-verdict object")
    return verdict


def _verdict_summary(v: Dict[str, Any]) -> Dict[str, Any]:
    """Project a nemesis verdict down to the GateBadge-ish summary the GUI renders."""
    return {
        "verdict": v.get("verdict", "error"),
        "score": v.get("risk_score", 100),
        "reasons": list(v.get("blocking_reasons") or [])[:8],
        "signed": bool((v.get("signature") or {}).get("value")),
        "recommendation": v.get("recommendation", ""),
        "scanned_at": v.get("scanned_at", ""),
    }


def _blocked_envelope(command: str, request: Dict[str, Any], v: Dict[str, Any]) -> int:
    """The §8 blocked envelope: {command, ok:false, blocked:true, request, gate, message}."""
    verdict = v.get("verdict", "error")
    why = "UNVERIFIABLE (scanner error)" if verdict == "error" else f"nemesis {verdict.upper()}"
    return emit(
        command, _exit=2, ok=False, blocked=True, request=request,
        gate=_verdict_summary(v),
        message=(f"refused — {why}; not installed. "
                 "Re-run with force:true (typed confirm) to override."),
    )


def _gate_install(
    command: str,
    env: Dict[str, Any],
    specs: List[str],
    *,
    confirmed: bool,
    force: bool,
    upgrade: bool = False,
    extra_download: Optional[List[str]] = None,
    extra_install: Optional[List[str]] = None,
    request_extra: Optional[Dict[str, Any]] = None,
) -> int:
    """THE GATED INSTALL SPINE (file 04 §6). NEVER installs ungated.

    Flow for ANY fetch:
      1. ``pip download --no-deps <specs>`` into a TEMP staging dir (brings the real
         artifact — incl. setup.py / pyproject — onto disk, NOT executed).
      2. ``nemesis gate <staging>`` — the real scanner, fail-closed.
      3. verdict ``allow`` → ``pip install --no-index --find-links <staging>`` into the
         target env's pip (install the EXACT vetted bytes — no TOCTOU re-fetch).
         verdict ``warn``  → return the verdict (NO install) for the GUI to confirm.
         verdict ``block`` → refuse (§8 blocked envelope) unless ``force`` (then install +
                             flag ``forced_danger``).
         verdict ``error`` → FAIL-CLOSED → refuse (``force`` may still override, flagged).

    Without ``--confirm`` we return a non-destructive ``plan`` (the bridge previews it
    and collects the typed confirm) — staging + scanning + installing only run with it.
    """
    request: Dict[str, Any] = {
        "env": env["name"], "path": env["path"], "kind": env.get("kind"),
        "specs": list(specs), "scope": "conda" if env.get("kind") == "conda" else "venv",
    }
    if request_extra:
        request.update(request_extra)

    pip = _pip_for(env)
    install_action = ["install", "--upgrade"] if upgrade else ["install"]
    plan = {
        # the PREVIEW must describe what actually runs — see the staging step below for why
        # the dependency closure is fetched rather than the named specs alone
        "download": pip + ["download", "--dest", "<staging>",
                           *(extra_download or []), *specs],
        "gate": ["nemesis", "gate", "<staging>", *_NEMESIS_GATE_FLAGS],
        "install": pip + install_action + ["--no-index", "--find-links", "<staging>",
                                            *(extra_install or []), *specs],
    }

    if not confirmed:
        log("dry plan (no --confirm): stage→scan→gated-install", " ".join(specs))
        return emit(command, planned=True, plan=plan, request=request, force=bool(force),
                    note="re-run with --confirm to stage, scan (nemesis), and gated-install")

    # 1) stage — bring the actual bytes onto disk WITHOUT executing them.
    staging = tempfile.mkdtemp(prefix="prom-stage-")
    try:
        # Stage the FULL dependency closure, not just the named specs.
        #
        # This passed `--no-deps` while step 3c installs with `--no-index --find-links <staging>`
        # and no `--no-deps` of its own. pip's resolver still demands the whole transitive
        # closure, and `--no-index` forbids fetching it, so any package whose dependencies were
        # not already present in the target env could never install — the gated spine was
        # unusable for exactly the packages people install (pandas, scikit-learn, fastapi are all
        # in the builtin templates). It failed as "gated pip install returned non-zero".
        #
        # Downloading the closure is also the SAFER half of the trade: `--no-index` means pip can
        # only ever install from this directory, so staging everything is what makes nemesis's
        # scan cover every byte that reaches the environment. Staging only the top-level artifact
        # would have gated one wheel and let its dependencies in unscanned, had the install
        # worked at all.
        dl_cmd = pip + ["download", "--dest", staging,
                        "--disable-pip-version-check", *(extra_download or []), *specs]
        log("staging:", " ".join(dl_cmd))
        try:
            dl = subprocess.run(dl_cmd, capture_output=True, text=True,
                                timeout=_PIP_DOWNLOAD_TIMEOUT)
        except subprocess.TimeoutExpired:
            return fail(command, "pip download timed out", request=request, blocked=True)
        except (OSError, subprocess.SubprocessError) as exc:  # noqa: BLE001
            return fail(command, f"pip download failed: {exc}", request=request, blocked=True)
        if dl.returncode != 0:
            return fail(command, "pip download returned non-zero (nothing fetched, nothing gated)",
                        request=request, blocked=True,
                        stderr=(dl.stderr or "").strip()[-1000:])

        # 2) scan — the real nemesis, fail-closed.
        v = nemesis_gate(staging)
        verdict = v.get("verdict", "error")
        request["gate"] = _verdict_summary(v)

        # 3a) warn → no install; hand the verdict to the GUI to confirm.
        if verdict == "warn" and not force:
            return emit(command, _exit=0, ok=True, installed=False, needs_confirm=True,
                        verdict="warn", request=request, gate=_verdict_summary(v),
                        message="nemesis WARN — review the findings, then re-run with "
                                "force:true to install the scanned artifact.")

        # 3b) block/error → refuse, unless force overrides.
        if verdict in ("block", "error") and not force:
            return _blocked_envelope(command, request, v)

        forced = verdict in ("block", "error", "warn") and force

        # 3c) install the EXACT vetted bytes (allow, or a forced override).
        inst_cmd = pip + install_action + [
            "--no-index", "--find-links", staging, "--disable-pip-version-check",
            *(extra_install or []), *specs,
        ]
        log("gated install:", " ".join(inst_cmd))
        try:
            inst = subprocess.run(inst_cmd, capture_output=True, text=True,
                                  timeout=_PIP_INSTALL_TIMEOUT)
        except subprocess.TimeoutExpired:
            return fail(command, "gated pip install timed out", request=request)
        except (OSError, subprocess.SubprocessError) as exc:  # noqa: BLE001
            return fail(command, f"gated pip install failed: {exc}", request=request)
        if inst.returncode != 0:
            return fail(command, "gated pip install returned non-zero", _exit=2,
                        request=request, returncode=inst.returncode,
                        stderr=(inst.stderr or "").strip()[-1000:])

        out: Dict[str, Any] = dict(
            installed=True, verdict=verdict, request=request, gate=_verdict_summary(v),
            stdout_tail=(inst.stdout or "").strip()[-1000:],
        )
        if forced:
            out["forced_danger"] = {
                "label": ", ".join(specs), "verdict": verdict,
                "risk_score": v.get("risk_score"),
                "blocking_reasons": list(v.get("blocking_reasons") or [])[:8],
            }
            out["message"] = (f"⚠ FORCED install of {verdict.upper()} artifact "
                              f"({', '.join(specs)}) — flagged for audit.")
        return emit(command, _exit=0, ok=True, **out)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


# --- read-only verbs (real) ------------------------------------------------- #

def v_env_list(argv: List[str]) -> int:
    envs = _discover_venvs() + _conda_envs() + [_system_python()]
    return emit("env.list", environments=envs, count=len(envs), conda_available=bool(_conda_present()))


def v_conda_envlist(argv: List[str]) -> int:
    if not _conda_present():
        return emit("conda.env-list", conda_available=False, environments=[], count=0)
    envs = _conda_envs()
    return emit("conda.env-list", conda_available=True, environments=envs, count=len(envs))


def v_pkg_list(argv: List[str]) -> int:
    pos = positional(argv)
    if not pos:
        return fail("pkg.list", "missing <env> (name or path)")
    env = _resolve_env(pos[0])
    if env is None:
        return fail("pkg.list", f"environment not found: {pos[0]}")
    cmd = _pip_for(env) + ["list", "--format=json", "--disable-pip-version-check"]
    log("running:", " ".join(cmd))
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as exc:  # noqa: BLE001
        return fail("pkg.list", f"pip list failed: {exc}", env=env["name"])
    if out.returncode != 0:
        return fail("pkg.list", "pip list returned non-zero", env=env["name"], stderr=out.stderr.strip()[:500])
    try:
        pkgs = json.loads(out.stdout or "[]")
    except json.JSONDecodeError as exc:
        return fail("pkg.list", f"could not parse pip output: {exc}", env=env["name"])
    return emit("pkg.list", env=env["name"], path=env["path"], packages=pkgs, count=len(pkgs))


def v_cuda_info(argv: List[str]) -> int:
    info: Dict[str, Any] = {
        "gpu": None, "driver": None, "cuda_version": None,
        "nvidia_smi": False, "nvcc": False, "torch_cuda": None,
    }
    smi = shutil.which("nvidia-smi")
    if smi:
        info["nvidia_smi"] = True
        try:
            q = subprocess.run(
                [smi, "--query-gpu=name,driver_version", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=15,
            )
            line = (q.stdout or "").strip().splitlines()
            if line:
                first = [c.strip() for c in line[0].split(",")]
                info["gpu"] = first[0] if first else None
                info["driver"] = first[1] if len(first) > 1 else None
        except Exception as exc:  # noqa: BLE001
            log("nvidia-smi query failed:", exc)
    nvcc = shutil.which("nvcc")
    if nvcc:
        info["nvcc"] = True
        try:
            v = subprocess.run([nvcc, "--version"], capture_output=True, text=True, timeout=15)
            for ln in (v.stdout or "").splitlines():
                if "release" in ln.lower():
                    # ".. release 12.4, V12.4.131"
                    part = ln.split("release", 1)[1].strip().lstrip(",").split(",")[0].strip()
                    info["cuda_version"] = part or info["cuda_version"]
        except Exception as exc:  # noqa: BLE001
            log("nvcc version failed:", exc)
    # torch.cuda only if torch importable in THIS interpreter (best-effort, never required)
    try:
        import torch  # type: ignore  # noqa: PLC0415
        info["torch_cuda"] = bool(torch.cuda.is_available())
        if info["torch_cuda"] and not info["cuda_version"]:
            info["cuda_version"] = getattr(torch.version, "cuda", None)
    except Exception:  # noqa: BLE001
        info["torch_cuda"] = None
    info["available"] = bool(info["nvidia_smi"] or info["nvcc"] or info["torch_cuda"])
    return emit("cuda.info", **info)


def v_template_list(argv: List[str]) -> int:
    templates: List[Dict[str, Any]] = []
    if _TEMPLATES_DIR.is_dir():
        for f in sorted(_TEMPLATES_DIR.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                templates.append({
                    "id": data.get("id", f.stem),
                    "label": data.get("label", f.stem),
                    "python": data.get("python"),
                    "packages": data.get("packages", []),
                    "path": str(f),
                })
            except Exception as exc:  # noqa: BLE001
                log("bad template", f, exc)
    else:
        # ship built-in defaults so template.list always returns something usable
        templates = _BUILTIN_TEMPLATES
    return emit("template.list", templates=templates, count=len(templates),
                source="bundled" if _TEMPLATES_DIR.is_dir() else "builtin")


def v_env_use(argv: List[str]) -> int:
    pos = positional(argv)
    if not pos:
        return fail("env.use", "missing <env> (name or path)")
    env = _resolve_env(pos[0])
    if env is None:
        return fail("env.use", f"environment not found: {pos[0]}")
    path = Path(env["path"])
    bindir = _bin_dir(path) if env["kind"] != "conda" else (path / "bin")
    py = _python_exe(path) or (bindir / "python3")
    # Activation info: what the supervisor (C8) sets to "use" this env.
    env_vars = {
        "VIRTUAL_ENV": str(path) if env["kind"] == "venv" else "",
        "CONDA_PREFIX": str(path) if env["kind"] == "conda" else "",
        "PATH_PREPEND": str(bindir),
    }
    return emit(
        "env.use",
        env=env["name"], path=env["path"], kind=env["kind"],
        bin=str(bindir), python=str(py),
        python_version=env.get("python_version"),
        env_vars={k: v for k, v in env_vars.items() if v},
    )


_BUILTIN_TEMPLATES: List[Dict[str, Any]] = [
    {"id": "blank", "label": "Blank venv", "python": None, "packages": []},
    {"id": "data-science", "label": "Data Science",
     "python": "3.11", "packages": ["numpy", "pandas", "scikit-learn", "jupyter", "matplotlib"]},
    {"id": "llm-cpu", "label": "LLM (CPU inference)",
     "python": "3.11", "packages": ["llama-cpp-python", "transformers", "huggingface-hub"]},
    {"id": "web", "label": "Web (FastAPI)",
     "python": "3.11", "packages": ["fastapi", "uvicorn", "pydantic"]},
]


# --- mutating verbs (real subprocess, guarded by --confirm) ----------------- #

def _planned_or_run(command: str, cmd: List[str], confirmed: bool, **fields: Any) -> int:
    """Without --confirm, return the plan (no side effect). With it, run for real.

    Reminder (C4/C5): install/download gating is the engine-bridge nemesis runner's
    job; --confirm here means the bridge already cleared this and the user approved.
    """
    if not confirmed:
        log("dry plan (no --confirm):", " ".join(cmd))
        return emit(command, planned=True, plan=cmd, note="re-run with --confirm to execute", **fields)
    log("executing:", " ".join(cmd))
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    except Exception as exc:  # noqa: BLE001
        return fail(command, f"subprocess failed: {exc}", plan=cmd, **fields)
    if out.returncode != 0:
        return fail(command, "command returned non-zero", _exit=2,
                    plan=cmd, returncode=out.returncode,
                    stderr=(out.stderr or "").strip()[:1000], **fields)
    return emit(command, executed=True, plan=cmd, returncode=0,
                stdout_tail=(out.stdout or "").strip()[-1000:], **fields)


def v_env_create(argv: List[str]) -> int:
    pos = positional(argv)
    if not pos:
        return fail("env.create", "missing <path-or-name> for the new environment")
    target = str(Path(pos[0]).expanduser())
    confirmed = has_flag(argv, "--confirm")
    use_conda = has_flag(argv, "--conda")
    pyver = opt_value(argv, "--python")
    if use_conda:
        conda = _conda_present()
        if not conda:
            return fail("env.create", "conda requested but not found on PATH")
        cmd = [conda, "create", "-y", "-n", Path(target).name]
        if pyver:
            cmd.append(f"python={pyver}")
        return _planned_or_run("env.create", cmd, confirmed, kind="conda", target=Path(target).name)
    base = sys.executable
    cmd = [base, "-m", "venv", target]
    return _planned_or_run("env.create", cmd, confirmed, kind="venv", target=target)


def v_env_delete(argv: List[str]) -> int:
    pos = positional(argv)
    if not pos:
        return fail("env.delete", "missing <env> (name or path)")
    env = _resolve_env(pos[0])
    confirmed = has_flag(argv, "--confirm")
    if env and env.get("kind") == "conda":
        conda = _conda_present() or "conda"
        cmd = [conda, "env", "remove", "-y", "-n", env["name"]]
        return _planned_or_run("env.delete", cmd, confirmed, kind="conda", target=env["name"])
    path = Path(env["path"]) if env else Path(pos[0]).expanduser()
    if env is None and not (_is_venv(path)):
        return fail("env.delete", f"refusing to delete: not a recognized venv: {path}")
    # rm -rf the venv dir — represented as a plan; executed only with --confirm.
    cmd = ["rm", "-rf", str(path)]
    if not confirmed:
        return emit("env.delete", planned=True, plan=cmd, kind="venv", target=str(path),
                    note="re-run with --confirm to execute")
    if path.exists() and _is_venv(path):
        # `ignore_errors=True` deletes as much as it can, which is what we want — but it also
        # SWALLOWED a partial failure, and this verb then reported `ok:true, executed:true`
        # with the environment still on disk. Measured: one read-only subtree
        # (`chmod 555 <env>/lib`) was enough. Verify the removal rather than assume it; the
        # second, error-raising pass exists only to name WHY for the user, and may itself
        # succeed if the first pass cleared whatever was blocking it.
        shutil.rmtree(path, ignore_errors=True)
        if path.exists():
            detail = ""
            try:
                shutil.rmtree(path)
            except OSError as exc:
                detail = f": {type(exc).__name__}: {exc}"
            if path.exists():
                return fail("env.delete", f"could not fully remove {path}{detail}")
        return emit("env.delete", executed=True, target=str(path), kind="venv")
    return fail("env.delete", f"path is not a venv or does not exist: {path}")


def v_env_clone(argv: List[str]) -> int:
    pos = positional(argv)
    if len(pos) < 2:
        return fail("env.clone", "usage: env.clone <src-env> <dest-path> [--confirm]")
    src = _resolve_env(pos[0])
    if src is None:
        return fail("env.clone", f"source environment not found: {pos[0]}")
    dest = str(Path(pos[1]).expanduser())
    confirmed = has_flag(argv, "--confirm")
    if src.get("kind") == "conda":
        conda = _conda_present() or "conda"
        cmd = [conda, "create", "-y", "-n", Path(dest).name, "--clone", src["name"]]
        return _planned_or_run("env.clone", cmd, confirmed, kind="conda", src=src["name"], dest=Path(dest).name)
    # venv clone (§4.2): freeze the source → create dest on the same base → GATED
    # reinstall of the frozen set (the honest, re-vetted clone — every fetch passes
    # the gate; we do NOT byte-copy the tree un-gated).
    force = has_flag(argv, "--force")
    if not confirmed:
        plan = {
            "create": [sys.executable, "-m", "venv", dest],
            "freeze": [str(_python_exe(Path(src["path"])) or "python3"), "-m", "pip", "freeze"],
            "gate_and_install": {"via": "_gate_install (stage→scan→install of the frozen set)"},
        }
        return emit("env.clone", planned=True, plan=plan, kind="venv", src=src["path"], dest=dest,
                    note="re-run with --confirm to create the venv and gated-reinstall the frozen set")
    specs, err = _freeze(src)
    if err:
        return fail("env.clone", f"could not freeze source: {err}", src=src["path"])
    if not _is_venv(Path(dest)):
        try:
            r1 = subprocess.run([sys.executable, "-m", "venv", dest],
                                capture_output=True, text=True, timeout=300)
        except Exception as exc:  # noqa: BLE001
            return fail("env.clone", f"venv create failed: {exc}", dest=dest)
        if r1.returncode != 0:
            return fail("env.clone", "venv create failed", dest=dest,
                        stderr=(r1.stderr or "").strip()[:500])
    if not specs:
        return emit("env.clone", created=True, installed=False, src=src["path"], dest=dest,
                    kind="venv", message="source had no frozen packages; empty clone created")
    dest_env = {"name": Path(dest).name, "path": str(Path(dest).resolve()), "kind": "venv"}
    return _gate_install("env.clone", dest_env, specs, confirmed=True, force=force,
                         request_extra={"src": src["path"], "dest": dest})


def v_pkg_install(argv: List[str]) -> int:
    """pkg.install <env> <spec...> [--confirm] [--force] — GATED (file 04 §6)."""
    return _pkg_gated("pkg.install", argv, upgrade=False)


def v_pkg_update(argv: List[str]) -> int:
    """pkg.update <env> <spec...> [--confirm] [--force] — single-pkg upgrade, GATED."""
    return _pkg_gated("pkg.update", argv, upgrade=True)


def v_pkg_upgrade(argv: List[str]) -> int:
    """pkg.upgrade <env> [<spec...>] [--confirm] [--force] — bulk GATED upgrade (§5).

    With explicit specs, upgrades those. Without, resolves the env's OUTDATED rows
    (``pip list --outdated``) and upgrades them all as ONE batched gate plan.
    """
    pos = positional(argv)
    if not pos:
        return fail("pkg.upgrade", "usage: pkg.upgrade <env> [<pkg...>] [--confirm] [--force]")
    env = _resolve_env(pos[0])
    if env is None:
        return fail("pkg.upgrade", f"environment not found: {pos[0]}")
    specs = pos[1:]
    if not specs:
        specs = _outdated_names(env)
        if not specs:
            return emit("pkg.upgrade", installed=False, up_to_date=True, env=env["name"],
                        message="nothing to upgrade — all packages current")
    return _gate_install(
        "pkg.upgrade", env, specs, upgrade=True,
        confirmed=has_flag(argv, "--confirm"), force=has_flag(argv, "--force"),
    )


def _pkg_gated(command: str, argv: List[str], *, upgrade: bool) -> int:
    pos = positional(argv)
    if len(pos) < 2:
        return fail(command, f"usage: {command} <env> <spec...> [--confirm] [--force]")
    env = _resolve_env(pos[0])
    if env is None:
        return fail(command, f"environment not found: {pos[0]}")
    return _gate_install(
        command, env, pos[1:], upgrade=upgrade,
        confirmed=has_flag(argv, "--confirm"), force=has_flag(argv, "--force"),
    )


def _outdated_names(env: Dict[str, Any]) -> List[str]:
    """Names of OUTDATED dists in ``env`` via ``pip list --outdated --format=json``."""
    cmd = _pip_for(env) + ["list", "--outdated", "--format=json", "--disable-pip-version-check"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rows = json.loads(out.stdout or "[]")
    except Exception as exc:  # noqa: BLE001
        log("pip list --outdated failed:", exc)
        return []
    return [r["name"] for r in rows if isinstance(r, dict) and r.get("name")]


def v_pkg_uninstall(argv: List[str]) -> int:
    """pkg.uninstall <env> <pkg...> [--confirm] — remove AND forget. NOT a fetch → no gate."""
    return _pkg_mutate("pkg.uninstall", ["uninstall", "-y"], argv)


def v_pkg_remove(argv: List[str]) -> int:
    """pkg.remove <env> <pkg...> [--confirm] — pip uninstall (pin kept by the store). No fetch."""
    return _pkg_mutate("pkg.remove", ["uninstall", "-y"], argv)


def _pkg_mutate(command: str, pip_action: List[str], argv: List[str]) -> int:
    pos = positional(argv)
    if len(pos) < 2:
        return fail(command, f"usage: {command} <env> <pkg> [--confirm]")
    env = _resolve_env(pos[0])
    if env is None:
        return fail(command, f"environment not found: {pos[0]}")
    pkgs = pos[1:]
    confirmed = has_flag(argv, "--confirm")
    cmd = _pip_for(env) + pip_action + ["--disable-pip-version-check"] + pkgs
    return _planned_or_run(command, cmd, confirmed, env=env["name"], packages=pkgs)


# --- env export / import / doctor (file 04 §4.2) ---------------------------- #

def _freeze(env: Dict[str, Any]) -> Tuple[List[str], Optional[str]]:
    """Return (frozen-requirement-lines, error). Uses ``pip freeze`` in the env."""
    cmd = _pip_for(env) + ["freeze", "--disable-pip-version-check"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as exc:  # noqa: BLE001
        return [], f"pip freeze failed: {exc}"
    if out.returncode != 0:
        return [], (out.stderr or "pip freeze returned non-zero").strip()[:500]
    lines = [ln.strip() for ln in (out.stdout or "").splitlines() if ln.strip()]
    return lines, None


def v_env_export(argv: List[str]) -> int:
    """env.export <env> [--to FILE] — pip freeze (or ``conda env export``). Read-only."""
    pos = positional(argv)
    if not pos:
        return fail("env.export", "missing <env> (name or path)")
    env = _resolve_env(pos[0])
    if env is None:
        return fail("env.export", f"environment not found: {pos[0]}")
    to = opt_value(argv, "--to")
    if env.get("kind") == "conda":
        conda = _conda_present() or "conda"
        cmd = [conda, "env", "export", "-n", env["name"]]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        except Exception as exc:  # noqa: BLE001
            return fail("env.export", f"conda env export failed: {exc}", env=env["name"])
        if out.returncode != 0:
            return fail("env.export", "conda env export returned non-zero", env=env["name"],
                        stderr=(out.stderr or "").strip()[:500])
        body = out.stdout or ""
        fmt = "environment.yml"
        lines = [ln for ln in body.splitlines() if ln.strip()]
    else:
        lines, err = _freeze(env)
        if err:
            return fail("env.export", err, env=env["name"])
        body = "\n".join(lines) + ("\n" if lines else "")
        fmt = "requirements.txt"
    written: Optional[str] = None
    if to:
        try:
            Path(to).expanduser().write_text(body, encoding="utf-8")
            written = str(Path(to).expanduser())
        except OSError as exc:
            return fail("env.export", f"could not write {to}: {exc}", env=env["name"])
    return emit("env.export", env=env["name"], path=env["path"], kind=env.get("kind"),
                format=fmt, requirements=lines, count=len(lines), written_to=written)


def v_env_import(argv: List[str]) -> int:
    """env.import --file F --name N [--python V] [--confirm] [--force] — create + GATED install.

    ``requirements.txt`` → create a venv then gated-install the pinned set.
    ``environment.yml``  → ``conda env create -f`` (conda owns its own solver/gate path).
    """
    file = opt_value(argv, "--file")
    name = opt_value(argv, "--name")
    if not file or not name:
        return fail("env.import", "usage: env.import --file requirements.txt|environment.yml "
                                  "--name N [--python V] [--confirm] [--force]")
    fpath = Path(file).expanduser()
    if not fpath.is_file():
        return fail("env.import", f"file not found: {fpath}")
    confirmed = has_flag(argv, "--confirm")
    force = has_flag(argv, "--force")
    is_yaml = fpath.suffix.lower() in (".yml", ".yaml")

    if is_yaml:
        conda = _conda_present()
        if not conda:
            return fail("env.import", "environment.yml requires conda, which is not on PATH")
        cmd = [conda, "env", "create", "-n", name, "-f", str(fpath)]
        return _planned_or_run("env.import", cmd, confirmed, kind="conda", target=name,
                               source=str(fpath))

    # requirements.txt → create the venv, then GATED install of its lines.
    try:
        specs = [ln.strip() for ln in fpath.read_text(encoding="utf-8").splitlines()
                 if ln.strip() and not ln.lstrip().startswith("#")]
    except OSError as exc:
        return fail("env.import", f"could not read {fpath}: {exc}")
    target = str(Path(name).expanduser()) if (os.sep in name or name.startswith("~")) \
        else str((Path.home() / ".prometheus" / "envs" / name))
    pyver = opt_value(argv, "--python")

    if not confirmed:
        plan = {
            "create": [sys.executable, "-m", "venv", target],
            "gate_and_install": {"specs": specs, "via": "_gate_install (stage→scan→install)"},
        }
        return emit("env.import", planned=True, plan=plan, kind="venv", target=target,
                    source=str(fpath), specs=specs, python=pyver,
                    note="re-run with --confirm to create the venv and gated-install its requirements")

    if not _is_venv(Path(target)):
        base = sys.executable
        try:
            r = subprocess.run([base, "-m", "venv", target],
                               capture_output=True, text=True, timeout=300)
        except Exception as exc:  # noqa: BLE001
            return fail("env.import", f"venv create failed: {exc}", target=target)
        if r.returncode != 0:
            return fail("env.import", "venv create returned non-zero", target=target,
                        stderr=(r.stderr or "").strip()[:500])
    env = {"name": Path(target).name, "path": str(Path(target).resolve()), "kind": "venv"}
    if not specs:
        return emit("env.import", created=True, installed=False, target=target,
                    message="venv created; requirements file had no installable lines")
    return _gate_install("env.import", env, specs, confirmed=True, force=force,
                         request_extra={"source": str(fpath), "created": target})


def v_env_doctor(argv: List[str]) -> int:
    """env.doctor <env> — health probe: interpreter runs? pip resolves? CUDA visible? Read-only."""
    pos = positional(argv)
    if not pos:
        return fail("env.doctor", "missing <env> (name or path)")
    env = _resolve_env(pos[0])
    if env is None:
        return fail("env.doctor", f"environment not found: {pos[0]}")
    checks: Dict[str, Any] = {}

    py = _python_exe(Path(env["path"])) if env.get("kind") != "conda" else None
    interp_ok = False
    if env.get("kind") == "system":
        interp_ok = True
    elif py and py.exists():
        interp_ok = _python_version(py) is not None
    elif env.get("kind") == "conda":
        interp_ok = env.get("python_version") is not None or bool(_conda_present())
    checks["interpreter_runs"] = interp_ok

    pip_ok = False
    try:
        r = subprocess.run(_pip_for(env) + ["--version", "--disable-pip-version-check"],
                           capture_output=True, text=True, timeout=60)
        pip_ok = r.returncode == 0
    except Exception as exc:  # noqa: BLE001
        log("doctor pip probe failed:", exc)
    checks["pip_resolves"] = pip_ok

    cfg_ok = True
    if env.get("kind") == "venv":
        cfg_ok = (Path(env["path"]) / "pyvenv.cfg").exists()
    checks["config_parses"] = cfg_ok

    cuda_visible: Optional[bool] = None
    if py and py.exists():
        try:
            r = subprocess.run(
                [str(py), "-c", "import torch,sys; sys.stdout.write('1' if torch.cuda.is_available() else '0')"],
                capture_output=True, text=True, timeout=60)
            if r.returncode == 0 and r.stdout.strip() in ("0", "1"):
                cuda_visible = r.stdout.strip() == "1"
        except Exception:  # noqa: BLE001
            cuda_visible = None
    checks["cuda_visible"] = cuda_visible

    if interp_ok and pip_ok and cfg_ok:
        health = "ok"
    elif interp_ok and cfg_ok:
        health = "degraded"
    else:
        health = "broken"
    return emit("env.doctor", env=env["name"], path=env["path"], kind=env.get("kind"),
                health=health, checks=checks)


# --- pkg enable / disable (reversible sentinel — file 04 §5) ---------------- #

_DISABLED_SUFFIX = ".studio-disabled"


def _dist_info_dirs(env: Dict[str, Any], pkg: str) -> List[Path]:
    """Locate ``<pkg>*.dist-info`` (and the disabled sentinel) in the env's site-packages.

    Ask the TARGET interpreter for its site-packages dirs, then glob the normalized
    package name (PEP 503). Returns active + sentinel candidates so enable/disable can
    find either state.
    """
    py = _python_exe(Path(env["path"]))
    if not py:
        return []
    code = "import json,site,sys; print(json.dumps(list(dict.fromkeys((site.getsitepackages() if hasattr(site,'getsitepackages') else [])+[site.getusersitepackages()]))))"  # noqa: E501
    try:
        out = subprocess.run([str(py), "-c", code], capture_output=True, text=True, timeout=30)
        roots = [Path(p) for p in json.loads(out.stdout or "[]")]
    except Exception as exc:  # noqa: BLE001
        log("site-packages probe failed:", exc)
        return []
    norm = pkg.lower().replace("-", "_")
    hits: List[Path] = []
    for root in roots:
        if not root.is_dir():
            continue
        for pat in (f"{norm}-*.dist-info", f"{pkg}-*.dist-info",
                    f"{norm}-*.dist-info{_DISABLED_SUFFIX}", f"{pkg}-*.dist-info{_DISABLED_SUFFIX}"):
            hits.extend(root.glob(pat))
    # de-dup preserving order
    seen: set[str] = set()
    uniq: List[Path] = []
    for h in hits:
        if str(h) not in seen:
            seen.add(str(h))
            uniq.append(h)
    return uniq


def v_pkg_disable(argv: List[str]) -> int:
    """pkg.disable <env> <pkg> [--confirm] — reversible: rename dist-info → sentinel. No fetch.

    Makes the package non-importable WITHOUT losing the pin; the metadata dir is
    renamed to ``*.dist-info.studio-disabled`` so re-enable is instant (§5 design note).
    """
    pos = positional(argv)
    if len(pos) < 2:
        return fail("pkg.disable", "usage: pkg.disable <env> <pkg> [--confirm]")
    env = _resolve_env(pos[0])
    if env is None:
        return fail("pkg.disable", f"environment not found: {pos[0]}")
    if env.get("kind") == "conda":
        return fail("pkg.disable", "pkg.disable is a venv-only convenience; use pkg.remove for conda")
    pkg = pos[1]
    confirmed = has_flag(argv, "--confirm")
    active = [d for d in _dist_info_dirs(env, pkg) if not d.name.endswith(_DISABLED_SUFFIX)]
    if not active:
        return fail("pkg.disable", f"no installed dist-info for '{pkg}' in {env['name']}")
    target = active[0]
    marker = target.with_name(target.name + _DISABLED_SUFFIX)
    if not confirmed:
        return emit("pkg.disable", planned=True, env=env["name"], package=pkg,
                    plan={"rename": str(target), "to": str(marker)},
                    note="re-run with --confirm to disable (reversible)")
    try:
        target.rename(marker)
    except OSError as exc:
        return fail("pkg.disable", f"could not disable: {exc}", env=env["name"], package=pkg)
    return emit("pkg.disable", executed=True, env=env["name"], package=pkg, state="disabled",
                disabled_marker=str(marker))


def v_pkg_enable(argv: List[str]) -> int:
    """pkg.enable <env> <pkg> [--confirm] — restore a sentinel-disabled package. No real fetch."""
    pos = positional(argv)
    if len(pos) < 2:
        return fail("pkg.enable", "usage: pkg.enable <env> <pkg> [--confirm]")
    env = _resolve_env(pos[0])
    if env is None:
        return fail("pkg.enable", f"environment not found: {pos[0]}")
    if env.get("kind") == "conda":
        return fail("pkg.enable", "pkg.enable is a venv-only convenience")
    pkg = pos[1]
    confirmed = has_flag(argv, "--confirm")
    markers = [d for d in _dist_info_dirs(env, pkg) if d.name.endswith(_DISABLED_SUFFIX)]
    if not markers:
        return fail("pkg.enable", f"no disabled sentinel for '{pkg}' in {env['name']} "
                                  "(nothing to re-enable; install it instead)")
    marker = markers[0]
    restored = marker.with_name(marker.name[: -len(_DISABLED_SUFFIX)])
    if not confirmed:
        return emit("pkg.enable", planned=True, env=env["name"], package=pkg,
                    plan={"rename": str(marker), "to": str(restored)},
                    note="re-run with --confirm to enable")
    try:
        marker.rename(restored)
    except OSError as exc:
        return fail("pkg.enable", f"could not enable: {exc}", env=env["name"], package=pkg)
    return emit("pkg.enable", executed=True, env=env["name"], package=pkg, state="enabled",
                restored=str(restored))


# --- cuda torch (file 04 §5.2) ---------------------------------------------- #

def v_cuda_torch(argv: List[str]) -> int:
    """cuda.torch --env ENVID [--index URL] [--confirm] [--force] — GATED CUDA-torch install.

    Installs the CUDA-matched (or CPU) ``torch`` wheel into the chosen env. The wheel
    fetch is staged + nemesis-gated like any other install (§6). The index is derived
    from ``cuda.info`` when not given.
    """
    target = opt_value(argv, "--env") or (positional(argv)[0] if positional(argv) else None)
    if not target:
        return fail("cuda.torch", "usage: cuda.torch --env ENVID [--index URL] [--confirm] [--force]")
    env = _resolve_env(target)
    if env is None:
        return fail("cuda.torch", f"environment not found: {target}")
    index = opt_value(argv, "--index")
    if index and index.startswith("-"):
        return fail("cuda.torch", "index must not start with a dash")
    extra_download: List[str] = []
    extra_install: List[str] = []
    if index:
        # pip download/install honor --index-url for the wheel source; vetted bytes
        # are still re-installed offline from the staging dir (--no-index) after the gate.
        extra_download = ["--index-url", index]
    return _gate_install(
        "cuda.torch", env, ["torch"],
        confirmed=has_flag(argv, "--confirm"), force=has_flag(argv, "--force"),
        extra_download=extra_download, extra_install=extra_install,
        request_extra={"torch_index": index, "scope": "cuda"},
    )


# --- template commit (file 04 §7) ------------------------------------------- #

def _resolve_template(template_id: str) -> Optional[Dict[str, Any]]:
    if _TEMPLATES_DIR.is_dir():
        for f in _TEMPLATES_DIR.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                continue
            if data.get("id", f.stem) == template_id:
                return data
    for t in _BUILTIN_TEMPLATES:
        if t.get("id") == template_id:
            return t
    return None


def _template_specs(tpl: Dict[str, Any]) -> List[str]:
    """Resolve a template's package entries to pip specs (strings or {name,version})."""
    specs: List[str] = []
    for p in tpl.get("packages", []):
        if isinstance(p, str):
            specs.append(p)
        elif isinstance(p, dict) and p.get("name"):
            if p.get("optional"):
                continue  # optional rows are unchecked-by-default; the GUI opts them in
            ver = p.get("version")
            specs.append(f"{p['name']}{ver}" if ver else p["name"])
    return specs


def v_template_commit(argv: List[str]) -> int:
    """template.commit --template ID --env ENV [--confirm] [--force] — batched GATED install (§7).

    Resolves the template's package set to one batched gate plan, scans, and installs
    the approved bytes. A block on the batch is fail-closed (the GUI can retry per-row).
    """
    tid = opt_value(argv, "--template")
    target = opt_value(argv, "--env")
    if not tid or not target:
        return fail("template.commit",
                    "usage: template.commit --template ID --env ENV [--confirm] [--force]")
    tpl = _resolve_template(tid)
    if tpl is None:
        return fail("template.commit", f"template not found: {tid}")
    env = _resolve_env(target)
    if env is None:
        return fail("template.commit", f"environment not found: {target}")
    specs = _template_specs(tpl)
    if not specs:
        return emit("template.commit", installed=False, env=env["name"], template=tid,
                    message="template has no default-checked packages")
    return _gate_install(
        "template.commit", env, specs,
        confirmed=has_flag(argv, "--confirm"), force=has_flag(argv, "--force"),
        request_extra={"template": tid},
    )


HANDLERS = {
    "env.list": v_env_list,
    "env.create": v_env_create,
    "env.delete": v_env_delete,
    "env.clone": v_env_clone,
    "env.use": v_env_use,
    "env.export": v_env_export,
    "env.import": v_env_import,
    "env.doctor": v_env_doctor,
    "pkg.list": v_pkg_list,
    "pkg.install": v_pkg_install,
    "pkg.uninstall": v_pkg_uninstall,
    "pkg.remove": v_pkg_remove,
    "pkg.update": v_pkg_update,
    "pkg.upgrade": v_pkg_upgrade,
    "pkg.enable": v_pkg_enable,
    "pkg.disable": v_pkg_disable,
    "cuda.info": v_cuda_info,
    "cuda.torch": v_cuda_torch,
    "conda.env-list": v_conda_envlist,
    "template.list": v_template_list,
    "template.commit": v_template_commit,
}


def main(argv: List[str]) -> int:
    return dispatch(PROG, HANDLERS, argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
