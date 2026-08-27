#!/usr/bin/env python3
"""metadata.py — atomic file-metadata control sidecar (file 0C, privacy protection).

Gives the user full, atomic control over the metadata of any file THEY choose: read it,
edit a field, erase it, or normalize timestamps — for their own privacy. Inspired by the
vendored `python/tools/wiper_venom.py` (the full forensic CLI), but SELF-CONTAINED here:
it never constructs `ForensicCleaner` (whose __init__ runs anti-forensic process/memory
tricks we must not trigger), never secure-deletes, never self-destructs — it touches
ONLY metadata, on the ONE user-selected file.

Verbs (C7 envelope — exactly one JSON object on stdout):
  inspect   --uri <path>                          read all metadata → JSON
  scrub     --uri <path> [--confirm]              strip all metadata (plan unless --confirm)
  edit      --uri <path> --field <G:tag> --value <v> [--confirm]   set one field (needs exiftool)
  timestomp --uri <path> --mtime <epoch> [--atime <epoch>] [--confirm]   normalize timestamps

SAFETY: every mutating verb is PLAN-ONLY without --confirm (C5 — JS never silently
mutates). Mutations work on a COPY in the same dir, verify the result, then atomically
`os.replace` — the original is NEVER lost on a failed scrub. stdlib-first; exiftool / PIL
/ pikepdf are optional and degrade gracefully.
"""
from __future__ import annotations

import os
import shutil
import stat as statmod
import subprocess
import tempfile
import zipfile
from typing import Any, Dict, List, Optional, Sequence

from _envelope import dispatch, emit, fail, log, opt_value

try:
    import mimetypes
except ImportError:  # pragma: no cover - mimetypes is stdlib
    mimetypes = None  # type: ignore

try:
    from PIL import Image  # type: ignore
except ImportError:
    Image = None  # type: ignore

try:
    import pikepdf  # type: ignore
except ImportError:
    pikepdf = None  # type: ignore

PROG = "metadata"
VERSION = "1.0.0"
_EXIFTOOL = shutil.which("exiftool")


# --- helpers ---------------------------------------------------------------- #

def _require_path(argv: Sequence[str], verb: str) -> Optional[str]:
    uri = opt_value(argv, "--uri")
    if not uri:
        fail(verb, "need --uri <path>")
        return None
    if uri.startswith("-"):
        fail(verb, "path must not start with a dash")
        return None
    real = os.path.realpath(uri)
    if not os.path.isfile(real):
        fail(verb, f"not a file: {uri}")
        return None
    return real


def _tools() -> Dict[str, bool]:
    return {"exiftool": _EXIFTOOL is not None, "pil": Image is not None, "pikepdf": pikepdf is not None}


def _mime(path: str) -> str:
    if mimetypes:
        guess, _ = mimetypes.guess_type(path)
        if guess:
            return guess
    return "application/octet-stream"


def _fs_meta(path: str) -> Dict[str, Any]:
    st = os.stat(path)
    out: Dict[str, Any] = {
        "size": st.st_size,
        "mode": oct(statmod.S_IMODE(st.st_mode)),
        "mtime": st.st_mtime,
        "atime": st.st_atime,
        "ctime": st.st_ctime,
        "uid": getattr(st, "st_uid", None),
        "gid": getattr(st, "st_gid", None),
    }
    bt = getattr(st, "st_birthtime", None)
    if bt is not None:
        out["birthtime"] = bt
    return out


_XATTR_CLI = shutil.which("xattr")  # macOS (no os.listxattr there)


def _xattrs(path: str) -> List[str]:
    listx = getattr(os, "listxattr", None)
    if listx is not None:  # Linux/FreeBSD
        try:
            return sorted(listx(path))
        except OSError:
            return []
    if _XATTR_CLI:  # macOS: `xattr <file>` prints one name per line
        try:
            cp = subprocess.run([_XATTR_CLI, path], capture_output=True, text=True, timeout=15, check=False)
            return sorted(n for n in cp.stdout.splitlines() if n.strip())
        except (OSError, subprocess.SubprocessError):
            return []
    return []


def _exiftool_tags(path: str) -> Dict[str, str]:
    if not _EXIFTOOL:
        return {}
    try:
        import json as _json

        cp = subprocess.run([_EXIFTOOL, "-j", "-G1", "-a", "-s", path], capture_output=True, text=True, timeout=60)
        data = _json.loads(cp.stdout or "[]")
        if not data:
            return {}
        # exiftool returns [{...}]; drop the bookkeeping keys
        raw = data[0]
        return {k: str(v) for k, v in raw.items() if k not in ("SourceFile",)}
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        log(f"exiftool read failed: {exc}")
        return {}


