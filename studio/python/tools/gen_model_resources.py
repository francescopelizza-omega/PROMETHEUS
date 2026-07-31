#!/usr/bin/env python3
"""gen_model_resources.py — compute the per-model RAM/CPU/GPU compute-demand block and
write it into config/open-models.json, from the VERIFIED architecture in
config/model-arch.json.

This is the precision heart of the "can my machine run this model?" feature: for every
model it adds
  - `arch`     — the compact architecture fit.py reads live (n_layers/n_kv_heads/head_dim/
                 attn/native_ctx/sliding_window/kv_layers/kv_per_layer/moe_active_b)
  - `resource` — the precomputed demand: q4 weight GB, KV at 8K + native ctx, min/rec RAM,
                 min GPU VRAM, cpu_ok, tier, needs_offload, and a one-line `resource_label`
                 surfaced BESIDE the text descriptor in the APP + CLI.

CANONICAL FORMULA (33-agent investigation, GiB):
  weights = params_b * 1e9 * (bpw/8) / 2^30                 (Q4_K_M bpw = 4.83)
  KV_dense = 2 * n_layers * n_kv_heads * head_dim * ctx * kv_bytes / 2^30   (GQA-correct)
  KV_mla   = n_layers * kv_per_layer * ctx * kv_bytes / 2^30                (DeepSeek/Kimi)
  KV_hybrid= 2 * kv_layers * n_kv_heads * head_dim * ctx * kv_bytes / 2^30  (Nemotron-H/Jamba)
  sliding-window caps the KV ctx at the window.
  activation = 0.3 (<5B) | 0.4 (5-40B) | 0.7 (>=40B)
  runtime_fixed = 0.75 (llama.cpp)
  total = weights + KV + activation + runtime_fixed
  HEADROOM: a machine with R GB RAM can run when total <= ~0.72*R (OS/page-cache/GPU reserve).
  MoE: weights use the FULL param count; decode SPEED uses active_b.
Run: python3 studio/python/tools/gen_model_resources.py  (idempotent; regenerates in place).
"""
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve()
CONFIG = HERE.parents[2] / "config"
CATALOG = CONFIG / "open-models.json"
ARCH = CONFIG / "model-arch.json"

BPW_Q4 = 4.83          # Q4_K_M effective bits/weight (llama.cpp measured)
KV_BYTES = 2.0         # bf16/fp16 KV element
RT_FIXED = 0.75        # llama.cpp runtime + context buffers (GiB)
GIB = 1024.0 ** 3
HEADROOM = 0.72        # usable fraction of system RAM (OS/page-cache/GPU-context reserve)
GPU_HEADROOM = 0.92    # usable fraction of dedicated VRAM
REF_CTX = 8192         # the "short context" reference for min-RAM
RAM_TIERS = [4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024]
GPU_TIERS = [4, 6, 8, 12, 16, 24, 32, 48, 80, 141, 192, 256, 384, 512]


def round_up(x, tiers):
    for t in tiers:
        if x <= t:
            return t
    return tiers[-1]


def activation_gb(params_b):
    if params_b < 5:
        return 0.3
    if params_b < 40:
        return 0.4
    return 0.7


def weights_gb(params_b, bpw=BPW_Q4):
    return params_b * 1e9 * (bpw / 8.0) / GIB


def kv_gb(arch, ctx):
    nl = arch["n_layers"]
    attn = arch.get("attn", "gqa")
    if attn == "mla":
        per = arch.get("kv_per_layer", 576)
        return nl * per * ctx * KV_BYTES / GIB
    nkv = arch["n_kv_heads"]
    hd = arch["head_dim"]
    eff_ctx = ctx
    sw = arch.get("sliding_window")
    if sw and ctx > sw:
        # blend: most layers windowed, a few global — conservative effective ctx.
        eff_ctx = sw + (ctx - sw) * 0.2
    layers = arch.get("kv_layers", nl) if attn == "hybrid" else nl
    return 2 * layers * nkv * hd * eff_ctx * KV_BYTES / GIB


def cpu_feasible(active_b, footprint_8k):
    # memory-bandwidth-bound decode: tok/s ~ DDR5(~90GB/s) / active_weight_GB.
    active_gb = max(active_b * (BPW_Q4 / 8.0), 0.2)
    toks = 90.0 / active_gb
    return toks >= 4.0 and footprint_8k <= 64.0


