#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
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
import hmac
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
_PICKLE_EXTS = {".bin", ".pt", ".pth", ".ckpt", ".pkl", ".pickle", ".joblib", ".npy", ".npz",
                ".keras", ".h5", ".hdf5", ".mar", ".pytorch", ".dill"}
_SAFE_EXTS = {".safetensors", ".gguf", ".ggml", ".onnx", ".mlx"}
# Files a loader EXECUTES when the model is loaded with trust_remote_code=True.
_CODE_EXTS = {".py", ".pyc", ".so", ".dylib", ".dll", ".pyd"}
# The only verdicts nemesis can emit. Anything else (a typo'd, truncated or tampered
# value) is not "something permissive we have not heard of" — it is an error.
_KNOWN_VERDICTS = ("allow", "warn", "block", "error")
_EXIT_VERDICT = {0: "allow", 10: "warn", 20: "block", 2: "error"}
_RANK = {"allow": 0, "warn": 1, "block": 2, "error": 3}
# Finding ids nemesis raises for model files. For a MODEL admission any of them refuses —
# a code repo may carry an odd pickle, a weights download may not.
_MODEL_RULE_PREFIXES = ("PICKLE-", "MODEL-", "GGUF-", "TMPL-")


# --- library layout --------------------------------------------------------- #

