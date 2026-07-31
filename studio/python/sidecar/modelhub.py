#!/usr/bin/env python3
"""modelhub.py — Studio model-hub sidecar (C7).

Hardware capability + local model inventory + fit scoring + catalog search for the
"run a local open model" flow. Each verb emits EXACTLY ONE JSON object on stdout via
``_envelope.emit``/``fail``; human logs go to stderr.

GATING (C4/C5): downloading a model is a network fetch and is gated upstream by the
engine-bridge nemesis runner. This sidecar never fetches and never decides "safe" — it
only inspects local hardware/files and reads the bundled catalog.

Verbs:
    hw.scan       REAL: total RAM, CPU cores, GPU + VRAM (nvidia-smi / macOS / sysctl)
    model.list    REAL: enumerate a local models dir (gguf/safetensors/bin)
    fit.score     REAL: model size + quant + hw.scan → fits|tight|no + recommended quant
    model.search  reads config/open-models.json (bundled Tier-A open catalog)
    fit           Cookbook fit-scoring (§4): ranked quants + recommended + reasons
    download      stage → REAL nemesis gate → admit|quarantine (§5; the security spine)
    serve         build a ServeProfile + fit-derived runner argv (§8; pure, no spawn)
    endpoints     LIVE passthrough of `prometheus.py localai endpoints` (§6)
    repoint       LIVE `localai show <tool>` → non-secret env diff (§6)

Python 3 stdlib only. Target 3.9+ (dev host 3.14).
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _envelope import (  # noqa: E402
    dispatch,
    emit,
    fail,
    log,
    opt_value,
    positional,
)
import fit as fitmod  # noqa: E402
import localai_bridge  # noqa: E402
import nemesis_gate  # noqa: E402
import serve as servemod  # noqa: E402

PROG = "modelhub"

# config/open-models.json sits at studio/config/ (this file is studio/python/sidecar/).
_CATALOG = Path(__file__).resolve().parents[2] / "config" / "open-models.json"

_MODEL_EXTS = {".gguf", ".safetensors", ".bin", ".pt", ".ggml", ".onnx"}

# Bits per weight for common quantizations (used by fit.score).
_QUANT_BPW = {
    "f32": 32.0, "fp32": 32.0,
    "f16": 16.0, "fp16": 16.0, "bf16": 16.0,
    "q8_0": 8.5, "int8": 8.0, "q8": 8.5,
    "q6_k": 6.6, "q6": 6.6,
    "q5_k_m": 5.7, "q5_k_s": 5.5, "q5_0": 5.5, "q5": 5.7,
    "q4_k_m": 4.85, "q4_k_s": 4.6, "q4_0": 4.5, "q4": 4.85, "int4": 4.0,
    "q3_k_m": 3.9, "q3": 3.9,
    "q2_k": 2.6, "q2": 2.6,
}
_QUANT_ORDER = ["q8_0", "q6_k", "q5_k_m", "q4_k_m", "q4_0", "q3_k_m", "q2_k"]


# --- hw.scan ---------------------------------------------------------------- #

def _total_ram_bytes() -> Optional[int]:
    # macOS / BSD
    if shutil.which("sysctl"):
        try:
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=10)
            v = out.stdout.strip()
            if v.isdigit():
                return int(v)
        except Exception as exc:  # noqa: BLE001
            log("sysctl hw.memsize failed:", exc)
    # Linux
    try:
        meminfo = Path("/proc/meminfo")
        if meminfo.exists():
            for ln in meminfo.read_text().splitlines():
                if ln.startswith("MemTotal:"):
                    kb = int(ln.split()[1])
                    return kb * 1024
    except Exception as exc:  # noqa: BLE001
        log("/proc/meminfo failed:", exc)
    # generic fallback
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        size = os.sysconf("SC_PAGE_SIZE")
        if pages > 0 and size > 0:
            return pages * size
    except Exception:  # noqa: BLE001
        pass
    return None


def _cpu_cores() -> Dict[str, Optional[int]]:
    logical = os.cpu_count()
    physical: Optional[int] = None
    if shutil.which("sysctl"):
        try:
            out = subprocess.run(["sysctl", "-n", "hw.physicalcpu"], capture_output=True, text=True, timeout=10)
            if out.stdout.strip().isdigit():
                physical = int(out.stdout.strip())
        except Exception:  # noqa: BLE001
            pass
    return {"logical": logical, "physical": physical}


def _gpus() -> List[Dict[str, Any]]:
    gpus: List[Dict[str, Any]] = []
    # NVIDIA
    smi = shutil.which("nvidia-smi")
    if smi:
        try:
            out = subprocess.run(
                [smi, "--query-gpu=name,memory.total,driver_version",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=15,
            )
            for ln in (out.stdout or "").strip().splitlines():
                parts = [c.strip() for c in ln.split(",")]
                if not parts or not parts[0]:
                    continue
                vram_mb = None
                if len(parts) > 1 and parts[1].replace(".", "").isdigit():
                    vram_mb = int(float(parts[1]))
                gpus.append({
                    "name": parts[0], "vendor": "nvidia",
                    "vram_mb": vram_mb,
                    "vram_bytes": vram_mb * 1024 * 1024 if vram_mb else None,
                    "driver": parts[2] if len(parts) > 2 else None,
                    "unified_memory": False,
                })
        except Exception as exc:  # noqa: BLE001
            log("nvidia-smi query failed:", exc)
    # Apple Silicon / macOS via system_profiler
    if not gpus and platform.system() == "Darwin" and shutil.which("system_profiler"):
        try:
            out = subprocess.run(
                ["system_profiler", "SPDisplaysDataType", "-json"],
                capture_output=True, text=True, timeout=30,
            )
            data = json.loads(out.stdout or "{}")
            for d in data.get("SPDisplaysDataType", []):
                name = d.get("sppci_model") or d.get("_name") or "Apple GPU"
                cores = d.get("sppci_cores") or d.get("spdisplays_ndrvs")
                is_apple = "apple" in str(name).lower()
                gpus.append({
                    "name": name, "vendor": "apple" if is_apple else "other",
                    # Apple Silicon: GPU shares system RAM (unified memory).
                    "vram_mb": None, "vram_bytes": None,
                    "metal_cores": cores if isinstance(cores, (int, str)) else None,
                    "unified_memory": is_apple,
                })
        except Exception as exc:  # noqa: BLE001
            log("system_profiler failed:", exc)
    return gpus


def v_hw_scan(argv: List[str]) -> int:
    ram = _total_ram_bytes()
    cores = _cpu_cores()
    gpus = _gpus()
    unified = any(g.get("unified_memory") for g in gpus)
    # Memory a model can actually use for weights: discrete VRAM if present,
    # else (unified/CPU) a share of system RAM.
    vram_total = sum(g["vram_bytes"] for g in gpus if g.get("vram_bytes"))
    if vram_total:
        usable_bytes = vram_total
        usable_basis = "vram"
    elif ram:
        # leave headroom for the OS + runtime; ~70% of RAM for weights+kv-cache.
        usable_bytes = int(ram * 0.70)
        usable_basis = "unified" if unified else "system-ram"
    else:
        usable_bytes = None
        usable_basis = "unknown"
    return emit(
        "hw.scan",
        os=platform.system(), arch=platform.machine(),
        cpu={"model": platform.processor() or platform.machine(), **cores},
        ram_bytes=ram,
        ram_gb=round(ram / 1024**3, 1) if ram else None,
        gpus=gpus, gpu_count=len(gpus),
        unified_memory=unified,
        usable_weight_bytes=usable_bytes,
        usable_weight_gb=round(usable_bytes / 1024**3, 1) if usable_bytes else None,
        usable_basis=usable_basis,
    )


# --- hardware → fit-scorer shape -------------------------------------------- #

def _scan_hw() -> Dict[str, Any]:
    """Run the real hardware detection and project it into the fit-scorer's shape.

    Returns ``{accel, usable_gb, gpu_count, unified, caps:{...}}`` derived from the
    SAME REAL probes ``hw.scan`` uses (nvidia-smi / system_profiler / sysctl).
    """
    ram = _total_ram_bytes()
    gpus = _gpus()
    unified = any(g.get("unified_memory") for g in gpus)
    vram_total = sum(g["vram_bytes"] for g in gpus if g.get("vram_bytes"))
    has_nvidia = any(g.get("vendor") == "nvidia" for g in gpus)
    if has_nvidia:
        accel = "cuda"
    elif unified:
        accel = "metal"
    elif gpus and any(g.get("vendor") == "amd" for g in gpus):
        accel = "rocm"
    else:
        accel = "cpu"
    if vram_total:
        usable_bytes: Optional[int] = vram_total
    elif ram:
        usable_bytes = int(ram * 0.70)
    else:
        usable_bytes = None
    usable_gb = (usable_bytes / 1024**3) if usable_bytes else 0.0
    # Capability flags drive §4.3 quant gating. compute_cap is not probed here (the
    # csv query omits it on many drivers) → fp8/awq_marlin stay conservative-false unless
    # an explicit override is supplied. Metal/flash conservative defaults.
    caps = {
        "accel": accel,
        "fp8": False,
        "awq_marlin": accel == "cuda",
        "flash_attn": accel == "cuda",
        "metal": accel == "metal",
        "total_vram_gb": round(vram_total / 1024**3, 2) if vram_total else 0.0,
    }
    return {
        "accel": accel, "usable_gb": round(usable_gb, 2),
        "gpu_count": len(gpus), "unified": unified, "caps": caps,
    }


# --- model.list ------------------------------------------------------------- #

def _default_models_dir() -> Path:
    env = os.environ.get("PROMETHEUS_MODELS_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".cache" / "prometheus" / "models"


def v_model_list(argv: List[str]) -> int:
    pos = positional(argv)
    root = Path(pos[0]).expanduser() if pos else _default_models_dir()
    models: List[Dict[str, Any]] = []
    if root.is_dir():
        for p in sorted(root.rglob("*")):
            if p.is_file() and p.suffix.lower() in _MODEL_EXTS:
                size = p.stat().st_size
                models.append({
                    "name": p.name,
                    "path": str(p),
                    "format": p.suffix.lstrip("."),
                    "size_bytes": size,
                    "size_gb": round(size / 1024**3, 2),
                    "quant": _guess_quant(p.name),
                })
    return emit("model.list", root=str(root), exists=root.is_dir(),
                models=models, count=len(models))


def _guess_quant(name: str) -> Optional[str]:
    low = name.lower()
    for q in sorted(_QUANT_BPW, key=len, reverse=True):
        if q in low:
            return q
    return None


# --- fit.score -------------------------------------------------------------- #

def _parse_params_b(token: str) -> Optional[float]:
    """'7b' -> 7.0, '0.5b' -> 0.5, '70B' -> 70.0."""
    m = re.match(r"^\s*([\d.]+)\s*[bB]?\s*$", token)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return None
    return None


def v_fit_score(argv: List[str]) -> int:
    params_b = opt_value(argv, "--params")  # e.g. 7b
    quant = (opt_value(argv, "--quant") or "q4_k_m").lower()
    size_gb_opt = opt_value(argv, "--size-gb")  # known on-disk weight size, optional
    hw_json = opt_value(argv, "--hw")  # an hw.scan object as JSON, optional

    # Resolve usable memory: from --hw object, else scan now.
    usable_bytes: Optional[int] = None
    hw_basis = "scanned"
    if hw_json:
        try:
            hw = json.loads(hw_json)
            usable_bytes = hw.get("usable_weight_bytes")
            hw_basis = "provided"
        except json.JSONDecodeError as exc:
            return fail("fit.score", f"--hw is not valid JSON: {exc}")
    if usable_bytes is None:
        ram = _total_ram_bytes()
        gpus = _gpus()
        vram = sum(g["vram_bytes"] for g in gpus if g.get("vram_bytes"))
        usable_bytes = vram or (int(ram * 0.70) if ram else None)
    if usable_bytes is None:
        return fail("fit.score", "could not determine usable memory; pass --hw <hw.scan json>")

    # Weight bytes: explicit --size-gb wins; else params * bpw/8.
    if size_gb_opt:
        try:
            weight_bytes = float(size_gb_opt) * 1024**3
        except ValueError:
            return fail("fit.score", f"--size-gb not a number: {size_gb_opt}")
    else:
        if not params_b:
            return fail("fit.score", "need --params <N>b or --size-gb <G>")
        pb = _parse_params_b(params_b)
        if pb is None:
            return fail("fit.score", f"could not parse --params: {params_b}")
        bpw = _QUANT_BPW.get(quant)
        if bpw is None:
            return fail("fit.score", f"unknown quant '{quant}'", known_quants=sorted(_QUANT_BPW))
        weight_bytes = pb * 1e9 * bpw / 8.0

    # KV-cache + runtime overhead ~ 20% of weights (rough, conservative).
    needed = weight_bytes * 1.20
    ratio = needed / usable_bytes if usable_bytes else float("inf")
    if ratio <= 0.80:
        verdict = "fits"
    elif ratio <= 1.0:
        verdict = "tight"
    else:
        verdict = "no"

    # Recommend the largest quant that comfortably fits (for the same params).
    recommended = quant
    if params_b and not size_gb_opt:
        pb = _parse_params_b(params_b) or 0
        for q in _QUANT_ORDER:
            wb = pb * 1e9 * _QUANT_BPW[q] / 8.0 * 1.20
            if wb / usable_bytes <= 0.80:
                recommended = q
                break

    return emit(
        "fit.score",
        verdict=verdict,
        quant=quant,
        recommended_quant=recommended,
        params_b=_parse_params_b(params_b) if params_b else None,
        weight_bytes=int(weight_bytes),
        weight_gb=round(weight_bytes / 1024**3, 2),
        needed_bytes=int(needed),
        needed_gb=round(needed / 1024**3, 2),
        usable_bytes=int(usable_bytes),
        usable_gb=round(usable_bytes / 1024**3, 2),
        headroom_ratio=round(ratio, 3),
        hw_basis=hw_basis,
    )


# --- model.search ----------------------------------------------------------- #

def _load_catalog() -> Optional[Dict[str, Any]]:
    if not _CATALOG.exists():
        return None
    try:
        return json.loads(_CATALOG.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        log("catalog parse failed:", exc)
        return None


def v_model_search(argv: List[str]) -> int:
    catalog = _load_catalog()
    if catalog is None:
        return fail("model.search", f"open-model catalog missing/invalid: {_CATALOG}")
    family = opt_value(argv, "--family")
    kind = opt_value(argv, "--kind")  # llm | non-llm
    src = opt_value(argv, "--source")  # ollama | hf | huggingface — filter by fetch route
    lic = opt_value(argv, "--license")  # case-insensitive substring filter over license
    # positional() also picks up the VALUES that follow value-flags (--source ollama →
    # "ollama" leaked into the query and matched nothing). Drop those consumed values.
    consumed = {v for v in (family, kind, src, lic) if v}
    query = " ".join(t for t in positional(argv) if t not in consumed).lower().strip()
    models: List[Dict[str, Any]] = catalog.get("models", [])
    results = []
    for m in models:
        # description IS searched now (CLI-025) so "coding agent"-style queries hit.
        hay = " ".join([
            str(m.get("id", "")), str(m.get("name", "")), str(m.get("family", "")),
            " ".join(m.get("tags", [])), str(m.get("kind", "")), str(m.get("description", "")),
        ]).lower()
        if query and query not in hay:
            continue
        if family and str(m.get("family", "")).lower() != family.lower():
            continue
        if kind and str(m.get("kind", "")).lower() != kind.lower():
            continue
        if lic and lic.lower() not in str(m.get("license", "")).lower():
            continue
        # source filter: "ollama" → only models with an ollama pull tag; "hf" → with a repo.
        if src == "ollama" and not m.get("ollama"):
            continue
        if src in ("hf", "huggingface") and not m.get("repo"):
            continue
        results.append(m)
    return emit("model.search", query=query or None, family=family, kind=kind,
                license=lic, results=results, count=len(results),
                catalog_version=catalog.get("version"), source=str(_CATALOG))


# --- fit (the Cookbook ranked scorer, §4) ----------------------------------- #

def _catalog_model(model_id: str) -> Optional[Dict[str, Any]]:
    cat = _load_catalog()
    if not cat:
        return None
    for m in cat.get("models", []):
        if str(m.get("id")) == model_id:
            return m
    return None


def _resolve_hw_arg(argv: List[str]) -> Dict[str, Any]:
    """Resolve the hardware shape for fit/serve: --hw JSON wins, else a real scan."""
    hw_json = opt_value(argv, "--hw")
    if hw_json:
        hw = json.loads(hw_json)
        # Accept either the fit shape (accel/usable_gb/caps) or an hw.scan envelope.
        if "usable_gb" in hw or "accel" in hw:
            hw.setdefault("caps", {"accel": hw.get("accel", "cpu")})
            hw["caps"].setdefault("accel", hw.get("accel", "cpu"))
            hw.setdefault("usable_gb", round((hw.get("usable_weight_bytes") or 0) / 1024**3, 2))
            return hw
        ub = hw.get("usable_weight_bytes")
        accel = "metal" if hw.get("unified_memory") else (
            "cuda" if any(g.get("vendor") == "nvidia" for g in hw.get("gpus", [])) else "cpu")
        return {
            "accel": accel,
            "usable_gb": round((ub or 0) / 1024**3, 2),
            "gpu_count": hw.get("gpu_count", len(hw.get("gpus", []))),
            "unified": bool(hw.get("unified_memory")),
            "caps": {"accel": accel, "fp8": False, "awq_marlin": accel == "cuda",
                     "flash_attn": accel == "cuda", "metal": accel == "metal"},
        }
    return _scan_hw()


def v_fit(argv: List[str]) -> int:
    model_id = opt_value(argv, "--id")
    params_opt = opt_value(argv, "--params")
    family = opt_value(argv, "--family")
    ctx_len = int(opt_value(argv, "--ctx") or 8192)
    candidate_quants: Optional[List[str]] = None
    active_params_b: Optional[float] = None
    arch: Optional[Dict[str, Any]] = None

    if model_id:
        m = _catalog_model(model_id)
        if not m:
            return fail("fit", f"unknown catalog model id: {model_id}",
                        hint="run model.search to list ids")
        params_b = fitmod.parse_params_b(m.get("params_b"))
        family = family or m.get("family")
        candidate_quants = list(m.get("quants") or []) or None
        active_params_b = fitmod.parse_params_b(m.get("active_params_b"))
        # the verified per-model architecture → PRECISE KV-cache estimate (GQA/MLA/hybrid).
        arch = m.get("arch") or None
        # default to a normal interactive context (8K) for the "will it run" verdict; a
        # user can pass --ctx <native> to size the FULL-context RAM (see resource.rec_ram_gb).
        ctx_len = int(opt_value(argv, "--ctx") or ctx_len)
    else:
        params_b = fitmod.parse_params_b(params_opt)
    if params_b is None:
        return fail("fit", "need --id <catalog id> or --params <N>b")

    try:
        hw = _resolve_hw_arg(argv)
    except json.JSONDecodeError as exc:
        return fail("fit", f"--hw is not valid JSON: {exc}")

    rec = fitmod.recommend(
        params_b=params_b, usable_gb=hw["usable_gb"], ctx_len=ctx_len,
        family=family, caps=hw.get("caps"), candidate_quants=candidate_quants,
        active_params_b=active_params_b, arch=arch,
    )
    return emit(
        "fit", id=model_id, params_b=params_b, family=family, ctx_len=ctx_len,
        accel=hw.get("accel"), usable_gb=hw["usable_gb"],
        recommended=rec["recommended"], ranked=rec["ranked"], reasons=rec["reasons"],
    )


# --- download (the security spine, §5) -------------------------------------- #

def v_download(argv: List[str]) -> int:
    """Stage → REAL nemesis gate → admit|quarantine. NEVER fetches+admits ungated.

    The network fetch (HF / Ollama, multi-GB) cannot run in this sandbox and is the
    caller's job upstream; what matters for security is the GATE DECISION over the
    staged bytes, which this implements faithfully. ``--staged`` (a dir that already
    holds the downloaded bytes, e.g. from a test or a completed bridge download) drives
    the gate; without it we return the resumable download PLAN (no bytes moved).
    """
    model_id = opt_value(argv, "--id")
    if not model_id:
        return fail("download", "need --id <model id>")
    quant = opt_value(argv, "--quant")
    source = opt_value(argv, "--source") or "huggingface"
    license = opt_value(argv, "--license")
    force = "--force" in argv
    staged = opt_value(argv, "--staged")  # a dir with the (already fetched) bytes
    sha_json = opt_value(argv, "--sha256")  # {"rfilename": "<hex>"}

    stage = nemesis_gate.stage_dir_for(model_id)
    if not staged:
        # No bytes on disk yet → return the resumable plan (the bridge does the fetch).
        m = _catalog_model(model_id)
        repo = (m or {}).get("repo")
        return emit(
            "download", planned=True, id=model_id, quant=quant, source=source,
            stage_dir=str(stage),
            plan={
                "fetch": {"source": source, "repo": repo, "quant": quant,
                          "resumable": True, "method": "HTTP Range",
                          "dest": str(stage)},
                "gate": ["nemesis", "gate", str(stage), "--sandbox", "auto",
                         "--jail", "auto", "--sign"],
                "admit": "on allow: move stage → live lib + write .prometheus_model.json",
            },
            note="fetch the bytes into stage_dir (resumable), then re-run with "
                 "--staged <dir> to gate+admit. Download/serve binaries are not "
                 "installed in this sandbox; the GATE decision is what runs here.",
        )

    expected = None
    if sha_json:
        try:
            expected = json.loads(sha_json)
        except json.JSONDecodeError as exc:
            return fail("download", f"--sha256 is not valid JSON: {exc}")

    result = nemesis_gate.admit(
        model_id, source=source, quant=quant, license=license,
        expected_sha256=expected, force=force, staging=Path(staged).expanduser(),
    )
    # Map the admit result onto the envelope (ok=False only on a real BLOCK).
    blocked = bool(result.get("blocked"))
    if blocked and not result.get("admitted"):
        return emit("download", _exit=2, ok=False, **result)
    return emit("download", **result)


# --- real local-model PULL via ollama (§5; the actual weight fetch) --------- #

def _which(binary: str) -> Optional[str]:
    """PATH lookup with test seams: MODELHUB_FORCE_NO_OLLAMA forces ollama absent;
    MODELHUB_FAKE_OLLAMA forces it present — so v_pull is unit-testable as a subprocess
    without a real install."""
    if binary == "ollama":
        if os.environ.get("MODELHUB_FORCE_NO_OLLAMA"):
            return None
        if os.environ.get("MODELHUB_FAKE_OLLAMA"):
            return "/fake/bin/ollama"
    return shutil.which(binary)


def _run_stream(cmd: List[str], on_line) -> int:
    """Run ``cmd`` streaming each output line to ``on_line``; return the exit code. The
    MODELHUB_FAKE_PULL_LINES / _CODE env seam replaces the real subprocess so the pull
    path runs hermetically in tests (no ollama binary, no network)."""
    fake = os.environ.get("MODELHUB_FAKE_PULL_LINES")
    if fake is not None:
        for line in fake.split("\n"):
            on_line(line)
        return int(os.environ.get("MODELHUB_FAKE_PULL_CODE", "0"))
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    if proc.stdout is not None:
        for line in proc.stdout:
            on_line(line.rstrip("\n"))
    return proc.wait()


_PCT_RE = re.compile(r"(\d{1,3})%")


def _emit_progress(pct: int, status: str) -> None:
    """A progress JSON-line on STDERR (stdout stays the ONE final envelope). The bridge
    tails stderr for {"event":"progress",...} to drive the Download Queue UI."""
    sys.stderr.write(
        json.dumps({"event": "progress", "verb": "pull", "pct": pct, "status": status}) + "\n"
    )
    sys.stderr.flush()


# --- ensure the ollama background daemon is up (the pull/chat prerequisite) -- #
#
# `brew install ollama` (the macOS formula) and some Linux setups install ONLY the
# CLI — the background SERVER is NOT auto-started. Then `ollama pull` cannot reach
# localhost:11434 and exits 1 ("could not connect to ollama app, is it running?").
# We probe the daemon and, if it's down, start `ollama serve` DETACHED (so it
# outlives this short-lived sidecar) and wait for it to accept connections.

_OLLAMA_STARTUP_TIMEOUT_S = 20.0


def _ollama_root() -> str:
    """The ollama daemon ROOT url (no /v1), honoring OLLAMA_HOST. /api/* lives here."""
    host = os.environ.get("OLLAMA_HOST") or "127.0.0.1:11434"
    if host.startswith(("http://", "https://")):
        return host.rstrip("/")
    return f"http://{host}".rstrip("/")


def _ollama_reachable(timeout: float = 1.0) -> bool:
    """True if the ollama daemon answers GET /api/version (the pull prerequisite)."""
    import urllib.request

    try:
        with urllib.request.urlopen(  # noqa: S310 — localhost daemon only
            f"{_ollama_root()}/api/version", timeout=timeout
        ) as resp:
            return int(getattr(resp, "status", 200)) < 500
    except Exception:  # noqa: BLE001 — any failure ⇒ not reachable
        return False


def _ensure_ollama_daemon() -> bool:
    """Ensure the ollama daemon is running before an `ollama pull`. Returns True once
    reachable (already up, or successfully started here), else False. Starts
    ``ollama serve`` DETACHED so the server survives this short-lived sidecar.

    Test seams: ``MODELHUB_FORCE_DAEMON_DOWN`` ⇒ always False (no spawn);
    ``MODELHUB_FORCE_DAEMON_UP`` / ``MODELHUB_FAKE_OLLAMA`` / ``MODELHUB_FAKE_PULL_LINES``
    ⇒ hermetic run, treated as already up (no probe, no spawn)."""
    if os.environ.get("MODELHUB_FORCE_DAEMON_DOWN"):
        return False
    if (
        os.environ.get("MODELHUB_FORCE_DAEMON_UP")
        or os.environ.get("MODELHUB_FAKE_OLLAMA")
        or os.environ.get("MODELHUB_FAKE_PULL_LINES") is not None
    ):
        return True
    if _ollama_reachable():
        return True
    ollama = _which("ollama")
    if not ollama:
        return False
    _emit_progress(0, "starting the ollama background service…")
    kwargs: Dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — survive our exit on Windows.
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True  # own session; outlives this sidecar
    try:
        subprocess.Popen([ollama, "serve"], **kwargs)  # noqa: S603 — fixed argv, no shell
    except OSError as exc:
        log(f"could not start `ollama serve`: {exc}")
        return False
    deadline = time.monotonic() + _OLLAMA_STARTUP_TIMEOUT_S
    while time.monotonic() < deadline:
        if _ollama_reachable(timeout=0.5):
            _emit_progress(0, "ollama service ready")
            return True
        time.sleep(0.4)
    return False


def v_pull(argv: List[str]) -> int:
    """REAL local-model install via the ollama runner: ``ollama pull <tag>`` streams the
    weight download, after which the model is served at ollama's OpenAI-compatible
    endpoint (localhost:11434/v1). Ollama's own signed registry is the trust boundary for
    these bytes — there is no local stage dir to nemesis-sign (unlike a raw HF GGUF, which
    stays in ``download``/``--staged``). Progress is emitted as JSON-lines on stderr.
    """
    model_id = opt_value(argv, "--id")
    if not model_id:
        return fail("pull", "need --id <model id>")
    runner = opt_value(argv, "--runner") or "ollama"
    if runner != "ollama":
        return fail("pull", f"pull supports the 'ollama' runner only (got '{runner}')")
    m = _catalog_model(model_id)
    tag = opt_value(argv, "--tag") or (m or {}).get("ollama") or model_id
    if not _which("ollama"):
        return emit(
            "pull", _exit=2, ok=False, id=model_id, tag=tag, runner="ollama",
            installable=True,
            error="the ollama runner is not installed",
            install=(
                "macOS: brew install ollama · "
                "Linux: curl -fsSL https://ollama.com/install.sh | sh · "
                "else https://ollama.com/download"
            ),
            hint="install ollama, then retry — it downloads AND serves the model locally",
        )
    # `ollama pull` talks to the daemon; `brew install ollama` doesn't start it, so a
    # CLI-only install fails with "could not connect … exited 1". Start it if needed.
    if not _ensure_ollama_daemon():
        return emit(
            "pull", _exit=2, ok=False, id=model_id, tag=str(tag), runner="ollama",
            error="the ollama background service isn't running and couldn't be started",
            hint=(
                "start it once in a terminal — `ollama serve` (or on macOS "
                "`brew services start ollama`) — then retry the install"
            ),
        )
    last = {"pct": 0}

    def on_line(line: str) -> None:
        match = _PCT_RE.search(line)
        if match:
            try:
                last["pct"] = max(last["pct"], min(100, int(match.group(1))))
            except ValueError:
                pass
        _emit_progress(last["pct"], line.strip()[:120])

    try:
        code = _run_stream(["ollama", "pull", str(tag)], on_line)
    except OSError as exc:
        return fail("pull", f"could not run ollama pull: {exc}", runner="ollama")
    if code != 0:
        return emit(
            "pull", _exit=2, ok=False, id=model_id, tag=str(tag), runner="ollama",
            error=f"ollama pull exited {code}",
        )
    return emit(
        "pull", ok=True, installed=True, id=model_id, tag=str(tag), runner="ollama",
        endpoint="http://localhost:11434/v1",
        note="pulled via ollama — served at the ollama OpenAI-compatible endpoint",
    )


# --- auto-install the local runner ON THE USER'S BEHALF (OS-aware) ----------- #

# The one official, pinned Linux installer. Hardcoded here so the renderer can NEVER
# inject a command — it only asks for runner="ollama"; the OS→command map lives here.
_OLLAMA_LINUX_INSTALL = "curl -fsSL https://ollama.com/install.sh | sh"
_OLLAMA_DOWNLOAD_URL = "https://ollama.com/download"


def _detect_os_family() -> str:
    """macos | linux | windows | <raw> — the family the install command is chosen for.
    ``MODELHUB_FORCE_OS`` overrides for hermetic tests."""
    forced = os.environ.get("MODELHUB_FORCE_OS")
    if forced:
        return forced
    sysname = platform.system()
    return {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}.get(sysname, sysname.lower())


def _find_brew() -> Optional[str]:
    """Homebrew, tolerant of a Finder-launched app whose PATH omits /opt/homebrew/bin.
    ``MODELHUB_FORCE_NO_BREW`` forces it absent for hermetic tests."""
    if os.environ.get("MODELHUB_FORCE_NO_BREW"):
        return None
    found = shutil.which("brew")
    if found:
        return found
    for cand in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew"):
        if os.path.exists(cand):
            return cand
    return None


def _run_install(cmd: List[str]) -> int:
    """Run an install command streaming each line as progress. The
    MODELHUB_FAKE_INSTALL_LINES / _CODE seam replaces the real subprocess in tests."""
    fake = os.environ.get("MODELHUB_FAKE_INSTALL_LINES")
    if fake is not None:
        for line in fake.split("\n"):
            _emit_install_progress(line)
        return int(os.environ.get("MODELHUB_FAKE_INSTALL_CODE", "0"))
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    if proc.stdout is not None:
        for line in proc.stdout:
            _emit_install_progress(line.rstrip("\n"))
    return proc.wait()


def _emit_install_progress(status: str) -> None:
    """A progress JSON-line on STDERR (stdout stays the ONE final envelope)."""
    sys.stderr.write(
        json.dumps({"event": "progress", "verb": "install-runner", "status": status[:160]}) + "\n"
    )
    sys.stderr.flush()


def v_install_runner(argv: List[str]) -> int:
    """Install the local model RUNNER (ollama) ON THE USER'S BEHALF, discriminating
    macOS vs Linux: macOS uses ``brew install ollama`` (no sudo); Linux runs the
    official ``curl … install.sh | sh``. Replaces the copy-paste hint — Prometheus
    runs the command itself and streams the output. Where we can't safely automate
    (no Homebrew on macOS, or Windows), it returns ``manual:true`` + the download URL.
    """
    runner = opt_value(argv, "--runner") or "ollama"
    if runner != "ollama":
        return fail("install-runner", f"only the 'ollama' runner is supported (got '{runner}')")
    family = _detect_os_family()

    # Already installed? Nothing to do — a clean, idempotent success.
    if _which("ollama"):
        return emit(
            "install-runner", ok=True, installed=True, runner="ollama", os=family,
            note="ollama is already installed",
        )

    if family == "macos":
        brew = _find_brew()
        if not brew:
            return emit(
                "install-runner", _exit=2, ok=False, runner="ollama", os=family, manual=True,
                url=_OLLAMA_DOWNLOAD_URL,
                install=f"Homebrew not found — download the macOS app from {_OLLAMA_DOWNLOAD_URL}",
                error="cannot auto-install on macOS without Homebrew",
            )
        cmd = [brew, "install", "ollama"]
    elif family == "linux":
        # Pinned official installer; no renderer input reaches this command.
        cmd = ["/bin/sh", "-c", _OLLAMA_LINUX_INSTALL]
    else:
        return emit(
            "install-runner", _exit=2, ok=False, runner="ollama", os=family, manual=True,
            url=_OLLAMA_DOWNLOAD_URL,
            install=f"Automatic install isn't supported on {family} — download from {_OLLAMA_DOWNLOAD_URL}",
            error=f"no automatic ollama install for {family}",
        )

    printable = " ".join(cmd) if cmd[0] != "/bin/sh" else _OLLAMA_LINUX_INSTALL
    log(f"install-runner: running `{printable}`")
    try:
        code = _run_install(cmd)
    except OSError as exc:
        return fail("install-runner", f"could not run the installer: {exc}", runner="ollama", os=family)

    # MODELHUB_FAKE_INSTALL_OK simulates the runner appearing on PATH post-install
    # (a real install can't be flipped mid-process by a static test seam).
    installed = _which("ollama") is not None or bool(os.environ.get("MODELHUB_FAKE_INSTALL_OK"))
    if code != 0 or not installed:
        return emit(
            "install-runner", _exit=2, ok=False, runner="ollama", os=family, cmdline=printable,
            installed=installed,
            error=(
                f"installer exited {code}" if code != 0
                else "installer finished but ollama is still not on PATH"
            ),
            install=(
                _OLLAMA_LINUX_INSTALL if family == "linux"
                else f"try manually — {_OLLAMA_DOWNLOAD_URL}"
            ),
            url=_OLLAMA_DOWNLOAD_URL,
        )
    return emit(
        "install-runner", ok=True, installed=True, runner="ollama", os=family, cmdline=printable,
        note="ollama installed — retry the model pull to download + serve the weights",
    )


# --- serve (ServeProfile + runner argv, §8; pure, no spawn) ------------------ #

def v_serve(argv: List[str]) -> int:
    model_id = opt_value(argv, "--id")
    quant = opt_value(argv, "--quant") or "q4_k_m"
    runner = opt_value(argv, "--runner") or "llamacpp"
    gguf_path = opt_value(argv, "--gguf")
    port_opt = opt_value(argv, "--port")
    ctx_opt = opt_value(argv, "--ctx")
    autostart = "--autostart" in argv
    if not model_id:
        return fail("serve", "need --id <model id>")
    if runner not in servemod.RUNNER_PORTS:
        return fail("serve", f"unknown runner '{runner}'",
                    known=sorted(servemod.RUNNER_PORTS))

    m = _catalog_model(model_id)
    params_b = fitmod.parse_params_b((m or {}).get("params_b")) or 0.0
    family = (m or {}).get("family")
    ctx_len = int(ctx_opt or (m or {}).get("context") or 8192)
    arch = fitmod.FAMILY_ARCH.get(str(family or "").lower(), {})
    n_layers = arch.get("n_layers", 32)

    try:
        hw = _resolve_hw_arg(argv)
    except json.JSONDecodeError as exc:
        return fail("serve", f"--hw is not valid JSON: {exc}")

    fit_one = fitmod.score_quant(
        quant, params_b=params_b, usable_gb=hw["usable_gb"], ctx_len=ctx_len,
        family=family, caps=hw.get("caps"),
    )
    profile = servemod.build_serve_profile(
        model_id=model_id, quant=quant, runner=runner, fit=fit_one,
        gguf_path=gguf_path, hf_id=(m or {}).get("repo"),
        ctx_len=ctx_len, n_layers=n_layers, gpu_count=hw.get("gpu_count", 1),
        caps=hw.get("caps"), port=int(port_opt) if port_opt else None,
        autostart=autostart,
    )
    return emit("serve", profile=profile, fit=fit_one,
                note="ServeProfile + runner argv computed (fit-derived -ngl / "
                     "tensor-parallel). The runner binary is an engine-owned model "
                     "TOOL and is not spawned in this sandbox; the desktop MAIN "
                     "(C8 ServerSupervisor) spawns + polls /v1/models.")


# --- endpoints / repoint (LIVE localai passthrough, §6) --------------------- #

def v_endpoints(argv: List[str]) -> int:
    res = localai_bridge.endpoints()
    if not res.get("ok"):
        return fail("endpoints", res.get("error", "localai endpoints failed"))
    return emit("endpoints", local=res["local"], open_api=res["open_api"],
                count=res["count"], engine=res.get("engine"))


def v_repoint(argv: List[str]) -> int:
    tool = opt_value(argv, "--tool")
    base_url = opt_value(argv, "--base-url")
    if not tool:
        return fail("repoint", "need --tool <ide|toolId>")
    if not base_url:
        return fail("repoint", "need --base-url <served endpoint base url>")
    res = localai_bridge.repoint_diff(tool, base_url)
    if not res.get("ok"):
        return fail("repoint", res.get("error", "localai show failed"), tool=tool)
    return emit("repoint", **{k: v for k, v in res.items() if k != "ok"})


# --- remove / unserve (library + serve-profile state, §3) ------------------- #

def _serve_profiles_path() -> Path:
    return _default_models_dir() / "serve-profiles.json"


def _load_serve_profiles() -> tuple[Any, List[Dict[str, Any]]]:
    """Return (raw, profiles[]); profiles is the list view (raw may be list or {profiles}).”"""
    p = _serve_profiles_path()
    if not p.is_file():
        return None, []
    try:
        data = json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return None, []
    profiles = data if isinstance(data, list) else (data.get("profiles", []) if isinstance(data, dict) else [])
    return data, [pr for pr in profiles if isinstance(pr, dict)]


def v_remove(argv: List[str]) -> int:
    """Delete a model's files from the live library. Refuses if a ServeProfile
    references the model (unless --force). Returns {ok, freed_bytes}."""
    model_id = opt_value(argv, "--id")
    if not model_id:
        return fail("remove", "need --id <model id>")
    quant = opt_value(argv, "--quant")
    force = "--force" in argv

    _, profiles = _load_serve_profiles()
    refs = [pr.get("id") for pr in profiles if pr.get("model_id") == model_id]
    if refs and not force:
        return emit("remove", ok=False, _exit=2, refused=True, model_id=model_id,
                    referenced_by=refs,
                    message="a serve profile references this model; pass --force to remove anyway")

    root = _default_models_dir()
    slug = model_id.replace("/", "__").lower()
    needle = model_id.lower()
    freed = 0
    removed: List[str] = []
    matched_any = False  # did ANY file match the id (before the quant filter)?
    if root.is_dir():
        for p in sorted(root.rglob("*"), reverse=True):
            if not (p.is_file() and p.suffix.lower() in _MODEL_EXTS):
                continue
            rel = str(p.relative_to(root)).lower()
            if slug not in rel and needle not in rel:
                continue
            matched_any = True
            if quant and quant.lower() not in p.name.lower():
                continue
            try:
                freed += p.stat().st_size
                p.unlink()
                removed.append(str(p))
            except OSError as exc:
                log(f"remove: could not unlink {p}: {exc}")
    # Unknown id (nothing in the library matched) is an honest exit-2 error, NOT a
    # silent ok:true/0 — a `remove --id typo` must not look like a successful no-op.
    if not matched_any:
        return emit("remove", ok=False, _exit=2, not_found=True, model_id=model_id,
                    quant=quant, removed_count=0, freed_bytes=0,
                    error=f"model '{model_id}' not found in the library")
    return emit("remove", ok=True, model_id=model_id, quant=quant,
                removed=removed, removed_count=len(removed),
                freed_bytes=freed, freed_gb=round(freed / 1024**3, 3))


def v_unserve(argv: List[str]) -> int:
    """Mark a ServeProfile stopped in serve-profiles.json (idempotent). The actual
    SIGTERM of the live runner pid is the desktop MAIN-process C8 ServerSupervisor's job."""
    profile_id = opt_value(argv, "--profile")
    if not profile_id:
        return fail("unserve", "need --profile <id>")
    raw, profiles = _load_serve_profiles()
    if raw is None:
        return emit("unserve", ok=True, stopped=True, profile=profile_id, found=False,
                    note="no serve-profiles.json tracked (idempotent stop)")
    found = False
    for pr in profiles:
        if pr.get("id") == profile_id:
            pr["status"] = "stopped"
            pr.pop("pid", None)
            found = True
    if found:
        try:
            _serve_profiles_path().write_text(json.dumps(raw, indent=2))
        except OSError as exc:
            return fail("unserve", f"could not persist serve-profiles.json: {exc}")
    return emit("unserve", ok=True, stopped=True, profile=profile_id, found=found,
                note="status set to stopped; the desktop C8 supervisor SIGTERMs the live pid")


_SHA_RE = re.compile(r"sha256[:-]([0-9a-f]{6,})")


def _referenced_blob_names(root: Path) -> set:
    """Blob filenames (``sha256-<hex>``) referenced by ANY manifest or serve profile.

    Ollama stores payload blobs as ``blobs/sha256-<hex>`` referenced by JSON manifests
    under ``manifests/``. A blob shared by two models is referenced if ANY manifest
    points at it (reference-counting) — prune must never delete a still-referenced blob.
    """
    referenced: set = set()

    def _collect(text: str) -> None:
        for hexd in _SHA_RE.findall(text):
            referenced.add(f"sha256-{hexd}")

    manifests_dir = root / "manifests"
    if manifests_dir.is_dir():
        for mf in manifests_dir.rglob("*"):
            if mf.is_file():
                try:
                    _collect(mf.read_text())
                except OSError:
                    continue
    # a serve profile can pin a blob by path/digest in its argv — count those too.
    sp = _serve_profiles_path()
    if sp.is_file():
        try:
            _collect(sp.read_text())
        except OSError:
            pass
    return referenced


def v_prune(argv: List[str]) -> int:
    """Remove DANGLING payload blobs — files under ``blobs/`` not referenced by any
    manifest or serve profile. ``--dry-run`` lists candidates and deletes nothing.
    Scans ONLY the blobs/payload dir, never manifests/config, so it can never classify
    a manifest as dangling. Mirrors ``v_remove``'s ``{freed_bytes, freed_gb}`` shape.
    """
    dry = "--dry-run" in argv
    root = _default_models_dir()
    blobs_dir = root / "blobs"
    referenced = _referenced_blob_names(root)

    candidates: List[str] = []
    freed = 0
    if blobs_dir.is_dir():
        for b in sorted(blobs_dir.iterdir()):
            if not b.is_file() or b.name in referenced:
                continue
            try:
                size = b.stat().st_size  # logical size BEFORE unlink (no post-unlink race)
            except OSError:
                continue
            candidates.append(str(b))
            freed += size
            if not dry:
                try:
                    b.unlink()
                except OSError as exc:
                    log(f"prune: could not unlink {b}: {exc}")
    return emit("prune", ok=True, dry_run=dry,
                removed=[] if dry else candidates, candidates=candidates,
                removed_count=len(candidates),
                freed_bytes=freed, freed_gb=round(freed / 1024**3, 3))


HANDLERS = {
    # canonical (existing) verbs
    "hw.scan": v_hw_scan,
    "model.list": v_model_list,
    "fit.score": v_fit_score,
    "model.search": v_model_search,
    "fit": v_fit,
    "download": v_download,
    "pull": v_pull,
    "install-runner": v_install_runner,
    "serve": v_serve,
    "unserve": v_unserve,
    "remove": v_remove,
    "prune": v_prune,
    "endpoints": v_endpoints,
    "repoint": v_repoint,
    # file-05 §3 verb-name aliases (the spec names; map to the implementations above)
    "hardware": v_hw_scan,
    "search": v_model_search,
    "info": v_model_search,
    "library": v_model_list,
}


def main(argv: List[str]) -> int:
    return dispatch(PROG, HANDLERS, argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
