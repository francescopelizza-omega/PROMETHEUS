#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""modelhub.py — Studio model-hub sidecar (C7).

Hardware capability + local model inventory + fit scoring + catalog search for the
"run a local open model" flow. Each verb emits EXACTLY ONE JSON object on stdout via
``_envelope.emit``/``fail``; human logs go to stderr.

GATING (C4/C5): downloading a model is a network fetch and is gated upstream by the
engine-bridge nemesis runner. This sidecar never fetches and never decides "safe" — it
only inspects local hardware/files and reads the bundled catalog.

Verbs:
    hw.scan           REAL: total RAM, CPU cores, GPU + VRAM (nvidia-smi / macOS / sysctl)
    model.list        REAL: enumerate a local models dir (gguf/safetensors/bin)
    fit.score         REAL: model size + quant + hw.scan → fits|tight|no + recommended quant
    model.search      reads config/open-models.json (bundled Tier-A open catalog)
    fit               Cookbook fit-scoring (§4): ranked quants + recommended + reasons
    download          stage → REAL nemesis gate → admit|quarantine (§5; the security spine)
    serve             build a ServeProfile + fit-derived runner argv (§8; pure, no spawn)
    endpoints         LIVE passthrough of `prometheus.py localai endpoints` (§6)
    repoint           LIVE `localai show <tool>` → non-secret env diff (§6)
    disk.check        REAL: would installing N bytes drop free space below a floor% (/hug)
    install-hf-cli    fetch HF's OWN `hf` downloader (pip install huggingface_hub[cli]) (/hug)
    fetch-hf          REAL: raw HF repo → local dir, via `hf download` (never hand-rolled HTTP) (/hug)
    install-converter fetch llama.cpp's OWN convert_hf_to_gguf.py (git clone, once) (/hug)
    convert           REAL: HF dir → GGUF (+ quantize), always via llama.cpp's own tools (/hug)
    install-target    wire a GGUF into ollama / llama.cpp / vllm / lmstudio — no duplicate bytes (/hug)

