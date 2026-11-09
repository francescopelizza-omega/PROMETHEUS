#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""_envelope.py — the one-JSON-object emit helper shared by the Studio sidecars.

Mirrors prometheus.py's ``emit_json`` contract (C2/C7):

  * **stdout** carries *exactly one* JSON object (sorted keys, ``ensure_ascii=False``).
  * **stderr** carries every human/diagnostic log line.
  * the process exit code is derived from the envelope (``ok`` / explicit ``_exit``).

The bridge (``@prometheus/engine-bridge``) launches these sidecars exactly like it
launches ``prometheus.py``: capture stdout, recover the last JSON-object line,
treat a missing/unparseable/timed-out object as an ``error`` verdict (fail-closed).

Every sidecar verb returns ``ok``, ``command`` and verb-specific fields. Errors use
``fail()`` which sets ``ok=False`` + ``error`` and a non-zero ``_exit``.

NOTE on gating (C4/C5): these sidecars NEVER decide that a download/install is
"safe". Any install/download path is gated by the engine-bridge **nemesis** runner
upstream. The mutating verbs here only run once the bridge has already cleared them
AND the caller passes ``--confirm``.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback
from typing import Any, Callable, Dict, List, NoReturn, Sequence

# ---------------------------------------------------------------------------- test seams
# The model-hub verbs carry test seams (MODELHUB_FAKE_* / MODELHUB_FORCE_* …) that replace
# installers, scanners' inputs and store paths. One of them (a fake colibri install) used to
# switch OFF a gate check in production, because nothing stopped the variables from reaching a
# real run. They are honoured ONLY inside the test harness: `_test_stores` writes a marker
# file with a random token into its own temp dir; without that exact marker every seam is
# removed from the environment before any verb reads it.
_SEAM_PREFIXES = ("MODELHUB_FAKE_", "MODELHUB_FORCE_")
_SEAM_NAMES = ("MODELHUB_HF_BASE", "MODELHUB_OLLAMA_MODELS", "MODELHUB_ZERO_COPY_TEST",
               "MODELHUB_NO_DAEMON_SPAWN")


def under_test_harness() -> bool:
    root, token = os.environ.get("MODELHUB_TEST_STORES"), os.environ.get("MODELHUB_TEST_TOKEN")
    if not root or not token:
        return False
    try:
        real = os.path.realpath(root)
        tmp = os.path.realpath(tempfile.gettempdir())
        if os.path.commonpath([real, tmp]) != tmp:
            return False
        with open(os.path.join(real, ".modelhub-test-marker"), encoding="utf-8") as f:
            return f.read().strip() == token
    except (OSError, ValueError):
        return False


def _strip_seams() -> None:
    if under_test_harness():
        return
    for k in list(os.environ):
        if k.startswith(_SEAM_PREFIXES) or k in _SEAM_NAMES:
            del os.environ[k]
    os.environ.pop("MODELHUB_TEST_STORES", None)


_strip_seams()


def log(*parts: Any) -> None:
    """Write a human/diagnostic line to stderr (never stdout)."""
    sys.stderr.write(" ".join(str(p) for p in parts) + "\n")
    sys.stderr.flush()


def _dump(obj: Dict[str, Any]) -> int:
    """Serialize ONE object to stdout (sorted, ensure_ascii=False) and return exit code."""
    sys.stdout.write(json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()
    if "_exit" in obj:
        try:
            return int(obj["_exit"])
        except (TypeError, ValueError):
            return 0
    return 0 if obj.get("ok", True) else 2


def emit(command: str, *, _exit: int | None = None, **fields: Any) -> int:
    """Emit a success envelope: ``{ok, command, ...fields}``. Returns the exit code.

    The ``_exit`` override is rarely needed for success (defaults to 0).
    """
    obj: Dict[str, Any] = {"ok": True, "command": command}
    obj.update(fields)
    if _exit is not None:
        obj["_exit"] = _exit
    return _dump(obj)


def fail(command: str, error: str, *, _exit: int = 2, **fields: Any) -> int:
    """Emit a fail-closed envelope: ``{ok:false, command, error, ...}``. Returns exit code."""
    obj: Dict[str, Any] = {"ok": False, "command": command, "error": error}
    obj.update(fields)
    obj["_exit"] = _exit
    return _dump(obj)


# --- argv dispatch ---------------------------------------------------------- #

# A verb handler receives the post-verb argv list and returns a process exit code
# (it is responsible for calling emit()/fail() exactly once).
Handler = Callable[[List[str]], int]


def has_flag(argv: Sequence[str], flag: str) -> bool:
    """True if ``flag`` (e.g. ``--confirm``) is present in argv."""
    return flag in argv


def positional(argv: Sequence[str]) -> List[str]:
    """Return non-flag argv tokens, in order (flags = tokens starting with ``-``)."""
    return [a for a in argv if not a.startswith("-")]


def opt_value(argv: Sequence[str], name: str, default: str | None = None) -> str | None:
    """Value for ``--name VALUE`` or ``--name=VALUE``; else ``default``.

    A flag-shaped value is returned AS IS (callers refuse it: falling back to ``default`` would
    turn ``--path --help`` into "run on ."). See ``flag_shaped_value`` for the up-front check."""
    pref = name + "="
    for i, a in enumerate(argv):
        if a == name and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(pref):
            return a[len(pref):]
    return default


def flag_shaped_value(argv: Sequence[str], valued: Sequence[str]) -> str | None:
    """The first option in ``valued`` whose separate value token starts with ``-``, or None.

    ``--id --no-gate`` made ``--no-gate`` both the id AND a present flag (``"--no-gate" in
    argv``), so a caller-chosen id could switch off the post-pull nemesis scan, accept a WARN or
    skip the RAM guard. Such argv is refused before any verb runs; a value that really starts
    with ``-`` must be written ``--name=VALUE``."""
    for i, a in enumerate(argv[:-1]):
        if a in valued and argv[i + 1].startswith("-"):
            return a
    return None


def dispatch(prog: str, handlers: Dict[str, Handler], argv: Sequence[str]) -> int:
    """Route ``argv[0]`` to a handler. Unknown/missing verb → fail-closed error envelope.

    Any exception inside a handler is caught and turned into a fail() envelope so the
    sidecar ALWAYS emits exactly one JSON object on stdout (the bridge contract).
    """
    args = list(argv)
    if not args:
        return fail(prog, f"no verb given; expected one of: {', '.join(sorted(handlers))}")
    verb = args[0]
    handler = handlers.get(verb)
    if handler is None:
        return fail(verb, f"unknown verb '{verb}'; expected one of: {', '.join(sorted(handlers))}")
    try:
        return handler(args[1:])
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — fail-closed: never crash without an envelope
        log("traceback:", traceback.format_exc())
        return fail(verb, f"{type(exc).__name__}: {exc}")
