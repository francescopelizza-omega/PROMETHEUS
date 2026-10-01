#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""fit.py — VRAM-aware quant fit-scoring (the Cookbook math, file 05 §4).

PURE arithmetic, no I/O, fully unit-testable offline. Given a model's params (or a
known on-disk size), a quant label, a context length, and a ``HardwareProfile``-ish
memory budget, this estimates VRAM and returns a per-quant verdict:

    FITS      runs fully on the accelerator with headroom        (green)
    TIGHT     fits but little kv-cache headroom; cap ctx_len      (yellow)
    PARTIAL   overflows one GPU → offload layers / tensor-parallel(orange)
    OVERFLOW  won't fit; recommend a smaller quant / AirLLM       (red)

It also picks a *recommended* quant (maximise quality subject to FITS/TIGHT and the
accel's runnable formats) and always explains *why* (``reasons[]``), exactly the
explain-the-recommendation ethos the doc calls for (§4.4).

This module is deliberately import-only (no ``emit``/argv); ``modelhub.py`` calls into
it and wraps the result in the JSON envelope.
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional

# Bits-per-weight for common quantizations (effective, incl. block scales).
# Kept in sync with modelhub._QUANT_BPW; this is the fit-scorer's source of truth.
QUANT_BPW: Dict[str, float] = {
    "f32": 32.0, "fp32": 32.0,
    "f16": 16.0, "fp16": 16.0, "bf16": 16.0,
    "fp8": 8.0,
    "q8_0": 8.5, "int8": 8.0, "q8": 8.5,
    "q6_k": 6.6, "q6": 6.6,
    "q5_k_m": 5.7, "q5_k_s": 5.5, "q5_0": 5.5, "q5": 5.7,
    "awq-4bit": 4.25, "awq": 4.25, "gptq-4bit": 4.25, "gptq": 4.25,
    "q4_k_m": 4.85, "q4_k_s": 4.6, "q4_0": 4.5, "q4": 4.85, "int4": 4.0,
    "q3_k_m": 3.9, "q3": 3.9,
    "q2_k": 2.6, "q2": 2.6,
}

# Quality rank 0..1 — closeness to F16 (Q4_K_M≈0.82, Q8_0≈0.99). Drives the recommender.
QUANT_QUALITY: Dict[str, float] = {
    "f32": 1.0, "fp32": 1.0, "f16": 1.0, "fp16": 1.0, "bf16": 1.0,
    "q8_0": 0.99, "q8": 0.99, "int8": 0.98, "fp8": 0.97,
    "q6_k": 0.95, "q6": 0.95,
    "q5_k_m": 0.90, "q5_k_s": 0.88, "q5_0": 0.87, "q5": 0.90,
    "q4_k_m": 0.82, "q4_k_s": 0.78, "q4_0": 0.74, "q4": 0.82, "int4": 0.72,
    "awq-4bit": 0.80, "awq": 0.80, "gptq-4bit": 0.79, "gptq": 0.79,
    "q3_k_m": 0.62, "q3": 0.62,
    "q2_k": 0.40, "q2": 0.40,
}

# Format → which runners can serve it (drives the "shown as recommended" gate, §4.3).
QUANT_FMT: Dict[str, str] = {
    "f32": "safetensors", "fp32": "safetensors", "f16": "gguf", "fp16": "gguf", "bf16": "gguf",
    "fp8": "fp8",
    "q8_0": "gguf", "q8": "gguf", "int8": "gguf",
    "q6_k": "gguf", "q6": "gguf",
    "q5_k_m": "gguf", "q5_k_s": "gguf", "q5_0": "gguf", "q5": "gguf",
    "q4_k_m": "gguf", "q4_k_s": "gguf", "q4_0": "gguf", "q4": "gguf", "int4": "gguf",
    "awq-4bit": "awq", "awq": "awq", "gptq-4bit": "gptq", "gptq": "gptq",
    "q3_k_m": "gguf", "q3": "gguf",
    "q2_k": "gguf", "q2": "gguf",
}

FMT_RUNNERS: Dict[str, List[str]] = {
    "gguf": ["llamacpp", "ollama"],
    "safetensors": ["vllm"],
    "awq": ["vllm"],
    "gptq": ["vllm"],
    "fp8": ["vllm"],
    "mlx": ["mlx"],
}

# Which formats an accelerator can run at all (Metal = gguf/mlx; cpu = gguf only).
ACCEL_FMTS: Dict[str, List[str]] = {
    "cuda": ["gguf", "safetensors", "awq", "gptq", "fp8"],
    "rocm": ["gguf", "safetensors", "awq", "gptq"],
    "metal": ["gguf", "mlx"],
    "cpu": ["gguf"],
}

# Per-family architecture fallback so `fit` works pre-download (when the catalog
# carries no per-model `arch` block + no GGUF/config metadata is available).
#   n_layers      num_hidden_layers
#   d_model       hidden_size (NOT used for KV when kv heads are known)
#   n_kv_heads    GQA key/value head count (KV scales with THIS, not n_attention_heads)
#   head_dim      per-head dim (kv_dim = n_kv_heads * head_dim is the GQA-correct KV width)
# These are conservative family medians; a per-model `arch` block in open-models.json
# OVERRIDES every field for atomic precision.
FAMILY_ARCH: Dict[str, Dict[str, int]] = {
    "qwen3":    {"n_layers": 36, "d_model": 4096, "n_kv_heads": 8,  "head_dim": 128},
    "qwen2.5":  {"n_layers": 28, "d_model": 3584, "n_kv_heads": 4,  "head_dim": 128},
    "llama":    {"n_layers": 32, "d_model": 4096, "n_kv_heads": 8,  "head_dim": 128},
    "llama3":   {"n_layers": 32, "d_model": 4096, "n_kv_heads": 8,  "head_dim": 128},
    "llama4":   {"n_layers": 48, "d_model": 5120, "n_kv_heads": 8,  "head_dim": 128},
    "gemma3":   {"n_layers": 34, "d_model": 3840, "n_kv_heads": 4,  "head_dim": 256, "sliding_window": 1024},
    "mistral":  {"n_layers": 32, "d_model": 4096, "n_kv_heads": 8,  "head_dim": 128},
    "phi":      {"n_layers": 40, "d_model": 5120, "n_kv_heads": 10, "head_dim": 128},
    "phi4":     {"n_layers": 40, "d_model": 5120, "n_kv_heads": 10, "head_dim": 128},
    # DeepSeek V3/R1 use MLA: the KV is a compressed latent (kv_lora_rank 512 + 64 rope)
    # ~= a tiny effective kv_dim. Treat the family kv_dim as that latent width.
    "deepseek": {"n_layers": 61, "d_model": 7168, "n_kv_heads": 1,  "head_dim": 576},
    "gpt-oss":  {"n_layers": 36, "d_model": 2880, "n_kv_heads": 8,  "head_dim": 64,  "sliding_window": 128},
    "granite":  {"n_layers": 40, "d_model": 4096, "n_kv_heads": 8,  "head_dim": 128},
    "nemotron": {"n_layers": 32, "d_model": 4096, "n_kv_heads": 8,  "head_dim": 128},
    # Nemotron-H / Jamba are hybrid Mamba-Transformer: only ~1/6 of layers carry KV.
    "nemotron-h": {"n_layers": 52, "d_model": 4096, "n_kv_heads": 8, "head_dim": 128, "kv_layers": 8},
    "jamba":      {"n_layers": 32, "d_model": 4096, "n_kv_heads": 8, "head_dim": 128, "kv_layers": 4},
}

# Recommender search order (best quality first); the scorer descends until one FITS/TIGHT.
RECOMMEND_ORDER: List[str] = ["q8_0", "q6_k", "q5_k_m", "q4_k_m", "q4_0", "q3_k_m", "q2_k"]

# Runtime overhead per accel (CUDA graph / Metal / vLLM capture), GiB.
OVERHEAD_GB: Dict[str, float] = {"cuda": 0.7, "rocm": 0.7, "metal": 0.4, "cpu": 0.5, "vllm": 1.2}

_GIB = 1024.0 ** 3

# Fit thresholds (§4.2): ratio = est_vram / budget.
_FITS_MAX = 0.80
_TIGHT_MAX = 1.0
_PARTIAL_MAX = 1.6
# Budget leaves 8% headroom on the accelerator (§4.2).
_BUDGET_FRACTION = 0.92


def parse_params_b(token: Any) -> Optional[float]:
    """'7b'→7.0, '0.5b'→0.5, '70B'→70.0, 8→8.0. None if unparseable."""
    if token is None:
        return None
    if isinstance(token, (int, float)):
        return float(token)
    m = re.match(r"^\s*([\d.]+)\s*[bB]?\s*$", str(token))
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def bpw(quant: str) -> Optional[float]:
    """Effective bits/weight for ``quant`` (case-insensitive). None if unknown."""
    return QUANT_BPW.get(str(quant).lower())


def quant_fmt(quant: str) -> str:
    """Coarse format for ``quant`` (gguf|safetensors|awq|gptq|fp8|mlx). Defaults gguf."""
    return QUANT_FMT.get(str(quant).lower(), "gguf")


def weights_gb(params_b: float, quant: str) -> float:
    """Weight footprint (GiB) = params_B * bpw / 8 (active params for MoE if passed)."""
    b = bpw(quant) or 4.85
    # params are in billions; 1e9 weights * bytes/weight → bytes → GiB.
    return (params_b * 1e9 * (b / 8.0)) / _GIB


def kv_cache_gb(
    ctx_len: int,
    n_layers: int,
    *,
    n_kv_heads: Optional[int] = None,
    head_dim: Optional[int] = None,
    d_model: Optional[int] = None,
    attn: str = "gqa",
    sliding_window: Optional[int] = None,
    kv_layers: Optional[int] = None,
    kv_per_layer: Optional[int] = None,
    kv_bits: int = 16,
) -> float:
    """KV-cache footprint (GiB) for ONE sequence — GQA/MLA/hybrid/sliding-aware.

    The per-layer KV WIDTH is ``n_kv_heads * head_dim`` (GQA-correct) — NOT ``d_model``
    (using d_model overstates KV ~4x for an 8-KV-head model). Variants:
      mla    — DeepSeek/Kimi: a single compressed latent per layer (``kv_per_layer``),
               so the cache is ``n_layers * kv_per_layer * ctx`` (no factor 2*heads).
      hybrid — Nemotron-H / Jamba: only ``kv_layers`` of N layers carry KV.
      sliding-window — KV ctx is capped near the window (a few global layers blended in).
    """
    kv_bytes = kv_bits / 8.0
    eff_ctx = float(ctx_len)
    if sliding_window and ctx_len > sliding_window:
        eff_ctx = sliding_window + (ctx_len - sliding_window) * 0.2
    if attn == "mla" and kv_per_layer:
        return (n_layers * kv_per_layer * eff_ctx * kv_bytes) / _GIB
    width = (n_kv_heads * head_dim) if (n_kv_heads and head_dim) else (d_model or 4096)
    layers = kv_layers if (attn == "hybrid" and kv_layers) else n_layers
    return (2 * layers * width * eff_ctx * kv_bytes) / _GIB


def est_vram_gb(
    params_b: float,
    quant: str,
    *,
    ctx_len: int = 8192,
    n_layers: Optional[int] = None,
    d_model: Optional[int] = None,
    family: Optional[str] = None,
    arch: Optional[Dict[str, Any]] = None,
    accel: str = "cpu",
    runner: str = "llamacpp",
    kv_bits: int = 16,
    size_gb: Optional[float] = None,
) -> Dict[str, float]:
    """Estimate total VRAM/RAM for (params, quant, ctx) on ``accel``.

    ``arch`` (the catalog per-model block: n_kv_heads/head_dim/attn/sliding_window/
    kv_layers/kv_per_layer) drives a PRECISE KV estimate; absent, fall back to
    ``FAMILY_ARCH[family]`` then the d_model heuristic. ``size_gb`` (known on-disk
    weight bytes) overrides params*bpw. Returns the component breakdown + total (GiB).
    """
    w = float(size_gb) if size_gb is not None else weights_gb(params_b, quant)
    fam = FAMILY_ARCH.get((family or "").lower(), {})
    a = arch or {}
    nl = a.get("n_layers") or n_layers or fam.get("n_layers", 32)
    kv = kv_cache_gb(
        ctx_len,
        nl,
        n_kv_heads=a.get("n_kv_heads") or fam.get("n_kv_heads"),
        head_dim=a.get("head_dim") or fam.get("head_dim"),
        d_model=d_model or fam.get("d_model"),
        attn=a.get("attn", "gqa"),
        sliding_window=a.get("sliding_window") or fam.get("sliding_window"),
        kv_layers=a.get("kv_layers") or fam.get("kv_layers"),
        kv_per_layer=a.get("kv_per_layer"),
        kv_bits=kv_bits,
    )
    overhead = OVERHEAD_GB["vllm"] if runner == "vllm" else OVERHEAD_GB.get(accel, 0.7)
    total = w + kv + overhead
    return {
        "weights_gb": round(w, 3),
        "kv_cache_gb": round(kv, 3),
        "overhead_gb": round(overhead, 3),
        "est_vram_gb": round(total, 3),
    }


def verdict_for_ratio(ratio: float) -> str:
    """Map est/budget ratio → FITS|TIGHT|PARTIAL|OVERFLOW (§4.2)."""
    if ratio <= _FITS_MAX:
        return "FITS"
    if ratio <= _TIGHT_MAX:
        return "TIGHT"
    if ratio <= _PARTIAL_MAX:
        return "PARTIAL"
    return "OVERFLOW"


def budget_gb(usable_gb: float) -> float:
    """The spendable accelerator budget = usable * 0.92 (8% headroom, §4.2)."""
    return max(usable_gb, 0.0) * _BUDGET_FRACTION


def caps_allow(quant: str, caps: Dict[str, Any]) -> Optional[str]:
    """Return a *reason string* if ``quant`` is gated out by hardware caps, else None.

    §4.3: FP8 needs fp8; AWQ/GPTQ-Marlin need awq_marlin; otherwise allowed.
    ``caps`` is a dict like HardwareProfile.caps (fp8/flash_attn/awq_marlin/metal/accel).
    """
    fmt = quant_fmt(quant)
    accel = str(caps.get("accel", "cpu"))
    if fmt == "fp8" and not caps.get("fp8"):
        return "needs FP8 (compute capability >= 8.9, RTX 40-series / H100)"
    if fmt in ("awq", "gptq") and not caps.get("awq_marlin"):
        return "AWQ/GPTQ Marlin kernel unavailable — serve via vLLM only"
    runnable = ACCEL_FMTS.get(accel, ["gguf"])
    if fmt not in runnable:
        return f"format '{fmt}' not runnable on accel '{accel}' (runs: {', '.join(runnable)})"
    return None


def score_quant(
    quant: str,
    *,
    params_b: float,
    usable_gb: float,
    ctx_len: int = 8192,
    family: Optional[str] = None,
    n_layers: Optional[int] = None,
    d_model: Optional[int] = None,
    caps: Optional[Dict[str, Any]] = None,
    active_params_b: Optional[float] = None,
    size_gb: Optional[float] = None,
    arch: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Score ONE quant: VRAM estimate, ratio, verdict, runner hints, caps gating.

    MoE: pass ``active_params_b`` — KV/compute scale with active params, but the FULL
    weights must still be resident, so weights use ``params_b`` and kv uses arch only.
    ``arch`` = the catalog per-model block (n_kv_heads/head_dim/attn/…) for precise KV.
    """
    caps = caps or {}
    accel = str(caps.get("accel", "cpu"))
    fmt = quant_fmt(quant)
    runners = FMT_RUNNERS.get(fmt, ["llamacpp"])
    runner = runners[0]
    comp = est_vram_gb(
        params_b, quant, ctx_len=ctx_len, n_layers=n_layers, d_model=d_model,
        family=family, arch=arch, accel=accel, runner=runner, size_gb=size_gb,
    )
    budget = budget_gb(usable_gb)
    ratio = comp["est_vram_gb"] / budget if budget > 0 else math.inf
    verdict = verdict_for_ratio(ratio)
    gate_reason = caps_allow(quant, {**caps, "accel": accel})
    return {
        "label": quant,
        "fmt": fmt,
        "bits": bpw(quant),
        "quality_rank": QUANT_QUALITY.get(str(quant).lower(), 0.5),
        "runner_hint": runners,
        **comp,
        "budget_gb": round(budget, 3),
        "ratio": round(ratio, 3) if math.isfinite(ratio) else None,
        "verdict": verdict,
        "runnable": gate_reason is None,
        "blocked_reason": gate_reason,
    }


def recommend(
    *,
    params_b: float,
    usable_gb: float,
    ctx_len: int = 8192,
    family: Optional[str] = None,
    caps: Optional[Dict[str, Any]] = None,
    candidate_quants: Optional[List[str]] = None,
    n_layers: Optional[int] = None,
    d_model: Optional[int] = None,
    active_params_b: Optional[float] = None,
    arch: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Rank quants and pick the recommended one (§4.4): max quality s.t. FITS/TIGHT & runnable.

    Tie-break toward GGUF (broadest runner support). Always returns ``reasons[]``.
    Returns ``{recommended, ranked, reasons}`` where ``recommended`` may be None when
    nothing fits (caller surfaces the OVERFLOW escape hatch: smaller quant / AirLLM).
    """
    caps = caps or {}
    quants = candidate_quants or RECOMMEND_ORDER
    ranked: List[Dict[str, Any]] = []
    for q in quants:
        if bpw(q) is None:
            continue
        ranked.append(score_quant(
            q, params_b=params_b, usable_gb=usable_gb, ctx_len=ctx_len,
            family=family, n_layers=n_layers, d_model=d_model, caps=caps,
            active_params_b=active_params_b, arch=arch,
        ))
    # Sort best-effort by est size ascending (smallest first) for stable display.
    ranked.sort(key=lambda r: (r["est_vram_gb"]))

    # Eligible = runnable AND verdict in {FITS, TIGHT}; maximise quality, tie-break GGUF.
    eligible = [r for r in ranked if r["runnable"] and r["verdict"] in ("FITS", "TIGHT")]
    reasons: List[str] = []
    recommended: Optional[Dict[str, Any]] = None
    if eligible:
        eligible.sort(
            key=lambda r: (r["quality_rank"], 1 if r["fmt"] == "gguf" else 0),
            reverse=True,
        )
        recommended = eligible[0]
        reasons.append(
            f"{recommended['label']} chosen: {recommended['est_vram_gb']}GB est "
            f"{'fits' if recommended['verdict'] == 'FITS' else 'is tight on'} your "
            f"{round(usable_gb, 1)}GB budget at ratio {recommended['ratio']}."
        )
        better = [r for r in eligible if r["quality_rank"] > recommended["quality_rank"]]
        if not better:
            reasons.append(
                f"{recommended['label']} is the highest-quality quant that fits "
                f"(quality {recommended['quality_rank']})."
            )
        if recommended["fmt"] == "gguf":
            reasons.append("GGUF = broadest runner support (llama.cpp / Ollama), easiest serve.")
    else:
        # OVERFLOW escape hatch (§4.2): name the smallest quant + AirLLM / served-API path.
        smallest = ranked[0] if ranked else None
        if smallest:
            reasons.append(
                f"nothing fits your {round(usable_gb, 1)}GB budget — smallest tried "
                f"({smallest['label']}) needs {smallest['est_vram_gb']}GB "
                f"(ratio {smallest['ratio']})."
            )
        reasons.append(
            "OVERFLOW: pick a smaller quant, stream layers from disk via AirLLM, "
            "or use a served open-weight API endpoint."
        )

    return {"recommended": recommended, "ranked": ranked, "reasons": reasons}
