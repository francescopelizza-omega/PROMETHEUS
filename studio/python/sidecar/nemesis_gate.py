#!/usr/bin/env python3
"""nemesis_gate.py — the Model-Hub security spine (file 05 §5).

EVERY downloaded model artifact is STAGED into ``~/.prometheus/models/.stage/<id>/``
(never the live library), then handed to the REAL ``nemesis`` binary as a subprocess
gate — the SAME fail-closed scanner ``prometheus.py`` gates clones/installs with. The
sidecar NEVER decides "safe" itself (C5 GOLDEN RULE):

    download → .stage/<id>/         (planted bytes; not executed, not in the live lib)
    nemesis gate <stage>           → ONE verdict object (real binary, fail-closed)
    sha256 check (per file)        → mismatch ⇒ synthetic BLOCK (supply-chain integrity)
    pickle-format risk             → *.bin/*.pt/*.ckpt ⇒ high-risk signal (arbitrary code
                                     on load) vs safetensors/gguf (no code on load)
    verdict allow  → admit: move .stage → live lib + write .prometheus_model.json
    verdict warn   → return verdict (NO admit) for the GUI to confirm
    verdict block  → REFUSE + QUARANTINE the stage dir (kept for inspect, NOT deleted)
    verdict error  → FAIL-CLOSED → BLOCK (scanner missing / timeout / exit2 / unparseable)
    force:true     → admit anyway over block/error/warn, flagged ``forced_danger``

This module is import-only (no argv/emit); ``modelhub.py`` wraps the result in an
envelope. The download/network half is the caller's; this is the gate + admit logic,
which is the security-load-bearing part and is fully unit-testable with planted bytes.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _envelope import log  # noqa: E402

# nemesis gate flags — identical to prometheus.py / envmgr so verdict/signing/policy match.
_NEMESIS_GATE_FLAGS = ["--sandbox", "auto", "--jail", "auto", "--sign"]
_NEMESIS_GATE_TIMEOUT = int(os.environ.get("PROMETHEUS_GATE_TIMEOUT", "840"))
_NEMESIS_SUBPROCESS_TIMEOUT = _NEMESIS_GATE_TIMEOUT + 60

# Model formats that execute code on load (Python pickle) vs. data-only safe formats.
_PICKLE_EXTS = {".bin", ".pt", ".pth", ".ckpt", ".pkl", ".pickle"}
_SAFE_EXTS = {".safetensors", ".gguf", ".ggml", ".onnx", ".mlx", ".npz"}


# --- library layout --------------------------------------------------------- #

def models_root() -> Path:
    """The live model library root. ``$PROMETHEUS_MODELS_HOME`` overrides for tests."""
    env = os.environ.get("PROMETHEUS_MODELS_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".prometheus" / "models"


def stage_root() -> Path:
    """The staging/quarantine root (mirrors the engine PURGE_DIR pattern)."""
    return models_root() / ".stage"


def _safe_id(model_id: str) -> str:
    """Turn an arbitrary model id into a filesystem-safe directory name."""
    return model_id.replace("/", "__").replace(":", "__").replace("..", "__")


def stage_dir_for(model_id: str) -> Path:
    """Where a download for ``model_id`` is staged before the gate decides."""
    return stage_root() / _safe_id(model_id)


def live_dir_for(model_id: str, source: str = "huggingface") -> Path:
    """Where admitted bytes live once nemesis allows them."""
    bucket = "url" if source == "url" else source
    return models_root() / bucket / _safe_id(model_id)


# --- nemesis location + fail-closed verdict --------------------------------- #

def find_nemesis() -> Optional[str]:
    """Locate the REAL nemesis binary (SAME precedence as prometheus.py / envmgr).

    ``$NEMESIS_BIN`` → sibling PROMETHEUS root (walk up) → ``which('nemesis')`` → None.
    None ⇒ the gate fails closed (verdict 'error' → BLOCK); never silently skipped.
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
            break
    return shutil.which("nemesis")


