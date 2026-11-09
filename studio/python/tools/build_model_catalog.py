#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""build_model_catalog.py — regenerate the local-model catalogue from its researched seed.

INPUTS (all in studio/config, checked in):
  model-catalog.seed.json   the researched FACTS per model: official repo, publisher, licence,
                            params, context, GGUF/MLX/Ollama coordinates (verified against the
                            Hugging Face API and ollama.com when the seed was written), the
                            two-line picker blurb, and gate-relevant flags (HF gating, pickle
                            files in the repo, remote code).
  model-arch.json           verified architecture per model (layers, KV heads, head dim,
                            attention kind, native context …). `--fetch-arch` fills missing
                            rows from each repo's config.json on Hugging Face.

OUTPUTS (generated — never edit by hand):
  open-models.json                                  the sidecar's catalogue (model.search)
  packages/core/src/ai/model-catalog/catalog.generated.ts   the same rows for TypeScript

SIZING — the canonical formula of gen_model_resources.py, with one change: when the seed
records the REAL Q4 GGUF byte count, that is the weight figure (the params×4.83-bit estimate
ran 6–10 % low on large models). KV at 8K / native context from the architecture.

GATE — every row is vetted at build time: an official publisher repo, weights available as
safetensors and/or GGUF (never pickle-only), a known licence. That makes a row ELIGIBLE; it
never makes a download trusted. Every download is still staged and scanned by nemesis before
admission (nemesis_gate.admit) — the catalogue's `gate` block says what was checked here.

Run:  python3 studio/python/tools/build_model_catalog.py [--fetch-arch] [--check]
      --check   exit 1 if the generated files differ from what is checked in (CI drift guard)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve()
STUDIO = HERE.parents[2]
CONFIG = STUDIO / "config"
SEED = CONFIG / "model-catalog.seed.json"
ARCH = CONFIG / "model-arch.json"
OUT_JSON = CONFIG / "open-models.json"
OUT_TS = STUDIO / "packages" / "core" / "src" / "ai" / "model-catalog" / "catalog.generated.ts"

GIB = 1024.0 ** 3
BPW_Q4 = 4.83
KV_BYTES = 2.0
RT_FIXED = 0.75
GPU_HEADROOM = 0.92
REF_CTX = 8192
RAM_TIERS = [2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536,
             2048, 3072]
GPU_TIERS = [2, 4, 6, 8, 12, 16, 24, 32, 48, 80, 141, 192, 256, 384, 512, 768, 1024, 1536]
NON_COMMERCIAL = re.compile(r"\b(nc|non[- ]?commercial|research[- ]only|cc-by-nc)\b", re.I)
# Licence ids whose terms forbid commercial or production use although the id does not say so.
NONCOMMERCIAL_LICENSES = {
    "exaone", "k-exaone", "mnpl", "qwen-research", "customized-nscl-v1",
    "nvidia-internal-scientific-research-and-development-model-license",
}
# Usable, but with terms a user should read before shipping anything (field-of-use limits,
# attribution/naming duties, revenue caps).
RESTRICTED_LICENSES = {"health-ai-developer-foundations", "xai-community", "kanana-open-license",
                       "minimax-model-license", "muse-model-license"}
# Size words are the tier's job (`resource.tier`, computed from RAM): as tags they drifted from
# the computed tier and duplicated it in the picker.
SIZE_TAGS = {"tiny", "small", "light", "moderate", "heavy", "workstation", "server", "datacenter"}
BLURB_MAX = 72


def round_up(x: float, tiers: list) -> int:
    for t in tiers:
        if x <= t:
            return t
    return int(math.ceil(x / 512.0) * 512)


def headroom(total_gb: float) -> float:
    """Share of a machine's RAM a model may take. The OS + apps cost a roughly FIXED few GB,
    so the share grows with the machine: 72% of 16 GB leaves 4.5 GB, but 72% of 512 GB left
    143 GB idle and pushed DeepSeek-V3 (≈382 GB) to the 768 GB tier."""
    return 0.72 if total_gb <= 32 else 0.80 if total_gb <= 64 else 0.85


def ram_tier(foot_gb: float) -> int:
    """The smallest RAM tier whose usable share (`headroom`) holds `foot_gb`."""
    for t in RAM_TIERS:
        if foot_gb <= t * headroom(t):
            return t
    return int(math.ceil(foot_gb / 0.85 / 512.0) * 512)


def activation_gb(params_b: float) -> float:
    return 0.3 if params_b < 5 else 0.4 if params_b < 40 else 0.7


