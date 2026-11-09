# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""model_place.py — admitted model weights end up in the serving software's OWN folder.

Prometheus has no model folder of its own. A download is staged, sha256-verified and scanned by
nemesis exactly as before (`nemesis_gate.admit`); what changes is where the admitted bytes go
next. They are MOVED — never copied — into the store of the software that will serve them:

  hf        the Hugging Face hub cache (`HF_HUB_CACHE` → `HF_HOME/hub` → `XDG_CACHE_HOME` →
            `~/.cache/huggingface/hub`), in Hugging Face's own layout
            (`models--org--name/blobs/<etag>` + `snapshots/<commit>/<file>` symlinks), so MLX-LM,
            AirLLM, vLLM, transformers, llama.cpp and colibri all read the same single copy;
  lmstudio  LM Studio's models folder (`~/.lmstudio-home-pointer` honoured), as real files under
            `<publisher>/<repo>/`, the layout LM Studio's own downloads use;
  ollama    nothing moves here: `ollama create` puts the bytes in Ollama's own blob store and the
            transit copy is deleted afterwards (`model_acquire._import_ollama`).

When the destination already holds the same bytes (the user downloaded that file with LM Studio,
or with `huggingface-cli`) the new copy is dropped and the existing file is verified and
recorded instead — the dedupe the user asked for.

Admission used to be bound to LOCATION (a file was trusted only inside `~/.prometheus/models`).
Once the bytes live in another tool's folder that proof is gone, so this module keeps a signed
placement LEDGER — Prometheus state, never weights — with each placed file's sha256, size and
inode, its verdict and the nemesis that gave it. `verify_file` / `verify_dir` re-hash the bytes
every time; a file not in the ledger, re-signed by anything else, or changed by a single byte is
not admitted. Records live OUTSIDE the runtimes' folders: a stray JSON file in LM Studio's tree or
an HF snapshot would be indexed as part of the model.
"""
from __future__ import annotations

import contextlib
import hashlib
import hmac
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nemesis_gate  # noqa: E402

TARGETS = ("hf", "lmstudio", "ollama", "llamacpp")
_WEIGHT_EXTS = (".gguf", ".safetensors")


# ---------------------------------------------------------------------------- stores
def hf_hub_cache() -> Path:
    """The Hugging Face hub cache, resolved the way huggingface_hub resolves it."""
    for var in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        v = os.environ.get(var)
        if v:
            return Path(v).expanduser()
    if os.environ.get("HF_HOME"):
        return Path(os.environ["HF_HOME"]).expanduser() / "hub"
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".cache"
    return base / "huggingface" / "hub"


def lmstudio_home() -> Path:
    """LM Studio's home: the pointer it writes when the user moves it, else the legacy
    `~/.cache/lm-studio` when that holds models, else `~/.lmstudio`."""
    pointer = Path.home() / ".lmstudio-home-pointer"
    try:
        target = pointer.read_text(encoding="utf-8").strip() if pointer.is_file() else ""
    except OSError:
        target = ""
    if target:
        return Path(target).expanduser()
    legacy = Path.home() / ".cache" / "lm-studio"
    if (legacy / "models").is_dir():
        return legacy
    return Path.home() / ".lmstudio"


def _lmstudio_setting_folder(home: Path) -> Optional[Path]:
    """The models folder chosen in LM Studio's own settings (My Models → folder), stored as
    `downloadsFolder` in the app's settings.json. None when unset or unreadable."""
    for f in (home / "apps" / "bionic" / "settings.json", home / "settings.json"):
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        v = doc.get("downloadsFolder") if isinstance(doc, dict) else None
        if isinstance(v, str) and v.strip():
            return Path(v.strip()).expanduser()
    return None


def lmstudio_models_root() -> Path:
    """LM Studio's models folder, resolved as LM Studio resolves it: an explicit override, the
    folder chosen in its settings, else `<home>/models`. Returned even when it does not exist."""
    override = os.environ.get("MODELHUB_FORCE_LMSTUDIO_DIR") or os.environ.get("LMSTUDIO_MODELS_DIR")
    if override:
        return Path(override).expanduser()
    home = lmstudio_home()
    return _lmstudio_setting_folder(home) or home / "models"