def error_verdict(reason: str) -> Dict[str, Any]:
    """Synthetic fail-closed verdict (C5): error ⇒ BLOCK. risk 100, safe_to all false."""
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
    """Run the REAL nemesis as a gate over the staged dir ``target``.

    Returns the parsed ``nemesis.verdict`` dict. FAIL-CLOSED by construction: missing
    binary, spawn failure, timeout, non-existent target, or unparseable stdout all
    yield an ``error`` verdict (treated as BLOCK). We shell the SAME binary with the
    SAME flags the engine uses — we never re-implement the decision in Python.
    """
    nem = find_nemesis()
    if not nem:
        return error_verdict(
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
        return error_verdict(f"nemesis timed out after {_NEMESIS_SUBPROCESS_TIMEOUT}s")
    except (OSError, subprocess.SubprocessError) as exc:  # noqa: BLE001
        return error_verdict(f"nemesis could not run: {exc}")
    try:
        verdict = json.loads(p.stdout)
    except (json.JSONDecodeError, ValueError):
        tail = (p.stderr or p.stdout or f"exit {p.returncode}").strip()[-200:]
        return error_verdict(f"unparseable nemesis verdict ({tail})")
    if not isinstance(verdict, dict) or "verdict" not in verdict:
        return error_verdict("nemesis returned a non-verdict object")
    return verdict


def verdict_summary(v: Dict[str, Any]) -> Dict[str, Any]:
    """Project a nemesis verdict to the GateBadge-ish summary the GUI renders."""
    return {
        "verdict": v.get("verdict", "error"),
        "score": v.get("risk_score", 100),
        "reasons": list(v.get("blocking_reasons") or [])[:8],
        "signed": bool((v.get("signature") or {}).get("value")),
        "recommendation": v.get("recommendation", ""),
        "scanned_at": v.get("scanned_at", ""),
    }


# --- model-specific supply-chain checks ------------------------------------- #

def sha256_file(path: Path, _bufsize: int = 1024 * 1024) -> str:
    """Streaming sha256 of a file (no whole-file read into memory)."""
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(_bufsize), b""):
            h.update(chunk)
    return h.hexdigest()


def format_risk(staging: Path) -> Dict[str, Any]:
    """Flag pickle-format weight files (*.bin/*.pt/*.ckpt) as high-risk vs safetensors/gguf.

    Returns ``{high_risk_files, safe_files, risk}`` where risk is 'high' if any
    pickle-format weight is present, else 'low'. This is a model supply-chain signal
    nemesis' deserialization/AST sinks already understand — we surface it explicitly so
    the GUI can warn even when the scanner verdict is otherwise clean.
    """
    high: List[str] = []
    safe: List[str] = []
    if staging.is_dir():
        for p in sorted(staging.rglob("*")):
            if not p.is_file():
                continue
            ext = p.suffix.lower()
            if ext in _PICKLE_EXTS:
                high.append(p.name)
            elif ext in _SAFE_EXTS:
                safe.append(p.name)
    return {"high_risk_files": high, "safe_files": safe, "risk": "high" if high else "low"}


def verify_checksums(staging: Path, expected: Dict[str, str]) -> Dict[str, Any]:
    """Verify per-file sha256 against ``expected`` ({rfilename: sha256}).

    Returns ``{ok, mismatches, missing, verified}``. A mismatch is a supply-chain
    integrity failure — the caller turns it into a synthetic BLOCK (sha256 mismatch ⇒
    BLOCK, §5.3). Files with no expected digest are skipped (not all HF files pin one).
    """
    mismatches: List[Dict[str, str]] = []
    missing: List[str] = []
    verified: List[str] = []
    for rfile, want in (expected or {}).items():
        if not want:
            continue
        fp = staging / rfile
        if not fp.is_file():
            missing.append(rfile)
            continue
        got = sha256_file(fp)
        if got.lower() != str(want).lower():
            mismatches.append({"file": rfile, "expected": want, "actual": got})
        else:
            verified.append(rfile)
    return {
        "ok": not mismatches and not missing,
        "mismatches": mismatches,
        "missing": missing,
        "verified": verified,
    }


# --- the admit decision ----------------------------------------------------- #