def compute_llm(model, arch):
    params_b = float(model.get("params_b") or 0)
    active_b = float(model.get("active_params_b") or params_b)
    native = int(arch.get("native_context") or model.get("context") or 8192)
    w = weights_gb(params_b)
    act = activation_gb(params_b)
    kv8 = kv_gb(arch, REF_CTX)
    kvn = kv_gb(arch, native)
    foot8 = w + kv8 + act + RT_FIXED
    footn = w + kvn + act + RT_FIXED
    min_ram = round_up(foot8 / HEADROOM, RAM_TIERS)
    rec_ram = round_up(footn / HEADROOM, RAM_TIERS)
    gpu_min = round_up(foot8 / GPU_HEADROOM, GPU_TIERS)
    cpu_ok = cpu_feasible(active_b, foot8)
    needs_offload = (foot8 / HEADROOM) > 128  # won't fit even a 128GB box at Q4
    tier = (
        "tiny" if min_ram <= 4 else "light" if min_ram <= 8 else "moderate" if min_ram <= 16
        else "heavy" if min_ram <= 32 else "workstation" if min_ram <= 64 else "server"
    )
    label = f"≈{w:.1f}GB Q4 · {min_ram}GB RAM"
    label += " · CPU-ok" if cpu_ok else " · GPU"
    if needs_offload:
        label += " · offload"
    return {
        "q4_gb": round(w, 2),
        "kv_8k_gb": round(kv8, 2),
        "kv_native_gb": round(kvn, 2),
        "min_ram_gb": min_ram,
        "rec_ram_gb": rec_ram,
        "gpu_min_vram_gb": gpu_min,
        "cpu_ok": cpu_ok,
        "tier": tier,
        "needs_offload": needs_offload,
        "label": label,
    }


def compact_arch(arch):
    out = {
        "n_layers": arch["n_layers"],
        "n_kv_heads": arch["n_kv_heads"],
        "head_dim": arch["head_dim"],
        "attn": arch.get("attn", "gqa"),
        "native_context": arch.get("native_context"),
    }
    for k in ("sliding_window", "kv_layers", "kv_per_layer", "moe_active_b"):
        if arch.get(k):
            out[k] = arch[k]
    return out


def compute_nonllm(model, nonllm_arch):
    params_b = float(model.get("params_b") or 0)
    info = nonllm_arch.get(model["id"])
    if info and info.get("ram_fp16_gb"):
        ram = float(info["ram_fp16_gb"])
        cpu_ok = bool(info.get("cpu_ok", True))
        vram = info.get("vram_min_gb") or ram
    else:
        # embeddings/encoders: no KV; RAM ~= weights fp16 + small overhead.
        ram = params_b * 2.0 + 0.5
        cpu_ok = params_b <= 2.0
        vram = ram
    min_ram = round_up(ram / HEADROOM, RAM_TIERS)
    gpu_min = round_up(float(vram) / GPU_HEADROOM, GPU_TIERS)
    tier = "tiny" if min_ram <= 4 else "light" if min_ram <= 8 else "moderate" if min_ram <= 16 else "heavy"
    label = f"≈{ram:.1f}GB · {min_ram}GB RAM" + (" · CPU-ok" if cpu_ok else " · GPU")
    return {
        "q4_gb": round(params_b * (BPW_Q4 / 8.0), 2),
        "min_ram_gb": min_ram,
        "rec_ram_gb": min_ram,
        "gpu_min_vram_gb": gpu_min,
        "cpu_ok": cpu_ok,
        "tier": tier,
        "needs_offload": False,
        "label": label,
    }


def main():
    catalog = json.loads(CATALOG.read_text())
    archdoc = json.loads(ARCH.read_text())
    archmap = archdoc["models"]
    nonllm_arch = archdoc.get("nonllm", {})
    n_arch = n_res = 0
    for m in catalog["models"]:
        mid = m["id"]
        if m.get("kind") == "llm":
            a = archmap.get(mid)
            if not a:
                print(f"  WARN no arch for {mid}")
                continue
            m["arch"] = compact_arch(a)
            m["resource"] = compute_llm(m, a)
            n_arch += 1
            n_res += 1
        else:
            m["resource"] = compute_nonllm(m, nonllm_arch)
            n_res += 1
    catalog["version"] = "3"
    catalog["note"] = (
        catalog.get("note", "")
        + " Each model carries `arch` (verified architecture) + `resource` (precomputed "
        "RAM/CPU/GPU demand at Q4_K_M: min_ram_gb, gpu_min_vram_gb, cpu_ok, tier, needs_offload "
        "+ a one-line `resource.label` shown beside the descriptor). See model-arch.json + "
        "MDS/model-resource-methodology.md for the formula."
    )
    CATALOG.write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"patched {n_res} models ({n_arch} with arch) -> {CATALOG}")
    # sample
    for mid in ("qwen3-8b", "llama3.3-70b", "deepseek-r1-671b", "gemma3-27b", "phi4-mini"):
        m = next((x for x in catalog["models"] if x["id"] == mid), None)
        if m:
            print(f"  {mid}: {m['resource']['label']}  (kv_native {m['resource'].get('kv_native_gb')}GB)")


if __name__ == "__main__":
    main()
