#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""probe.py — system-Python capability probe (file 10 §3.2).

Studio can run the engine with a BYO / system Python ("system-python mode") when a
bundled relocatable CPython is unavailable (or in `pnpm dev`). On first run Studio
shells this stdlib-only probe to learn whether the system interpreter is usable
(>= 3.9, the engine's floor) and surface a banner if it falls back.

Stdlib-only, never throws, prints EXACTLY one JSON object to stdout (the same
one-object contract the bridge's JSON-lines parser already consumes). Exit 0 always.
"""
import json
import platform
import sys


def main() -> int:
    info = sys.version_info
    payload = {
        "ok": True,
        "command": "probe",
        "python_version": platform.python_version(),
        "version_tuple": [info.major, info.minor, info.micro],
        "executable": sys.executable,
        "implementation": platform.python_implementation(),
        "platform": sys.platform,
        # the engine floor (file 10 §0/§3.2): CPython 3.9+ runs prometheus.py + nemesis.
        "ge_39": (info.major, info.minor) >= (3, 9),
        "capabilities": {
            "stdlib_json": True,  # we just used it
            "argv0": sys.argv[0],
        },
    }
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never throw — emit a fail-soft envelope
        sys.stdout.write(json.dumps({"ok": False, "command": "probe", "error": str(exc)}))
        sys.stdout.write("\n")
        sys.exit(0)