def _image_exif(path: str) -> Dict[str, str]:
    if Image is None:
        return {}
    try:
        with Image.open(path) as im:
            exif = im.getexif()
            return {str(k): str(v) for k, v in exif.items()} if exif else {}
    except Exception as exc:  # noqa: BLE001 - PIL raises many shapes
        log(f"PIL exif read failed: {exc}")
        return {}


def _pdf_info(path: str) -> Dict[str, str]:
    if pikepdf is None:
        return {}
    try:
        with pikepdf.open(path) as pdf:
            info = dict(pdf.docinfo) if pdf.docinfo is not None else {}
            return {str(k): str(v) for k, v in info.items()}
    except Exception as exc:  # noqa: BLE001
        log(f"pikepdf read failed: {exc}")
        return {}


def _office_props(path: str) -> Dict[str, str]:
    """Read docProps/core.xml + app.xml from a zip-based office doc (stdlib zipfile)."""
    out: Dict[str, str] = {}
    try:
        with zipfile.ZipFile(path) as zf:
            for name in ("docProps/core.xml", "docProps/app.xml"):
                if name in zf.namelist():
                    text = zf.read(name).decode("utf-8", "replace")
                    out[name] = text[:2000]
    except (zipfile.BadZipFile, OSError):
        pass
    return out


def _read_tags(path: str) -> Dict[str, Any]:
    """Best metadata read available: exiftool → PIL/pikepdf/zip fallbacks."""
    if _EXIFTOOL:
        tags = _exiftool_tags(path)
        if tags:
            return {"source": "exiftool", "tags": tags}
    mime = _mime(path)
    if mime.startswith("image/"):
        tags = _image_exif(path)
        if tags:
            return {"source": "pil", "tags": tags}
    if mime == "application/pdf" or path.lower().endswith(".pdf"):
        tags = _pdf_info(path)
        if tags:
            return {"source": "pikepdf", "tags": tags}
    office = _office_props(path)
    if office:
        return {"source": "zip", "tags": office}
    return {"source": "none", "tags": {}}


def _inspect_payload(path: str) -> Dict[str, Any]:
    read = _read_tags(path)
    tags = read["tags"]
    return {
        "file": path,
        "mime": _mime(path),
        "fs": _fs_meta(path),
        "xattrs": _xattrs(path),
        "tagSource": read["source"],
        "tags": tags,
        "tagCount": len(tags),
        "tools": _tools(),
    }


# --- verbs ------------------------------------------------------------------ #

def v_inspect(argv: Sequence[str]) -> int:
    path = _require_path(argv, "inspect")
    if path is None:
        return 2
    return emit("inspect", **_inspect_payload(path))


def _strip_to_copy(src: str, tmp: str) -> bool:
    """Strip metadata from `src` into the fresh copy `tmp`. Returns True on success."""
    shutil.copy2(src, tmp)
    if _EXIFTOOL:
        try:
            subprocess.run(
                [_EXIFTOOL, "-all=", "-XMP:all=", "-IPTC:all=", "-overwrite_original", tmp],
                capture_output=True, text=True, timeout=120, check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            log(f"exiftool scrub failed: {exc}")
            return False
    else:
        mime = _mime(src)
        if mime.startswith("image/") and Image is not None:
            try:
                with Image.open(tmp) as im:
                    data = list(im.getdata())
                    clean = Image.new(im.mode, im.size)
                    clean.putdata(data)
                    clean.save(tmp)
            except Exception as exc:  # noqa: BLE001
                log(f"PIL scrub failed: {exc}")
                return False
        elif (mime == "application/pdf" or src.lower().endswith(".pdf")) and pikepdf is not None:
            try:
                with pikepdf.open(tmp, allow_overwriting_input=True) as pdf:
                    with pdf.open_metadata() as meta:
                        meta.clear()
                    if "/Metadata" in pdf.Root:
                        del pdf.Root.Metadata
                    pdf.save(tmp)
            except Exception as exc:  # noqa: BLE001
                log(f"pikepdf scrub failed: {exc}")
                return False
        # else: no content-metadata tool for this type — fs/xattr scrub below still applies.
    # always drop xattrs on the cleaned copy
    _remove_xattrs(tmp)
    return True


def _remove_xattrs(path: str) -> None:
    listx = getattr(os, "listxattr", None)
    rmx = getattr(os, "removexattr", None)
    if listx is not None and rmx is not None:  # Linux/FreeBSD
        try:
            for name in listx(path):
                try:
                    rmx(path, name)
                except OSError:
                    pass
        except OSError:
            pass
        return
    if _XATTR_CLI:  # macOS: clear ALL extended attributes at once
        try:
            subprocess.run([_XATTR_CLI, "-c", path], capture_output=True, text=True, timeout=15, check=False)
        except (OSError, subprocess.SubprocessError):
            pass


def v_scrub(argv: Sequence[str]) -> int:
    path = _require_path(argv, "scrub")
    if path is None:
        return 2
    before = _inspect_payload(path)
    confirm = "--confirm" in argv
    if not confirm:
        # PLAN ONLY — never mutate without the typed confirm (C5).
        return emit("scrub", planned=True, file=path, before={"tagCount": before["tagCount"], "tags": before["tags"], "xattrs": before["xattrs"]},
                    note="re-run with --confirm to erase the metadata")
    tmp_fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".prom-meta-")
    os.close(tmp_fd)
    try:
        if not _strip_to_copy(path, tmp):
            os.unlink(tmp)
            return fail("scrub", "metadata strip failed — original left intact")
        after = _inspect_payload(tmp)
        if after["tagCount"] > before["tagCount"]:
            os.unlink(tmp)
            return fail("scrub", "verification failed (tags not reduced) — original left intact")
        # atomic replace (same dir → same filesystem)
        shutil.copystat(path, tmp)  # keep perms; timestamps normalized below if requested
        # `copystat` also copies EXTENDED ATTRIBUTES on Linux, which put back everything
        # `_strip_to_copy` had just removed — including the `user.xdg.origin.url` /
        # `user.xdg.referrer.url` that browsers stamp on a download, i.e. exactly the
        # provenance a user runs this tool to erase. The report still said `xattrsRemoved: N`
        # while the attributes survived intact. Strip them again, AFTER copystat.
        _remove_xattrs(tmp)
        os.replace(tmp, path)
    except OSError as exc:
        if os.path.exists(tmp):
            os.unlink(tmp)
        return fail("scrub", f"{type(exc).__name__}: {exc} — original left intact")
    final = _inspect_payload(path)
    return emit("scrub", scrubbed=True, file=path,
                before={"tagCount": before["tagCount"]}, after={"tagCount": final["tagCount"]},
                removed=before["tagCount"] - final["tagCount"], xattrsRemoved=len(before["xattrs"]))


