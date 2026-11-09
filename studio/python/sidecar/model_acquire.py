#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""model_acquire.py — every way model weights reach this machine, each one nemesis-gated.

Imported by modelhub.py (the verbs below are registered there). Three paths:

  stage-hf      Hugging Face → stage dir → sha256 (from HF's own LFS metadata, revision-pinned)
                → nemesis_gate.admit → live library. GGUF files, or a safetensors snapshot
                (MLX / vLLM). Pickle formats and repository code are refused BEFORE a byte is
                downloaded. Resumable (HTTP Range); disk space is checked first.
  ollama-gate   after `ollama pull` (Ollama's registry has no local stage): resolve the tag's
                manifest, scan the model blob(s) and template with nemesis, and `ollama rm`
                the model on a BLOCK. A scan that cannot complete leaves the files but
                refuses the model (fail-closed, nothing large is deleted on a timeout).
  import-ollama serve an ADMITTED GGUF through Ollama: `ollama create` from a Modelfile that
                points at the admitted file. Refuses any path that did not pass the gate.

Nothing here executes downloaded content. Test seams: MODELHUB_HF_BASE (fake HF server),
MODELHUB_OLLAMA_MODELS (fake Ollama store), MODELHUB_FAKE_OLLAMA_CMD_CODE (no ollama binary).
"""
from __future__ import annotations

import contextlib
import fnmatch
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _envelope import emit, fail, opt_value  # noqa: E402
import model_place  # noqa: E402
import nemesis_gate  # noqa: E402

# Files a weights download may contain. Everything else is refused before download.
_ALLOWED_EXTS = (".gguf", ".safetensors", ".json", ".jinja", ".txt", ".model", ".tiktoken",
                 ".md", ".png", ".jpg")
_PICKLE_EXTS = (".bin", ".pt", ".pth", ".ckpt", ".pkl", ".pickle", ".joblib", ".npy", ".npz",
                ".h5", ".keras", ".mar", ".dill", ".pytorch")
_CODE_EXTS = (".py", ".pyc", ".so", ".dylib", ".dll", ".pyd", ".sh", ".exe")
_SHARD_RE = re.compile(r"^(?P<stem>.+)-(?P<i>\d{5})-of-(?P<n>\d{5})\.gguf$")
_TAG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)?(:[A-Za-z0-9._-]+)?$")
_CHUNK = 1 << 20
_CONFIG_READ_MAX = 4 * 1024 * 1024


def _emit_progress(verb: str, pct: int, status: str, **extra: Any) -> None:
    sys.stderr.write(json.dumps({"event": "progress", "verb": verb, "pct": pct,
                                 "status": status[:160], **extra}) + "\n")
    sys.stderr.flush()


# --------------------------------------------------------------------------- HF
def hf_base() -> str:
    return os.environ.get("MODELHUB_HF_BASE", "https://huggingface.co").rstrip("/")


def _hf_request(url: str, headers: Optional[Dict[str, str]] = None) -> urllib.request.Request:
    req = urllib.request.Request(url, headers={"User-Agent": "prometheus-modelhub/1",
                                               **(headers or {})})
    tok = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if tok and url.startswith(hf_base()):
        # UNREDIRECTED: urllib copies ordinary headers onto every redirect, so HF_TOKEN went to
        # the CDN host too (and presigned S3 URLs reject a request that carries one)
        req.add_unredirected_header("Authorization", f"Bearer {tok}")
    return req


def hf_repo_files(repo: str, revision: str) -> Tuple[str, Dict[str, Dict[str, Any]]]:
    """(commit sha, {path: {size, sha256}}) for `repo@revision`, from the HF API with blobs.

    The sha256 of every LFS file comes from Hugging Face itself; it is what the download is
    verified against, and the commit sha pins every file to the same revision."""
    if not re.match(r"^[\w.-]+/[\w.-]+$", repo):
        raise ValueError(f"not an org/name repo id: {repo!r}")
    q = urllib.parse.quote(revision, safe="")
    url = f"{hf_base()}/api/models/{repo}/revision/{q}?blobs=true"
    with urllib.request.urlopen(_hf_request(url), timeout=30) as r:
        info = json.loads(r.read(16 * 1024 * 1024).decode("utf-8"))
    sha = info.get("sha") or revision
    files: Dict[str, Dict[str, Any]] = {}
    for s in info.get("siblings") or []:
        name = s.get("rfilename")
        if not name:
            continue
        lfs = s.get("lfs") or {}
        files[name] = {"size": lfs.get("size", s.get("size")), "sha256": lfs.get("sha256")}
    return str(sha), files


def expand_shards(wanted: List[str], available: Dict[str, Any]) -> List[str]:
    """A split GGUF named by its first shard brings every shard of the same set."""
    out: List[str] = []
    for f in wanted:
        m = _SHARD_RE.match(os.path.basename(f))
        if m:
            prefix = f[: len(f) - len(os.path.basename(f))] + m.group("stem")
            n = int(m.group("n"))
            shards = [f"{prefix}-{i:05d}-of-{n:05d}.gguf" for i in range(1, n + 1)]
            missing = [s for s in shards if s not in available]
            if missing:
                raise ValueError(f"split GGUF is incomplete in the repo: {missing[:2]}")
            out += shards
        else:
            out.append(f)
    return list(dict.fromkeys(out))


def file_refusal(path: str) -> Optional[str]:
    """Why a repo file may not be downloaded as part of a model, or None."""
    low = path.lower()
    if path.startswith("/") or ".." in path.split("/") or "\\" in path:
        return f"unsafe path {path!r}"
    if any(ord(c) < 32 or ord(c) == 127 for c in path):
        # a newline in a file name would become a second directive in the Modelfile
        # (`FROM <path>`) that import-ollama writes
        return f"unsafe path {path!r} (control character)"
    if any(part.startswith(".") for part in path.split("/")):
        # hidden files are never weights — and `.prometheus_model.json` / `.prometheus_gate.json`
        # are Prometheus's own admission records, which a repo must not be able to ship
        return f"{path}: hidden files are never downloaded with a model"
    if low.endswith(_PICKLE_EXTS):
        return f"{path}: pickle-format weights are never downloaded (code runs on load)"
    if low.endswith(_CODE_EXTS):
        return f"{path}: repository code is never downloaded with a model"
    if not low.endswith(_ALLOWED_EXTS):
        return f"{path}: not a weights/tokenizer/config file"
    return None


def snapshot_refusal(files: Dict[str, Any], config: Optional[dict]) -> Optional[str]:
    """A safetensors snapshot that needs code to load is refused before any download."""
    if not any(p.endswith(".safetensors") for p in files):
        return "the repo has no safetensors weights"
    if isinstance(config, dict) and config.get("auto_map"):
        return "the model needs trust_remote_code (config.json auto_map) — use its GGUF/MLX build"
    return None


def _free_bytes(path: Path) -> int:
    p = path
    while not p.exists():
        p = p.parent
    return shutil.disk_usage(p).free


def download_file(url: str, dest: Path, size: Optional[int], sha256: Optional[str],
                  label: str, done_before: int, total: int) -> int:
    """Stream `url` into `dest` (resuming a `.part`), hashing as it goes; verify size and
    sha256. Returns bytes written. Raises on any mismatch (the part file is removed)."""
    part = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    have = part.stat().st_size if part.exists() else 0
    if size is not None and have > size:
        part.unlink()
        have = 0
    if have:
        with part.open("rb") as fh:
            for chunk in iter(lambda: fh.read(_CHUNK), b""):
                h.update(chunk)
    headers = {"Range": f"bytes={have}-"} if have else {}
    req = _hf_request(url, headers)
    last_pct = -1
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            if have and getattr(r, "status", 200) != 206:
                # the server ignored the Range header: start over cleanly
                have = 0
                h = hashlib.sha256()
                mode = "wb"
            else:
                mode = "ab" if have else "wb"
            got = have
            with part.open(mode) as out:
                while True:
                    chunk = r.read(_CHUNK)
                    if not chunk:
                        break
                    out.write(chunk)
                    h.update(chunk)
                    got += len(chunk)
                    if size and got > size:
                        raise ValueError(f"{label}: server sent more than {size} bytes")
                    if total:
                        pct = int((done_before + got) * 100 / total)
                        if pct != last_pct:
                            last_pct = pct
                            _emit_progress("stage-hf", pct, f"{label} {got >> 20} MiB",
                                           bytes=done_before + got, total=total)
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise ConnectionError(f"{label}: download interrupted ({exc}); re-run to resume") from exc
    actual = part.stat().st_size
    if size is not None and actual != size:
        raise ValueError(f"{label}: got {actual} bytes, expected {size} — re-run to resume")
    digest = h.hexdigest()
    if sha256 and digest.lower() != str(sha256).lower():
        part.unlink(missing_ok=True)
        raise ValueError(f"{label}: sha256 mismatch (expected {sha256}, got {digest}) — "
                         "the download was discarded")
    os.replace(part, dest)
    return actual


def pick_gguf(files: Dict[str, Any], quant: str = "Q4_K_M") -> Optional[str]:
    """The GGUF in a repo listing for `quant` (default Q4_K_M, like llama.cpp and Ollama):
    an exact quant token in the name, never a vision projector (mmproj), first shard of a
    split set. None when the repo has no file for that quant."""
    q = quant.upper().replace("-", "_")
    best: List[str] = []
    for p in files:
        base = os.path.basename(p)
        up = base.upper().replace("-", "_")
        if not up.endswith(".GGUF") or "MMPROJ" in up:
            continue
        if re.search(rf"(^|[._]){re.escape(q)}([._]|$)", up[:-5]) or up[:-5].endswith(q):
            m = _SHARD_RE.match(base)
            if m and int(m.group("i")) != 1:
                continue
            best.append(p)
    return sorted(best, key=len)[0] if best else None


def _hf_files_or_fail(cmd: str, repo: str, revision: str) -> Tuple[Optional[Tuple[str, Dict[str, Dict[str, Any]]]], Optional[int]]:
    try:
        return hf_repo_files(repo, revision), None
    except urllib.error.HTTPError as exc:
        hint = ("this repo is gated: accept its licence on huggingface.co and set HF_TOKEN"
                if exc.code in (401, 403) else "")
        return None, fail(cmd, f"Hugging Face API: HTTP {exc.code}", repo=repo, hint=hint)
    except (urllib.error.URLError, ValueError, OSError) as exc:
        return None, fail(cmd, f"Hugging Face API unreachable: {exc}", repo=repo)


def drop_duplicate_formats(chosen: List[str]) -> List[str]:
    """The same weights in two formats are fetched once. Mistral-format repos ship HF shards
    (`model-*.safetensors`, named by model.safetensors.index.json) AND a native
    `consolidated*.safetensors`; a `*.safetensors` include took both — twice the download and
    the disk, for bytes no loader reads together."""
    if any(fnmatch.fnmatch(Path(p).name, "model*.safetensors") for p in chosen):
        return [p for p in chosen if not fnmatch.fnmatch(Path(p).name, "consolidated*.safetensors")]
    return chosen


def v_stage_hf(argv: List[str]) -> int:
    """Download a model from Hugging Face into its stage dir and admit it through nemesis."""
    return _stage_hf(argv, "stage-hf")


def _already_admitted(model_id: str, chosen: List[str],
                      files: Dict[str, Dict[str, Any]]) -> Optional[Path]:
    """The live library dir when it already holds every chosen GGUF with Hugging Face's sha256,
    under a valid admission record (verdict allow, not forced). None otherwise — including for
    safetensors snapshots, whose digests the record does not carry."""
    if not chosen or not all(p.endswith(".gguf") for p in chosen):
        return None
    live = nemesis_gate.live_dir_for(model_id, "huggingface")
    try:
        rec = json.loads((live / ".prometheus_model.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict):
        return None
    # an ALLOW, or a WARN the user accepted (forced) — never a forced block or scanner error:
    # those are not "the same verdict again", they are an override that must be made again
    verdict, forced = rec.get("nemesis_verdict"), bool(rec.get("forced"))
    if not (verdict == "allow" and not forced) and not (verdict == "warn" and forced):
        return None
    if rec.get("nemesis") != nemesis_gate.nemesis_identity():
        return None                     # admitted by another ruleset: scan again
    sig = nemesis_gate.manifest_signature_status(rec)
    if sig == "invalid" or (sig == "unsigned" and nemesis_gate._gate_key()):
        return None
    have = rec.get("files_sha256") or {}
    for p in chosen:
        want = str((files.get(p) or {}).get("sha256") or "").lower()
        if not want or str(have.get(p, "")).lower() != want:
            return None
        f = live / p
        try:
            if not f.is_file() or f.stat().st_size != int((files.get(p) or {}).get("size") or -1):
                return None
            # the bytes, not the record: a file rewritten in place keeps its size and its record
            if nemesis_gate.sha256_file(f).lower() != want:
                return None
        except OSError:
            return None
    return live


def _stage_hf(argv: List[str], cmd: str, after_admit=None) -> int:
    model_id = opt_value(argv, "--id")
    repo = opt_value(argv, "--repo")
    if not model_id or not repo:
        return fail(cmd, "need --id <model id> and --repo <org/name>")
    revision = opt_value(argv, "--revision") or "main"
    wanted = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "--file"]
    includes = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "--include"]
    force = "--force" in argv
    # the user's typed acceptance of a WARN they were shown — admits a WARN, nothing else
    accept_warn = "--accept-warn" in argv
    dry = "--plan" in argv
    # Where the admitted bytes END UP: the serving software's own folder (`hf` = the Hugging
    # Face cache, `lmstudio` = LM Studio's models folder), or `ollama` = a transit copy that
    # import-ollama hands to `ollama create` and then deletes. Never a Prometheus folder.
    place = opt_value(argv, "--place") or "hf"
    if place not in ("hf", "lmstudio", "ollama"):
        return fail(cmd, f"--place must be hf, lmstudio or ollama (got {place!r})")
    got, err = _hf_files_or_fail(cmd, repo, revision)
    if err is not None:
        return err
    sha, files = got  # type: ignore[misc]
    if not wanted and not includes and opt_value(argv, "--quant"):
        pick = pick_gguf(files, opt_value(argv, "--quant") or "Q4_K_M")
        if not pick:
            ggufs = sorted(p for p in files if p.endswith(".gguf"))
            # `no_gguf`: the repo ships NO GGUF at all (a caller may convert it instead) — as
            # opposed to lacking only this quant, where converting is the wrong answer.
            return fail(cmd, f"{repo} has no {opt_value(argv, '--quant')} GGUF file", repo=repo,
                        available=ggufs[:30], **({"no_gguf": True} if not ggufs else {}))
        wanted = [pick]
    if not wanted and not includes:
        return fail(cmd, "name the weights: --file <path> (GGUF), --quant Q (GGUF repo) or "
                         "--include <glob> (snapshot)")
    try:
        chosen = expand_shards(wanted, files) if wanted else []
    except ValueError as exc:
        return fail(cmd, str(exc), repo=repo)
    for pat in includes:
        chosen += [p for p in files if fnmatch.fnmatch(p, pat)]
    chosen = drop_duplicate_formats(list(dict.fromkeys(chosen)))
    if not chosen:
        return fail(cmd, "nothing in the repo matches the requested files", repo=repo,
                    available=sorted(files)[:40])
    missing = [p for p in chosen if p not in files]
    if missing:
        return fail(cmd, f"not in {repo}@{sha[:12]}: {missing[:4]}", repo=repo)
    refusals = [r for r in (file_refusal(p) for p in chosen) if r]
    if refusals:
        return fail(cmd, "refused before download: " + "; ".join(refusals[:4]), repo=repo)
    if includes and not wanted:
        cfg = None
        # Fail CLOSED. A config padded past the read limit, or any fetch/parse failure, used to
        # leave `cfg = None` and skip the auto_map check entirely.
        for name in ("config.json", "tokenizer_config.json"):
            if name not in files:
                continue
            try:
                url = f"{hf_base()}/{repo}/resolve/{sha}/{name}"
                with urllib.request.urlopen(_hf_request(url), timeout=30) as r:
                    raw = r.read(_CONFIG_READ_MAX + 1)
                if len(raw) > _CONFIG_READ_MAX:
                    return fail(cmd, f"refused before download: {name} is over "
                                     f"{_CONFIG_READ_MAX >> 20} MiB", repo=repo)
                doc = json.loads(raw.decode("utf-8"))
            except (urllib.error.URLError, ValueError, OSError) as exc:
                return fail(cmd, f"refused before download: could not read {name} to check "
                                 f"for remote code ({exc})", repo=repo, resumable=True)
            if name == "config.json":
                cfg = doc
            elif isinstance(doc, dict) and doc.get("auto_map"):
                return fail(cmd, "refused before download: tokenizer_config.json declares "
                                 "auto_map (custom tokenizer code)", repo=repo)
        why = snapshot_refusal({p: files[p] for p in chosen}, cfg)
        if why:
            return fail(cmd, f"refused before download: {why}", repo=repo)
    unverifiable = [p for p in chosen if p.endswith((".gguf", ".safetensors"))
                    and not files[p].get("sha256")]
    if unverifiable:
        return fail(cmd, "Hugging Face reports no sha256 for these weight files, so the download "
                         f"could not be verified: {unverifiable[:3]}", repo=repo)
    total = sum(int(files[p].get("size") or 0) for p in chosen)
    stage = nemesis_gate.stage_dir_for(model_id)
    plan = {"repo": repo, "revision": sha, "files": chosen, "bytes": total, "stage_dir": str(stage)}
    # Already placed by an earlier run (here or for another runtime) and still byte-identical:
    # the same single copy serves this pick too.
    want = {p: str(files[p].get("sha256") or "") for p in chosen}
    # files Hugging Face stores in LFS (their cache blob is named by sha256)
    lfs = {p for p in chosen if files[p].get("sha256")}
    # An Ollama import may start from a copy placed for ANY runtime: it is hard-linked into
    # Ollama's blob store, so a model already in the HF cache is never downloaded again.
    hit = model_place.placed_for(model_id, chosen, repo, sha, expected=want,
                                 target=None if place == "ollama" else place)
    if hit is not None:
        if dry:
            return emit(cmd, planned=True, already_admitted=True, **plan)
        result = {"admitted": True, "cached": True, "verdict": "allow", "placed": place,
                  "message": f"already admitted and placed at {hit['local_path']}", **hit}
        result.update(revision=sha, repo=repo, files=chosen, bytes=total)
        if after_admit is not None:
            return after_admit(model_id, result)
        return emit(cmd, **result)
    have = _already_admitted(model_id, chosen, files)
    if have is not None:
        # The library already holds exactly these bytes, admitted and signed: re-downloading a
        # 40 GB model to reach the same verdict was the old behaviour of every retry.
        if dry:
            return emit(cmd, planned=True, already_admitted=True, **plan)
        result = {"admitted": True, "cached": True, "local_path": str(have),
                  "verdict": "allow", "message": f"already admitted at {have}",
                  "weights": [str(have / p) for p in chosen if p.endswith((".gguf", ".safetensors"))]}
        result.update(revision=sha, repo=repo, files=chosen, bytes=total)
        # a legacy library install is moved into its runtime's folder now (migration on use)
        placed = _finish_placement(cmd, model_id, result, repo, sha, place, lfs=lfs)
        if isinstance(placed, int):
            return placed
        if after_admit is not None:
            return after_admit(model_id, placed)
        return emit(cmd, **placed)
    if dry:
        return emit(cmd, planned=True, **plan)
    stage.mkdir(parents=True, exist_ok=True)
    have = sum((stage / p).stat().st_size for p in chosen if (stage / p).exists())
    have += sum((stage / (p + ".part")).stat().st_size for p in chosen
                if (stage / (p + ".part")).exists())
    need = max(0, total - have)
    free = _free_bytes(stage)
    if need + (1 << 30) > free:
        return fail(cmd, f"not enough free disk: need {need >> 30} GiB more, "
                         f"{free >> 30} GiB free at {stage}", **plan)
    done = 0
    expected: Dict[str, str] = {}
    for p in chosen:
        meta = files[p]
        dest = stage / p
        if meta.get("sha256"):
            expected[p] = meta["sha256"]
        if dest.exists() and meta.get("size") is not None and dest.stat().st_size == meta["size"]:
            done += dest.stat().st_size          # already complete; admit re-verifies the hash
            continue
        url = f"{hf_base()}/{repo}/resolve/{sha}/{urllib.parse.quote(p)}"
        try:
            done += download_file(url, dest, meta.get("size"), meta.get("sha256"), p, done, total)
        except (ValueError, ConnectionError) as exc:
            return fail(cmd, str(exc), resumable=isinstance(exc, ConnectionError), **plan)
    # What actually arrived is checked again: the pre-download check read the repo's config at
    # one moment; this reads the bytes that will be admitted.
    why = code_refusal(stage)
    if why and not force:
        return fail(cmd, f"refused after download: {why}", **plan)
    _emit_progress("stage-hf", 100, "scanning with nemesis…")
    result = nemesis_gate.admit(
        model_id, source="huggingface", quant=opt_value(argv, "--quant"),
        license=opt_value(argv, "--license"), expected_sha256=expected or None,
        force=force, staging=stage, accept_warn=accept_warn,
    )
    result.update(revision=sha, repo=repo, files=chosen, bytes=total)
    if result.get("admitted"):
        live = Path(result["local_path"])
        result["weights"] = [str(live / p) for p in chosen if p.endswith((".gguf", ".safetensors"))]
        placed = _finish_placement(cmd, model_id, result, repo, sha, place, lfs=lfs)
        if isinstance(placed, int):
            return placed
        if after_admit is not None:
            return after_admit(model_id, placed)
        return emit(cmd, **placed)
    return emit(cmd, _exit=2, ok=False, **result)


def _finish_placement(cmd: str, model_id: str, result: Dict[str, Any], repo: str,
                      revision: str, place: str, lfs: Optional[set] = None) -> Any:
    """Move the admitted bytes from the gate's library dir into the runtime's own folder.
    Returns the updated result, or an exit code after emitting a refusal (the admitted bytes
    then stay in the library dir, still gated — nothing is lost and nothing is half-moved)."""
    if place == "ollama":
        # a transit copy: import-ollama gives it to `ollama create`, then removes it
        return {**result, "placed": "ollama", "transit": True}
    live = Path(result["local_path"])
    try:
        rec = json.loads((live / ".prometheus_model.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fail(cmd, "admitted, but the admission record is unreadable — not placed",
                    local_path=str(live))
    try:
        placed = model_place.place(model_id, live, rec, place, repo, revision, lfs=lfs)
    except (OSError, ValueError) as exc:
        return fail(cmd, f"admitted, but could not place it in {place}'s folder: {exc}",
                    local_path=str(live), resumable=True)
    out = {**result, "local_path": placed["local_path"], "weights": placed["weights"],
           "placed": place, "store": str(model_place.store_root(place))}
    if placed["deduped"]:
        out["deduped"] = placed["deduped"]
    return out


# --------------------------------------------------------------------------- ollama
# Where an Ollama daemon may keep its store when OLLAMA_MODELS is not set: the per-user default
# (macOS app, `ollama serve` by hand), the official Linux install script's service user, and the
# Arch/Debian package's state dir. Only `~/.ollama/models` used to be read, so on a Linux
# service install every pulled model had "no readable manifest" and was refused.
_OLLAMA_STORE_CANDIDATES = (
    Path.home() / ".ollama" / "models",
    Path("/usr/share/ollama/.ollama/models"),
    Path("/var/lib/ollama/.ollama/models"),
    Path("/var/lib/ollama/models"),
)


def ollama_store_candidates() -> List[Path]:
    env = os.environ.get("MODELHUB_OLLAMA_MODELS") or os.environ.get("OLLAMA_MODELS")
    if env:
        return [Path(env).expanduser()]
    return list(_OLLAMA_STORE_CANDIDATES)


def ollama_models_dir() -> Path:
    """The store in use: an explicit OLLAMA_MODELS, else the first candidate that has one."""
    cands = ollama_store_candidates()
    for c in cands:
        if (c / "manifests").is_dir():
            return c
    return cands[0]


def ollama_store_for(tag: str) -> Path:
    """The store that actually holds `tag`'s manifest (blobs live beside it)."""
    for c in ollama_store_candidates():
        if manifest_path(tag, c).is_file():
            return c
    return ollama_models_dir()


def tag_refusal(tag: str) -> Optional[str]:
    """Only Ollama-registry library tags are pulled through Ollama. A host-qualified tag
    (`hf.co/…`, `huggingface.co/…`, any `host.tld/…`) is someone else's file served through
    Ollama's trust; those go through stage-hf → gate → import-ollama instead."""
    if not tag or len(tag) > 200:
        return "empty or oversized model tag"
    first = tag.split("/", 1)[0]
    if "/" in tag and ("." in first or ":" in first):
        return (f"{tag!r} names a host ({first}); third-party GGUFs are downloaded through the "
                "gated Hugging Face path (stage-hf), never `ollama pull`")
    if not _TAG_RE.match(tag):
        return f"{tag!r} is not an Ollama library tag"
    return None


def manifest_path(tag: str, root: Optional[Path] = None) -> Path:
    root = root or ollama_models_dir()
    name, _, ver = tag.partition(":")
    ver = ver or "latest"
    parts = name.split("/")
    if len(parts) == 1:
        parts = ["library", parts[0]]
    return root / "manifests" / "registry.ollama.ai" / Path(*parts) / ver


_GATED_LAYERS = {
    "application/vnd.ollama.image.model": "model.gguf",
    "application/vnd.ollama.image.projector": "projector.gguf",
    "application/vnd.ollama.image.adapter": "adapter.gguf",
    "application/vnd.ollama.image.template": "template.jinja",
}


def _ollama_cmd(args: List[str], timeout: int = 600) -> int:
    fake = os.environ.get("MODELHUB_FAKE_OLLAMA_CMD_CODE")
    if fake is not None:
        sys.stderr.write(json.dumps({"event": "fake-ollama", "args": args}) + "\n")
        return int(fake)
    if not shutil.which("ollama"):
        return 127
    try:
        return subprocess.run(["ollama", *args], capture_output=True, text=True,
                              timeout=timeout).returncode
    except (OSError, subprocess.SubprocessError):
        return 1


_RANK = {"allow": 0, "warn": 1, "block": 2, "error": 3}


def _ledger_path() -> Path:
    return nemesis_gate.models_root() / ".ollama-gate-ledger.json"


def _ledger() -> Dict[str, Any]:
    try:
        d = json.loads(_ledger_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _nemesis_identity() -> str:
    """sha256 of the nemesis that is scanning. A ledger ALLOW recorded by an older ruleset is not
    an ALLOW from this one: a rule added to catch a new attack must reach models scanned before."""
    return nemesis_gate.nemesis_identity()


def _blob_stat(blob: Path) -> str:
    """size/mtime/ctime/inode of a blob. Ollama names blobs by digest but never re-hashes them
    on load, so a blob rewritten in place keeps its name; the ledger hit has to notice."""
    st = blob.stat()
    return f"{st.st_size}:{st.st_mtime_ns}:{st.st_ctime_ns}:{st.st_ino}"


def _ledger_mac(digest: str, rec: Dict[str, Any]) -> Optional[str]:
    key = nemesis_gate._gate_key()
    if not key:
        return None
    body = f"{digest}|{rec.get('verdict')}|{rec.get('nemesis')}|{rec.get('blob')}".encode()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def _ledger_hit(known: Dict[str, Any], digest: str, blob: Path) -> Optional[str]:
    """The recorded verdict ("allow" | "warn-accepted") when it still applies, else None."""
    rec = known.get(digest)
    if not isinstance(rec, dict) or rec.get("verdict") not in ("allow", "warn-accepted"):
        return None
    try:
        if not blob.is_file() or rec.get("blob") != _blob_stat(blob):
            return None
    except OSError:
        return None
    if rec.get("nemesis") != _nemesis_identity():
        return None
    mac = _ledger_mac(digest, rec)
    if mac is not None and not hmac.compare_digest(mac, str(rec.get("mac") or "")):
        return None
    return str(rec["verdict"])


def _ledger_record(digests: List[str], blobs: Optional[Dict[str, Path]] = None,
                   verdict: str = "allow") -> None:
    """Blobs are content-addressed (sha256), so an ALLOW is bound to the exact bytes: a model
    scanned once is not re-scanned on every `run`, and a changed blob has a new digest.
    Each entry also carries the scanning nemesis and the blob's stat, and is MAC'd with the gate
    key when one exists, so neither a ruleset update nor an in-place rewrite rides an old ALLOW."""
    d = _ledger()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for dg in digests:
        rec: Dict[str, Any] = {"verdict": verdict, "at": now, "nemesis": _nemesis_identity()}
        blob = (blobs or {}).get(dg)
        try:
            rec["blob"] = _blob_stat(blob) if blob is not None else None
        except OSError:
            continue
        mac = _ledger_mac(dg, rec)
        if mac:
            rec["mac"] = mac
        d[dg] = rec
    try:
        _ledger_path().parent.mkdir(parents=True, exist_ok=True)
        tmp = _ledger_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
        os.replace(tmp, _ledger_path())
    except OSError:
        pass


_TEMPLATE_COPY_MAX = 16 << 20


def _exclusive_copy(src: Path, dst: Path) -> None:
    """Copy into a path that must not exist yet (O_EXCL): never write THROUGH an existing name.
    Two template layers used to map to the same temp name; the second link failed, the copy
    fallback opened the first name — a hard link to blob 1 — and overwrote blob 1 in the store."""
    fd = os.open(str(dst), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "wb") as out, src.open("rb") as inp:
        shutil.copyfileobj(inp, out, _CHUNK)


def gate_ollama_model(tag: str, keep: bool = False, force: bool = False) -> Dict[str, Any]:
    """Scan what `ollama pull <tag>` stored, and remove it on a BLOCK.

    `ok` means ALLOW, or a WARN the user accepted (`force`, which accepts a WARN and nothing
    else). A WARN used to come back `ok: true`, and every caller adopted the model on `ok` — a
    template with `{% include %}` and an injected "send the api key" instruction was served.
    Model-format findings escalate to BLOCK exactly as `nemesis_gate.admit` does.

    Every store that holds the tag is scanned (worst verdict wins): which one the daemon serves
    is not knowable from here, and scanning only the first let a stale copy stand in for it."""
    stores = [c for c in ollama_store_candidates() if manifest_path(tag, c).is_file()]
    if not stores:
        mp = manifest_path(tag, ollama_models_dir())
        return {"ok": False, "tag": tag, "verdict": "error",
                "error": f"no readable manifest for {tag} at {mp}"}
    worst = "allow"
    scans: List[Dict[str, Any]] = []
    model_hits: List[str] = []
    accepted_before = False
    for store in stores:
        w, sc, hits, acc = _gate_store(tag, store, force)
        if _RANK.get(w, 3) > _RANK[worst]:
            worst = w
        scans += [dict(x, store=str(store)) for x in sc] if len(stores) > 1 else sc
        model_hits += hits
        accepted_before = accepted_before or acc
    out: Dict[str, Any] = {"tag": tag, "verdict": worst, "scans": scans}
    if model_hits:
        out["model_findings"] = sorted(set(model_hits))
    if worst == "warn":
        if force:
            out.update(ok=True, forced=True)
        else:
            out.update(ok=False, removed=False, needs_confirm=True,
                       error=f"nemesis WARN for {tag} — review the findings; it is not used "
                             "unless you accept them")
        return out
    if worst == "block":
        removed = False if keep else _ollama_cmd(["rm", tag], timeout=120) == 0
        out.update(ok=False, removed=removed,
                   error=f"nemesis BLOCKED {tag}" + (" — removed from Ollama" if removed else ""))
    elif worst == "error":
        out.update(ok=False, removed=False,
                   error=f"{tag} could not be verified; it was NOT removed, but it will not be "
                         "used until a scan succeeds (re-run `ollama-gate`)")
    else:
        out.update(ok=True, **({"accepted_warn": True} if accepted_before else {}))
    return out


def _gate_store(tag: str, store: Path, force: bool) -> Tuple[str, List[Dict[str, Any]], List[str], bool]:
    """(worst, scans, model_hits, served-from-an-accepted-WARN) for `tag` in one store."""
    mp = manifest_path(tag, store)
    try:
        manifest = json.loads(mp.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return "error", [{"verdict": "error", "error": f"no readable manifest at {mp}: {exc}"}], [], False
    blobs = store / "blobs"
    layers = [l for l in manifest.get("layers") or [] if l.get("mediaType") in _GATED_LAYERS]
    if not any(l.get("mediaType") == "application/vnd.ollama.image.model" for l in layers):
        return "error", [{"verdict": "error", "error": "manifest has no model layer"}], [], False
    worst = "allow"
    scans: List[Dict[str, Any]] = []
    known = _ledger()
    ok_now: Dict[str, Path] = {}
    warn_now: Dict[str, Path] = {}
    model_hits: List[str] = []
    accepted = False
    tmp = Path(tempfile.mkdtemp(prefix="ollama-gate-"))
    try:
        for i, layer in enumerate(layers):
            digest = str(layer.get("digest", ""))
            if not re.match(r"^sha256:[0-9a-f]{64}$", digest):
                worst = "error"
                scans.append({"layer": layer.get("mediaType"), "verdict": "error",
                              "error": "malformed digest"})
                continue
            blob = blobs / ("sha256-" + digest.split(":", 1)[1])
            hit = _ledger_hit(known, digest, blob)
            if hit:
                scans.append({"layer": layer.get("mediaType"), "verdict": "allow", "cached": True,
                              **({"accepted_warn": True} if hit == "warn-accepted" else {})})
                accepted = accepted or hit == "warn-accepted"
                continue
            if not blob.is_file():
                worst = "error"
                scans.append({"layer": layer.get("mediaType"), "verdict": "error",
                              "error": f"missing blob {blob.name}"})
                continue
            # Give the scanner the format the blob really is (nemesis dispatches GGUF by magic,
            # templates by name): a hard link (no copy) under a meaningful name — one directory
            # per layer, so two layers of the same type can never share (and write through) a
            # name. A template that cannot be linked is copied (O_EXCL); one too big to copy is
            # an error, because scanned under its blob name the template rules never run.
            slot = tmp / str(i)
            slot.mkdir()
            named = slot / _GATED_LAYERS[layer["mediaType"]]
            target = blob
            try:
                os.link(blob, named)
                target = named
            except OSError:
                if layer["mediaType"].endswith("template"):
                    if blob.stat().st_size > _TEMPLATE_COPY_MAX:
                        worst = "error"
                        scans.append({"layer": layer["mediaType"], "blob": blob.name,
                                      "verdict": "error", "error": "template layer too large to scan"})
                        continue
                    _exclusive_copy(blob, named)
                    target = named
            v = nemesis_gate.nemesis_gate(str(target))
            verdict = v.get("verdict", "error")
            if verdict not in _RANK:
                verdict = "error"
            hits = nemesis_gate._model_findings(v)
            if hits and verdict in ("allow", "warn"):
                verdict = "block"
                model_hits.extend(hits)
            scans.append({"layer": layer["mediaType"], "blob": blob.name, "verdict": verdict,
                          "reasons": list(v.get("blocking_reasons") or [])[:6],
                          **({"model_findings": hits} if hits else {})})
            if verdict == "allow":
                ok_now[digest] = blob
            elif verdict == "warn":
                warn_now[digest] = blob
            if _RANK.get(verdict, 3) > _RANK[worst]:
                worst = verdict
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if ok_now:
        _ledger_record(list(ok_now), ok_now)
    if warn_now and force and worst == "warn":
        # The user accepted THESE bytes' findings: re-verifying the same blobs later (before an
        # adopt) must not ask again — but a changed blob, or a new nemesis, scans afresh.
        _ledger_record(list(warn_now), warn_now, verdict="warn-accepted")
    return worst, scans, model_hits, accepted


def v_ollama_gate(argv: List[str]) -> int:
    tag = opt_value(argv, "--tag")
    if not tag:
        return fail("ollama-gate", "need --tag <name:tag>")
    why = tag_refusal(tag)
    if why:
        return fail("ollama-gate", why, tag=tag)
    res = gate_ollama_model(tag, keep="--keep" in argv,
                            force="--force" in argv or "--accept-warn" in argv)
    if res.get("ok"):
        return emit("ollama-gate", **res)
    res.pop("ok", None)
    return emit("ollama-gate", _exit=2, ok=False, **res)


def v_verify_admitted(argv: List[str]) -> int:
    """ok only when an admission record of the gated library vouches for THIS file as it is now
    (location, signature, sha256). Run before a runtime is pointed at a file: a path remembered
    earlier may have been removed, replaced or rewritten in place since."""
    path = opt_value(argv, "--path")
    folder = opt_value(argv, "--dir")
    if folder:
        drec = admitted_dir(Path(folder).expanduser())
        if not drec:
            return fail("verify-admitted", "no valid admission record vouches for every file in "
                                           "this directory as it is now", path=folder)
        return emit("verify-admitted", ok=True, path=folder, verdict=drec.get("nemesis_verdict"),
                    forced=bool(drec.get("forced")))
    if not path:
        return fail("verify-admitted", "need --path <file> or --dir <model directory>")
    rec = admitted_manifest(Path(path).expanduser())
    if not rec or (rec.get("nemesis_verdict") != "allow" and not rec.get("forced")):
        return fail("verify-admitted", "no valid admission record vouches for this exact file",
                    path=path)
    return emit("verify-admitted", ok=True, path=path, verdict=rec.get("nemesis_verdict"),
                forced=bool(rec.get("forced")))


def v_ollama_discard(argv: List[str]) -> int:
    """Remove a model the user REFUSED after a nemesis WARN.

    A refused WARN used to leave the model in Ollama's store, and the next "use" saw it as
    installed — no pull, so no gate — and adopted it. Refusing now removes it, so the only way
    to that model is another pull, which is scanned again."""
    tag = opt_value(argv, "--tag")
    if not tag:
        return fail("ollama-discard", "need --tag <name:tag>")
    why = tag_refusal(tag)
    if why:
        return fail("ollama-discard", why, tag=tag)
    code = _ollama_cmd(["rm", tag], timeout=120)
    if code != 0:
        return fail("ollama-discard", f"ollama rm exited {code}", tag=tag)
    return emit("ollama-discard", ok=True, tag=tag, removed=True)


def admitted_manifest(path: Path) -> Optional[Dict[str, Any]]:
    """The admission record vouching for `path`, or None: the gate library's own record when the
    file sits in the library (a transit copy, a legacy install), else the placement ledger for
    bytes PLACED into a runtime's own folder. Either way the file's sha256 is re-checked."""
    return _library_manifest(path) or _placed_record(model_place.verify_file(path))


def _library_manifest(path: Path) -> Optional[Dict[str, Any]]:
    """The admission record vouching for `path`, or None.

    Only the record `admit` writes counts: `<models_root>/<source>/<model>/.prometheus_model.json`,
    never one under `.stage/` or `.stage/.quarantine/` (or any dot-directory), signed when a gate
    key exists, and listing THIS file's sha256 — which is re-checked here. It used to accept the
    first `.prometheus_model.json` found walking up from the file, so a repo shipping one with
    `"nemesis_verdict": "allow"` made its staged or quarantined GGUF importable."""
    root = nemesis_gate.models_root().resolve()
    try:
        rp = path.resolve()
        rel = rp.relative_to(root)
    except (OSError, ValueError):
        return None
    parts = rel.parts
    if len(parts) < 3 or any(p.startswith(".") for p in parts):
        return None
    lib = root / parts[0] / parts[1]
    try:
        rec = json.loads((lib / ".prometheus_model.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict):
        return None
    sig = nemesis_gate.manifest_signature_status(rec)
    if sig == "invalid" or (sig == "unsigned" and nemesis_gate._gate_key()):
        # with a key on this machine every record admit wrote is signed: unsigned = not ours
        return None
    want = (rec.get("files_sha256") or {}).get(str(Path(*parts[2:])))
    if not want:
        return None
    try:
        if nemesis_gate.sha256_file(rp).lower() != str(want).lower():
            return None
    except OSError:
        return None
    return rec


def _placed_record(entry: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """A placement-ledger entry in the shape callers read from an admission manifest."""
    if not entry:
        return None
    return {**entry, "nemesis_verdict": entry.get("verdict"), "forced": bool(entry.get("forced")),
            "placed": True}


def admitted_dir(path: Path) -> Optional[Dict[str, Any]]:
    """The admission record vouching for a whole model DIRECTORY as it is now, or None: the
    library's record for a library dir, else the placement ledger for a directory placed into a
    runtime's own folder (an HF snapshot, an LM Studio MLX folder), checked file by file."""
    return _library_dir(path) or _placed_record(model_place.verify_dir(path))


def _library_dir(path: Path) -> Optional[Dict[str, Any]]:
    """The admission record vouching for a whole model DIRECTORY as it is now, or None.

    For snapshot weights (safetensors, MLX) a server is pointed at the directory, not a file.
    The directory must be the library dir `admit` wrote (`<models_root>/<source>/<model>`), its
    record valid and signed when a key exists, its verdict an allow or an accepted WARN — and
    EVERY file in it must be one the record lists, with the recorded sha256. A file added after
    the admit (a planted `modeling_x.py`) or rewritten in place fails the check."""
    root = nemesis_gate.models_root().resolve()
    try:
        rp = path.resolve()
        rel = rp.relative_to(root)
    except (OSError, ValueError):
        return None
    if len(rel.parts) != 2 or any(p.startswith(".") for p in rel.parts) or not rp.is_dir():
        return None
    try:
        rec = json.loads((rp / ".prometheus_model.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict):
        return None
    sig = nemesis_gate.manifest_signature_status(rec)
    if sig == "invalid" or (sig == "unsigned" and nemesis_gate._gate_key()):
        return None
    if rec.get("nemesis_verdict") != "allow" and not rec.get("forced"):
        return None
    want = rec.get("files_sha256") or {}
    if not isinstance(want, dict) or not want:
        return None
    seen = 0
    for f in sorted(rp.rglob("*")):
        relf = f.relative_to(rp)
        if any(part.startswith(".") for part in relf.parts):
            continue                       # the record itself, the gate marker
        if f.is_symlink():
            return None
        if not f.is_file():
            continue
        digest = want.get(str(relf))
        if not digest:
            return None                    # not admitted: added after the scan
        try:
            if nemesis_gate.sha256_file(f).lower() != str(digest).lower():
                return None
        except OSError:
            return None
        seen += 1
    return rec if seen == len(want) else None


def v_import_ollama(argv: List[str]) -> int:
    cmd = "import-ollama"
    model_id = opt_value(argv, "--id")
    path = opt_value(argv, "--path")
    if not model_id or not path:
        return fail(cmd, "need --id <model id> and --path <admitted .gguf>")
    return _import_ollama(cmd, model_id, path)


def _import_ollama(cmd: str, model_id: str, path: str, extra: Optional[Dict[str, Any]] = None) -> int:
    p = Path(path).expanduser()
    if not p.is_file() or not p.name.endswith(".gguf"):
        return fail(cmd, f"not a GGUF file: {p}")
    if any(ord(c) < 32 or ord(c) == 127 for c in str(p.resolve())):
        return fail(cmd, "refused: the path contains a control character", path=repr(str(p)))
    mf = admitted_manifest(p)
    if not mf or mf.get("nemesis_verdict") not in ("allow", "warn", "block", "error"):
        return fail(cmd, "refused: no admission record of the gated model library vouches for "
                         "this exact file (it never passed nemesis, or it changed since); "
                         "download it with stage-hf first", path=str(p))
    if mf.get("nemesis_verdict") != "allow" and not mf.get("forced"):
        return fail(cmd, f"refused: its gate verdict was {mf.get('nemesis_verdict')}", path=str(p))
    safe = re.sub(r"[^a-z0-9._-]+", "-", model_id.lower()).strip("-.") or "model"
    name = f"prometheus/{safe}"
    zc = zero_copy_import(p, mf, name)
    if zc is not None:
        removed = _drop_transit_copy(p)
        return emit(cmd, ok=True, tag=f"{name}:latest", path=str(p), **(extra or {}),
                    zero_copy=zc["method"], blob=zc["blob"],
                    **({"transit_removed": removed} if removed else {}),
                    note="placed straight into Ollama's own store (" + zc["method"] +
                         ") — no second copy was made")
    with tempfile.TemporaryDirectory(prefix="ollama-import-") as td:
        modelfile = Path(td) / "Modelfile"
        modelfile.write_text(f"FROM {p.resolve()}\n", encoding="utf-8")
        code = _ollama_cmd(["create", name, "-f", str(modelfile)], timeout=3600)
    if code != 0:
        return fail(cmd, f"ollama create exited {code}", tag=name, **(extra or {}))
    # Ollama now holds the bytes in its own store. A copy in the gate's library is only a
    # transit copy — removed, so the model exists ONCE, in Ollama's folder. (A file placed in
    # another runtime's folder, or the user's own file, is left alone.)
    removed = _drop_transit_copy(p)
    return emit(cmd, ok=True, tag=f"{name}:latest", path=str(p), **(extra or {}),
                **({"transit_removed": removed} if removed else {}),
                note="the model now lives in Ollama's own store" + (
                    "; the transit copy was removed" if removed else ""))


# --------------------------------------------------------------------------- zero-copy import
# `ollama create` uploads the GGUF into the daemon's blob store — a full second copy while it
# runs (and forever, when the source is a file another runtime also uses). Ollama names a
# model layer `blobs/sha256-<digest>` and `POST /api/create` accepts a `files` map of digests
# it already holds: so the admitted file is renamed (a transit copy) or hard-linked (a file
# placed for another runtime) into the store under that name, the daemon is asked whether it
# sees the blob, and the model is created from it. Any doubt → undo and fall back.

def _ollama_base_url() -> str:
    host = (os.environ.get("OLLAMA_HOST") or "127.0.0.1:11434").strip()
    if "://" not in host:
        host = "http://" + host
    u = urllib.parse.urlsplit(host)
    hostname = u.hostname or "127.0.0.1"
    if hostname in ("0.0.0.0", "::"):
        hostname = "127.0.0.1"           # the server's "all interfaces"; a client uses loopback
    return f"{u.scheme or 'http'}://{hostname}:{u.port or 11434}"


def _ollama_http(method: str, url: str, body: Optional[bytes] = None,
                 timeout: float = 10) -> "tuple[int, bytes]":
    headers = {"Content-Type": "application/json"} if body is not None else {}
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — loopback only
            return r.status, r.read(1 << 20)
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, exc.read(4096)
        except OSError:
            return exc.code, b""
    except (urllib.error.URLError, OSError, ValueError):
        return 0, b""


def _listener_env(port: int) -> Dict[str, str]:
    """The environment of the process listening on `port` — the daemon actually serving, whose
    OLLAMA_MODELS can differ from this process's (an app-launched or orphaned `ollama serve`)."""
    try:
        out = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                             capture_output=True, text=True, timeout=5).stdout.split()
    except (OSError, subprocess.SubprocessError):
        return {}
    if not out or not out[0].isdigit():
        return {}
    pid = out[0]
    environ = Path(f"/proc/{pid}/environ")
    try:
        if environ.is_file():
            raw = environ.read_bytes().split(b"\0")
            return dict(x.decode("utf-8", "replace").split("=", 1) for x in raw if b"=" in x)
        text = subprocess.run(["ps", "eww", "-p", pid], capture_output=True, text=True,
                              timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    m = re.search(r"(?:^|\s)OLLAMA_MODELS=(\S+)", text)
    return {"OLLAMA_MODELS": m.group(1)} if m else {}


def daemon_store(base: Optional[str] = None) -> Path:
    """The running daemon's store: its own OLLAMA_MODELS, else the usual candidates."""
    env = os.environ.get("MODELHUB_OLLAMA_MODELS")
    if env:
        return Path(env).expanduser()
    port = urllib.parse.urlsplit(base or _ollama_base_url()).port or 11434
    v = _listener_env(port).get("OLLAMA_MODELS")
    return Path(v).expanduser() if v else ollama_models_dir()


def _digest_of(p: Path, mf: Dict[str, Any]) -> str:
    d = str(mf.get("sha256") or "").lower()
    if not d:
        for rel, sha in (mf.get("files_sha256") or {}).items():
            if Path(rel).name == p.name:
                d = str(sha).lower()
                break
    return d if re.fullmatch(r"[0-9a-f]{64}", d) else model_place.sha256_file(p)


def zero_copy_import(p: Path, mf: Dict[str, Any], name: str) -> Optional[Dict[str, str]]:
    """Create Ollama model `name` from admitted GGUF `p` without copying it. Returns
    {"method", "blob"} on success, None when the caller must fall back to `ollama create`."""
    if (os.environ.get("MODELHUB_FAKE_OLLAMA_CMD_CODE") is not None
            or os.environ.get("MODELHUB_TEST_STORES")) and not os.environ.get("MODELHUB_ZERO_COPY_TEST"):
        return None                          # tests never reach a real daemon's store
    base = _ollama_base_url()
    if urllib.parse.urlsplit(base).hostname not in ("127.0.0.1", "localhost", "::1"):
        return None                          # a remote daemon's store is not ours to write
    if _ollama_http("GET", f"{base}/api/version", timeout=3)[0] != 200:
        return None
    blobs = daemon_store(base) / "blobs"
    try:
        real = p.resolve(strict=True)
        digest = _digest_of(real, mf)
        blob = blobs / f"sha256-{digest}"
        transit = bool(_drop_transit_candidate(real))
        undo = None
        if blob.exists():
            if blob.stat().st_size != real.stat().st_size:
                return None
            method = "existing"
        elif not blobs.is_dir():
            return None                      # a store this user cannot see or write
        elif real.stat().st_dev == blobs.stat().st_dev:
            if transit:
                os.replace(real, blob)
                method = "moved"
                undo = lambda: os.replace(blob, real)  # noqa: E731
            else:
                os.link(real, blob)
                method = "linked"
                undo = blob.unlink
        elif transit:
            return None                      # across volumes `ollama create` copies, then the
                                             # transit is dropped: still one copy at the end
        else:
            os.symlink(real, blob)
            method = "symlinked"
            undo = blob.unlink
    except OSError:
        return None
    ok = False
    try:
        if _ollama_http("HEAD", f"{base}/api/blobs/sha256:{digest}", timeout=10)[0] == 200:
            body = json.dumps({"model": name, "files": {real.name: f"sha256:{digest}"},
                               "stream": False}).encode()
            status, _out = _ollama_http("POST", f"{base}/api/create", body, timeout=1800)
            ok = status == 200
    finally:
        if not ok and undo is not None:
            with contextlib.suppress(OSError):
                undo()
    if not ok:
        return None
    with contextlib.suppress(OSError, ValueError):
        model_place.record_file(blob, digest, {**model_place.gate_meta(mf), "target": "ollama",
                                               "tag": name, "visible": str(blob)})
    return {"method": method, "blob": str(blob)}


def _drop_transit_candidate(p: Path) -> bool:
    """True when `p` is a transit copy in the gate library (its bytes may be MOVED)."""
    root = nemesis_gate.models_root().resolve()
    try:
        rel = p.resolve().relative_to(root)
    except (OSError, ValueError):
        return False
    return len(rel.parts) >= 3 and not any(x.startswith(".") for x in rel.parts)


def _drop_transit_copy(p: Path) -> List[str]:
    """Delete the weights of the gate-library dir holding `p` (all shards). [] when `p` is not
    in the library (placed elsewhere, or a file of the user's)."""
    root = nemesis_gate.models_root().resolve()
    try:
        rel = p.resolve().relative_to(root)
    except (OSError, ValueError):
        return []
    if len(rel.parts) < 3 or any(x.startswith(".") for x in rel.parts):
        return []
    live = root / rel.parts[0] / rel.parts[1]
    removed: List[str] = []
    for w in model_place.library_weights(live):
        try:
            w.unlink()
            removed.append(str(w))
        except OSError:
            pass
    return removed


def v_hug_ollama(argv: List[str]) -> int:
    """`/hug <org>/<repo>[:QUANT] → ollama`, gated: pick the GGUF for the quant, stage it,
    verify Hugging Face's sha256, admit it through nemesis, import it into Ollama. Replaces
    `ollama pull hf.co/<anyone>/<repo>`, which handed an arbitrary uploader's file to Ollama
    under the registry's trust."""
    repo = opt_value(argv, "--repo") or ""
    quant = opt_value(argv, "--quant") or "Q4_K_M"
    if ":" in repo:
        repo, _, q = repo.partition(":")
        quant = q or quant
    model_id = opt_value(argv, "--id") or repo
    args = [f"--id={model_id}", f"--repo={repo}", f"--quant={quant}", "--place=ollama"]
    if "--force" in argv:
        args.append("--force")
    if "--accept-warn" in argv:
        args.append("--accept-warn")

    def then_import(mid: str, staged: Dict[str, Any]) -> int:
        gguf = [w for w in staged.get("weights") or [] if str(w).endswith(".gguf")]
        if not gguf:
            return fail("hug-ollama", "admitted, but no GGUF file to import", **staged)
        return _import_ollama("hug-ollama", mid, gguf[0],
                              extra={"admitted": True, "repo": staged.get("repo"),
                                     "revision": staged.get("revision"),
                                     "gate": staged.get("gate")})
    return _stage_hf(args, "hug-ollama", after_admit=then_import)


def code_refusal(src: Path) -> Optional[str]:
    """A model directory that would make a loader or converter execute repository code."""
    for name in ("config.json", "tokenizer_config.json"):
        f = src / name
        if f.is_file():
            try:
                cfg = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(cfg, dict) and cfg.get("auto_map"):
                return f"{name} declares auto_map (custom code, trust_remote_code)"
    py = [str(p.relative_to(src)) for p in src.rglob("*") if p.suffix.lower() in _CODE_EXTS]
    if py:
        return f"the directory ships code: {', '.join(py[:4])}"
    pk = [str(p.relative_to(src)) for p in src.rglob("*") if p.suffix.lower() in _PICKLE_EXTS]
    if pk and not any(p.suffix == ".safetensors" for p in src.rglob("*.safetensors")):
        return f"pickle-only weights: {', '.join(pk[:4])}"
    return None


_HF_SAFE_INCLUDES = ["*.safetensors", "*.json", "tokenizer*", "*.model", "*.tiktoken", "*.txt",
                     "*.jinja", "*.md"]
GATE_MARKER = ".prometheus_gate.json"


def tree_fingerprint(root: Path) -> str:
    """Every entry's relpath, type, size, mtime, ctime and inode (symlinks by target). ctime is
    what a rewrite cannot hide: restoring the mtime with `os.utime` used to keep the marker
    valid over swapped bytes."""
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.name == GATE_MARKER and p.parent == root:
            continue
        try:
            st = p.lstat()
            link = os.readlink(p) if p.is_symlink() else ""
        except OSError:
            h.update(f"{p.relative_to(root)}\x00unreadable\n".encode())
            continue
        h.update(f"{p.relative_to(root)}\x00{st.st_mode}\x00{st.st_size}\x00{st.st_mtime_ns}"
                 f"\x00{st.st_ctime_ns}\x00{st.st_ino}\x00{link}\n".encode())
    return h.hexdigest()


def _marker_mac(rec: Dict[str, Any]) -> Optional[str]:
    key = nemesis_gate._gate_key()
    if not key:
        return None
    body = json.dumps({k: rec[k] for k in sorted(rec) if k != "mac"}, sort_keys=True,
                      separators=(",", ":")).encode()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def gate_dir(root: Path, force: bool = False) -> Dict[str, Any]:
    """nemesis over a downloaded source tree; writes a marker bound to the tree's fingerprint
    on an allow (or a forced warn) so a later step can tell the bytes were scanned."""
    # A marker that predates this scan (or arrived with the download) never survives it.
    try:
        (root / GATE_MARKER).unlink()
    except FileNotFoundError:
        pass
    why = code_refusal(root)
    if why:
        return {"ok": False, "verdict": "block", "error": f"refused: {why}"}
    # Fingerprint BEFORE the scan and compare after: bytes swapped in while nemesis ran would
    # otherwise be fingerprinted as if they were the ones scanned.
    before = tree_fingerprint(root)
    v = nemesis_gate.nemesis_gate(str(root))
    verdict = v.get("verdict", "error")
    hits = nemesis_gate._model_findings(v)
    if hits and verdict in ("allow", "warn"):
        verdict = "block"
    if tree_fingerprint(root) != before:
        return {"ok": False, "verdict": "error",
                "error": "the files changed while nemesis was scanning them — not used"}
    if verdict == "allow" or (verdict == "warn" and force):
        rec: Dict[str, Any] = {
            "verdict": verdict, "forced": verdict != "allow", "fingerprint": before,
            "scanned_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        mac = _marker_mac(rec)
        if mac:
            rec["mac"] = mac
        (root / GATE_MARKER).write_text(json.dumps(rec), encoding="utf-8")
        return {"ok": True, "verdict": verdict}
    return {"ok": False, "verdict": verdict,
            "reasons": list(v.get("blocking_reasons") or [])[:6],
            "error": ("nemesis WARN — review, then re-run with --force" if verdict == "warn"
                      else f"nemesis {str(verdict).upper()} — not used")}


def gate_marker_valid(root: Path) -> bool:
    try:
        rec = json.loads((root / GATE_MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(rec, dict) or rec.get("verdict") not in ("allow", "warn"):
        return False
    mac = _marker_mac(rec)
    if mac is not None and not hmac.compare_digest(mac, str(rec.get("mac") or "")):
        return False
    return rec.get("fingerprint") == tree_fingerprint(root)


# --------------------------------------------------------------------------- runtimes
# How each runtime / local-model agent is installed through an OFFICIAL channel. Mirrors the
# auto methods of packages/core/src/ai/runtimes/registry.ts (a TS test reads this table and
# fails on drift). Vendor `curl | sh` scripts are never here — they are MANUAL, shown verbatim.
RUNTIME_INSTALL: Dict[str, Dict[str, Any]] = {
    "ollama": {"bins": ["ollama"], "apps": ["/Applications/Ollama.app"],
               "macos": ("brew-formula", "ollama"), "linux": ("brew-formula", "ollama")},
    "llamacpp": {"bins": ["llama-server", "llama"],
                 "macos": ("brew-formula", "llama.cpp"), "linux": ("brew-formula", "llama.cpp")},
    "lmstudio": {"bins": ["lms"], "needs_bin": True,
                 "apps": ["/Applications/LM Studio.app", "/Applications/Bionic.app"],
                 "macos": ("brew-cask", "lm-studio"),
                 "manual": "curl -fsSL https://lmstudio.ai/install.sh | bash"},
    "mlx": {"bins": ["mlx_lm.server"], "macos": ("brew-formula", "mlx-lm")},
    "jan": {"bins": [], "apps": ["/Applications/Jan.app"], "macos": ("brew-cask", "jan")},
    "opencode": {"bins": ["opencode"], "macos": ("npm-global", "opencode-ai"),
                 "linux": ("npm-global", "opencode-ai")},
    "aider": {"bins": ["aider"], "macos": ("brew-formula", "aider"), "linux": ("brew-formula", "aider")},
    "goose": {"bins": ["goose"], "macos": ("brew-formula", "block-goose-cli"),
              "linux": ("brew-formula", "block-goose-cli")},
    "claude-code": {"bins": ["claude"], "macos": ("npm-global", "@anthropic-ai/claude-code"),
                    "linux": ("npm-global", "@anthropic-ai/claude-code")},
    "codex": {"bins": ["codex"], "macos": ("npm-global", "@openai/codex"),
              "linux": ("npm-global", "@openai/codex")},
    "hermes": {"bins": ["hermes"],
               "manual": "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"},
    "vllm": {"bins": ["vllm"], "manual": "uv venv --python 3.12 && uv pip install vllm --torch-backend=auto"},
    # disk-streaming runtimes (stream_runtimes.py), used only when the user insists on a model
    # too big for RAM: AirLLM through gated pip into Prometheus's own venv; colibri from its
    # pinned source, scanned, built locally (its prebuilt archive is refused by nemesis)
    "airllm": {"bins": [], "macos": ("pip-venv", "airllm"), "linux": ("pip-venv", "airllm")},
    "colibri": {"bins": [], "macos": ("source-build", "colibri"),
                "linux": ("source-build", "colibri")},
}

# runtimes whose install and presence live in stream_runtimes.py
_STREAM_KINDS = ("pip-venv", "source-build")


def _os_family() -> str:
    forced = os.environ.get("MODELHUB_FORCE_OS")
    if forced:
        return forced
    import platform as _p
    return {"Darwin": "macos", "Linux": "linux"}.get(_p.system(), "other")


def runtime_present(rid: str) -> Optional[str]:
    spec = RUNTIME_INSTALL.get(rid) or {}
    if os.environ.get("MODELHUB_FORCE_NOT_INSTALLED"):
        return None
    if any((spec.get(f) or ("",))[0] in _STREAM_KINDS for f in ("macos", "linux")):
        import stream_runtimes  # noqa: WPS433 — late import (stream_runtimes imports this module)
        return stream_runtimes.present(rid)
    for b in spec.get("bins") or []:
        found = shutil.which(b)
        if found:
            return found
        vendor = Path.home() / f".{rid}" / "bin" / b      # ~/.lmstudio/bin/lms and the like
        if vendor.is_file() and os.access(vendor, os.X_OK):
            return str(vendor)
    if spec.get("needs_bin"):
        # the app alone is not enough: Prometheus drives it through its CLI (`lms`), and an
        # app-only install used to read "installed" and then fail with "lms did not start"
        return None
    for a in spec.get("apps") or []:
        if os.path.isdir(a):
            return a
    return None


def install_argv(kind: str, name: str) -> Optional[List[str]]:
    if kind == "brew-formula":
        brew = shutil.which("brew") or next((c for c in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew")
                                             if os.path.exists(c)), None)
        return [brew, "install", "--formula", name] if brew else None
    if kind == "brew-cask":
        brew = shutil.which("brew") or next((c for c in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew")
                                             if os.path.exists(c)), None)
        return [brew, "install", "--cask", "--require-sha", name] if brew else None
    if kind == "npm-global":
        npm = shutil.which("npm")
        return [npm, "install", "-g", name] if npm else None
    return None


def v_install_runtime(argv: List[str]) -> int:
    """Install one runtime or local-model agent through its official package channel."""
    cmd = "install-runtime"
    rid = opt_value(argv, "--runtime") or ""
    spec = RUNTIME_INSTALL.get(rid)
    if not spec:
        return fail(cmd, f"unknown runtime {rid!r}", known=sorted(RUNTIME_INSTALL))
    have = runtime_present(rid)
    if have:
        return emit(cmd, ok=True, installed=True, runtime=rid, path=have, note="already installed")
    fam = _os_family()
    method = spec.get(fam)
    if not method:
        manual = spec.get("manual")
        return emit(cmd, _exit=2, ok=False, runtime=rid, os=fam, manual=True,
                    **({"install": manual} if manual else {}),
                    error=(f"{rid} has no official package for {fam} that Prometheus runs — "
                           + ("run the vendor command yourself after reading it" if manual
                              else "install it from its website")))
    if method[0] in _STREAM_KINDS:
        import stream_runtimes  # noqa: WPS433 — late import (cycle)
        r = stream_runtimes.install(rid, accept_warn="--accept-warn" in argv, plan="--plan" in argv)
        return emit(cmd, **({} if r.get("ok") else {"_exit": 2}), **r)
    argv_install = install_argv(*method)
    if not argv_install:
        return emit(cmd, _exit=2, ok=False, runtime=rid, os=fam, manual=True,
                    error=f"{method[0].split('-')[0]} is not installed — needed for {rid}",
                    install=f"{method[0]}: {method[1]}")
    if "--plan" in argv:
        return emit(cmd, planned=True, runtime=rid, argv=argv_install)
    fake = os.environ.get("MODELHUB_FAKE_INSTALL_CODE")
    if fake is not None:
        code = int(fake)
    else:
        try:
            proc = subprocess.Popen(argv_install, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1)
            if proc.stdout is not None:
                for line in proc.stdout:
                    _emit_progress(cmd, 0, line.rstrip("\n"))
            code = proc.wait(timeout=3600)
        except (OSError, subprocess.SubprocessError) as exc:
            return fail(cmd, f"could not run the installer: {exc}", runtime=rid)
    if code != 0:
        return emit(cmd, _exit=2, ok=False, runtime=rid, cmdline=" ".join(argv_install),
                    error=f"installer exited {code}")
    return emit(cmd, ok=True, installed=True, runtime=rid, cmdline=" ".join(argv_install))


def v_runtimes(argv: List[str]) -> int:
    """What is installed, per runtime/agent — for the `/models runtimes` view."""
    fam = _os_family()
    rows = []
    for rid, spec in RUNTIME_INSTALL.items():
        m = spec.get(fam)
        rows.append({"id": rid, "installed": runtime_present(rid),
                     "auto": f"{m[0]} {m[1]}" if m else None, "manual": spec.get("manual")})
    return emit("runtimes", ok=True, os=fam, runtimes=rows)


# --------------------------------------------------------------------------- migration
def _migrate_one(live: Path, rec: Dict[str, Any], dry: bool) -> Dict[str, Any]:
    """Move one legacy library model's weights into the store that serves them."""
    mid = str(rec.get("id") or live.name)
    weights = model_place.library_weights(live)
    row: Dict[str, Any] = {"id": mid, "from": str(live),
                           "bytes": sum(w.stat().st_size for w in weights)}
    verdict = rec.get("nemesis_verdict")
    if not (verdict == "allow" or (verdict == "warn" and rec.get("forced"))):
        return {**row, "action": "kept", "reason": f"gate verdict {verdict!r} — never placed"}
    files = {k: str(v).lower() for k, v in (rec.get("files_sha256") or {}).items()}
    # the bytes must still be the admitted ones, every file (one changed file = left alone)
    for rel, sha in files.items():
        f = live / rel
        if f.is_file() and model_place.sha256_file(f) != sha:
            return {**row, "action": "kept", "reason": f"{rel} changed since admission"}
    repo = mid if mid.count("/") == 1 else ""
    if repo:
        # an HF snapshot needs the commit: find the upstream revision whose LFS digests ARE
        # these bytes (main first). No network or no match → a store that needs no commit.
        try:
            commit, up = hf_repo_files(repo, "main")
            lfs = {p for p, m in up.items() if m.get("sha256")}
            if all(str(up.get(rel, {}).get("sha256") or "").lower() == sha
                   for rel, sha in files.items() if rel in lfs or rel.endswith((".gguf", ".safetensors"))):
                if dry:
                    return {**row, "action": "would-place", "target": "hf", "revision": commit}
                out = model_place.place(mid, live, rec, "hf", repo, commit, lfs=lfs & set(files))
                return {**row, "action": "placed", "target": "hf", "to": out["local_path"],
                        "weights": out["weights"]}
        except (OSError, ValueError, urllib.error.URLError):
            pass
    if all(w.suffix == ".gguf" for w in weights):
        # llama.cpp reads a GGUF from its own cache; LM Studio / Ollama link it from there
        if dry:
            return {**row, "action": "would-place", "target": "llamacpp"}
        dest = model_place.llamacpp_cache()
        for w in weights:
            rel = str(w.relative_to(live))
            model_place.share(w, dest / w.name, "llamacpp",
                              {**model_place.gate_meta(rec), "rel": rel}, move=True)
        return {**row, "action": "placed", "target": "llamacpp", "to": str(dest),
                "weights": [str(dest / w.name) for w in weights]}
    # a snapshot (safetensors/MLX) with no resolvable commit: LM Studio's folder keeps the
    # repo's own layout and needs no commit id
    org, name = (repo.split("/", 1) if repo else ("local", re.sub(r"[^A-Za-z0-9._-]+", "-", mid)))
    if dry:
        return {**row, "action": "would-place", "target": "lmstudio"}
    out = model_place.place(mid, live, rec, "lmstudio", f"{org}/{name}", "", source=str(rec.get("source") or ""))
    return {**row, "action": "placed", "target": "lmstudio", "to": out["local_path"],
            "weights": out["weights"]}


def v_migrate_library(argv: List[str]) -> int:
    """Move every weight still inside the gated library (`~/.prometheus/models/<source>/<id>`,
    from installs before weights went to each runtime's own folder) into the store that serves
    it — NOW, instead of "the next time that model is picked". The admission record stays (it
    is what vouches for the bytes); nothing is copied; a model whose bytes changed, or whose
    verdict is not an allow / accepted WARN, is left where it is and reported."""
    cmd = "migrate-library"
    dry = "--plan" in argv or "--dry-run" in argv
    root = nemesis_gate.models_root()
    rows: List[Dict[str, Any]] = []
    if root.is_dir():
        for source in sorted(root.iterdir()):
            if not source.is_dir() or source.name.startswith("."):
                continue
            for live in sorted(source.iterdir()):
                if not live.is_dir() or live.name.startswith(".") or not model_place.library_weights(live):
                    continue
                try:
                    rec = json.loads((live / ".prometheus_model.json").read_text(encoding="utf-8"))
                    sig = nemesis_gate.manifest_signature_status(rec) if isinstance(rec, dict) else "invalid"
                    if sig == "invalid" or (sig == "unsigned" and nemesis_gate._gate_key()):
                        rows.append({"id": live.name, "from": str(live), "action": "kept",
                                     "reason": "admission record unsigned or tampered"})
                        continue
                    rows.append(_migrate_one(live, rec, dry))
                except (OSError, ValueError, PermissionError) as exc:
                    rows.append({"id": live.name, "from": str(live), "action": "kept", "reason": str(exc)})
    moved = [r for r in rows if r.get("action") in ("placed", "would-place")]
    # Download leftovers (an abandoned `.part`, a refused or never-accepted WARN, a failed
    # conversion's f16) sit in `.stage` until swept: anything there for three days is swept now
    # — a model nobody finished is never kept as a hidden multi-GB copy.
    swept = _sweep_stage(72, dry)
    return emit(cmd, ok=True, planned=dry, models=rows, moved=len(moved),
                stage_swept=len(swept), stage_bytes=sum(g["bytes"] for g in swept),
                bytes=sum(int(r.get("bytes") or 0) for r in moved),
                note=("nothing left in the Prometheus library — every model lives in its "
                      "runtime's own folder") if not rows else None)


def v_discard_stage(argv: List[str]) -> int:
    """Remove download leftovers under the gate's `.stage` — abandoned `.part` files, refused
    or unaccepted downloads, quarantined BLOCKs — older than `--older-than-hours` (default 24).
    Admitted models are never under `.stage`; this frees space without touching one."""
    cmd = "discard-stage"
    try:
        hours = float(opt_value(argv, "--older-than-hours") or 24)
    except ValueError:
        return fail(cmd, "--older-than-hours must be a number")
    dry = "--plan" in argv
    gone = _sweep_stage(hours, dry)
    return emit(cmd, ok=True, planned=dry, removed=gone, bytes=sum(g["bytes"] for g in gone))


def _sweep_stage(hours: float, dry: bool) -> List[Dict[str, Any]]:
    stage = nemesis_gate.models_root() / ".stage"
    cutoff = time.time() - hours * 3600
    gone: List[Dict[str, Any]] = []
    if stage.is_dir():
        for entry in sorted(stage.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            try:
                if entry.is_file() and not entry.is_symlink() and entry.stat().st_mtime < cutoff:
                    gone.append({"path": str(entry), "bytes": entry.stat().st_size})
                    if not dry:
                        entry.unlink()
                elif entry.is_dir() and not dry and not any(entry.iterdir()):
                    entry.rmdir()
            except OSError:
                continue
    return gone


VERBS = {
    "migrate-library": v_migrate_library,
    "discard-stage": v_discard_stage,
    "install-runtime": v_install_runtime,
    "runtimes": v_runtimes,
    "stage-hf": v_stage_hf,
    "ollama-gate": v_ollama_gate,
    "ollama-discard": v_ollama_discard,
    "verify-admitted": v_verify_admitted,
    "import-ollama": v_import_ollama,
    "hug-ollama": v_hug_ollama,
}