def models_root() -> Path:
    """The GATED model library root. ``$PROMETHEUS_MODELS_HOME`` overrides for tests.

    Distinct from ``modelhub._default_models_dir()`` (``$PROMETHEUS_MODELS_DIR``), which is the
    download cache. See that function's docstring for why the two must not be collapsed despite
    the near-identical names: this one holds ``.stage/``, the quarantine the gate moves weights
    through, and a cache and a security record have different deletion semantics.
    """
    env = os.environ.get("PROMETHEUS_MODELS_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".prometheus" / "models"


def stage_root() -> Path:
    """The staging/quarantine root (mirrors the engine PURGE_DIR pattern)."""
    return models_root() / ".stage"


def _safe_id(model_id: str) -> str:
    """Turn an arbitrary model id into a filesystem-safe directory name.

    Never the stage root itself: "" / "." / ".." used to map onto `.stage` (or its parent),
    so a pathological id could quarantine or promote the WHOLE stage. Any id that would
    start with a dot is prefixed, and separators of every platform are folded.
    """
    s = (model_id.replace("\\", "__").replace("/", "__").replace(":", "__")
         .replace("..", "__").replace("\x00", ""))
    if not s or s.startswith("."):
        s = "_" + s
    return s


def _own_staging(given: Path, model_id: str) -> Path:
    """The dir `admit` may MOVE: `given` when it already lives under the stage root, else a COPY.

    Admit promotes by moving the staging dir into the live library and quarantines by moving it
    aside. `--staged` is caller-supplied, so `--staged ~/Downloads` moved the user's Downloads
    folder into the model store (allow) or into quarantine (block). Outside the stage root the
    tree is copied in — symlinks AS links, never their targets — and only the copy moves.
    A path that does not exist is returned unchanged so the fail-closed "nothing staged" check
    below still reports it.
    """
    try:
        real = given.resolve(strict=True)
    except (OSError, RuntimeError):
        return given
    if not real.is_dir():
        return given
    root = stage_root().resolve()
    if real != root and root in real.parents:
        return real
    dest = stage_dir_for(model_id)
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(real, dest, symlinks=True)
    return dest


def stage_dir_for(model_id: str) -> Path:
    """Where a download for ``model_id`` is staged before the gate decides."""
    return stage_root() / _safe_id(model_id)


# The only library buckets. `source` arrives from argv (`--source`), and it used to be joined
# onto the library root verbatim: `--source ~/Library --id LaunchAgents` made `live` an existing
# directory of the user's, which `_move_to_live` renamed aside, replaced with the model's files,
# and then deleted. A source outside this set is refused, and the result must stay inside the
# library root whatever the id is.
LIBRARY_SOURCES = frozenset({"huggingface", "hf", "ollama", "url"})


def live_dir_for(model_id: str, source: str = "huggingface") -> Path:
    """Where admitted bytes live once nemesis allows them. Raises ValueError for a source
    that is not a library bucket, or a path that would land outside the library."""
    if source not in LIBRARY_SOURCES:
        raise ValueError(f"unknown model source {source!r} (expected one of {sorted(LIBRARY_SOURCES)})")
    root = models_root()
    live = root / source / _safe_id(model_id)
    try:
        inside = root.resolve() in live.resolve().parents
    except (OSError, RuntimeError):
        inside = False
    if not inside:
        raise ValueError(f"model path escapes the library: {live}")
    return live


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
    return reconcile_verdict(verdict, p.returncode)


def _gate_key() -> Optional[bytes]:
    """nemesis's HMAC key (~/.nemesis/gate.key) — read only, never created here."""
    try:
        k = (Path.home() / ".nemesis" / "gate.key").read_bytes().strip()
        return k or None
    except OSError:
        return None


def signature_status(v: Dict[str, Any]) -> str:
    """'verified' | 'unsigned' | 'invalid' for a parsed verdict.

    The canonical form is nemesis's own `_verdict_canonical`: every key except
    `signature`/`cached`, sorted, compact separators. A signature that is present but
    does not verify means the verdict was altered after nemesis wrote it.
    """
    sig = v.get("signature") if isinstance(v, dict) else None
    if not isinstance(sig, dict) or sig.get("alg") != "HMAC-SHA256" or not sig.get("value"):
        return "unsigned"
    key = _gate_key()
    if not key:
        return "unsigned"
    body = {k: v[k] for k in v if k not in ("signature", "cached", "_signature")}
    want = hmac.new(key, json.dumps(body, sort_keys=True, separators=(",", ":")).encode(),
                    hashlib.sha256).hexdigest()
    return "verified" if hmac.compare_digest(want, str(sig.get("value"))) else "invalid"


def reconcile_verdict(verdict: Any, returncode: int) -> Dict[str, Any]:
    """Accept a verdict only in the exact shape nemesis emits; fail closed otherwise.

    * the verdict string must be one of allow/warn/block/error — `"ALLOW"`, `"pending"`
      or a missing key used to fall through `admit` to an ADMIT;
    * the process exit code and the stdout verdict must agree — when they do not, the
      STRICTER wins (the same reconciliation prometheus.py's gate does);
    * a signature that is present but does not verify is tampering → error.
    """
    if not isinstance(verdict, dict) or "verdict" not in verdict:
        return error_verdict("nemesis returned a non-verdict object")
    vv = verdict.get("verdict")
    if vv not in _KNOWN_VERDICTS:
        return error_verdict(f"nemesis returned an unknown verdict {str(vv)[:24]!r}")
    rc_v = _EXIT_VERDICT.get(returncode)
    if rc_v is None:
        return error_verdict(f"nemesis exited with unrecognized code {returncode}")
    if _RANK[rc_v] > _RANK[vv]:
        out = error_verdict(f"exit/verdict mismatch (exit {returncode}={rc_v}, stdout {vv})")
        out["verdict"] = rc_v
        out["reconciled_from"] = vv
        return out
    status = signature_status(verdict)
    if status == "invalid":
        return error_verdict("verdict signature does not verify — altered after signing")
    verdict["_signature"] = status
    return verdict


def verdict_summary(v: Dict[str, Any]) -> Dict[str, Any]:
    """Project a nemesis verdict to the GateBadge-ish summary the GUI renders."""
    return {
        "verdict": v.get("verdict", "error"),
        "score": v.get("risk_score", 100),
        "reasons": list(v.get("blocking_reasons") or [])[:8],
        # `signed` means VERIFIED, not "a signature field is present".
        "signed": v.get("_signature") == "verified",
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
    code: List[str] = []
    if staging.is_dir():
        for p in sorted(staging.rglob("*")):
            if not p.is_file():
                continue
            ext = p.suffix.lower()
            if ext in _PICKLE_EXTS:
                high.append(p.name)
            elif ext in _SAFE_EXTS:
                safe.append(p.name)
            elif ext in _CODE_EXTS:
                code.append(p.name)
    return {"high_risk_files": high, "safe_files": safe, "code_files": code,
            "risk": "high" if (high or code) else "low"}


def _tree_snapshot(root: Path) -> List[tuple]:
    """(relpath, size, mtime_ns, ctime_ns, inode, mode) of every entry — cheap change detection
    between the scan and the promotion, without re-hashing hundreds of gigabytes.

    ctime is the field that matters against a deliberate swap: an in-place rewrite with the
    mtime put back (`os.utime`) kept size, mtime and inode identical and passed unnoticed;
    the kernel moves ctime on every write and no API sets it back."""
    snap: List[tuple] = []
    for p in sorted(root.rglob("*")):
        try:
            st = p.lstat()
        except OSError:
            continue
        snap.append((str(p.relative_to(root)), st.st_size, st.st_mtime_ns, st.st_ctime_ns,
                     st.st_ino, st.st_mode))
    return snap


def _model_findings(v: Dict[str, Any]) -> List[str]:
    """Rule ids of model-format findings anywhere in the verdict.

    `rule_ids` is nemesis's uncapped list of every rule that fired. `top_findings` alone is
    capped at 15: sixteen `verify=False` vuln lines used to push a PICKLE-GLOBAL out of it, and
    the model escalation (block) quietly became a review-and-confirm."""
    ids: List[str] = [str(r) for r in (v.get("rule_ids") or [])
                      if str(r).startswith(_MODEL_RULE_PREFIXES)]
    by_class = v.get("findings_by_class") or {}
    found = [*(v.get("top_findings") or [])]
    if isinstance(by_class, dict):
        for lst in by_class.values():
            found.extend(lst or [])
    for f in found:
        rid = str((f or {}).get("rule_id") or (f or {}).get("id") or "") if isinstance(f, dict) else ""
        if rid.startswith(_MODEL_RULE_PREFIXES):
            ids.append(rid)
    for r in (v.get("blocking_reasons") or []):
        head = str(r).split(" ", 1)[0]
        if head.startswith(_MODEL_RULE_PREFIXES):
            ids.append(head)
    return sorted(set(ids))


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
    accept_warn: bool = False,
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
    stage = _own_staging(staging, model_id) if staging is not None else stage_dir_for(model_id)
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

    # 0) Prometheus's own record files are never part of a download. One planted beside the
    #    weights (`.prometheus_model.json` with "nemesis_verdict": "allow") used to be accepted
    #    by import-ollama as the admission record of whatever sat next to it.
    planted = sorted(str(p.relative_to(stage)) for p in stage.rglob(".prometheus_*"))
    if planted:
        quarantine = _quarantine(stage)
        result.update(
            admitted=False, blocked=True, verdict="block",
            gate=verdict_summary(error_verdict("download carries Prometheus record files")),
            quarantined=str(quarantine),
            message="refused — the download carries Prometheus's own record files "
                    f"({', '.join(planted[:3])}); quarantined.",
        )
        return result

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

    # 2) nemesis — the real fail-closed scanner. The tree is snapshotted first so bytes
    #    swapped in AFTER the scan cannot ride the promotion (scan/move TOCTOU).
    snap_before = _tree_snapshot(stage)
    v = nemesis_gate(str(stage))
    verdict = v.get("verdict", "error")
    if verdict not in _KNOWN_VERDICTS:          # belt and braces over reconcile_verdict
        v = error_verdict(f"unknown verdict {str(verdict)[:24]!r}")
        verdict = "error"
    model_hits = _model_findings(v)
    if model_hits and verdict in ("allow", "warn"):
        # a weights file with a pickle import / malformed header / template injection is
        # never a "review and confirm" — it is a refusal unless the operator forces it.
        verdict = "block"
        v = dict(v, verdict="block",
                 blocking_reasons=[*list(v.get("blocking_reasons") or []),
                                   f"model-file findings: {', '.join(model_hits)}"])
    if verdict == "allow" and fmt.get("high_risk_files"):
        # A pickle-format weight is code on load. The opcode walk is a strong check, not a
        # proof; an ALLOW over a pickle needs the operator's explicit confirmation.
        verdict = "warn"
        v = dict(v, verdict="warn",
                 blocking_reasons=[*list(v.get("blocking_reasons") or []),
                                   "pickle-format weights (code runs on load): "
                                   + ", ".join(fmt["high_risk_files"][:6])])
    if verdict == "allow" and fmt.get("code_files"):
        # loadable only with trust_remote_code=True — executable Python ships with it.
        verdict = "warn"
        v = dict(v, verdict="warn",
                 blocking_reasons=[*list(v.get("blocking_reasons") or []),
                                   "ships executable code (trust_remote_code): "
                                   + ", ".join(fmt["code_files"][:6])])
    result["gate"] = verdict_summary(v)
    if model_hits:
        result["model_findings"] = model_hits

    # 3) decide. `accept_warn` is the user's typed acceptance of a WARN they were shown — it
    #    admits a WARN and NOTHING else: not a block, not a scanner error, not a sha256 mismatch
    #    (those return above). `force` is the operator's explicit override of everything.
    if verdict == "warn" and not (force or accept_warn):
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

    forced = (verdict in ("block", "error", "warn") and force) or (verdict == "warn" and accept_warn)

    # 4) admit — move the EXACT vetted bytes from stage → live lib, provided they are
    #    still the bytes that were scanned.
    if _tree_snapshot(stage) != snap_before:
        quarantine = _quarantine(stage)
        result.update(
            admitted=False, blocked=True, verdict="error",
            gate=verdict_summary(error_verdict("staged files changed during the scan")),
            quarantined=str(quarantine),
            message="refused — the staged files changed between the scan and the admit; "
                    "quarantined (fail-closed).",
        )
        return result
    # The digest of every admitted file, recorded in the manifest so a later import or serve
    # can prove the bytes it is handed are the ones that were scanned (HF's verified digest
    # when there is one). Only GGUFs used to be listed, so a safetensors/MLX snapshot directory
    # had nothing a server start could check its files against.
    verified = set((result.get("checksum") or {}).get("verified") or [])
    files_sha: Dict[str, str] = {}
    for g in sorted(p for p in stage.rglob("*") if p.is_file() and not p.is_symlink()):
        rel = str(g.relative_to(stage))
        if any(part.startswith(".") for part in Path(rel).parts):
            continue
        want = (expected_sha256 or {}).get(rel)
        files_sha[rel] = str(want).lower() if (want and rel in verified) else sha256_file(g)
    live = live_dir_for(model_id, source)
    _move_to_live(stage, live)
    manifest = _write_manifest(
        live, model_id=model_id, source=source, quant=quant, license=license,
        verdict=verdict, gate=result["gate"], format_risk=fmt,
        checksum=result.get("checksum"), forced=forced, files_sha256=files_sha,
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
    format_risk: Dict[str, Any], checksum: Optional[Dict[str, Any]], forced: bool = False,
    files_sha256: Optional[Dict[str, str]] = None,
) -> Path:
    """Write the per-model manifest (parallel to the engine's .prometheus_tool.json).

    Signed with nemesis's HMAC key when one exists (`signature`), over the same canonical form
    nemesis uses for verdicts, so a manifest edited or written by anything else is detectable."""
    manifest = live / ".prometheus_model.json"
    payload: Dict[str, Any] = {
        "id": model_id, "source": source, "quant": quant, "license": license,
        "nemesis_verdict": verdict, "gate": gate, "forced": bool(forced),
        "format_risk": format_risk, "checksum": checksum,
        "files_sha256": dict(files_sha256 or {}),
        # the scanner that admitted it: a reuse check must not ride a verdict an older ruleset gave
        "nemesis": nemesis_identity(),
        "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    key = _gate_key()
    if key:
        payload["signature"] = {"alg": "HMAC-SHA256", "value": hmac.new(
            key, json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(),
            hashlib.sha256).hexdigest()}
    manifest.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return manifest


_NEMESIS_ID: Optional[str] = None


def nemesis_identity() -> str:
    """sha256 of the nemesis that is scanning ("absent"/"unreadable" when it cannot be read)."""
    global _NEMESIS_ID
    if _NEMESIS_ID is None:
        exe = find_nemesis()
        try:
            _NEMESIS_ID = sha256_file(Path(exe)) if exe else "absent"
        except OSError:
            _NEMESIS_ID = "unreadable"
    return _NEMESIS_ID


def manifest_signature_status(rec: Dict[str, Any]) -> str:
    """'verified' | 'unsigned' | 'invalid' for a parsed .prometheus_model.json."""
    sig = rec.get("signature") if isinstance(rec, dict) else None
    if not isinstance(sig, dict) or sig.get("alg") != "HMAC-SHA256" or not sig.get("value"):
        return "unsigned"
    key = _gate_key()
    if not key:
        return "unsigned"
    body = {k: rec[k] for k in rec if k != "signature"}
    want = hmac.new(key, json.dumps(body, sort_keys=True, separators=(",", ":")).encode(),
                    hashlib.sha256).hexdigest()
    return "verified" if hmac.compare_digest(want, str(sig.get("value"))) else "invalid"