def v_edit(argv: Sequence[str]) -> int:
    path = _require_path(argv, "edit")
    if path is None:
        return 2
    field = opt_value(argv, "--field")
    value = opt_value(argv, "--value")
    if not field or value is None:
        return fail("edit", "need --field <Group:Tag> --value <value>")
    if field.startswith("-") or value.startswith("-"):
        return fail("edit", "field/value must not start with a dash")
    if not _EXIFTOOL:
        return fail("edit", "exiftool is required to edit a metadata field (not found on PATH)")
    if "--confirm" not in argv:
        return emit("edit", planned=True, file=path, field=field, value=value,
                    note="re-run with --confirm to write the field")
    tmp_fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".prom-meta-")
    os.close(tmp_fd)
    try:
        shutil.copy2(path, tmp)
        cp = subprocess.run([_EXIFTOOL, f"-{field}={value}", "-overwrite_original", tmp],
                            capture_output=True, text=True, timeout=60, check=False)
        if cp.returncode != 0:
            os.unlink(tmp)
            return fail("edit", f"exiftool failed: {(cp.stderr or '').strip()[-200:]} — original left intact")
        os.replace(tmp, path)
    except (OSError, subprocess.SubprocessError) as exc:
        if os.path.exists(tmp):
            os.unlink(tmp)
        return fail("edit", f"{type(exc).__name__}: {exc} — original left intact")
    return emit("edit", edited=True, file=path, field=field, value=value)


def v_timestomp(argv: Sequence[str]) -> int:
    path = _require_path(argv, "timestomp")
    if path is None:
        return 2
    mtime_s = opt_value(argv, "--mtime")
    if not mtime_s:
        return fail("timestomp", "need --mtime <epoch seconds>")
    try:
        mtime = float(mtime_s)
        atime = float(opt_value(argv, "--atime") or mtime_s)
    except ValueError:
        return fail("timestomp", "--mtime/--atime must be epoch seconds")
    if "--confirm" not in argv:
        return emit("timestomp", planned=True, file=path, mtime=mtime, atime=atime,
                    current=_fs_meta(path), note="re-run with --confirm to set the timestamps")
    try:
        os.utime(path, (atime, mtime))
    except OSError as exc:
        return fail("timestomp", f"{type(exc).__name__}: {exc}")
    return emit("timestomp", stomped=True, file=path, mtime=mtime, atime=atime, fs=_fs_meta(path))


def v_version(_argv: Sequence[str]) -> int:
    return emit("version", version=VERSION, tools=_tools())


HANDLERS = {
    "inspect": v_inspect,
    "scrub": v_scrub,
    "edit": v_edit,
    "timestomp": v_timestomp,
    "version": v_version,
}


if __name__ == "__main__":
    import sys

    raise SystemExit(dispatch(PROG, HANDLERS, sys.argv[1:]))