Python 3 stdlib only. Target 3.9+ (dev host 3.14).
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
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
    """The DOWNLOAD CACHE root -- where `model.pull` puts bytes it fetched itself.

    NOT the same thing as ``nemesis_gate.models_root()``, however alike the two env names look.
    Keep them apart:

        PROMETHEUS_MODELS_DIR   ~/.cache/prometheus/models   download cache, this function
        PROMETHEUS_MODELS_HOME  ~/.prometheus/models         the nemesis-GATED library + .stage/

    One is a cache: deleting it costs a re-download. The other holds the staging/quarantine tree
    the security gate moves weights through, and deleting it loses the gate's record of what was
    admitted. They were flagged as a naming duplicate to collapse; they are two concepts whose
    names collided, and merging them would put unscanned downloads inside the gated library.
    That is the same shape as the `home` field collision in `updates-live/resolve.ts` -- two
    different directories behind one plausible name, invisible to the type checker.

    Neither is where the user's EXISTING models live. Those stay in their own tool's store
    (ollama, LM Studio, the HF cache) and are INDEXED, never moved -- see `v_model_list`.
    """
    env = os.environ.get("PROMETHEUS_MODELS_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".cache" / "prometheus" / "models"


def _ollama_installed_models() -> List[Dict[str, Any]]:
    """Index models already pulled into the Ollama store (spec 05 §9: the Hub does NOT own
    Ollama's bytes — it INDEXES Ollama's own library via its HTTP API). Never raises — a
    daemon that genuinely can't be reached (not installed, or failed to start) just means
    no ollama rows.

    This calls `_ensure_ollama_daemon()` (not a bare reachability check) because the two
    outcomes look identical to a user but are not: "ollama was never installed" is a real
    empty state, but "ollama is installed, models are pulled, the daemon just isn't running
    right now" used to ALSO report zero installed models — the daemon being down erased
    already-downloaded weights from the library, and the GUI/CLI both then offered to
    "install" a model the user had already spent the bandwidth pulling once. Ensuring the
    daemon (a no-op, no spawn, if `ollama` isn't on PATH at all — see its own docstring)
    is what actually distinguishes those two cases correctly.
    """
    if not _ensure_ollama_daemon():
        return []
    import json as _json

    # Test seam (mirrors MODELHUB_FAKE_PULL_LINES): a hermetic run fakes the daemon as
    # already up (MODELHUB_FAKE_OLLAMA / _FORCE_DAEMON_UP short-circuit _ensure_ollama_daemon
    # above) but there is still no REAL server on :11434 to answer /api/tags — this lets a
    # test supply that response body directly instead of needing a live ollama binary.
    fake_tags = os.environ.get("MODELHUB_FAKE_OLLAMA_TAGS")
    if fake_tags is not None:
        try:
            data = _json.loads(fake_tags)
        except _json.JSONDecodeError:
            return []
    else:
        import urllib.request

        try:
            with urllib.request.urlopen(  # noqa: S310 — localhost daemon only
                f"{_ollama_root()}/api/tags", timeout=2.0
            ) as resp:
                data = _json.loads(resp.read().decode("utf-8"))
        except Exception:  # noqa: BLE001 — any failure ⇒ no ollama rows
            return []
    out: List[Dict[str, Any]] = []
    for m in data.get("models", []) or []:
        name = m.get("name") or m.get("model") or ""
        if not name:
            continue
        det = m.get("details") or {}
        size = int(m.get("size") or 0)
        out.append({
            "name": name,
            "id": f"ollama:{name}",
            "source": "ollama",
            "modality": "text",
            "path": "",  # Ollama owns the bytes; nothing in our library tree
            "format": det.get("format") or "gguf",
            "size_bytes": size,
            "size_gb": round(size / 1024**3, 2) if size else 0,
            "quant": det.get("quantization_level"),
            "params": det.get("parameter_size"),
            "family": det.get("family"),
            "installed": True,
            "served": True,
            "endpoint": "http://localhost:11434/v1",
        })
    return out


def _lmstudio_models_root() -> Optional[Path]:
    """LM Studio's model directory, resolved the way LM Studio itself resolves it.

    Not guessed. The home is named by `~/.lmstudio-home-pointer`, a plain file in $HOME holding
    the path — LM Studio writes it so a user can move the home off the boot disk, which is
    exactly what someone with 24 GB of weights tends to do. Falling straight to `~/.lmstudio`
    would miss every relocated install.
    """
    pointer = Path.home() / ".lmstudio-home-pointer"
    try:
        if pointer.is_file():
            target = pointer.read_text(encoding="utf-8").strip()
            if target:
                root = Path(target).expanduser() / "models"
                if root.is_dir():
                    return root
    except OSError:
        pass
    default = Path.home() / ".lmstudio" / "models"
    return default if default.is_dir() else None


def _hf_cache_root() -> Optional[Path]:
    """The HuggingFace hub cache — shared by llama.cpp, vLLM, MLX and transformers.

    Precedence is HuggingFace's own: HF_HUB_CACHE, then HF_HOME/hub, then the documented
    default. Measured on the machine this was written for, this was the LARGEST store present
    (90 GB) and nothing in Prometheus looked at it.
    """
    for var, suffix in (("HF_HUB_CACHE", ""), ("HF_HOME", "hub")):
        raw = os.environ.get(var, "").strip()
        if raw:
            root = Path(raw).expanduser()
            if suffix:
                root = root / suffix
            if root.is_dir():
                return root
    default = Path.home() / ".cache" / "huggingface" / "hub"
    return default if default.is_dir() else None


def _scan_dir_models(root: Path, source: str, *, snapshots_only: bool = False) -> List[Dict[str, Any]]:
    """Index model files under `root`, in the row shape `model.list` already emits.

    `snapshots_only` is for the HuggingFace cache, whose layout is
    `models--<org>--<name>/snapshots/<rev>/<file>` where each file is a SYMLINK into a sibling
    `blobs/<sha>`. Walking the whole tree would therefore count every tensor twice — once under
    its real name and once as a hash — so only the snapshot views are read. `stat()` follows the
    link, so the size is the real one.
    """
    out: List[Dict[str, Any]] = []
    try:
        if snapshots_only:
            candidates = root.glob("models--*/snapshots/*/*")
        else:
            candidates = root.rglob("*")
        for p in sorted(candidates):
            try:
                if not p.is_file() or p.suffix.lower() not in _MODEL_EXTS:
                    continue
                size = p.stat().st_size
            except OSError:
                continue  # a broken symlink or an unreadable file is not a finding
            # For the HF cache the repo id is the directory two levels above the snapshot.
            repo = ""
            if snapshots_only:
                try:
                    repo = p.parents[2].name.replace("models--", "", 1).replace("--", "/")
                except IndexError:
                    repo = ""
            out.append({
                "name": p.name,
                "id": f"{source}:{repo or p.name}",
                "source": source,
                "modality": "text",
                "path": str(p),
                "format": p.suffix.lstrip("."),
                "size_bytes": size,
                "size_gb": round(size / 1024**3, 2),
                "quant": _guess_quant(p.name),
                "installed": True,
                "served": False,
                **({"repo": repo} if repo else {}),
            })
    except OSError:
        return out
    return out


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
    # ── index the stores the USER already has, not just the one Prometheus owns ──────────────
    #
    # spec 05 §9: the Hub does not own anyone else's bytes, it INDEXES them. That was honoured
    # for Ollama and for nothing else, so the library showed a fraction of what was installed.
    #
    # Measured 2026-10-01 on the machine this was written for:
    #
    #     ~/.ollama/models                  29 GB   indexed
    #     ~/.lmstudio/models                24 GB   NOT indexed
    #     ~/.cache/huggingface/hub          90 GB   NOT indexed  (the largest store present)
    #     <_default_models_dir()>            0 B    scanned, and empty
    #
    # So 114 GB of models a user had already downloaded were invisible, and the Hub would offer
    # to "install" something already sitting on the disk. Each store is resolved by its OWN
    # rules — LM Studio's home pointer, HuggingFace's HF_HUB_CACHE/HF_HOME — never by assuming
    # a default that happens to be true here.
    models.extend(_ollama_installed_models())
    lms = _lmstudio_models_root()
    if lms:
        models.extend(_scan_dir_models(lms, "lmstudio"))
    hf = _hf_cache_root()
    if hf:
        # "hf-cache", NOT "huggingface". These bytes live in the SHARED hub cache that
        # llama.cpp, vLLM and MLX all read; they are not in Prometheus's library and `remove`
        # (which only walks `_default_models_dir()`) cannot and must not touch them. Labelling
        # them "huggingface" made them indistinguishable from models Prometheus owns, so Remove
        # answered "not found in the library" for a row the user could plainly see.
        models.extend(_scan_dir_models(hf, "hf-cache", snapshots_only=True))
    # `roots` is reported so a caller can show WHERE this came from, and so an empty result is
    # distinguishable from "we only looked in one place".
    roots = {
        "library": str(root),
        **({"lmstudio": str(lms)} if lms else {}),
        **({"hf-cache": str(hf)} if hf else {}),
    }
    return emit("model.list", root=str(root), exists=root.is_dir(), roots=roots,
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


def _known_local_model(model_id: str) -> bool:
    """Is this id something already pulled into Ollama (which the Hub indexes, never owns)?

    `_catalog_model` only sees the BUNDLED catalog, so gating `serve` on it alone would refuse a
    model the user really has. Ollama rows carry both `ollama:<name>` and the bare `<name>`.
    A down daemon yields no rows, which is the fail-closed direction for this check.
    """
    want = model_id[len("ollama:") :] if model_id.startswith("ollama:") else model_id
    for row in _ollama_installed_models():
        if str(row.get("id")) == model_id or str(row.get("name")) == want:
            return True
    return False


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
    """PATH lookup with test seams: MODELHUB_FORCE_NO_<X> forces the binary absent;
    MODELHUB_FAKE_<X> forces it present — so subprocess-shaped verbs are unit-testable
    without any of these tools actually being installed."""
    if binary == "ollama":
        if os.environ.get("MODELHUB_FORCE_NO_OLLAMA"):
            return None
        if os.environ.get("MODELHUB_FAKE_OLLAMA"):
            return "/fake/bin/ollama"
    if binary == "git":
        if os.environ.get("MODELHUB_FORCE_NO_GIT"):
            return None
        if os.environ.get("MODELHUB_FAKE_GIT"):
            return "/fake/bin/git"
    if binary in ("llama-quantize", "llama-server"):
        if os.environ.get("MODELHUB_FORCE_NO_LLAMACPP_BIN"):
            return None
        if os.environ.get("MODELHUB_FAKE_LLAMACPP_BIN"):
            return f"/fake/bin/{binary}"
    if binary == "lms":
        if os.environ.get("MODELHUB_FORCE_NO_LMS"):
            return None
        if os.environ.get("MODELHUB_FAKE_LMS"):
            return "/fake/bin/lms"
    if binary in ("hf", "huggingface-cli"):
        if os.environ.get("MODELHUB_FORCE_NO_HF_CLI"):
            return None
        if os.environ.get("MODELHUB_FAKE_HF_CLI"):
            return f"/fake/bin/{binary}"
    if binary in ("pip", "pip3") and os.environ.get("MODELHUB_FORCE_NO_PIP"):
        return None
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


def _ollama_daemon_marker_path() -> Path:
    """Where we record "prometheus itself spawned this ollama daemon". Lives next to the
    models cache (same `PROMETHEUS_MODELS_DIR`-relative root `_default_models_dir` already
    uses), not in the ollama-owned `~/.ollama` tree — we never write into a store we don't
    own (spec 05 §9)."""
    return _default_models_dir().parent / "ollama-daemon.json"


def _record_ollama_started_by_us(pid: int) -> None:
    """Best-effort: a failure to WRITE the marker must never fail the daemon-start itself —
    worst case, a later `ollama.release` correctly refuses to stop a daemon it can't prove
    it started, which is the fail-SAFE direction (never kill something we didn't spawn)."""
    try:
        marker = _ollama_daemon_marker_path()
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps({"pid": pid, "started_at": time.time()}))
    except OSError:
        pass


def _ensure_ollama_daemon() -> bool:
    """Ensure the ollama daemon is running before an `ollama pull` (or before listing/
    serving already-installed models — spec 05 §9 addendum: a model that's genuinely on
    disk must not read as "not installed" just because the background service happens to be
    stopped right now). Returns True once reachable (already up, or successfully started
    here), else False. Starts ``ollama serve`` DETACHED so the server survives this
    short-lived sidecar, and records the pid (see `_record_ollama_started_by_us`) so a later
    `ollama.release` call can tell "we woke this up" apart from "the user's own instance" —
    the ONLY case it is ever safe to autonomously stop.

    Test seams: ``MODELHUB_FORCE_DAEMON_DOWN`` ⇒ always False (no spawn);
    ``MODELHUB_FORCE_DAEMON_UP`` / ``MODELHUB_FAKE_OLLAMA`` / ``MODELHUB_FAKE_PULL_LINES``
    ⇒ hermetic run, treated as already up (no probe, no spawn, no marker — a faked daemon
    was never really started, so there is nothing real to ever release)."""
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
        proc = subprocess.Popen([ollama, "serve"], **kwargs)  # noqa: S603 — fixed argv, no shell
    except OSError as exc:
        log(f"could not start `ollama serve`: {exc}")
        return False
    # Claim ownership the MOMENT the spawn succeeds — NOT once the readiness poll passes.
    # The child is DETACHED (its own session/process group), so it outlives this short-lived
    # sidecar whether or not it answered /api/version inside the deadline. Recording only on
    # the success branch meant a daemon that bound :11434 at second 21 — or one still starting
    # when the app quit mid-poll — was a daemon Prometheus started but could never PROVE it
    # started, so `ollama.release` refused to stop it ("not started by Prometheus") for the
    # rest of the machine's life and the model stayed resident. `model.list` runs this path
    # unattended on every desktop launch, so it is the common case, not an edge one.
    #
    # Claiming early stays fail-SAFE: `_release_ollama_daemon` signals nothing unless the pid
    # is still alive AND its command name contains "ollama", so a `serve` that died at once
    # (port already bound by the user's own instance, a crash) leaves a marker that is
    # correctly read as stale and discarded rather than acted on.
    _record_ollama_started_by_us(proc.pid)
    deadline = time.monotonic() + _OLLAMA_STARTUP_TIMEOUT_S
    while time.monotonic() < deadline:
        if _ollama_reachable(timeout=0.5):
            _emit_progress(0, "ollama service ready")
            return True
        if proc.poll() is not None:
            # OUR `serve` exited outright (and is reaped by that poll(), so no zombie).
            # Nothing of ours is running, so withdraw the claim rather than leave a marker
            # naming a dead pid the OS may later recycle.
            try:
                _ollama_daemon_marker_path().unlink(missing_ok=True)
            except OSError:
                pass
            return False
        time.sleep(0.4)
    # Readiness deadline missed, but the process is STILL ALIVE and detached — it will very
    # likely come up a moment from now. Report "not ready" (the caller degrades correctly) and
    # KEEP the marker, because we did start it and must remain able to stop it.
    return False


def _process_name(pid: int) -> Optional[str]:
    """The command name for a live pid, or None if it's not running (a zombie counts as not
    running), or can't be inspected.
    Stdlib-only (no psutil dep): shells out to `ps`, which is present on every macOS/Linux
    host this sidecar targets (Windows falls back to `tasklist`)."""
    try:
        if os.name == "nt":
            out = subprocess.run(  # noqa: S603, S607
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=3,
            ).stdout
            return out.split(",")[0].strip('"') if "," in out else None
        out = subprocess.run(  # noqa: S603, S607
            ["ps", "-p", str(pid), "-o", "state=,comm="],
            capture_output=True, text=True, timeout=3,
        ).stdout.strip()
        if not out:
            return None
        parts = out.split(None, 1)
        state = parts[0]
        comm = parts[1].strip() if len(parts) > 1 else ""
        # A ZOMBIE (state begins "Z") is an ALREADY-DEAD process still occupying a table slot
        # until its parent reaps it. `ps` keeps reporting it under its original command name,
        # so counting it as live made "has it gone yet?" answer "no" forever whenever the
        # caller was also the parent — precisely the shape of a sidecar that spawned the
        # daemon itself. It also meant `_release_ollama_daemon` would SIGTERM a corpse instead
        # of taking its "no longer running under that pid" branch. Dead is gone.
        if state.startswith("Z"):
            return None
        return comm or None
    except Exception:  # noqa: BLE001 — inspection failure ⇒ "can't confirm", treated as absent
        return None


def _release_ollama_daemon() -> Dict[str, Any]:
    """Stop the ollama daemon, but ONLY if `_ensure_ollama_daemon` is the one that started
    it (the marker `_record_ollama_started_by_us` wrote). This is the fail-SAFE direction on
    every branch: no marker, an unreadable/corrupt marker, a pid that's gone, or a pid that
    now belongs to some OTHER process (recycled by the OS after the real ollama exited) all
    return `stopped: false` rather than signal anything — a service the user started by hand
    (or via `brew services`, or a second app that also needs it) must never be killed just
    because Prometheus happens to be shutting down.
    """
    marker = _ollama_daemon_marker_path()
    if not marker.is_file():
        return {"ok": True, "stopped": False, "reason": "not started by Prometheus"}
    try:
        rec = json.loads(marker.read_text())
        pid = int(rec["pid"])
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return {"ok": True, "stopped": False, "reason": "marker unreadable"}
    name = _process_name(pid)
    if not name or "ollama" not in name.lower():
        # The pid is gone, or (rarer) recycled by the OS for an unrelated process — either
        # way this is no longer "our" ollama; drop the stale marker and stop.
        try:
            marker.unlink()
        except OSError:
            pass
        return {"ok": True, "stopped": False, "reason": "no longer running under that pid"}
    try:
        os.kill(pid, getattr(signal, "SIGTERM", 15))
    except ProcessLookupError:
        marker.unlink(missing_ok=True)
        return {"ok": True, "stopped": False, "reason": "already exited"}
    except OSError as exc:
        return {"ok": False, "stopped": False, "error": f"could not signal pid {pid}: {exc}"}
    def _wait_gone(seconds: float) -> bool:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if _process_name(pid) is None:
                return True
            time.sleep(0.2)
        return _process_name(pid) is None

    # SIGTERM grace, then ESCALATE. The old code polled for 5s and then fell through to the
    # same unconditional tail — unlink the marker, report `stopped: true` — whether or not the
    # process had actually gone. `ollama serve` flushing a multi-GB model out of memory is
    # exactly the case that takes longer than that, so a still-resident daemon was reported as
    # stopped AND the marker (the only proof Prometheus may stop it) was destroyed, orphaning
    # it permanently. That is the "success reported for work never done" the sidecar contract
    # exists to forbid.
    if not _wait_gone(5.0):
        try:
            os.kill(pid, getattr(signal, "SIGKILL", 9))
        except ProcessLookupError:
            pass  # raced to exit between the last poll and the kill — a clean stop
        except OSError as exc:
            return {
                "ok": False,
                "stopped": False,
                "pid": pid,
                "error": f"pid {pid} ignored SIGTERM and could not be killed: {exc}",
            }
        if not _wait_gone(3.0):
            # Wedged/uninterruptible even after SIGKILL. KEEP the marker so a later release
            # can try again, and say plainly that it is still running.
            return {
                "ok": False,
                "stopped": False,
                "pid": pid,
                "error": f"pid {pid} is still running after SIGTERM and SIGKILL",
            }
    try:
        marker.unlink()
    except OSError:
        pass
    return {"ok": True, "stopped": True, "pid": pid}


def v_ollama_release(argv: List[str]) -> int:
    """Stop the ollama daemon IF (and only if) Prometheus itself started it this session —
    the autonomous-stop half of the autonomous-start `_ensure_ollama_daemon` already does.
    Called best-effort on app quit; never errors, always emits a valid envelope."""
    del argv  # no arguments — this always targets "whatever we started, if anything"
    result = _release_ollama_daemon()
    return emit("ollama.release", **result)


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

    # RAM guard: a catalogued model has a known size, so refuse a pull that would land in
    # OVERFLOW territory before it downloads a single byte — a full weight download is the
    # expensive, hard-to-undo half of "pull a model too big for this box", and swap-thrashing
    # the machine to find that out is exactly the failure this check exists to prevent.
    # Skipped for unknown/uncatalogued tags (no size to reason about) and for --force.
    params_b = fitmod.parse_params_b((m or {}).get("params_b")) if m else None
    if params_b and "--force" not in argv and "--allow-overflow" not in argv:
        try:
            hw = _resolve_hw_arg(argv)
        except json.JSONDecodeError as exc:
            return fail("pull", f"--hw is not valid JSON: {exc}")
        rec = fitmod.recommend(
            params_b=params_b, usable_gb=hw["usable_gb"], family=(m or {}).get("family"),
            # `caps`, like both sibling call sites (`v_fit` above, `v_serve`'s score_quant
            # below). `recommend()` does `caps = caps or {}` and `score_quant` then reads
            # `accel = caps.get("accel", "cpu")` — so omitting it judged a metal/cuda box as a
            # plain CPU host: the wrong overhead constant AND the cpu-only format allow-list,
            # on hardware `_resolve_hw_arg` had already profiled and was holding right here.
            caps=hw.get("caps"),
            candidate_quants=list((m or {}).get("quants") or []) or None,
            active_params_b=fitmod.parse_params_b((m or {}).get("active_params_b")),
            arch=(m or {}).get("arch") or None,
        )
        # OVERFLOW only — the SAME bar `v_serve`'s guard applies below, deliberately.
        # `rec["recommended"]` is None for anything worse than TIGHT (fit.py's eligibility is
        # FITS|TIGHT, ratio <= 1.0), which swept in the whole PARTIAL band (1.0 < ratio <= 1.6).
        # PARTIAL means "needs layer offload", which the ollama/llama.cpp runner does for you.
        # Gating on it made `pull` STRICTER than `serve`: a model this tool will happily serve
        # could not be downloaded. `recommend()` exposes no "best verdict", so read `ranked`.
        if not any(r.get("runnable") and r.get("verdict") != "OVERFLOW" for r in rec["ranked"]):
            return fail(
                "pull",
                f"{model_id} ({params_b}B) needs far more than this machine's "
                f"~{hw['usable_gb']}GB usable memory in every offered quant (OVERFLOW) — "
                "pulling and running it risks exhausting RAM/swap.",
                id=model_id, tag=str(tag), runner="ollama",
                hint="pick a smaller model (`model fit --id <id>` lists what fits), "
                     "or re-run with --force to override",
                reasons=rec["reasons"],
            )

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
    if m is None and not gguf_path and not _known_local_model(model_id):
        # A model we know NOTHING about has no parameter count, so `params_b` fell back to 0.0
        # and `score_quant` dutifully reported that a zero-byte model FITS: `prometheus model
        # serve zzz-not-a-model` returned `verdict:"FITS", runnable:true, weights_gb:0` and a
        # complete runner argv for a model that does not exist — while `model info` on the very
        # same id correctly refused. Any string was accepted, including path-shaped ones.
        #
        # Refused HERE rather than in a host, because all four hosts call this verb and a check
        # in one of them would leave the others fabricating. The three legitimate ways to serve
        # something outside the bundled catalog all still work: an explicit `--gguf <path>`, a
        # model already pulled into Ollama, and of course any catalogued id.
        return fail(
            "serve",
            f"unknown model id '{model_id}': not in the bundled catalog, not installed in "
            "Ollama, and no --gguf path given",
            hint="model search",
        )
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
    # RAM guard: OVERFLOW means this quant's estimate is >1.6x the usable budget — building
    # (and a host then spawning) an argv for it anyway is how a resident model runs a laptop
    # out of RAM and into swap. Refuse here, the one choke point all four hosts call through
    # (see the module-not-found refusal above), rather than trusting every caller to check
    # `fit.verdict` itself before spawning.
    if fit_one.get("verdict") == "OVERFLOW" and "--force" not in argv and "--allow-overflow" not in argv:
        return fail(
            "serve",
            f"{model_id} ({quant}) needs ~{fit_one.get('est_vram_gb')}GB but only "
            f"~{hw['usable_gb']}GB is usable on this machine (ratio {fit_one.get('ratio')}) — "
            "serving it risks exhausting RAM/swap.",
            id=model_id, quant=quant, fit=fit_one,
            hint="pick a smaller quant (`model fit --id <id>` lists what fits), "
                 "or re-run with --force to override",
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


# --- disk-space guard (/hug) -------------------------------------------------- #
#
# Prometheus never installs a model that would leave the disk dangerously full. The
# CALLER (CLI/desktop) decides what to do with a "low" verdict — delete other models,
# wait for the user to free space manually, or fall back to a different disk — this
# verb only answers the yes/no question honestly. Pure read; never deletes anything.

_DISK_FLOOR_PCT_DEFAULT = 7.0


def _disk_usage(path: Path) -> "tuple[int, int]":
    """(total_bytes, free_bytes) for the filesystem holding ``path``. Walks up to the
    nearest existing ancestor first, since the install destination may not exist yet."""
    p = path
    while not p.exists() and p != p.parent:
        p = p.parent
    usage = shutil.disk_usage(p)
    return int(usage.total), int(usage.free)


def v_disk_check(argv: List[str]) -> int:
    """Would installing ``--need-bytes`` more data at ``--path`` leave less than
    ``--floor-pct`` (default 7%) free? Returns a verdict, never blocks by itself."""
    path_arg = opt_value(argv, "--path") or str(_default_models_dir())
    need_raw = opt_value(argv, "--need-bytes", "0")
    try:
        need_bytes = int(need_raw) if need_raw is not None else 0
    except ValueError:
        return fail("disk.check", f"--need-bytes must be an integer (got '{need_raw}')")
    floor_raw = opt_value(argv, "--floor-pct")
    try:
        floor_pct = float(floor_raw) if floor_raw is not None else _DISK_FLOOR_PCT_DEFAULT
    except ValueError:
        return fail("disk.check", f"--floor-pct must be a number (got '{floor_raw}')")
    try:
        total, free = _disk_usage(Path(path_arg).expanduser())
    except OSError as exc:
        return fail("disk.check", f"could not read disk usage for {path_arg}: {exc}")
    if total <= 0:
        return fail("disk.check", f"disk usage for {path_arg} reported zero total bytes")
    free_after = free - need_bytes
    free_after_pct = round((free_after / total) * 100, 2)
    verdict = "ok" if free_after_pct >= floor_pct else "low"
    return emit(
        "disk.check", ok=True, path=path_arg, verdict=verdict,
        total_bytes=total, free_bytes=free, need_bytes=need_bytes,
        free_after_bytes=free_after, free_after_pct=free_after_pct, floor_pct=floor_pct,
        message=(
            f"{free_after_pct}% free after this install (floor {floor_pct}%) — OK"
            if verdict == "ok" else
            f"only {free_after_pct}% would be free after this install (floor {floor_pct}%) — "
            "free up space, remove another model, or choose a different disk"
        ),
    )


# --- fetch RAW HF weights (§ the actual byte fetch `download`'s plan defers) - #
#
# `download` (above) never fetches bytes itself — by design, it only stages → nemesis-
# gates → admits bytes some upstream caller already fetched. For /hug's "arbitrary HF
# repo → local raw weights, ready to convert" step, THIS is that upstream fetch — via
# Hugging Face's OWN `hf`/`huggingface-cli` downloader, never a hand-rolled HTTP client.

def _hf_cli() -> Optional[str]:
    for name in ("hf", "huggingface-cli"):
        found = _which(name)
        if found:
            return found
    return None


def v_install_hf_cli(argv: List[str]) -> int:
    """`pip install huggingface_hub[cli]` (provides the `hf` CLI) — the one-time
    "detect absence, offer install" step for the HF fetch tool, mirroring
    install-runner/install-converter exactly."""
    if _hf_cli():
        return emit("install-hf-cli", ok=True, installed=True, note="the hf CLI is already available")
    pip = _which("pip3") or _which("pip")
    if not pip:
        return emit(
            "install-hf-cli", _exit=2, ok=False, manual=True,
            error="pip is required to install huggingface_hub",
            install="install Python/pip, then retry — or `pip install huggingface_hub[cli]` yourself",
        )
    _emit_install_progress("installing huggingface_hub (provides the `hf` CLI) …")
    try:
        code = _run_install([pip, "install", "--quiet", "-U", "huggingface_hub[cli]"])
    except OSError as exc:
        return fail("install-hf-cli", f"could not run pip install: {exc}")
    # MODELHUB_FAKE_INSTALL_OK simulates the CLI appearing on PATH post-install — same
    # seam install-runner already uses; a real install can't be flipped by a static
    # test seam mid-process.
    installed = _hf_cli() is not None or bool(os.environ.get("MODELHUB_FAKE_INSTALL_OK"))
    if code != 0 or not installed:
        return emit(
            "install-hf-cli", _exit=2, ok=False,
            error=(
                f"pip install exited {code}" if code != 0
                else "installed but the hf CLI is still not on PATH"
            ),
        )
    return emit("install-hf-cli", ok=True, installed=True, note="huggingface_hub installed")


def v_fetch_hf(argv: List[str]) -> int:
    """The ACTUAL raw-weights fetch for an arbitrary HF repo, via HF's own `hf`/
    `huggingface-cli` downloader — never a hand-rolled HTTP client. Downloads into
    ``--out`` (defaults under the canonical models dir's own `.hf-src` cache)."""
    repo = opt_value(argv, "--repo")
    if not repo:
        return fail("fetch-hf", "need --repo <org/repo>")
    unsafe = _reject_unsafe_id(repo, "--repo", "fetch-hf")
    if unsafe is not None:
        return unsafe
    out_arg = opt_value(argv, "--out")
    slug = repo.replace("/", "__").lower() or "repo"
    out_dir = (
        Path(out_arg).expanduser().resolve()
        if out_arg
        else (_default_models_dir() / ".hf-src" / slug)
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    cli = _hf_cli()
    if not cli:
        return emit(
            "fetch-hf", _exit=2, ok=False, installable=True,
            error="no HF downloader (`hf`/`huggingface-cli`) is on PATH",
            hint="run `model install-hf-cli` once, then retry",
        )
    cmd = [cli, "download", repo, "--local-dir", str(out_dir)]
    revision = opt_value(argv, "--revision")
    if revision:
        cmd += ["--revision", revision]

    def on_line(line: str) -> None:
        _emit_convert_progress("fetch-hf", line.strip()[:140])

    try:
        code = _run_stream_labeled(cmd, on_line)
    except OSError as exc:
        return fail("fetch-hf", f"could not run {cli} download: {exc}")
    if os.environ.get("MODELHUB_FAKE_CONVERT_LINES") is not None and not any(out_dir.iterdir()):
        (out_dir / "config.json").write_text("{}")  # hermetic stub — no real fetch ran
    if code != 0:
        return emit("fetch-hf", _exit=2, ok=False, error=f"{Path(cli).name} download exited {code}")
    return emit(
        "fetch-hf", ok=True, repo=repo, path=str(out_dir),
        note=f"fetched via {Path(cli).name} download — this directory feeds `model convert`'s --src",
    )


# --- shared install helpers (symlink-share, never duplicate bytes) ---------- #

_UNSAFE_ID_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")  # control chars, incl. newline/CR


def _reject_unsafe_id(value: str, flag: str, command: str) -> Optional[int]:
    """``None`` if ``value`` is safe to use as a model/repo id downstream; else the int
    exit code from a ``fail()`` envelope already emitted (the caller must ``return`` it
    immediately). ``value`` ends up (a) written verbatim into a Modelfile, (b) turned
    into filename/path components (including an LM Studio symlink target), and (c)
    passed as a bare positional to `hf download` / `ollama create` — so this rejects,
    in order: control characters (Modelfile-directive / filename injection via an
    embedded newline), a leading ``-`` (argv-flag confusion in the downstream tool),
    and any ``..`` path segment (path-traversal escape once the id becomes a path).
    """
    if not value:
        return None
    if _UNSAFE_ID_CHARS_RE.search(value):
        return fail(command, f"{flag} contains control characters — refusing")
    if value.startswith("-"):
        return fail(command, f"{flag} looks like a flag ('{value}') — refusing")
    if any(part == ".." for part in value.split("/")):
        return fail(command, f"{flag} contains a '..' path segment — refusing")
    return None


def _lmstudio_models_dir() -> Path:
    override = os.environ.get("LMSTUDIO_MODELS_DIR") or os.environ.get("MODELHUB_FORCE_LMSTUDIO_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".lmstudio" / "models"


def _publisher_model_split(model_id: str) -> "tuple[str, str]":
    """Always a SAFE, flat (publisher, name) pair — never more than two path segments,
    regardless of how many '/'-separated parts ``model_id`` actually has (a caller-
    supplied ``--id`` isn't guaranteed to be exactly "org/repo" shaped)."""
    parts = [p for p in model_id.split("/") if p]  # drop empty segments (leading/trailing/doubled '/')
    if not parts:
        return "local", model_id or "model"
    if len(parts) == 1:
        return "local", parts[0]
    return parts[0], "__".join(parts[1:])


def _ensure_symlink(link_path: Path, target_path: Path) -> None:
    """Point ``link_path`` at ``target_path``, replacing whatever is already there.
    Never copies — the whole point is ONE physical file, many runtimes seeing it."""
    link_path.parent.mkdir(parents=True, exist_ok=True)
    if link_path.is_symlink() or link_path.exists():
        try:
            link_path.unlink()
        except OSError:
            pass
    os.symlink(target_path, link_path)


# --- conversion tooling: llama.cpp's OWN scripts, never reimplemented ------- #

_LLAMACPP_REPO = "https://github.com/ggml-org/llama.cpp"


def _tools_dir() -> Path:
    return _default_models_dir().parent / "tools"


def _llamacpp_dir() -> Path:
    override = os.environ.get("LLAMACPP_DIR") or os.environ.get("MODELHUB_FORCE_LLAMACPP_DIR")
    if override:
        return Path(override).expanduser()
    return _tools_dir() / "llama.cpp"


def _convert_script() -> Optional[Path]:
    d = _llamacpp_dir()
    for name in ("convert_hf_to_gguf.py", "convert-hf-to-gguf.py"):
        p = d / name
        if p.is_file():
            return p
    return None


def v_install_converter(argv: List[str]) -> int:
    """Fetch llama.cpp's OWN convert_hf_to_gguf.py (+ its light python deps) via a
    shallow git clone of the upstream repo — the same "detect absence, offer install,
    verify" shape install-runner already uses for ollama. Never a Prometheus-authored
    converter."""
    if _convert_script() is not None:
        return emit(
            "install-converter", ok=True, installed=True,
            path=str(_convert_script()), note="llama.cpp's converter is already available",
        )
    git = _which("git")
    if not git:
        return emit(
            "install-converter", _exit=2, ok=False, manual=True,
            error="git is required to fetch llama.cpp's conversion tooling",
            install=f"install git, then retry — or clone {_LLAMACPP_REPO} yourself and set $LLAMACPP_DIR",
        )
    dest = _llamacpp_dir()
    dest.parent.mkdir(parents=True, exist_ok=True)
    _emit_install_progress(f"cloning {_LLAMACPP_REPO} …")
    try:
        code = _run_install(["git", "clone", "--depth", "1", _LLAMACPP_REPO, str(dest)])
    except OSError as exc:
        return fail("install-converter", f"could not run git clone: {exc}")
    # The fake-install-lines test seam doesn't actually create files — plant a stub
    # script so a hermetic test can exercise the "now available" branch afterward.
    if os.environ.get("MODELHUB_FAKE_INSTALL_LINES") is not None and _convert_script() is None:
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "convert_hf_to_gguf.py").write_text("# fake test stub\n")
    if code != 0 or _convert_script() is None:
        return emit(
            "install-converter", _exit=2, ok=False,
            error=(
                f"git clone exited {code}" if code != 0
                else "clone finished but the converter script is missing"
            ),
        )
    pip = _which("pip3") or _which("pip")
    if pip:
        _emit_install_progress("installing the converter's python dependencies …")
        req = dest / "requirements" / "requirements-convert_hf_to_gguf.txt"
        try:
            _run_install([pip, "install", "--quiet", "-r", str(req)])
        except OSError:
            pass  # best-effort — v_convert fails informatively if a dep is truly missing
    return emit(
        "install-converter", ok=True, installed=True, path=str(_convert_script()),
        note="llama.cpp's converter is ready",
    )


def _run_stream_labeled(cmd: List[str], on_line) -> int:
    """Like _run_stream but for convert/quantize/ollama-create, which need their own
    fake-subprocess test seam distinct from pull's (MODELHUB_FAKE_PULL_LINES)."""
    fake = os.environ.get("MODELHUB_FAKE_CONVERT_LINES")
    if fake is not None:
        for line in fake.split("\n"):
            on_line(line)
        return int(os.environ.get("MODELHUB_FAKE_CONVERT_CODE", "0"))
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    if proc.stdout is not None:
        for line in proc.stdout:
            on_line(line.rstrip("\n"))
    return proc.wait()


def _emit_convert_progress(phase: str, status: str) -> None:
    sys.stderr.write(
        json.dumps({"event": "progress", "verb": "convert", "phase": phase, "status": status[:160]}) + "\n"
    )
    sys.stderr.flush()


# quant strings that mean "leave it at full precision" — never fed to llama-quantize.
_QUANT_NO_REQUANT = {"f32", "fp32", "f16", "fp16", "bf16", "auto"}

# convert_hf_to_gguf.py's --outtype only accepts f32|f16|bf16|auto (plus q8_0, out of
# scope here) — map our accepted aliases onto the value the script actually expects.
_OUTTYPE_ALIASES = {"fp16": "f16", "fp32": "f32"}


def v_convert(argv: List[str]) -> int:
    """HF directory → GGUF (+ quantize), ALWAYS by shelling out to llama.cpp's own
    tools — convert_hf_to_gguf.py for the conversion step, llama-quantize for the
    quantization step. This sidecar never re-implements either one; it only
    orchestrates them.

    ``--out`` may point at a different disk than the default open_models dir (the
    /hug disk-guard's "fall back to another disk" path) — when it does, a symlink is
    left at the CANONICAL open_models location too, so every part of Prometheus that
    looks there (model.list, remove, prune) still finds the file with no duplicate
    download.
    """
    src = opt_value(argv, "--src")
    if not src:
        return fail("convert", "need --src <local HF-format model directory>")
    src_dir = Path(src).expanduser()
    if not src_dir.is_dir():
        return fail("convert", f"--src is not a directory: {src_dir}")

    quant = (opt_value(argv, "--quant") or "q4_k_m").lower()
    out_arg = opt_value(argv, "--out")
    # .resolve() (not just .expanduser()) so a RELATIVE --out is made absolute here —
    # otherwise the canonical-store symlink built below from this path would embed a
    # relative target, which the OS resolves against the SYMLINK's own parent dir (the
    # canonical models dir), not this process's cwd, producing a dangling symlink.
    out_dir = Path(out_arg).expanduser().resolve() if out_arg else _default_models_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    model_id = opt_value(argv, "--id") or src_dir.name
    unsafe = _reject_unsafe_id(model_id, "--id", "convert")
    if unsafe is not None:
        return unsafe
    slug = model_id.replace("/", "__").lower()

    script = _convert_script()
    if script is None:
        return emit(
            "convert", _exit=2, ok=False, installable=True,
            error="llama.cpp's convert_hf_to_gguf.py is not available",
            hint="run `model install-converter` once, then retry",
        )

    # Disk guard — BUILT IN, not optional per-caller plumbing: a conversion writes a
    # full-precision GGUF (roughly the size of the source weights) before any
    # quantization shrinks it, so this is exactly the moment disk pressure bites.
    # Fails OPEN on a probe error (never blocks a legitimate conversion over a stat
    # hiccup), same discipline as the CPU/RAM launch guard elsewhere in this codebase.
    if "--skip-disk-check" not in argv:
        need_bytes = 0
        for f in src_dir.rglob("*"):
            if f.is_file():
                try:
                    need_bytes += f.stat().st_size
                except OSError:
                    pass
        floor_raw = opt_value(argv, "--floor-pct")
        try:
            floor_pct = float(floor_raw) if floor_raw is not None else _DISK_FLOOR_PCT_DEFAULT
        except ValueError:
            floor_pct = _DISK_FLOOR_PCT_DEFAULT
        try:
            total, free = _disk_usage(out_dir)
            if total > 0:
                free_after_pct = round(((free - need_bytes) / total) * 100, 2)
                if free_after_pct < floor_pct:
                    return emit(
                        "convert", _exit=2, ok=False, low_disk=True,
                        path=str(out_dir), need_bytes=need_bytes,
                        free_after_pct=free_after_pct, floor_pct=floor_pct,
                        error=(
                            f"converting here would leave only {free_after_pct}% free "
                            f"(floor {floor_pct}%)"
                        ),
                        hint=(
                            "free up space, remove another model (`model remove`), or "
                            "retry with --out <a different disk>"
                        ),
                    )
        except OSError:
            pass

    # The INTERMEDIATE conversion's outtype: when no further quantization will run
    # (quant is already a no-requant value), this IS the final output, so it must
    # actually match what was requested — bf16/f32/fp32/auto, not silently always
    # "f16". When a real quantization WILL follow, f16 is the standard, correct
    # source precision for llama-quantize to work from regardless of the target
    # quant, so it stays hardcoded in that case.
    base_outtype = _OUTTYPE_ALIASES.get(quant, quant) if quant in _QUANT_NO_REQUANT else "f16"
    f16_path = out_dir / f"{slug}-{base_outtype}.gguf"
    _emit_convert_progress("convert", f"converting {src_dir.name} → GGUF ({base_outtype})…")
    py = sys.executable or "python3"
    cmd = [py, str(script), str(src_dir), "--outfile", str(f16_path), "--outtype", base_outtype]

    def on_line(line: str) -> None:
        _emit_convert_progress("convert", line.strip()[:140])

    try:
        code = _run_stream_labeled(cmd, on_line)
    except OSError as exc:
        return fail("convert", f"could not run convert_hf_to_gguf.py: {exc}")
    if os.environ.get("MODELHUB_FAKE_CONVERT_LINES") is not None and not f16_path.exists():
        f16_path.write_bytes(b"\x00" * 16)  # hermetic stub — no real conversion ran
    if code != 0 or not f16_path.is_file():
        return emit("convert", _exit=2, ok=False, error=f"conversion failed (exit {code})")

    if quant in _QUANT_NO_REQUANT:
        final_path = f16_path
    else:
        quantize_bin = _which("llama-quantize")
        if not quantize_bin:
            return emit(
                "convert", _exit=2, ok=False, installable=True,
                path=str(f16_path), quant="f16",
                error="llama-quantize is not on PATH",
                hint="install llama.cpp's compiled tools (e.g. `brew install llama.cpp`), then retry",
                note="the f16 GGUF was produced and left in place — quantization alone failed",
            )
        final_path = out_dir / f"{slug}-{quant}.gguf"
        _emit_convert_progress("quantize", f"quantizing → {quant.upper()}…")

        def on_qline(line: str) -> None:
            _emit_convert_progress("quantize", line.strip()[:140])

        try:
            qcode = _run_stream_labeled(
                [quantize_bin, str(f16_path), str(final_path), quant.upper()], on_qline,
            )
        except OSError as exc:
            return fail("convert", f"could not run llama-quantize: {exc}")
        if os.environ.get("MODELHUB_FAKE_CONVERT_LINES") is not None and not final_path.exists():
            final_path.write_bytes(b"\x00" * 16)
        if qcode != 0 or not final_path.is_file():
            return emit(
                "convert", _exit=2, ok=False, path=str(f16_path), quant="f16",
                error=f"quantization failed (exit {qcode})",
                note="the f16 GGUF is intact at `path` — quantization alone failed",
            )
        if final_path != f16_path:
            try:
                f16_path.unlink()
            except OSError:
                pass

    canonical_dir = _default_models_dir()
    canonical_path = final_path
    if out_dir.resolve() != canonical_dir.resolve():
        canonical_path = canonical_dir / final_path.name
        try:
            _ensure_symlink(canonical_path, final_path)
        except OSError as exc:
            log(f"convert: could not create the canonical-store symlink: {exc}")
            canonical_path = final_path

    try:
        size = final_path.stat().st_size
    except OSError:
        size = 0
    return emit(
        "convert", ok=True, id=model_id, path=str(final_path), canonical_path=str(canonical_path),
        quant=quant, size_bytes=size, size_gb=round(size / 1024**3, 3),
        note="converted via llama.cpp's own convert_hf_to_gguf.py / llama-quantize",
    )


def v_install_target(argv: List[str]) -> int:
    """Wire an already-converted (or already-GGUF) model into ONE target runtime,
    never duplicating the payload: llama.cpp/vLLM read the canonical file/directory
    directly by path; Ollama ingests it into its own store (that internal copy is
    Ollama's own architecture, outside Prometheus's control); LM Studio gets a
    SYMLINK into its expected folder (or an `lms import` when the `lms` CLI is
    present, which handles its manifest bookkeeping more reliably than a raw copy).
    """
    target = (opt_value(argv, "--target") or "").lower()
    model_id = opt_value(argv, "--id")
    if not model_id:
        return fail("install-target", "need --id <model id>")
    unsafe = _reject_unsafe_id(model_id, "--id", "install-target")
    if unsafe is not None:
        return unsafe
    if target not in ("ollama", "llamacpp", "vllm", "lmstudio"):
        return fail(
            "install-target",
            f"--target must be one of ollama|llamacpp|vllm|lmstudio (got '{target}')",
        )

    if target == "llamacpp":
        gguf = opt_value(argv, "--gguf")
        if not gguf or not Path(gguf).expanduser().is_file():
            return fail("install-target", "need --gguf <path> pointing at an existing GGUF file")
        return emit(
            "install-target", ok=True, target="llamacpp", id=model_id,
            path=str(Path(gguf).expanduser()),
            note="no install step needed — `model serve --runner llamacpp` reads this file directly",
        )

    if target == "vllm":
        src = opt_value(argv, "--src")
        if not src or not Path(src).expanduser().is_dir():
            return fail("install-target", "need --src <HF-format model directory> for the vllm target")
        return emit(
            "install-target", ok=True, target="vllm", id=model_id,
            path=str(Path(src).expanduser()),
            note=(
                "no install step needed — `model serve --runner vllm` reads this directory "
                "directly (vLLM does not need the GGUF conversion)"
            ),
        )

    if target == "lmstudio":
        gguf = opt_value(argv, "--gguf")
        if not gguf or not Path(gguf).expanduser().is_file():
            return fail("install-target", "need --gguf <path> pointing at an existing GGUF file")
        gguf_path = Path(gguf).expanduser().resolve()
        lms = _which("lms")
        if lms:
            _emit_install_progress(f"lms import {gguf_path.name} …")
            try:
                code = _run_install([lms, "import", str(gguf_path)])
            except OSError as exc:
                return fail("install-target", f"could not run lms import: {exc}")
            if code != 0:
                return emit(
                    "install-target", _exit=2, ok=False, target="lmstudio", id=model_id,
                    error=f"lms import exited {code}",
                )
            return emit(
                "install-target", ok=True, target="lmstudio", id=model_id,
                method="lms-import", path=str(gguf_path),
                note="imported via LM Studio's own `lms` CLI — open LM Studio to serve it",
            )
        publisher, name = _publisher_model_split(model_id)
        link_path = _lmstudio_models_dir() / publisher / name / gguf_path.name
        try:
            _ensure_symlink(link_path, gguf_path)
        except OSError as exc:
            return fail("install-target", f"could not create the LM Studio symlink: {exc}")
        return emit(
            "install-target", ok=True, target="lmstudio", id=model_id,
            method="symlink", path=str(link_path), source=str(gguf_path),
            note=(
                "symlinked into LM Studio's model folder (no `lms` CLI found) — "
                "open LM Studio and start the server to serve it"
            ),
        )

    # target == "ollama"
    gguf = opt_value(argv, "--gguf")
    if not gguf or not Path(gguf).expanduser().is_file():
        return fail("install-target", "need --gguf <path> pointing at an existing GGUF file")
    gguf_path = Path(gguf).expanduser().resolve()
    if not _which("ollama"):
        return emit(
            "install-target", _exit=2, ok=False, target="ollama", id=model_id, installable=True,
            error="the ollama runner is not installed",
            hint="run `model install-runner`, then retry",
        )
    if not _ensure_ollama_daemon():
        return emit(
            "install-target", _exit=2, ok=False, target="ollama", id=model_id,
            error="the ollama background service isn't running and couldn't be started",
        )
    quant = opt_value(argv, "--quant")
    with tempfile.TemporaryDirectory(prefix="prometheus-hug-modelfile-") as tmp:
        modelfile = Path(tmp) / "Modelfile"
        modelfile.write_text(f"FROM {gguf_path}\n")
        cmd = ["ollama", "create", model_id]
        if quant and quant.lower() not in _QUANT_NO_REQUANT:
            cmd += ["--quantize", quant.upper()]
        cmd += ["-f", str(modelfile)]

        def on_line(line: str) -> None:
            _emit_convert_progress("ollama-create", line.strip()[:140])

        try:
            code = _run_stream_labeled(cmd, on_line)
        except OSError as exc:
            return fail("install-target", f"could not run ollama create: {exc}", target="ollama")
    if code != 0:
        return emit(
            "install-target", _exit=2, ok=False, target="ollama", id=model_id,
            error=f"ollama create exited {code}",
        )
    return emit(
        "install-target", ok=True, target="ollama", id=model_id,
        endpoint="http://localhost:11434/v1",
        note="created via `ollama create` from the already-downloaded GGUF — no re-download",
    )


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
    "ollama.release": v_ollama_release,
    "remove": v_remove,
    "prune": v_prune,
    "endpoints": v_endpoints,
    "repoint": v_repoint,
    # /hug: download-agnostic disk guard + convert/install-into-a-runtime pipeline
    "disk.check": v_disk_check,
    "install-hf-cli": v_install_hf_cli,
    "fetch-hf": v_fetch_hf,
    "install-converter": v_install_converter,
    "convert": v_convert,
    "install-target": v_install_target,
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