def llamacpp_cache() -> Path:
    """llama.cpp's own cache for files that are not Hugging Face repos (`--model-url`
    downloads): `LLAMA_CACHE`, else the platform cache dir. (Hub GGUFs go to the Hugging Face
    cache, which llama.cpp's `-hf` has used as its store since 2026-03.)"""
    if os.environ.get("LLAMA_CACHE"):
        return Path(os.environ["LLAMA_CACHE"]).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "llama.cpp"
    xdg = os.environ.get("XDG_CACHE_HOME")
    return (Path(xdg).expanduser() if xdg else Path.home() / ".cache") / "llama.cpp"


def store_root(target: str) -> Path:
    if target == "hf":
        return hf_hub_cache()
    if target == "lmstudio":
        return lmstudio_models_root()
    raise ValueError(f"no folder of its own for target {target!r}")


def _split_repo(repo: str) -> Tuple[str, str]:
    org, _, name = repo.strip("/").partition("/")
    if not org or not name or "/" in name or org in (".", "..") or name in (".", ".."):
        raise ValueError(f"not an org/name repo id: {repo!r}")
    return org, name


def hf_repo_dir(repo: str) -> Path:
    org, name = _split_repo(repo)
    return hf_hub_cache() / f"models--{org}--{name}"


# ---------------------------------------------------------------------------- hashing
def sha256_file(p: Path) -> str:
    return nemesis_gate.sha256_file(p).lower()


def git_blob_sha1(p: Path) -> str:
    """The git object id Hugging Face uses as the etag (and cache blob name) of a non-LFS file."""
    size = p.stat().st_size
    h = hashlib.sha1(f"blob {size}\0".encode())  # noqa: S324 — git's object id, not security
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------- ledger
def _ledger_path() -> Path:
    return nemesis_gate.models_root() / "placements.json"


@contextlib.contextmanager
def _locked() -> Iterator[None]:
    path = _ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_suffix(".lock")
    with open(lock, "a+") as fh:
        try:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        yield


def _load() -> Dict[str, Any]:
    try:
        doc = json.loads(_ledger_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"files": {}, "dirs": {}}
    if not isinstance(doc, dict):
        return {"files": {}, "dirs": {}}
    doc.setdefault("files", {})
    doc.setdefault("dirs", {})
    return doc


