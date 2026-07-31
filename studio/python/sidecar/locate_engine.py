#!/usr/bin/env python3
"""locate_engine.py — deterministic, cross-OS resolution of the Studio engine.

File 01 §11.4. The Studio MAIN/engine-bridge needs to spawn the Python engine
(``prometheus.py``), the ``nemesis`` scanner binary, and the Python interpreter
that runs ``prometheus.py``. This sidecar resolves those three paths using the
SAME precedence the JS bridge uses (``engine-bridge/src/config.ts``) so both
layers agree on where the engine lives.

Resolution order (per binary, first hit wins):

  prometheus.py : ``$PROMETHEUS_PY`` → sibling PROMETHEUS root (walk up from this
                  file) → ``shutil.which("prometheus.py")`` on PATH → null.
  nemesis       : ``$NEMESIS_BIN`` → sibling PROMETHEUS root → ``which("nemesis")``
                  → null.
  python        : ``$PYTHON`` → ``$PYTHON_BIN`` → ``which("python3")`` →
                  ``which("python")`` → ``sys.executable`` → ``"python3"``.

GOLDEN RULE (C5): this layer NEVER decides anything is "safe" and NEVER throws on
a missing binary. A binary that cannot be located is reported as ``null`` with a
``source`` of ``"unresolved"`` and ``ok:false`` plus a human ``reason``. The spawn
layer upstream fail-closes (BLOCK) on a null/missing engine; this module only
*locates*, it never executes.

CLI::

    python3 locate_engine.py --json

Emits ONE JSON object on stdout via the shared ``_envelope`` helper::

    {ok, command:"locate_engine", prometheus_py, nemesis_bin, python_bin,
     root, sources:{prometheus_py, nemesis_bin, python_bin}, reason?}

``ok`` is true only when BOTH ``prometheus_py`` AND ``nemesis_bin`` resolved to an
existing file (``python_bin`` always resolves — at worst the literal "python3").
"""
from __future__ import annotations

import os
import shutil
import sys
from typing import Dict, List, Optional, Tuple

# Allow ``python3 locate_engine.py`` from any CWD: ensure this dir is importable
# so the sibling ``_envelope`` module is found regardless of how we were spawned.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from _envelope import emit, log  # noqa: E402  (path bootstrap must precede import)

COMMAND = "locate_engine"

#: How many parent dirs to walk up from this file looking for the engine root.
#: …/PROMETHEUS/studio/python/sidecar/locate_engine.py → up 3 dirs = …/PROMETHEUS
_WALK_UP_MAX = 6


def _env(name: str) -> Optional[str]:
    """Return a non-empty, stripped env var value, else None."""
    val = os.environ.get(name)
    if val is None:
        return None
    val = val.strip()
    return val or None


def _is_file(path: Optional[str]) -> bool:
    """True iff ``path`` is a non-empty string pointing at an existing regular file."""
    return bool(path) and os.path.isfile(path)  # type: ignore[arg-type]


def find_sibling_root(start: Optional[str] = None) -> Optional[str]:
    """Walk up from this file to the PROMETHEUS repo root holding the engine.

    The root is the first ancestor directory that contains ``prometheus.py``.
    Mirrors ``engine-bridge/src/config.ts``'s ``siblingRoot()``. Returns the
    absolute root dir, or ``None`` when no ancestor carries the engine.
    """
    here = os.path.abspath(start or _HERE)
    # If start is a file, begin from its directory.
    if os.path.isfile(here):
        here = os.path.dirname(here)
    seen = set()
    for _ in range(_WALK_UP_MAX + 1):
        if here in seen:
            break
        seen.add(here)
        if os.path.isfile(os.path.join(here, "prometheus.py")):
            return here
        parent = os.path.dirname(here)
        if parent == here:  # reached filesystem root
            break
        here = parent
    return None


def _resolve_named(
    *,
    env_names: Tuple[str, ...],
    root: Optional[str],
    root_filename: Optional[str],
    which_names: Tuple[str, ...],
) -> Tuple[Optional[str], str]:
    """Resolve one binary, returning ``(path_or_None, source_label)``.

    Precedence: each env var in order (only if it points at an existing file) →
    the sibling ``root``/``root_filename`` (if it exists) → ``shutil.which`` over
    ``which_names`` → ``(None, "unresolved")``.

    An env var that is *set* but does not point at an existing file is reported via
    ``"env:<NAME>(missing)"`` so a typo is visible rather than silently skipped.
    """
    missing_env: Optional[str] = None
    for name in env_names:
        val = _env(name)
        if val is None:
            continue
        if _is_file(val):
            return os.path.abspath(val), f"env:{name}"
        # Set-but-broken override: remember the first, keep looking deterministically.
        if missing_env is None:
            missing_env = name

    if root and root_filename:
        candidate = os.path.join(root, root_filename)
        if _is_file(candidate):
            return os.path.abspath(candidate), "sibling-root"

    for wname in which_names:
        found = shutil.which(wname)
        if found:
            return os.path.abspath(found), f"path:{wname}"

    if missing_env is not None:
        return None, f"env:{missing_env}(missing)"
    return None, "unresolved"


