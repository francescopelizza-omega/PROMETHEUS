#!/usr/bin/env python3
"""Deterministic modelhub.py stand-in for client.test.ts — emits the file 05 §5
download BLOCKED envelope on stdout (one JSON object), exit 2. NO fetch, NO nemesis:
it lets the TS boundary mapper be proven against a nemesis-BLOCK shape WITHOUT touching
the network or the real scanner. Mirrors nemesis_gate.admit()'s blocked result: the
stage is quarantined (kept for inspection), the gate verdict rides through, and the
pickle-format risk is surfaced. The download GATE decision is the engine's (real nemesis
in production); JS NEVER decides "safe" (C5) — a block is a RETURNED value, not a throw.
"""
import json
import sys

verb = sys.argv[1] if len(sys.argv) > 1 else "download"
print("staging + scanning (fake): nemesis returned BLOCK", file=sys.stderr)
print(json.dumps({
    "command": verb,
    "ok": False,
    "admitted": False,
    "blocked": True,
    "_exit": 2,
    "id": "evil/malware-gguf",
    "source": "huggingface",
    "quant": "q4_k_m",
    "verdict": "block",
    "stage_dir": "/tmp/.prometheus/models/.stage/evil__malware-gguf",
    "quarantined": "/tmp/.prometheus/models/.stage/.quarantine/evil__malware-gguf.1750000000",
    "format_risk": {
        "high_risk_files": ["pytorch_model.bin"],
        "safe_files": [],
        "risk": "high",
    },
    "gate": {
        "verdict": "block",
        "score": 100,
        "reasons": [
            "pickle GLOBAL opcode → arbitrary code on torch.load",
            "embedded base64 exec payload in pytorch_model.bin",
        ],
        "signed": True,
        "recommendation": "Refuse — pickle deserialization RCE. Prefer safetensors/gguf.",
        "scanned_at": "2026-06-16T00:00:00Z",
    },
    "message": ("refused — nemesis BLOCK; staged bytes quarantined for inspection "
                "(NOT deleted). Re-run with force:true (typed confirm) to override."),
}, sort_keys=True, ensure_ascii=False))
sys.exit(2)
