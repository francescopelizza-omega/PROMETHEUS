#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""serve.py — ServeProfile + runner-argv construction (file 05 §8).

PURE: builds the runner command-line and a reproducible ``ServeProfile`` from a
fit verdict — it does NOT spawn anything (the runner binaries llama.cpp / vLLM /
ollama are model TOOLs owned by the engine and are not installed in this sandbox).
The argv construction (fit-derived ``-ngl`` / ``--ctx`` / ``--tensor-parallel-size``)
is the load-bearing, testable part; the actual spawn + ``/v1/models`` poll is a thin
subprocess wrapper the desktop MAIN process (C8 ServerSupervisor) drives.

``ServeProfile.endpoint.base_url`` is EXACTLY a value from the engine's
``LOCAL_AI_ENDPOINTS`` (llamacpp→:8080/v1, vllm→:8000/v1, ollama→:11434/v1) — the seam
where this hub meets ``localai`` (§2.4).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

# Default OpenAI-compatible local ports — MUST match prometheus.py LOCAL_AI_ENDPOINTS.
RUNNER_PORTS: Dict[str, int] = {"llamacpp": 8080, "vllm": 8000, "ollama": 11434}
RUNNER_BASE_PATH: Dict[str, str] = {"llamacpp": "/v1", "vllm": "/v1", "ollama": "/v1"}

# Which fmt each runner serves (cross-check against fit.FMT_RUNNERS at the call site).
RUNNER_FMTS: Dict[str, List[str]] = {
    "llamacpp": ["gguf"],
    "vllm": ["safetensors", "awq", "gptq", "fp8"],
    "ollama": ["gguf"],
}


def base_url(runner: str, host: str = "127.0.0.1", port: Optional[int] = None) -> str:
    """The OpenAI-compatible base URL for a runner (matches LOCAL_AI_ENDPOINTS)."""
    p = port or RUNNER_PORTS.get(runner, 8080)
    path = RUNNER_BASE_PATH.get(runner, "/v1")
    return f"http://{host}:{p}{path}"


def gpu_layers_for(verdict: str, n_layers: int, ratio: Optional[float]) -> int:
    """Fit-derived ``-ngl``: how many transformer layers to put on the accelerator.

    FITS/TIGHT → all layers on GPU. PARTIAL → offload proportionally (the fraction that
    fits the budget). OVERFLOW → 0 (CPU/disk-stream; the recommender names AirLLM).
    """
    if verdict in ("FITS", "TIGHT"):
        return n_layers
    if verdict == "PARTIAL" and ratio and ratio > 0:
        # Put as many layers on GPU as the budget allows (budget = est/ratio).
        frac = min(1.0, 1.0 / ratio)
        return max(0, int(n_layers * frac))
    return 0


def tensor_parallel_for(verdict: str, gpu_count: int) -> int:
    """vLLM ``--tensor-parallel-size``: shard across GPUs when one GPU overflows."""
    if verdict in ("PARTIAL", "OVERFLOW") and gpu_count > 1:
        return gpu_count
    return 1


def build_serve_profile(
    *,
    model_id: str,
    quant: str,
    runner: str,
    fit: Dict[str, Any],
    gguf_path: Optional[str] = None,
    hf_id: Optional[str] = None,
    ctx_len: int = 8192,
    n_layers: int = 32,
    gpu_count: int = 1,
    caps: Optional[Dict[str, Any]] = None,
    host: str = "127.0.0.1",
    port: Optional[int] = None,
    autostart: bool = False,
) -> Dict[str, Any]:
    """Build a reproducible ServeProfile + the runner argv (§2.4, §8). No spawn.

    ``fit`` is one entry from ``fit.score_quant`` (has ``verdict``/``ratio``). The argv
    pre-fills the fit-derived ``-ngl`` (llama.cpp) / ``--tensor-parallel-size`` (vLLM).
    """
    caps = caps or {}
    verdict = str(fit.get("verdict", "FITS"))
    ratio = fit.get("ratio")
    port = port or RUNNER_PORTS.get(runner, 8080)
    url = base_url(runner, host=host, port=port)
    served_name = model_id

    args: Dict[str, Any] = {"ctx_len": ctx_len, "served_model_name": served_name}
    argv: List[str]

    if runner == "llamacpp":
        ngl = gpu_layers_for(verdict, n_layers, ratio)
        args["gpu_layers"] = ngl
        target = gguf_path or "<gguf>"
        argv = [
            "llama-server", "-m", target,
            "-ngl", str(ngl), "-c", str(ctx_len),
            "--host", host, "--port", str(port),
        ]
    elif runner == "vllm":
        tp = tensor_parallel_for(verdict, gpu_count)
        args["tensor_parallel"] = tp
        args["max_model_len"] = ctx_len
        kv = "fp8" if caps.get("fp8") else "auto"
        args["kv_cache_dtype"] = kv
        argv = [
            "vllm", "serve", hf_id or model_id,
            "--tensor-parallel-size", str(tp),
            "--max-model-len", str(ctx_len),
            "--host", host, "--port", str(port),
        ]
        fmt = str(fit.get("fmt", "gguf"))
        if fmt in ("awq", "gptq", "fp8"):
            argv += ["--quantization", fmt]
        if caps.get("fp8"):
            argv += ["--kv-cache-dtype", "fp8"]
    elif runner == "ollama":
        # Ollama auto-fits; the Hub just records the endpoint and the pull tag.
        argv = ["ollama", "pull", model_id]
    else:
        raise ValueError(f"unknown runner: {runner}")

    return {
        "id": f"{_slug(model_id)}-{_slug(quant)}-{runner}",
        "model_id": model_id,
        "quant": quant,
        "runner": runner,
        "endpoint": {"host": host, "port": port, "base_url": url},
        "api_key": "local",
        "args": args,
        "argv": argv,
        "autostart": bool(autostart),
        "status": "stopped",
    }


def _slug(s: str) -> str:
    out = []
    for ch in str(s).lower():
        out.append(ch if ch.isalnum() else "-")
    slug = "".join(out)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-") or "model"
