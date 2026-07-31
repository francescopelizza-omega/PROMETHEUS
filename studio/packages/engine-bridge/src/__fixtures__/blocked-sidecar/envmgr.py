#!/usr/bin/env python3
"""Deterministic envmgr.py stand-in for env.test.ts — emits the file 04 §8 BLOCKED
install envelope on stdout (one JSON object), exit 2. NO fetch, NO pip, NO nemesis:
it lets the TS boundary mapper be proven against a nemesis-BLOCK shape without ever
touching the network. Mirrors the real sidecar's blocked envelope byte-for-byte.
"""
import json
import sys

# argv: [<this script>, "pkg.install", <env>, <spec...>, "--confirm"?]
verb = sys.argv[1] if len(sys.argv) > 1 else "pkg.install"
print("staging + scanning (fake): nemesis returned BLOCK", file=sys.stderr)
print(json.dumps({
    "command": verb,
    "ok": False,
    "blocked": True,
    "_exit": 2,
    "request": {
        "env": "demo",
        "path": "/tmp/demo",
        "kind": "venv",
        "specs": ["evil-pkg"],
        "scope": "venv",
    },
    "gate": {
        "verdict": "block",
        "score": 100,
        "reasons": [
            "postinstall script spawns curl|sh",
            "obfuscated base64 exec in setup.py",
        ],
        "signed": True,
        "recommendation": "Refuse install — malicious build hook.",
        "scanned_at": "2026-06-16T00:00:00Z",
    },
    "message": ("refused — nemesis BLOCK; not installed. "
                "Re-run with force:true (typed confirm) to override."),
}, sort_keys=True, ensure_ascii=False))
sys.exit(2)