def kv_gb(arch: dict, ctx: int) -> float:
    nl = int(arch["n_layers"])
    attn = arch.get("attn", "gqa")
    if attn == "mla":
        return nl * int(arch.get("kv_per_layer", 576)) * ctx * KV_BYTES / GIB
    nkv = int(arch["n_kv_heads"])
    hd = int(arch["head_dim"])
    eff = ctx
    sw = arch.get("sliding_window")
    if sw and ctx > sw:
        eff = sw + (ctx - sw) * 0.2
    layers = int(arch.get("kv_layers") or nl) if attn == "hybrid" else nl
    return 2 * layers * nkv * hd * eff * KV_BYTES / GIB


def kv_fallback(params_b: float, active_b: float, ctx: int) -> float:
    """No verified architecture (gated config): a conservative GQA-shaped guess."""
    base = 0.25 + 0.025 * min(params_b, 120)
    if active_b < params_b * 0.5:          # MoE: attention is a small share
        base *= 0.6
    return base * ctx / REF_CTX


def cpu_feasible(active_b: float, foot8: float) -> bool:
    active_gb = max(active_b * (BPW_Q4 / 8.0), 0.2)
    return (90.0 / active_gb) >= 4.0 and foot8 <= 64.0


def tier_for(min_ram: float) -> str:
    return ("tiny" if min_ram <= 4 else "light" if min_ram <= 8 else "moderate" if min_ram <= 16
            else "heavy" if min_ram <= 32 else "workstation" if min_ram <= 64
            else "server" if min_ram <= 256 else "datacenter")


def compute_resource(m: dict, arch: dict | None) -> dict:
    params = float(m.get("params_b") or 0)
    active = float(m.get("active_params_b") or params)
    gg = m.get("gguf") or {}
    measured = isinstance(gg.get("bytes"), (int, float)) and gg["bytes"] > 0
    w = gg["bytes"] / GIB if measured else params * 1e9 * (BPW_Q4 / 8.0) / GIB
    native = int((arch or {}).get("native_context") or m.get("context") or 8192)
    # What the row advertises (and the picker shows) is the context the recommendation is for;
    # max_position_embeddings is often a larger, untrained ceiling.
    rec_ctx = min(int(m.get("context") or native), native)
    ref_ctx = min(REF_CTX, native)            # a 4K-context model never holds an 8K cache
    if m.get("kind", "llm") != "llm":
        ram = max(params * 2.0 + 0.5, w + 0.5)
        min_ram = ram_tier(ram)
        return {"q4_gb": round(w, 2), "weights_measured": measured, "min_ram_gb": min_ram,
                "rec_ram_gb": min_ram, "gpu_min_vram_gb": round_up(ram / GPU_HEADROOM, GPU_TIERS),
                "cpu_ok": params <= 2.0, "tier": tier_for(min_ram), "needs_offload": False,
                "label": f"≈{ram:.1f}GB · {min_ram}GB RAM" + (" · CPU-ok" if params <= 2 else " · GPU")}
    if arch:
        kv8, kvn = kv_gb(arch, ref_ctx), kv_gb(arch, rec_ctx)
    else:
        kv8, kvn = kv_fallback(params, active, ref_ctx), kv_fallback(params, active, rec_ctx)
    act = activation_gb(params)
    foot8 = w + kv8 + act + RT_FIXED
    footn = w + kvn + act + RT_FIXED
    min_ram = ram_tier(foot8)
    rec_ram = max(min_ram, ram_tier(footn))
    cpu_ok = cpu_feasible(active, foot8)
    needs_offload = min_ram > 128
    label = f"≈{w:.1f}GB Q4 · {min_ram}GB RAM" + (" · CPU-ok" if cpu_ok else " · GPU")
    if needs_offload:
        label += " · offload"
    out = {"q4_gb": round(w, 2), "weights_measured": measured, "kv_8k_gb": round(kv8, 2),
           "kv_native_gb": round(kvn, 2), "min_ram_gb": min_ram, "rec_ram_gb": rec_ram,
           "gpu_min_vram_gb": round_up(foot8 / GPU_HEADROOM, GPU_TIERS), "cpu_ok": cpu_ok,
           "tier": tier_for(min_ram), "needs_offload": needs_offload, "label": label,
           "arch_verified": bool(arch)}
    small = m.get("gguf_small") or {}
    if isinstance(small.get("bytes"), (int, float)) and small["bytes"] > 0:
        ws = small["bytes"] / GIB
        out["small_quant"] = small.get("quant")
        out["small_gb"] = round(ws, 2)
        out["small_min_ram_gb"] = ram_tier(ws + kv8 + act + RT_FIXED)
    return out