def admit(
    model_id: str,
    *,
    source: str = "huggingface",
    quant: Optional[str] = None,
    license: Optional[str] = None,
    expected_sha256: Optional[Dict[str, str]] = None,
    force: bool = False,
    staging: Optional[Path] = None,
) -> Dict[str, Any]:
    """THE GATE DECISION over an ALREADY-STAGED dir (file 05 §5). NEVER admits ungated.

    Pure of network — the caller has already planted the downloaded bytes into the
    staging dir (``stage_dir_for(model_id)`` by default). This runs:

      1. checksum verify (mismatch ⇒ synthetic BLOCK before we even spend a scan).
      2. ``nemesis gate <stage>`` — the real scanner, fail-closed.
      3. pickle-format risk classification (surfaced regardless of verdict).
      4. decide:
           allow            → admit (move stage → live lib + .prometheus_model.json)
           warn  (no force) → needs_confirm (NO admit)
           block/error      → REFUSE + QUARANTINE (stage kept, NOT deleted)
           force            → admit over block/error/warn, flag ``forced_danger``

    Returns a result dict (the caller wraps it in the JSON envelope).
    """
    stage = staging or stage_dir_for(model_id)
    result: Dict[str, Any] = {
        "id": model_id, "source": source, "quant": quant,
        "stage_dir": str(stage),
    }

    if not stage.is_dir():
        v = error_verdict(f"staging dir does not exist: {stage}")
        result.update(admitted=False, blocked=True, gate=verdict_summary(v),
                      message="nothing staged — fail-closed BLOCK.")
        return result

    fmt = format_risk(stage)
    result["format_risk"] = fmt

    # 1) checksum — a mismatch is an integrity BLOCK regardless of the scanner verdict.
    if expected_sha256:
        chk = verify_checksums(stage, expected_sha256)
        result["checksum"] = chk
        if not chk["ok"] and not force:
            quarantine = _quarantine(stage)
            result.update(
                admitted=False, blocked=True,
                gate=verdict_summary(error_verdict("sha256 mismatch")),
                quarantined=str(quarantine),
                message="sha256 mismatch — supply-chain integrity BLOCK; quarantined.",
            )
            return result

    # 2) nemesis — the real fail-closed scanner.
    v = nemesis_gate(str(stage))
    verdict = v.get("verdict", "error")
    result["gate"] = verdict_summary(v)

    # 3) decide.
    if verdict == "warn" and not force:
        result.update(
            admitted=False, needs_confirm=True, verdict="warn",
            message="nemesis WARN — review findings, then re-run with force:true to admit.",
        )
        return result

    if verdict in ("block", "error") and not force:
        quarantine = _quarantine(stage)
        why = "UNVERIFIABLE (scanner error)" if verdict == "error" else f"nemesis {verdict.upper()}"
        result.update(
            admitted=False, blocked=True, verdict=verdict,
            quarantined=str(quarantine),
            message=f"refused — {why}; staged bytes quarantined for inspection "
                    "(NOT deleted). Re-run with force:true (typed confirm) to override.",
        )
        return result

    forced = verdict in ("block", "error", "warn") and force

    # 4) admit — move the EXACT vetted bytes from stage → live lib.
    live = live_dir_for(model_id, source)
    _move_to_live(stage, live)
    manifest = _write_manifest(
        live, model_id=model_id, source=source, quant=quant, license=license,
        verdict=verdict, gate=result["gate"], format_risk=fmt,
        checksum=result.get("checksum"),
    )
    result.update(
        admitted=True, verdict=verdict, local_path=str(live),
        manifest=str(manifest),
    )
    if forced:
        result["forced_danger"] = {
            "label": model_id, "verdict": verdict,
            "risk_score": v.get("risk_score"),
            "blocking_reasons": list(v.get("blocking_reasons") or [])[:8],
        }
        result["message"] = (f"⚠ FORCED admit of {verdict.upper()} artifact "
                             f"({model_id}) — flagged for audit.")
    else:
        result["message"] = f"admitted {model_id} → {live}"
    return result


def _quarantine(stage: Path) -> Path:
    """Move a refused stage dir aside (kept for inspection; never auto-deleted)."""
    qroot = stage_root() / ".quarantine"
    qroot.mkdir(parents=True, exist_ok=True)
    dest = qroot / f"{stage.name}.{int(time.time())}"
    try:
        shutil.move(str(stage), str(dest))
        return dest
    except (OSError, shutil.Error) as exc:  # noqa: BLE001
        log("quarantine move failed (left in place):", exc)
        return stage


def _move_to_live(stage: Path, live: Path) -> None:
    """Promote the staged tree to the live library location, keeping the old one until it lands.

    The docstring here said "atomically" while the body did `rmtree(live)` and THEN `move(...)`
    — two steps, destructive one first. Between them the previously admitted, already-gated model
    was simply gone, and if the move then failed (disk full, a cross-device copy fallback, a
    permission error, power loss) the user was left with nothing at `live` and no backup. The
    `ignore_errors=True` made it worse in a quieter way: a partial delete was swallowed, so a
    stale mixture of old and new files could survive into the tree the manifest then vouches for.

    The staged bytes themselves were never at risk — CPython's `shutil.move` copies before it
    removes the source, so a failed promotion leaves the vetted stage intact and `admit`
    re-runnable. What was destroyed is the working model being REPLACED. So the old tree is moved
    aside first and only removed once the new one is in place; if anything throws, it goes back.
    This mirrors what the engine's own layout path already does with `_backup_live`.
    """
    live.parent.mkdir(parents=True, exist_ok=True)
    backup: Optional[Path] = None
    if live.exists():
        backup = live.with_name(f"{live.name}.replacing-{os.getpid()}")
        # a leftover from a previous crashed run must not block the rename
        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
        os.rename(live, backup)
    try:
        shutil.move(str(stage), str(live))
    except Exception:
        if backup is not None and not live.exists():
            os.rename(backup, live)  # put the working model back
            backup = None
        raise
    finally:
        if backup is not None:
            shutil.rmtree(backup, ignore_errors=True)


def _write_manifest(
    live: Path, *, model_id: str, source: str, quant: Optional[str],
    license: Optional[str], verdict: str, gate: Dict[str, Any],
    format_risk: Dict[str, Any], checksum: Optional[Dict[str, Any]],
) -> Path:
    """Write the per-model manifest (parallel to the engine's .prometheus_tool.json)."""
    manifest = live / ".prometheus_model.json"
    payload = {
        "id": model_id, "source": source, "quant": quant, "license": license,
        "nemesis_verdict": verdict, "gate": gate,
        "format_risk": format_risk, "checksum": checksum,
        "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    manifest.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return manifest
