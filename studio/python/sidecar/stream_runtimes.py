# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""stream_runtimes.py — the disk-streaming runtimes Prometheus sets up itself.

A model that does not fit this machine's RAM is refused by the picker; when the user INSISTS
(and types the model's name), one of these runs it by moving weights between disk and RAM:

  airllm   — github.com/lyogavin/airllm, a Python library that runs a dense model one
             transformer layer at a time. Installed from PyPI into Prometheus's own venv through
             the gated pip spine (wheels only → nemesis → install exactly the scanned bytes).
             AirLLM has no server: Prometheus's own shim (airllm_serve.py) serves it on
             127.0.0.1 with an OpenAI-compatible API.
  colibri  — github.com/JustVugg/colibri, a C engine for very large Mixture-of-Experts models
             that streams experts from NVMe. Its PREBUILT release archive is refused by nemesis
             (HEUR-EXE: native binaries nobody here built), so Prometheus fetches the PINNED
             source commit, scans it, and builds the engines locally with the system compiler.

Security notes that shaped this file (verified against the projects' source, 2026-11-04):
  * AirLLM calls `AutoConfig.from_pretrained(..., trust_remote_code=True)` unconditionally and
    loads its tokenizer the same way. That is only safe because the model directory it is given
    is a nemesis-admitted snapshot that contains NO code and no `auto_map` (stage-hf refuses
    both before download and again after), and because the server runs fully offline. The shim
    re-checks both before it loads anything.
  * AirLLM may fall back to `torch.load` for `.bin` checkpoints; Prometheus never downloads
    pickles, and the install requires torch >= 2.6 (`weights_only=True` by default).
  * colibri's server accepts any request on loopback without a key, so Prometheus always starts
    it with a per-session `COLI_API_KEY` the session alone knows.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _envelope import emit, fail, opt_value  # noqa: E402
import model_acquire  # noqa: E402
import model_place  # noqa: E402
import nemesis_gate  # noqa: E402

# ---------------------------------------------------------------------------- pins
AIRLLM_PIN = "airllm==4.0.0"
# torch >= 2.6 flips torch.load to weights_only=True by default (AirLLM pins only >= 2.4)
AIRLLM_DEPS = ["torch>=2.6"]
# AirLLM's Apple Silicon path (AirLLMLlamaMlx) needs mlx, which it does not declare
AIRLLM_MAC_DEPS = ["mlx"]
AIRLLM_MARKER = ".prometheus-airllm.json"
# AirLLM's Apple Silicon class accepts only these architectures (auto_model.py, 4.0.0)
AIRLLM_MAC_ARCHS = ("LlamaForCausalLM", "MistralForCausalLM")

COLIBRI_REPO = "https://github.com/JustVugg/colibri"
COLIBRI_TAG = "v2.1.0"
COLIBRI_SHA = "704a3f68184b78367a04cb5526e428dc2f90f05b"
COLIBRI_SPARSE = ("/c/", "/ui/", "/LICENSE", "/NOTICE", "/THIRD_PARTY_NOTICES.md")
# the engines `make install` builds (c/Makefile, v2.1.0), minus the image/vision helpers
COLIBRI_ENGINES = ("colibri", "glm53", "inkling", "kimi_k3", "olmoe", "qwen36", "qwen38",
                   "deepseek_v41", "mimo")
COLIBRI_MARKER = ".prometheus-colibri.json"

AIRLLM_PORT = 8094
# Not 8000: that is vLLM's port, and discovery labels whatever answers there as vLLM.
COLIBRI_PORT = 8096
_SHIM = Path(__file__).resolve().parent / "airllm_serve.py"


def _mh():
    """modelhub, imported lazily: it imports model_acquire, which imports this module."""
    import modelhub  # noqa: WPS433 — deliberate late import (cycle)
    return modelhub


def _progress(verb: str, status: str) -> None:
    sys.stderr.write(json.dumps({"event": "progress", "verb": verb, "status": status[:160]}) + "\n")
    sys.stderr.flush()


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _is_mac_arm() -> bool:
    import platform as _p
    forced = os.environ.get("MODELHUB_FORCE_OS")
    if forced:
        return forced == "macos"
    return _p.system() == "Darwin" and _p.machine() == "arm64"


# ---------------------------------------------------------------------------- AirLLM
def airllm_venv() -> Path:
    return _mh()._tool_venv("airllm")


def airllm_python() -> Optional[Path]:
    """The venv's interpreter, when the gated install finished (its marker is written last)."""
    venv = airllm_venv()
    py = _mh()._venv_bin(venv, "python")
    if not py.is_file() or not (venv / AIRLLM_MARKER).is_file():
        return None
    return py


def install_airllm(accept_warn: bool, plan: bool) -> Dict[str, Any]:
    pkgs = [AIRLLM_PIN, *AIRLLM_DEPS, *(AIRLLM_MAC_DEPS if _is_mac_arm() else [])]
    venv = airllm_venv()
    if plan:
        return {"ok": True, "planned": True, "runtime": "airllm", "packages": pkgs,
                "venv": str(venv), "method": "gated pip (wheels only → nemesis → install)"}
    have = airllm_python()
    if have is not None:
        return {"ok": True, "installed": True, "runtime": "airllm", "path": str(have),
                "note": "already installed"}
    mh = _mh()
    why = mh._ensure_venv(venv)
    if why:
        return {"ok": False, "runtime": "airllm", "error": f"AirLLM venv: {why}"}
    _progress("install-runtime", f"installing {' '.join(pkgs)} (gated) …")
    r = mh._gated_pip(venv, pkgs, force=accept_warn)
    if not r.get("ok"):
        out = {"ok": False, "runtime": "airllm", "error": r.get("error") or "gated pip failed",
               **({"gate": r["gate"]} if r.get("gate") else {})}
        if r.get("needs_confirm"):
            out["needs_confirm"] = True
        if r.get("blocked"):
            out["blocked"] = True
        return out
    (venv / AIRLLM_MARKER).write_text(json.dumps({
        "packages": pkgs, "verdict": r.get("verdict"), "forced": bool(r.get("forced")),
        "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, indent=2), encoding="utf-8")
    return {"ok": True, "installed": True, "runtime": "airllm",
            "path": str(mh._venv_bin(venv, "python")), "gate": r.get("gate")}


# ---------------------------------------------------------------------------- colibri
def colibri_dir() -> Path:
    return _mh()._tools_dir() / f"colibri-{COLIBRI_TAG}"


def colibri_models_dir() -> Path:
    return _mh()._tools_dir() / "colibri-models"


def _colibri_files(root: Path) -> List[Path]:
    """The files whose bytes the install record pins: the launcher, the gateway and engines."""
    c = root / "c"
    files = [c / "coli", c / "openai_server.py", c / "family_registry.py"]
    files += [c / e for e in COLIBRI_ENGINES if (c / e).is_file()]
    return files


def colibri_launcher() -> Optional[Path]:
    """`c/coli` of a Prometheus-built colibri whose pinned files are byte-identical to the
    install record. Anything else (edited, half-built, someone else's checkout) is not ours."""
    root = colibri_dir()
    try:
        rec = json.loads((root / COLIBRI_MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict) or rec.get("commit") != COLIBRI_SHA:
        return None
    want = rec.get("sha256") or {}
    if not isinstance(want, dict) or not want:
        return None
    for rel, digest in want.items():
        p = root / rel
        try:
            if not p.is_file() or _sha256(p) != digest:
                return None
        except OSError:
            return None
    launcher = root / "c" / "coli"
    return launcher if launcher.is_file() else None


def _git_head(git: str, repo: Path) -> Optional[str]:
    if git == "/fake/bin/git":  # test seam: no real git exists
        return os.environ.get("MODELHUB_FAKE_GIT_HEAD", COLIBRI_SHA)
    try:
        p = subprocess.run([git, "-c", "core.fsmonitor=false", "-C", str(repo), "rev-parse", "HEAD"],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout.strip() if p.returncode == 0 else None


def _clone_colibri(git: str, stage: Path) -> Optional[str]:
    run = _mh()._run_install
    steps = [
        [git, "-c", "core.fsmonitor=false", "-c", "advice.detachedHead=false", "clone",
         "--depth", "1", "--branch", COLIBRI_TAG, "--single-branch", "--no-tags",
         "--filter=blob:none", "--no-checkout", COLIBRI_REPO, str(stage)],
        [git, "-c", "core.fsmonitor=false", "-C", str(stage), "sparse-checkout", "set",
         "--no-cone", *COLIBRI_SPARSE],
    ]
    for step in steps:
        try:
            code = run(step)
        except OSError as exc:
            return f"could not run git: {exc}"
        if code != 0:
            return f"git exited {code}"
    head = _git_head(git, stage)
    if head != COLIBRI_SHA:
        return (f"{COLIBRI_TAG} resolved to {head or 'nothing'}, not the pinned commit "
                f"{COLIBRI_SHA[:12]} — refusing (the tag may have been moved)")
    try:
        code = run([git, "-c", "core.fsmonitor=false", "-C", str(stage), "checkout", "--detach",
                    COLIBRI_SHA])
    except OSError as exc:
        return f"could not run git checkout: {exc}"
    return None if code == 0 else f"git checkout exited {code}"


def install_colibri(accept_warn: bool, plan: bool) -> Dict[str, Any]:
    dest = colibri_dir()
    make = shutil.which("make")
    cc = shutil.which("clang") or shutil.which("gcc") or shutil.which("cc")
    steps = [f"git clone {COLIBRI_REPO} @ {COLIBRI_TAG} ({COLIBRI_SHA[:12]}, sparse: c/ ui/)",
             "nemesis scans the source (a WARN needs your typed acceptance)",
             f"make -C c {' '.join(COLIBRI_ENGINES)}   # built here, never a prebuilt binary"]
    if plan:
        return {"ok": True, "planned": True, "runtime": "colibri", "dir": str(dest), "steps": steps}
    have = colibri_launcher()
    if have is not None:
        return {"ok": True, "installed": True, "runtime": "colibri", "path": str(have),
                "note": "already installed"}
    mh = _mh()
    git = os.environ.get("MODELHUB_FAKE_GIT") or mh._which("git")
    if not git:
        return {"ok": False, "runtime": "colibri", "manual": True,
                "error": "git is needed to fetch colibri's source", "install": "install git, then retry"}
    fake = os.environ.get("MODELHUB_FAKE_INSTALL_LINES") is not None
    if not fake and (not make or not cc):
        return {"ok": False, "runtime": "colibri", "manual": True,
                "error": "a C compiler and make are needed to build colibri",
                "install": "xcode-select --install   (macOS)  ·  your distro's build-essential (Linux)"}
    if dest.exists() and any(dest.iterdir()):
        # not ours (no valid record) and not empty: never overwrite someone's checkout
        return {"ok": False, "runtime": "colibri", "path": str(dest),
                "error": f"{dest} exists but is not a Prometheus-built colibri — remove it, then retry"}
    dest.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".colibri-stage-", dir=str(dest.parent))) / "colibri"
    try:
        _progress("install-runtime", f"cloning colibri {COLIBRI_TAG} (pinned) …")
        why = _clone_colibri(git, stage)
        if why is None and fake:
            # the fake-install seam runs nothing: plant the files a build would leave
            (stage / "c").mkdir(parents=True, exist_ok=True)
            for name in ("coli", "openai_server.py", "family_registry.py"):
                (stage / "c" / name).write_text("# fake test stub\n", encoding="utf-8")
        if why is None and not (stage / "c" / "coli").is_file():
            why = "the clone finished but colibri's launcher (c/coli) is missing"
        if why:
            return {"ok": False, "runtime": "colibri", "error": why}
        shutil.rmtree(stage / ".git", ignore_errors=True)
        _progress("install-runtime", "nemesis is scanning colibri's source …")
        before = model_acquire.tree_fingerprint(stage)
        v = nemesis_gate.nemesis_gate(str(stage))
        verdict = v.get("verdict", "error")
        gate = nemesis_gate.verdict_summary(v)
        if model_acquire.tree_fingerprint(stage) != before:
            return {"ok": False, "runtime": "colibri", "gate": gate,
                    "error": "the source changed while nemesis was scanning it — not installed"}
        if verdict == "warn" and not accept_warn:
            return {"ok": False, "runtime": "colibri", "needs_confirm": True, "verdict": verdict,
                    "gate": gate, "error": "nemesis WARN on colibri's source — review the findings, "
                                           "then accept by typing the model's name"}
        if verdict not in ("allow", "warn"):
            return {"ok": False, "runtime": "colibri", "blocked": True, "verdict": verdict,
                    "gate": gate, "error": f"nemesis {str(verdict).upper()} on colibri's source — not built"}
        _progress("install-runtime", "building colibri's engines (this takes a few minutes) …")
        if fake:
            code = mh._run_install(["make", "-C", str(stage / "c"), *COLIBRI_ENGINES])
        else:
            code = mh._run_install([make, "-C", str(stage / "c"), *COLIBRI_ENGINES])
        if code != 0:
            return {"ok": False, "runtime": "colibri", "verdict": verdict, "gate": gate,
                    "error": f"building colibri failed (make exited {code})"}
        if fake:
            (stage / "c" / "colibri").write_text("# fake engine\n", encoding="utf-8")
        built = [e for e in COLIBRI_ENGINES if (stage / "c" / e).is_file()]
        if not built:
            return {"ok": False, "runtime": "colibri", "error": "the build produced no engine"}
        record = {
            "repo": COLIBRI_REPO, "tag": COLIBRI_TAG, "commit": COLIBRI_SHA, "verdict": verdict,
            "forced": verdict != "allow", "engines": built,
            "sha256": {str(p.relative_to(stage)): _sha256(p) for p in _colibri_files(stage)},
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        (stage / COLIBRI_MARKER).write_text(json.dumps(record, indent=2), encoding="utf-8")
        if dest.exists():
            dest.rmdir()
        os.replace(str(stage), str(dest))
    finally:
        shutil.rmtree(stage.parent, ignore_errors=True)
    launcher = colibri_launcher()
    if launcher is None:
        return {"ok": False, "runtime": "colibri", "error": "colibri was built but does not verify"}
    return {"ok": True, "installed": True, "runtime": "colibri", "path": str(launcher),
            "engines": built, "gate": gate}


# ---------------------------------------------------------------------------- dispatch
def present(rid: str) -> Optional[str]:
    if rid == "airllm":
        p = airllm_python()
        return str(p) if p else None
    if rid == "colibri":
        p = colibri_launcher()
        return str(p) if p else None
    return None


def install(rid: str, accept_warn: bool, plan: bool) -> Dict[str, Any]:
    if rid == "airllm":
        return install_airllm(accept_warn, plan)
    if rid == "colibri":
        return install_colibri(accept_warn, plan)
    return {"ok": False, "error": f"{rid} is not a streaming runtime"}


def _admitted_snapshot(path: str) -> Optional[str]:
    """None when `path` is a nemesis-admitted model directory with no code; else why not."""
    p = Path(path).expanduser()
    if not p.is_dir():
        return f"{path} is not a directory"
    if model_acquire.admitted_dir(p) is None:
        return ("refused: only a model directory the nemesis gate admitted — every file, "
                "unchanged — can be served")
    why = model_acquire.code_refusal(p)
    if why:
        return f"refused: {why}"
    return None


def _port(argv: List[str], default: int) -> Optional[int]:
    raw = opt_value(argv, "--port")
    if raw is None:
        return default
    try:
        port = int(raw)
    except ValueError:
        return None
    return port if 1024 <= port <= 65535 else None


def _ctx(argv: List[str], default: int) -> Optional[int]:
    raw = opt_value(argv, "--ctx")
    if raw is None:
        return default
    try:
        n = int(raw)
    except ValueError:
        return None
    return n if 512 <= n <= 262144 else None


def _safe_id(raw: Optional[str]) -> Optional[str]:
    import re as _re
    if not raw or not _re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,120}", raw):
        return None
    return raw


def v_runtime_argv(argv: List[str]) -> int:
    """The argv (and env) that serves one admitted model on a streaming runtime.

    The CLI spawns it (engine-bridge is the only TS module that starts processes); this verb
    only decides WHAT runs, so the venv path, the shim and the admission checks live in one
    place. Every path it names was admitted by nemesis or built by `install-runtime`."""
    cmd = "runtime-argv"
    rid = opt_value(argv, "--runtime") or ""
    model = opt_value(argv, "--model") or ""
    mid = _safe_id(opt_value(argv, "--id"))
    if not mid:
        return fail(cmd, "need --id=<catalogue id> (letters, digits, . _ -)")
    if rid == "airllm":
        py = airllm_python()
        if py is None:
            return fail(cmd, "AirLLM is not installed — install-runtime --runtime airllm first")
        why = _admitted_snapshot(model)
        if why:
            return fail(cmd, why, path=model)
        port = _port(argv, AIRLLM_PORT)
        ctx = _ctx(argv, 4096)
        if port is None or ctx is None:
            return fail(cmd, "bad --port or --ctx")
        layers = airllm_layers_dir(mid)
        if not _snapshot_weights(Path(model).expanduser()):
            # a consolidated model: its weights live ONLY in the layer split, which must be the
            # signed one made from THIS snapshot for THIS id
            why = _split_refusal(layers, mid, Path(model).expanduser())
            if why:
                return fail(cmd, why, path=str(layers))
        args = [str(py), "-I", str(_SHIM), f"--model={Path(model).expanduser()}",
                "--host=127.0.0.1", f"--port={port}", f"--alias={mid}", f"--ctx={ctx}",
                f"--layers={layers}"]
        env = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
               "TOKENIZERS_PARALLELISM": "false"}
        return emit(cmd, ok=True, runtime=rid, argv=args, env=env, port=port,
                    base_url=f"http://127.0.0.1:{port}/v1", model=mid)
    if rid == "colibri":
        launcher = colibri_launcher()
        if launcher is None:
            return fail(cmd, "colibri is not installed — install-runtime --runtime colibri first")
        root = colibri_models_dir().resolve()
        mdir = Path(model).expanduser().resolve()
        if root not in mdir.parents or not (mdir / "config.json").is_file():
            return fail(cmd, "refused: only a model directory made by colibri-import can be served",
                        path=model)
        why = _colibri_link_refusal(mdir)
        if why:
            return fail(cmd, why, path=model)
        port = _port(argv, COLIBRI_PORT)
        ctx = _ctx(argv, 8192)
        if port is None or ctx is None:
            return fail(cmd, "bad --port or --ctx")
        # -E -s, not -I: the launcher imports its sibling modules from its own directory
        args = [sys.executable, "-E", "-s", str(launcher), "serve", "--model", str(mdir),
                "--host", "127.0.0.1", "--port", str(port), "--model-id", mid, "--ctx", str(ctx)]
        # COLI_API_KEY is added by the caller (a per-session secret, never on argv)
        return emit(cmd, ok=True, runtime=rid, argv=args, env={"KV_SLOTS": "1"},
                    needs_key_env="COLI_API_KEY", port=port,
                    base_url=f"http://127.0.0.1:{port}/v1", model=mid)
    return fail(cmd, f"unknown streaming runtime {rid!r}", known=["airllm", "colibri"])


def _linked_ggufs(mdir: Path) -> List[Path]:
    """The GGUF files a link-mode colibri model directory reads (its `gguf.json`)."""
    try:
        doc = json.loads((mdir / "gguf.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    found: List[Path] = []

    def walk(v: Any) -> None:
        if isinstance(v, str) and v.endswith(".gguf"):
            p = Path(v)
            found.append(p if p.is_absolute() else (mdir / p))
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(doc)
    return found


def _colibri_link_refusal(mdir: Path, expect: Optional[Path] = None) -> Optional[str]:
    """None when every GGUF the colibri directory reads is one the gate admitted, unchanged."""
    if os.environ.get("MODELHUB_FAKE_INSTALL_LINES") is not None and not (mdir / "gguf.json").exists():
        return None  # hermetic test seam: the fake import writes no gguf.json
    linked = _linked_ggufs(mdir)
    if not linked:
        return "refused: the colibri model directory names no GGUF to verify"
    for g in linked:
        if model_acquire.admitted_manifest(g) is None:
            return f"refused: {g.name} is not a GGUF the nemesis gate admitted (or it changed since)"
    if expect is not None and all(g.resolve() != expect for g in linked):
        return "the colibri directory points at a different GGUF"
    return None


def v_colibri_import(argv: List[str]) -> int:
    """`coli import <admitted gguf> --mode link`: a colibri model directory that READS the
    admitted GGUF in place (nothing copied), written under Prometheus's tools dir."""
    cmd = "colibri-import"
    mid = _safe_id(opt_value(argv, "--id"))
    gguf = opt_value(argv, "--gguf") or ""
    if not mid:
        return fail(cmd, "need --id=<catalogue id>")
    launcher = colibri_launcher()
    if launcher is None:
        return fail(cmd, "colibri is not installed — install-runtime --runtime colibri first")
    g = Path(gguf).expanduser()
    if not g.is_file() or not g.name.endswith(".gguf"):
        return fail(cmd, "need --gguf=<path to the admitted GGUF (first shard)>")
    if model_acquire.admitted_manifest(g.resolve()) is None:
        return fail(cmd, "refused: only a GGUF the nemesis gate admitted can be imported", path=gguf)
    out = colibri_models_dir() / f"{mid}.colibri"
    if (out / "config.json").is_file():
        # reuse only a directory that still points at THIS admitted GGUF
        if _colibri_link_refusal(out, expect=g.resolve()) is None:
            return emit(cmd, ok=True, model_dir=str(out), cached=True)
        shutil.rmtree(out, ignore_errors=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR")}
    env.update({"HF_HUB_OFFLINE": "1"})
    if os.environ.get("MODELHUB_FAKE_INSTALL_LINES") is not None:
        out.mkdir(parents=True, exist_ok=True)
        (out / "config.json").write_text("{}", encoding="utf-8")
        return emit(cmd, ok=True, model_dir=str(out))
    try:
        p = subprocess.run([sys.executable, "-E", "-s", str(launcher), "import", str(g.resolve()),
                            "--out", str(out), "--mode", "link"],
                           capture_output=True, text=True, timeout=1800, env=env)
    except (OSError, subprocess.SubprocessError) as exc:
        return fail(cmd, f"could not run coli import: {exc}")
    if p.returncode != 0 or not (out / "config.json").is_file():
        tail = (p.stderr or p.stdout or "").strip().splitlines()[-3:]
        return fail(cmd, "coli import refused this GGUF (colibri supports Qwen3/3.5/3.6/3.8 MoE, "
                         "DeepSeek V4, GLM-5, Kimi K3, MiMo-V2, OLMoE …): " + " · ".join(tail)[:300])
    return emit(cmd, ok=True, model_dir=str(out))


# --------------------------------------------------------------------------- AirLLM: one copy
# AirLLM re-writes a model as one file per layer and streams them from disk. Kept beside the
# admitted snapshot, that split is a full SECOND copy of the weights. Once the split is complete
# and verified, `airllm-consolidate` records it in the signed placement ledger (bound to its id
# and source snapshot) and frees the snapshot's weight blobs: AirLLM needs only the index,
# config and tokenizer from the snapshot after that. Only sharded snapshots (with a
# model.safetensors.index.json, which AirLLM reads to name the layers) are consolidated.

_INDEX = "model.safetensors.index.json"


def airllm_layers_dir(mid: str) -> Path:
    return _mh()._tools_dir() / "airllm-layers" / mid


def _snapshot_weights(snap: Path) -> List[Path]:
    return sorted(p for p in snap.glob("*.safetensors")) if snap.is_dir() else []


def _split_refusal(layers: Path, mid: str, snap: Path) -> Optional[str]:
    e = model_place.verify_dir(layers)
    if e is None:
        return ("refused: the snapshot's weights were consolidated into an AirLLM layer split, "
                "and that split no longer verifies — download the model again")
    try:
        same_src = Path(str(e.get("source_dir") or "")).resolve() == snap.resolve()
    except OSError:
        same_src = False
    if e.get("model_id") != mid or not same_src or e.get("target") != "airllm-layers":
        return "refused: the layer split was made from a different model or snapshot"
    return None


def v_airllm_consolidate(argv: List[str]) -> int:
    cmd = "airllm-consolidate"
    mid = _safe_id(opt_value(argv, "--id"))
    snap = Path(opt_value(argv, "--model") or "").expanduser()
    if not mid or not snap.is_dir():
        return fail(cmd, "need --id=<id> and --model=<admitted snapshot dir>")
    layers = airllm_layers_dir(mid)
    weights = _snapshot_weights(snap)
    if not weights:
        why = _split_refusal(layers, mid, snap)
        return emit(cmd, ok=why is None, already=True, **({"error": why} if why else {}))
    entry = model_place.verify_dir(snap)
    if entry is None:
        return fail(cmd, "refused: the snapshot is not an admitted placement (every file listed, "
                         "unchanged)", path=str(snap))
    if not (snap / _INDEX).is_file():
        return emit(cmd, ok=True, consolidated=False,
                    note="single-file snapshot: AirLLM still needs model.safetensors — kept")
    rec_path = layers / ".prometheus-layers.json"
    try:
        rec = json.loads(rec_path.read_text(encoding="utf-8"))
        want = rec["sha256"]
        assert isinstance(want, dict) and want
    except (OSError, ValueError, KeyError, AssertionError):
        return fail(cmd, "no complete layer split yet (start the model once first)")
    files: Dict[str, str] = {}
    for rel, sha in want.items():
        f = layers / rel
        if not f.is_file() or model_place.sha256_file(f) != str(sha).lower():
            return fail(cmd, f"the layer split does not verify ({rel}) — nothing was freed")
        files[rel] = str(sha).lower()
    on_disk = sorted(str(p.relative_to(layers)) for p in layers.rglob("*")
                     if p.is_file() and not any(x.startswith(".") for x in p.relative_to(layers).parts))
    if on_disk != sorted(files):
        return fail(cmd, "the layer split holds files its record does not list — nothing was freed")
    meta = {**model_place.gate_meta(entry), "model_id": mid, "target": "airllm-layers",
            "source_dir": str(snap.resolve())}
    model_place.record_dir(layers, files, meta)
    if model_place.verify_dir(layers) is None:
        return fail(cmd, "could not record the layer split — nothing was freed")
    # free the snapshot's weights: the link, and its blob when no other snapshot uses it
    repo = snap.parent.parent
    other_links = [p for p in repo.glob("snapshots/*/**/*") if p.is_symlink() and snap not in p.parents]
    freed = 0
    remaining = dict(entry.get("files") or {})
    gone: List[Path] = []
    for w in weights:
        try:
            blob = w.resolve(strict=True)
        except OSError:
            continue
        size = blob.stat().st_size
        if w.is_symlink():
            w.unlink()
            if not any(_same(o, blob) for o in other_links):
                blob.unlink()
                freed += size
            gone.append(blob)
        else:
            w.unlink()            # a real file (an LM Studio-style folder)
            freed += size
            gone.append(w)
        remaining.pop(str(w.relative_to(snap)), None)
    model_place.forget(gone)
    model_place.record_dir(snap, remaining, {k: v for k, v in entry.items()
                                             if k not in ("files", "mac", "placed_at")})
    return emit(cmd, ok=True, consolidated=True, freed_bytes=freed, layers=str(layers),
                note="the model is stored once: as AirLLM's layer split")


def _same(link: Path, blob: Path) -> bool:
    try:
        return link.resolve(strict=True) == blob
    except OSError:
        return False


VERBS = {
    "airllm-consolidate": v_airllm_consolidate,
    "runtime-argv": v_runtime_argv,
    "colibri-import": v_colibri_import,
}