def _resolve_python() -> Tuple[str, str]:
    """Resolve the Python interpreter. ALWAYS returns a value (worst case literal).

    Precedence: ``$PYTHON`` → ``$PYTHON_BIN`` (each only if it exists as a file) →
    ``which("python3")`` → ``which("python")`` → ``sys.executable`` → ``"python3"``.
    """
    for name in ("PYTHON", "PYTHON_BIN"):
        val = _env(name)
        if val is None:
            continue
        if _is_file(val):
            return os.path.abspath(val), f"env:{name}"
        # A bare interpreter name (e.g. "python3.12") set in env → resolve via PATH.
        found = shutil.which(val)
        if found:
            return os.path.abspath(found), f"env:{name}(path)"

    for wname in ("python3", "python"):
        found = shutil.which(wname)
        if found:
            return os.path.abspath(found), f"path:{wname}"

    if _is_file(sys.executable):
        return os.path.abspath(sys.executable), "sys.executable"

    return "python3", "fallback"


def locate(start: Optional[str] = None) -> Dict[str, object]:
    """Resolve prometheus.py, nemesis and python; return the envelope payload dict.

    Pure (no I/O beyond stat/PATH lookups), never raises on a missing binary, and
    is the single source of truth shared by the CLI and the unittest suite.
    """
    root = find_sibling_root(start)

    prometheus_py, prometheus_src = _resolve_named(
        env_names=("PROMETHEUS_PY",),
        root=root,
        root_filename="prometheus.py",
        which_names=("prometheus.py",),
    )
    nemesis_bin, nemesis_src = _resolve_named(
        env_names=("NEMESIS_BIN",),
        root=root,
        root_filename="nemesis",
        which_names=("nemesis",),
    )
    python_bin, python_src = _resolve_python()

    ok = _is_file(prometheus_py) and _is_file(nemesis_bin)

    payload: Dict[str, object] = {
        "ok": ok,
        "prometheus_py": prometheus_py,
        "nemesis_bin": nemesis_bin,
        "python_bin": python_bin,
        "root": root,
        "sources": {
            "prometheus_py": prometheus_src,
            "nemesis_bin": nemesis_src,
            "python_bin": python_src,
        },
    }
    if not ok:
        missing: List[str] = []
        if not _is_file(prometheus_py):
            missing.append("prometheus.py")
        if not _is_file(nemesis_bin):
            missing.append("nemesis")
        payload["reason"] = (
            "could not locate: "
            + ", ".join(missing)
            + ". Set "
            + " / ".join(
                env
                for env, want in (("PROMETHEUS_PY", "prometheus.py"), ("NEMESIS_BIN", "nemesis"))
                if want in missing
            )
            + " to an absolute path, or run beside the PROMETHEUS repo."
        )
    return payload


def handle(argv: List[str]) -> int:
    """CLI entry: emit ONE locate_engine envelope. ``--json`` is accepted (default)."""
    # The bridge always passes --json; we are JSON-only regardless, but reject an
    # unexpected verb/positional so typos surface instead of being ignored.
    unknown = [a for a in argv if a not in ("--json",) and a.startswith("-")]
    positionals = [a for a in argv if not a.startswith("-")]
    if unknown or positionals:
        from _envelope import fail  # local import keeps module import surface minimal

        bad = unknown + positionals
        return fail(
            COMMAND,
            f"unexpected argument(s): {' '.join(bad)}; usage: locate_engine.py [--json]",
        )

    payload = locate()
    ok = bool(payload.pop("ok"))
    reason = payload.pop("reason", None)
    if reason is not None:
        log(COMMAND + ":", reason)
    # emit() always sets ok=True; we want the real ok + a non-zero exit when not ok
    # so the spawn layer can fail-closed on the exit code too (envelope ok is authoritative).
    fields = dict(payload)
    fields["ok"] = ok
    if reason is not None:
        fields["reason"] = reason
    # _exit: 0 when resolved, 2 when something is missing (fail-closed signal upstream).
    return emit(COMMAND, _exit=0 if ok else 2, **fields)


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    return handle(args)


if __name__ == "__main__":
    raise SystemExit(main())