# --------------------------------------------------------------------------- arch fetch
def _hf_json(url: str) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": "prometheus-catalog-build/1"})
    tok = os.environ.get("HF_TOKEN")
    if tok:
        req.add_unredirected_header("Authorization", f"Bearer {tok}")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read(4 * 1024 * 1024).decode("utf-8"))
    except (urllib.error.URLError, ValueError, TimeoutError, OSError):
        return None


def arch_from_config(cfg: dict) -> dict | None:
    """Derive the compact architecture from a transformers config.json."""
    sub = cfg.get("text_config") or cfg.get("llm_config") or cfg.get("language_config") or {}
    c = {**cfg, **sub} if isinstance(sub, dict) else cfg
    nl = c.get("num_hidden_layers") or c.get("n_layer") or c.get("num_layers") or c.get("n_layers")
    nh = c.get("num_attention_heads") or c.get("n_head") or c.get("n_heads")
    if not nl or not nh:
        return None
    nkv = (c.get("num_key_value_heads") or c.get("n_head_kv") or c.get("multi_query_group_num")
           or c.get("num_kv_heads") or nh)
    hidden = c.get("hidden_size") or c.get("d_model") or c.get("n_embd") or 0
    hd = c.get("head_dim") or (hidden // nh if hidden and nh else 128)
    native = (c.get("max_position_embeddings") or c.get("max_sequence_length")
              or c.get("seq_length") or c.get("n_positions"))
    arch = {"n_layers": int(nl), "n_kv_heads": int(nkv), "head_dim": int(hd), "attn": "gqa",
            "native_context": int(native) if native else None}
    if c.get("kv_lora_rank"):
        arch["attn"] = "mla"
        arch["kv_per_layer"] = int(c["kv_lora_rank"]) + int(c.get("qk_rope_head_dim") or 64)
    lt = c.get("layer_types")
    if isinstance(lt, list) and lt:
        full = sum(1 for t in lt if str(t) in ("full_attention", "attention", "global"))
        slid = sum(1 for t in lt if "sliding" in str(t))
        other = len(lt) - full - slid
        if other > 0 and arch["attn"] != "mla":
            arch["attn"] = "hybrid"
            arch["kv_layers"] = max(1, full + slid)
        if slid and c.get("sliding_window"):
            arch["sliding_window"] = int(c["sliding_window"])
    fai = c.get("full_attention_interval")
    if isinstance(fai, int) and fai > 1 and arch["attn"] != "mla":
        # Qwen3-Next / Qwen3.5-style: one full-attention layer every `fai`, linear attention
        # (no growing KV cache) in between — counting every layer overstated KV by `fai`×.
        arch["attn"] = "hybrid"
        arch["kv_layers"] = max(1, int(nl) // fai)
    pat = c.get("hybrid_override_pattern")
    if isinstance(pat, str) and pat:
        arch["attn"] = "hybrid"
        arch["kv_layers"] = max(1, pat.count("*"))
    if c.get("attn_layer_period") and c.get("attn_layer_offset") is not None:
        arch["attn"] = "hybrid"
        arch["kv_layers"] = max(1, int(nl) // int(c["attn_layer_period"]))
    mt = str(c.get("model_type", ""))
    if mt.startswith("gemma") and c.get("sliding_window") and "sliding_window" not in arch:
        arch["sliding_window"] = int(c["sliding_window"])
    return arch


def fetch_arch(repo: str) -> dict | None:
    cfg = _hf_json(f"https://huggingface.co/{repo}/resolve/main/config.json")
    time.sleep(0.25)
    return arch_from_config(cfg) if isinstance(cfg, dict) else None


# --------------------------------------------------------------------------- build
# GGUF publishers trusted to repackage weights faithfully (llama.cpp's own org, and the two
# quantizers every runtime's docs point at). Anything else is the publisher itself or a
# community uploader — the latter is flagged, never silently treated like the publisher.
_TRUSTED_QUANTIZERS = {"ggml-org", "unsloth", "bartowski", "lmstudio-community", "mlx-community"}


def gate_block(m: dict) -> dict:
    formats = []
    if m.get("gguf"):
        formats.append("gguf")
    formats.append("safetensors")
    if m.get("mlx"):
        formats.append("mlx")
    notes = []
    if m.get("has_pickle_files"):
        notes.append("repo also ships pickle files (.bin/.pt/.pth) — Prometheus downloads only "
                     "safetensors/GGUF and nemesis refuses pickle imports")
    if m.get("remote_code"):
        notes.append("transformers loading needs trust_remote_code — use the GGUF/MLX build")
    if m.get("hf_gated"):
        notes.append("Hugging Face gated: accept the licence on the model page first")
    lic = str(m.get("license", "")).lower()
    if (NON_COMMERCIAL.search(lic) or lic in NONCOMMERCIAL_LICENSES
            or "non-commercial" in m.get("tags", [])):
        notes.append("non-commercial / research-only licence")
    elif lic in RESTRICTED_LICENSES:
        notes.append(f"licence '{lic}' restricts use — read its terms before shipping anything")
    gg = m.get("gguf") or {}
    gorg = str(gg.get("repo", "")).split("/")[0]
    porg = str(m.get("repo", "")).split("/")[0]
    if gorg and gorg != porg and gorg not in _TRUSTED_QUANTIZERS:
        notes.append(f"GGUF repackaged by community uploader {gorg} (not the publisher) — "
                     "still scanned by nemesis on download")
    return {"status": "caution" if notes else "vetted", "formats": formats,
            "checks": ["official-publisher-repo", "safetensors-or-gguf", "licence-known",
                       "download-scanned-by-nemesis"],
            "notes": notes}


def validate(m: dict) -> list[str]:
    errs = []
    for k in ("id", "name", "repo", "license", "blurb"):
        if not m.get(k):
            errs.append(f"{m.get('id')}: missing {k}")
    b = m.get("blurb") or []
    if not (isinstance(b, list) and len(b) == 2 and all(isinstance(x, str) and x.strip() for x in b)):
        errs.append(f"{m.get('id')}: blurb must be two non-empty lines")
    elif any(len(x) > BLURB_MAX for x in b):
        errs.append(f"{m.get('id')}: blurb line over {BLURB_MAX} chars")
    if not re.match(r"^[a-z0-9][a-z0-9._-]*$", str(m.get("id", ""))):
        errs.append(f"{m.get('id')}: id must be lower-case kebab")
    if not re.match(r"^[\w.-]+/[\w.-]+$", str(m.get("repo", ""))):
        errs.append(f"{m.get('id')}: repo must be org/name")
    if m.get("ollama") and not re.match(r"^[a-z0-9][\w.-]*(:[\w.-]+)?$", str(m["ollama"])):
        errs.append(f"{m.get('id')}: odd ollama tag {m['ollama']!r}")
    return errs


def build(fetch: bool) -> tuple[dict, str]:
    seed = json.loads(SEED.read_text())
    archdoc = json.loads(ARCH.read_text())
    archmap = archdoc.setdefault("models", {})
    rows = []
    errs = []
    fetched = 0
    for m in seed["models"]:
        errs += validate(m)
        arch = archmap.get(m["id"])
        if arch is None and fetch and m.get("kind", "llm") == "llm":
            a = fetch_arch(m["repo"])
            if a:
                a["confidence"] = "config.json"
                archmap[m["id"]] = a
                arch = a
                fetched += 1
        compact = None
        if arch and arch.get("n_layers") and arch.get("head_dim") and arch.get("n_kv_heads"):
            compact = {k: arch[k] for k in ("n_layers", "n_kv_heads", "head_dim", "attn",
                                            "native_context", "sliding_window", "kv_layers",
                                            "kv_per_layer") if arch.get(k) is not None}
        row = dict(m)
        tags = [t for t in dict.fromkeys(m.get("tags") or []) if t not in SIZE_TAGS]
        lic = str(m.get("license", "")).lower()
        if (NON_COMMERCIAL.search(lic) or lic in NONCOMMERCIAL_LICENSES) \
                and "non-commercial" not in tags:
            tags.append("non-commercial")
        row["tags"] = tags
        row["description"] = f"{m['blurb'][0]} {m['blurb'][1]}"
        row["resource"] = compute_resource(m, compact)
        if compact:
            row["arch"] = compact
        row["gate"] = gate_block(row)
        row.pop("evidence", None)
        rows.append(row)
    if errs:
        sys.exit("seed validation failed:\n  " + "\n  ".join(errs[:60]))
    # One row per model: the same id, official repo, GGUF file or Ollama tag twice is the same
    # model listed twice (two seed scouts found Qwen3-Next and Nemotron Bolt independently).
    for label, keyf in (("id", lambda r: r["id"]), ("repo", lambda r: r.get("repo")),
                        ("gguf", lambda r: (r.get("gguf") or {}).get("repo", "") + "/" +
                         (r.get("gguf") or {}).get("file", "") if r.get("gguf") else None),
                        ("ollama", lambda r: r.get("ollama"))):
        vals = [keyf(r) for r in rows]
        dup = sorted({v for v in vals if v and vals.count(v) > 1})
        if dup:
            sys.exit(f"duplicate {label}: {dup[:6]}")
    rows.sort(key=lambda r: (r["resource"]["min_ram_gb"], r["resource"]["q4_gb"], r["id"]))
    if fetched:
        ARCH.write_text(json.dumps(archdoc, indent=2, sort_keys=True) + "\n")
        print(f"fetched {fetched} architectures from config.json")
    catalog = {
        "version": "4",
        "generated_by": "studio/python/tools/build_model_catalog.py",
        "seed_date": seed.get("seed_date"),
        "note": (
            "Local open-weight catalogue, generated from model-catalog.seed.json + model-arch.json "
            "(do not edit by hand). Each row: official `repo`, `gguf`/`mlx`/`ollama` coordinates, a "
            "two-line `blurb` for the picker, `resource` (RAM/VRAM need at Q4_K_M — measured GGUF "
            "bytes when known) and `gate` (what was vetted at build time). GATING, precisely: a "
            "catalogue row is ELIGIBLE, never trusted — every download is staged and scanned by "
            "nemesis before admission (model weights included: pickle opcodes, GGUF/safetensors "
            "structure, chat-template injection). An ollama-registry pull is scanned after the "
            "pull and removed on a block."),
        "models": rows,
    }
    return catalog, render_ts(rows)


def render_ts(rows: list) -> str:
    keep = ("id", "name", "family", "publisher", "repo", "kind", "params_b", "active_params_b",
            "context", "license", "hf_gated", "released", "gguf", "gguf_small", "mlx", "ollama",
            "ollama_cloud", "tools", "vision", "reasoning", "tags", "has_pickle_files",
            "remote_code", "blurb", "resource", "gate")
    slim = []
    for r in rows:
        o = {k: r[k] for k in keep if k in r and r[k] is not None}
        res = o.get("resource", {})
        o["resource"] = {k: res[k] for k in ("q4_gb", "min_ram_gb", "rec_ram_gb", "gpu_min_vram_gb",
                                             "cpu_ok", "tier", "needs_offload", "label",
                                             "weights_measured", "small_quant", "small_gb",
                                             "small_min_ram_gb") if k in res}
        slim.append(o)
    body = json.dumps(slim, indent=1, ensure_ascii=False)
    return (
        "// SPDX-License-Identifier: Apache-2.0\n"
        "// Copyright 2026 Francesco Pelizza\n"
        "// GENERATED by studio/python/tools/build_model_catalog.py from config/model-catalog.seed.json.\n"
        "// Do not edit by hand — edit the seed and re-run the builder (it also rewrites open-models.json).\n"
        "// (excluded from biome by the `**/*.generated.ts` rule in studio/biome.json)\n"
        "import type { CatalogModel } from \"./catalog-types.js\";\n\n"
        f"export const CATALOG_MODELS: readonly CatalogModel[] = Object.freeze({body} as CatalogModel[]);\n"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--fetch-arch", action="store_true",
                    help="fetch config.json from Hugging Face for rows with no verified arch")
    ap.add_argument("--check", action="store_true", help="fail if generated files are stale")
    a = ap.parse_args()
    catalog, ts = build(a.fetch_arch)
    js = json.dumps(catalog, indent=2, ensure_ascii=False) + "\n"
    if a.check:
        stale = [p for p, want in ((OUT_JSON, js), (OUT_TS, ts))
                 if not p.exists() or p.read_text() != want]
        if stale:
            print("stale generated files: " + ", ".join(str(p) for p in stale))
            return 1
        print("catalogue is up to date")
        return 0
    OUT_JSON.write_text(js)
    OUT_TS.write_text(ts)
    tiers: dict = {}
    for r in catalog["models"]:
        tiers[r["resource"]["tier"]] = tiers.get(r["resource"]["tier"], 0) + 1
    print(f"wrote {len(catalog['models'])} models -> {OUT_JSON.name}, {OUT_TS.name}  tiers={tiers}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