def _save(doc: Dict[str, Any]) -> None:
    path = _ledger_path()
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(doc, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _mac(key_path: str, entry: Dict[str, Any]) -> Optional[str]:
    key = nemesis_gate._gate_key()
    if not key:
        return None
    body = json.dumps({"path": key_path, **{k: entry[k] for k in sorted(entry) if k != "mac"}},
                      sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def _signed_ok(key_path: str, entry: Dict[str, Any]) -> bool:
    want = _mac(key_path, entry)
    if want is None:
        # no key on this machine: nothing here could sign or check it (the same rule as the
        # admission manifests — unsigned is accepted only where signing is impossible)
        return True
    return hmac.compare_digest(want, str(entry.get("mac") or ""))


def _verdict_ok(entry: Dict[str, Any]) -> bool:
    v = entry.get("verdict")
    return v == "allow" or (v == "warn" and bool(entry.get("forced")))


def _stat_fields(p: Path) -> Dict[str, int]:
    st = p.stat()
    return {"size": st.st_size, "ino": st.st_ino, "dev": st.st_dev}


def _record_file(doc: Dict[str, Any], real: Path, sha: str, meta: Dict[str, Any]) -> None:
    entry = {"sha256": sha, **_stat_fields(real), **meta,
             "placed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    mac = _mac(str(real), entry)
    if mac:
        entry["mac"] = mac
    doc["files"][str(real)] = entry


def _record_dir(doc: Dict[str, Any], d: Path, files: Dict[str, str], meta: Dict[str, Any]) -> None:
    entry = {"files": dict(sorted(files.items())), **meta,
             "placed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    mac = _mac(str(d), entry)
    if mac:
        entry["mac"] = mac
    doc["dirs"][str(d)] = entry


# ---------------------------------------------------------------------------- verify
def verify_file(path: Path) -> Optional[Dict[str, Any]]:
    """The ledger entry vouching for the bytes at `path` (a symlink is followed), or None.

    The file is re-hashed every time: a size, inode or signature mismatch is a fast refusal,
    and a matching one is still confirmed against the recorded sha256."""
    try:
        real = Path(path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    entry = _load()["files"].get(str(real))
    if not isinstance(entry, dict) or not _signed_ok(str(real), entry) or not _verdict_ok(entry):
        return None
    try:
        if real.stat().st_size != entry.get("size"):
            return None
        if sha256_file(real) != str(entry.get("sha256", "")).lower():
            return None
    except OSError:
        return None
    return entry


def verify_dir(path: Path) -> Optional[Dict[str, Any]]:
    """The ledger entry vouching for a whole placed model DIRECTORY (an HF snapshot or an LM
    Studio MLX folder) as it is now: every file listed, none added, each one's bytes unchanged.
    In an HF snapshot each entry is a symlink that must resolve into THAT repo's `blobs/`."""
    try:
        d = Path(path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    entry = _load()["dirs"].get(str(d))
    if not isinstance(entry, dict) or not _signed_ok(str(d), entry) or not _verdict_ok(entry):
        return None
    want: Dict[str, str] = entry.get("files") or {}
    if not want:
        return None
    blobs = d.parent.parent / "blobs" if entry.get("target") == "hf" else None
    seen = 0
    for f in sorted(d.rglob("*")):
        rel = f.relative_to(d)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if f.is_dir() and not f.is_symlink():
            continue
        digest = want.get(str(rel))
        if not digest:
            return None
        try:
            real = f.resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        if f.is_symlink() and (blobs is None or blobs.resolve() not in real.parents):
            return None
        try:
            if sha256_file(real) != digest.lower():
                return None
        except OSError:
            return None
        seen += 1
    return entry if seen == len(want) else None


def placed_for(model_id: str, rels: List[str], repo: str, revision: str,
               expected: Optional[Dict[str, str]] = None,
               target: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Paths where `rels` of `repo@revision` were already placed and still verify, so a retry
    does not download them again. None when any of them is missing or changed — or when
    `expected` (Hugging Face's current sha256 per file) no longer matches what was admitted.

    `target` limits the hit to one store (an LM Studio pick must get LM Studio's copy, not the
    HF cache's); None accepts any store (an Ollama import hard-links whichever copy exists)."""
    doc = _load()
    out: Dict[str, str] = {}
    for real, e in doc["files"].items():
        if (isinstance(e, dict) and e.get("model_id") == model_id and e.get("repo") == repo
                and e.get("revision") == revision and e.get("rel") in rels
                and e.get("target") in ((target,) if target else ("hf", "lmstudio", "llamacpp"))):
            out[str(e["rel"])] = e.get("visible") or real
    if set(out) != set(rels):
        return None
    current = nemesis_gate.nemesis_identity()
    for rel, p in out.items():
        e = verify_file(Path(p))
        # bytes admitted by ANOTHER nemesis ruleset are scanned again (the library rule too)
        if e is None or e.get("nemesis") != current:
            return None
        # Only LFS files carry an upstream sha256; a small non-LFS file (config.json) is pinned by
        # the commit id the hit already had to match — it used to make every snapshot a miss.
        want = (expected or {}).get(rel)
        if want and str(want).lower() != str(e.get("sha256")):
            return None
    dirs = [k for k, e in doc["dirs"].items() if isinstance(e, dict) and e.get("model_id") == model_id
            and e.get("repo") == repo and e.get("revision") == revision
            and (target is None or e.get("target") == target)]
    return {"weights": [out[r] for r in rels if r.endswith(_WEIGHT_EXTS)],
            "files": out, "local_path": dirs[0] if dirs else str(Path(next(iter(out.values()))).parent)}


def forget(paths: List[Path]) -> None:
    with _locked():
        doc = _load()
        for p in paths:
            for key in (str(p), str(Path(p).expanduser().resolve())):
                doc["files"].pop(key, None)
                doc["dirs"].pop(key, None)
        _save(doc)


# ---------------------------------------------------------------------------- moving
def _same_device(a: Path, b: Path) -> bool:
    try:
        return a.stat().st_dev == b.stat().st_dev
    except OSError:
        return False


def _move_verified(src: Path, dest: Path, sha: str) -> None:
    """Move `src` to `dest` with its sha256 checked at the destination. A rename on one
    filesystem; across filesystems a copy to `<dest>.part`, a hash check, then the rename and
    the source's removal — so the final state is ONE copy, and a torn copy is never visible.
    A failed or interrupted copy removes its partial file (it used to stay, multi-GB, hidden)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if _same_device(src, dest.parent):
        os.replace(src, dest)
        return
    size = src.stat().st_size
    free = shutil.disk_usage(dest.parent).free
    if size + (256 << 20) > free:
        raise OSError(f"not enough free space at {dest.parent}: need {size >> 20} MiB, "
                      f"{free >> 20} MiB free")
    part = dest.with_name(f".{dest.name}.prometheus-part")
    try:
        shutil.copyfile(src, part)
        if sha256_file(part) != sha:
            raise OSError(f"copy of {src.name} did not verify at {dest.parent}")
        os.replace(part, dest)
    finally:
        part.unlink(missing_ok=True)
    src.unlink()


def _same_file(a: Path, b: Path) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _take_existing(src: Path, dest: Path, sha: str) -> Optional[str]:
    """What to do when `dest` already exists. Returns "existing" when it already holds the
    same bytes and `src` may be dropped, "replaced-link" when `dest` was only a link to `src`
    itself (now the real file), None when `dest` was a dangling link (removed: free to place).
    Raises FileExistsError for different content. NEVER deletes the only copy: when `dest` is
    a symlink resolving to `src` (an old Prometheus link in LM Studio's folder), deleting
    `src` as a "duplicate" used to delete the bytes the link pointed at."""
    if dest.is_symlink() and not dest.exists():
        dest.unlink()
        return None
    if _same_file(src, dest):
        if dest.is_symlink():
            os.replace(src, dest)          # the link becomes the file; one copy, no loss
            return "replaced-link"
        return "existing-same-inode"       # a hard link of src: both names are one file
    try:
        same = dest.resolve(strict=True).is_file() and sha256_file(dest.resolve()) == sha
    except (OSError, RuntimeError):
        same = False
    if not same:
        raise FileExistsError(f"{dest} already exists with different content — not replaced")
    return "existing"


def _place_one(src: Path, dest: Path, sha: str) -> str:
    """Put `src` at `dest`. When `dest` already holds the same bytes, drop `src` (dedupe).
    Never overwrites a DIFFERENT file at `dest` — that is the user's, and it is reported."""
    if dest.exists() or dest.is_symlink():
        how = _take_existing(src, dest, sha)
        if how == "existing":
            src.unlink()
            return "existing"
        if how == "existing-same-inode":
            src.unlink()                   # the other name keeps the (same) bytes
            return "existing"
        if how == "replaced-link":
            return "moved"
    _move_verified(src, dest, sha)
    return "moved"


def _rel_link(link: Path, target: Path) -> str:
    return os.path.relpath(target, link.parent)


# Hugging Face's default .gitattributes: files matching these are stored in LFS, so their cache
# blob is named by sha256; everything else by its git object id (sha1).
_LFS_EXTS = (".7z", ".arrow", ".bin", ".bz2", ".ckpt", ".ftz", ".gguf", ".gz", ".h5", ".joblib",
             ".mlmodel", ".model", ".msgpack", ".npy", ".npz", ".onnx", ".ot", ".parquet", ".pb",
             ".pickle", ".pkl", ".pt", ".pth", ".rar", ".safetensors", ".tar", ".tflite", ".tgz",
             ".wasm", ".xz", ".zip", ".zst")
_COMMIT_RE = re.compile(r"[0-9a-f]{40}")


def _is_lfs(rel: str, path: Path, lfs: Optional[set]) -> bool:
    if lfs is not None:
        return rel in lfs
    # unknown (no API listing): the default patterns, and any file over the hub's 10 MiB
    # non-LFS limit
    try:
        big = path.stat().st_size > (10 << 20)
    except OSError:
        big = False
    return rel.lower().endswith(_LFS_EXTS) or big


def place(model_id: str, live: Path, rec: Dict[str, Any], target: str, repo: str,
          revision: str, source: str = "huggingface", lfs: Optional[set] = None) -> Dict[str, Any]:
    """Move the admitted files of `live` into `target`'s store and record them.

    `rec` is the admission manifest `admit` wrote (its `files_sha256` lists every admitted
    file); `lfs` names the files Hugging Face stores in LFS (blob named by sha256). Returns
    {"local_path", "weights", "files", "target", "deduped"}. Leaves only the admission record
    behind in `live`. Raises on any refusal; every file placed before the refusal stays
    recorded in the ledger (it is still admitted), the rest stay in the library.
    """
    if target not in ("hf", "lmstudio"):
        raise ValueError(f"cannot place into {target!r}")
    verdict = rec.get("nemesis_verdict")
    if not (verdict == "allow" or (verdict == "warn" and rec.get("forced"))):
        # a BLOCK (forced or not) is never put where LM Studio / llama.cpp / MLX would load it
        raise PermissionError(f"not placing a model whose gate verdict is {verdict!r}")
    if target == "hf" and not _COMMIT_RE.fullmatch(str(revision or "")):
        # `snapshots/<revision>` is a path: a 40-hex commit only (no `main`, no `../`)
        raise ValueError(f"an HF-cache placement needs the 40-hex commit id, not {revision!r}")
    files: Dict[str, str] = {k: str(v).lower() for k, v in (rec.get("files_sha256") or {}).items()}
    present = {rel: sha for rel, sha in files.items() if (live / rel).is_file()}
    if not present:
        raise FileNotFoundError(f"no admitted files under {live}")
    meta = {"model_id": model_id, "source": source, "repo": repo, "revision": revision,
            "target": target, "verdict": rec.get("nemesis_verdict"),
            "forced": bool(rec.get("forced")), "nemesis": rec.get("nemesis") or nemesis_gate.nemesis_identity()}
    placed: Dict[str, str] = {}
    deduped: List[str] = []
    with _locked():
        doc = _load()
        try:
            local = _place_all(doc, live, present, target, repo, revision, meta, lfs, placed, deduped)
            _record_dir(doc, local.resolve(), present, meta)
        finally:
            # placed files are recorded even when a later one is refused: they left the library,
            # so the ledger is the only thing still vouching for them
            _save(doc)
    # the library dir keeps only the admission record (and is never served from again)
    for rel in present:
        p = live / rel
        with contextlib.suppress(OSError):
            for parent in list(p.parents):
                if parent == live:
                    break
                parent.rmdir()
    weights = [placed[r] for r in present if r.endswith(_WEIGHT_EXTS)]
    return {"local_path": str(local), "weights": weights, "files": placed, "target": target,
            "deduped": deduped}


def _place_all(doc: Dict[str, Any], live: Path, present: Dict[str, str], target: str, repo: str,
               revision: str, meta: Dict[str, Any], lfs: Optional[set],
               placed: Dict[str, str], deduped: List[str]) -> Path:
    if target == "lmstudio":
        org, name = _split_repo(repo)
        base = lmstudio_models_root() / org / name
        for rel, sha in present.items():
            dest = base / rel
            how = _place_one(live / rel, dest, sha)
            if how == "existing":
                deduped.append(rel)
            _record_file(doc, dest.resolve(), sha, {**meta, "rel": rel, "visible": str(dest)})
            placed[rel] = str(dest)
        return base
    else:
        rdir = hf_repo_dir(repo)
        snap = rdir / "snapshots" / revision
        for rel, sha in present.items():
            src = live / rel
            blob_name = sha if _is_lfs(rel, src, lfs) else git_blob_sha1(src)
            blob = rdir / "blobs" / blob_name
            link = snap / rel
            if link.is_symlink() or link.exists():
                # the user's own `hf download` of the same commit: same bytes are fine
                # whatever its blob is called — compare content, not names
                try:
                    existing = link.resolve(strict=True)
                    ok = existing.is_file() and sha256_file(existing) == sha
                except (OSError, RuntimeError):
                    ok = False
                if not ok:
                    raise FileExistsError(f"{link} points at different content — not replaced")
                src.unlink()
                deduped.append(rel)
                _record_file(doc, existing, sha, {**meta, "rel": rel, "visible": str(link)})
                placed[rel] = str(link)
                continue
            how = _place_one(src, blob, sha)
            if how == "existing":
                deduped.append(rel)
            link.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(_rel_link(link, blob), link)
            _record_file(doc, blob.resolve(), sha, {**meta, "rel": rel, "visible": str(link)})
            placed[rel] = str(link)
        ref = rdir / "refs" / "main"
        if not ref.exists():
            ref.parent.mkdir(parents=True, exist_ok=True)
            ref.write_text(revision, encoding="utf-8")
        return snap


def library_weights(live: Path) -> List[Path]:
    """Weight files still sitting in a library dir (a transit copy, or a legacy install)."""
    if not live.is_dir():
        return []
    return [p for p in live.rglob("*") if p.is_file() and p.suffix in _WEIGHT_EXTS]


def share(src: Path, dest: Path, target: str, meta: Dict[str, Any], move: bool = False) -> str:
    """Make admitted bytes at `src` visible at `dest` WITHOUT a second copy: a hard link on one
    filesystem (one set of bytes, two names); across filesystems a symbolic link (LM Studio,
    llama.cpp and the HF cache all follow them — `lms import --symbolic-link` is LM Studio's own
    form). It used to COPY across filesystems: the duplicate this module exists to prevent.
    `move` (a transit or legacy library file) renames instead, so the library keeps no weights.
    `dest` is recorded in the ledger; the caller has already verified `src`.
    Returns existing|linked|symlinked|moved."""
    real = Path(src).expanduser().resolve(strict=True)
    sha = sha256_file(real)
    how: str
    if dest.is_symlink() and not dest.exists():
        dest.unlink()                                  # a dangling link holds no bytes
    if dest.exists() or dest.is_symlink():
        if _same_file(real, dest):
            # dest already IS these bytes (a hard link, or a symlink to them). Moving turns an
            # old link into the real file; sharing leaves the view as it is. Never unlink src.
            if move and dest.is_symlink():
                os.replace(real, dest)
                how = "moved"
            else:
                how = "existing"
        else:
            if _take_existing(real, dest, sha) != "existing":
                raise FileExistsError(f"{dest} already exists with different content — not replaced")
            how = "existing"
            if move:
                real.unlink()
    elif move:
        _move_verified(real, dest, sha)
        how = "moved"
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(real, dest)
            how = "linked"
        except OSError:
            os.symlink(real, dest)
            how = "symlinked"
    record_file(dest, sha, {**meta, "target": target, "visible": str(dest)})
    return how


def record_file(path: Path, sha: str, meta: Dict[str, Any]) -> None:
    """Vouch for the bytes now at `path` (a symlink is recorded under its target). An entry
    that already exists for the same real file keeps its own `visible` path and gains `path`
    as an alias, so a second name never hides the first."""
    real = Path(path).expanduser().resolve()
    with _locked():
        doc = _load()
        old = doc["files"].get(str(real))
        if isinstance(old, dict) and old.get("sha256") == sha and real != Path(path).expanduser().absolute():
            aliases = sorted(set(old.get("aliases") or []) | {str(path)})
            _record_file(doc, real, sha, {**{k: v for k, v in old.items()
                                               if k not in ("mac", "placed_at", "size", "ino", "dev")},
                                            "aliases": aliases})
        else:
            _record_file(doc, real, sha, meta)
        _save(doc)


def remove_placed(model_id: str, quant: Optional[str] = None) -> Dict[str, Any]:
    """Delete what Prometheus PLACED for `model_id` in the HF cache, LM Studio's folder and
    llama.cpp's cache — exactly the files the signed ledger lists, nothing else — and forget
    them. A name hard-linked elsewhere (an Ollama blob made zero-copy) keeps the bytes alive:
    only the last name frees space. Ollama's own copy is removed with `ollama rm`, not here."""
    def _quant_ok(name: str) -> bool:
        return not quant or quant.lower() in re.split(r"[-._]", name.lower())

    removed: List[str] = []
    freed = 0
    with _locked():
        doc = _load()
        mine = [(k, e) for k, e in doc["files"].items()
                if isinstance(e, dict) and e.get("model_id") == model_id
                and e.get("target") in ("hf", "lmstudio", "llamacpp")
                and _quant_ok(Path(str(e.get("rel") or k)).name)]
        touched_dirs = set()
        for real, e in mine:
            names = [Path(str(e.get("visible") or real)), *(Path(a) for a in e.get("aliases") or [])]
            for n in names:
                if n.is_symlink() or (n.exists() and str(n) != real):
                    with contextlib.suppress(OSError):
                        n.unlink()
                        touched_dirs.add(n.parent)
            rp = Path(real)
            with contextlib.suppress(OSError):
                st = rp.stat()
                rp.unlink()
                touched_dirs.add(rp.parent)
                if st.st_nlink == 1:
                    freed += st.st_size
            removed.append(str(names[0]))
            doc["files"].pop(real, None)
        for k, e in list(doc["dirs"].items()):
            if isinstance(e, dict) and e.get("model_id") == model_id and (
                    not quant or not any(Path(d).exists() for d in [k])) and e.get("target") in ("hf", "lmstudio"):
                doc["dirs"].pop(k, None)
                touched_dirs.add(Path(k))
        _save(doc)
    # tidy the folders this emptied (never one that still holds anything)
    stores = {hf_hub_cache().resolve(), lmstudio_models_root().resolve(), llamacpp_cache().resolve()}
    for d in sorted(touched_dirs, key=lambda p: len(p.parts), reverse=True):
        cur = d
        while cur.resolve() not in stores and cur != cur.parent:
            refs = cur / "refs" / "main"
            snaps, blobs = cur / "snapshots", cur / "blobs"
            empty = lambda d: not d.is_dir() or not any(d.iterdir())  # noqa: E731
            if refs.is_file() and empty(snaps) and empty(blobs):
                # an HF repo dir whose last snapshot is gone: its ref points at nothing
                with contextlib.suppress(OSError):
                    refs.unlink()
                    (cur / "refs").rmdir()
                for d in (snaps, blobs):
                    with contextlib.suppress(OSError):
                        d.rmdir()
            try:
                cur.rmdir()
            except OSError:
                break
            cur = cur.parent
    return {"removed": removed, "freed_bytes": freed}


FETCHED_FOR_CONVERT = ".prometheus-fetched-for-convert"


def drop_snapshot(snap: Path) -> int:
    """Remove ONE Hugging Face cache snapshot that Prometheus downloaded only as a conversion
    source (it carries FETCHED_FOR_CONVERT): its links, the blobs no other snapshot uses, and
    the repo dir when it ends up empty. Returns the bytes freed. Never touches a snapshot
    without the marker — the user's own `hf download` stays."""
    if not (snap / FETCHED_FOR_CONVERT).is_file():
        return 0
    repo = snap.parent.parent
    others = [p for p in repo.glob("snapshots/*/**/*") if p.is_symlink() and snap not in p.parents]
    used = set()
    for o in others:
        with contextlib.suppress(OSError, RuntimeError):
            used.add(o.resolve(strict=True))
    freed = 0
    for f in sorted(snap.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        with contextlib.suppress(OSError, RuntimeError):
            if f.is_symlink():
                blob = f.resolve(strict=True)
                f.unlink()
                if blob not in used and blob.exists():
                    freed += blob.stat().st_size
                    blob.unlink()
            elif f.is_file():
                freed += f.stat().st_size
                f.unlink()
            elif f.is_dir():
                f.rmdir()
    with contextlib.suppress(OSError):
        snap.rmdir()
    snaps, blobs = repo / "snapshots", repo / "blobs"
    if (not snaps.is_dir() or not any(snaps.iterdir())) and (not blobs.is_dir() or not any(blobs.iterdir())):
        shutil.rmtree(repo, ignore_errors=True)
    return freed


def record_dir(d: Path, files: Dict[str, str], meta: Dict[str, Any]) -> None:
    with _locked():
        doc = _load()
        _record_dir(doc, d.resolve(), files, meta)
        _save(doc)


def gate_meta(rec: Dict[str, Any]) -> Dict[str, Any]:
    """The ledger fields of an admission record or ledger entry (whichever vouched)."""
    return {"model_id": rec.get("model_id") or rec.get("id"), "source": rec.get("source"),
            "repo": rec.get("repo"), "revision": rec.get("revision"),
            "verdict": rec.get("verdict") or rec.get("nemesis_verdict"),
            "forced": bool(rec.get("forced")),
            "nemesis": rec.get("nemesis") or nemesis_gate.nemesis_identity()}


def under(path: Path, root: Path) -> bool:
    try:
        return root.resolve() in Path(path).expanduser().resolve().parents
    except (OSError, RuntimeError):
        return False
