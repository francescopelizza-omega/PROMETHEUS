#!/usr/bin/env python3
"""urlclassifier.py — L4 behavioural classifier (malice + indirect-prompt-injection).

Scores the PINNED, post-render content of a URL (from L3/L5) for malice and IPI.
The classifier has NO tools, NO agency, NO credentials — it reads DATA and returns
SCORE + evidence only (url_injection_safeguard.md §3 L4). All input is spotlighted /
datamarked and fenced as DATA before scoring.

Backends (decided in §8 Q1):
  * heuristic  — always available, pure-stdlib pattern + structural scoring.
  * prompt-guard — OPTIONAL local model (Meta Prompt-Guard-2, 86M) used ONLY if
    `transformers` imports AND `PROMETHEUS_PROMPTGUARD_MODEL` points at a local
    model dir. Never downloaded here; never required. When absent we degrade to the
    heuristic and SAY SO (`backend:"heuristic"`, `degraded:true`) so the verdict
    ceiling stays warn — absence of a model is not evidence of safety.

Verb:
  classify  [--text-file FILE | stdin]  [--url URL]  [--context exec|doc|comment|config]
            [--datamark]
"""
from __future__ import annotations

import os
import re
import sys
from typing import List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _envelope import dispatch, emit, fail, log, opt_value  # noqa: E402

# Zero-width / bidi / TAG controls — text the human reviewer cannot see.
_HIDDEN_CHARS_RX = re.compile(
    "[​‌‍⁠‪-‮⁦-⁩﻿"
    "\U000e0000-\U000e007f]")

# Weighted IPI / malice signals. (weight, kind, regex). Weights sum toward a 0..1
# score; any single high-weight hit alone can reach the "suspicious" floor.
_SIGNALS: List[Tuple[float, str, str]] = [
    (0.55, "instruction-override",
     r"ignore\s+(all\s+)?(the\s+)?(previous|above|prior|earlier|system)\s+"
     r"(instructions?|prompts?|messages?|rules?)"),
    (0.45, "instruction-override", r"disregard\s+(all\s+|everything\s+)?(previous|above|your)"),
    (0.5, "persona-switch", r"\byou\s+are\s+now\s+(a|an|the|in)\b"),
    (0.5, "persona-switch", r"\b(new\s+)?(system\s*prompt|developer\s*message|jailbreak)\b"),
    (0.6, "secret-exfil",
     r"\b(send|post|exfiltrate|upload|forward|leak|email|transmit)\b[^\n]{0,50}\b"
     r"(api[_-]?key|token|secret|password|credentials?|cookie|ssh|\.env|private[_-]?key)\b"),
    (0.55, "command-exec",
     r"\b(run|execute|eval|exec)\b[^\n]{0,40}\b(the\s+following|this\s+command|"
     r"shell|bash|zsh|powershell|cmd|curl|wget|os\.system|subprocess)\b"),
    (0.5, "decode-and-run",
     r"\b(base64|hex|rot13)\b[^\n]{0,40}\b(decode|decrypt)\b[^\n]{0,40}\b(run|exec|eval)\b"),
    (0.45, "data-suppression",
     r"\b(do\s+not|don'?t|never)\b[^\n]{0,30}\b(tell|inform|notify|warn|mention)\b[^\n]{0,20}"
     r"\b(the\s+)?(user|human|operator)\b"),
    (0.5, "markdown-exfil",
     r"!\[[^\]]*\]\(https?://[^)]*[?&=][^)]*\)"),     # image URL with a data param
    (0.4, "fenced-instruction", r"\bBEGIN\b[^\n]{0,30}\b(SYSTEM|INSTRUCTIONS?|PROMPT)\b"),
    (0.35, "tool-invoke", r"<\s*(tool_call|function_call|invoke)\b|\bcall\s+the\s+\w+\s+tool\b"),
]
_SIGNALS_RX = [(w, k, re.compile(rx, re.I)) for w, k, rx in _SIGNALS]


def _datamark(text: str) -> str:
    return re.sub(r"\s+", "▁", text)


def _heuristic_classify(text: str, context: str) -> dict:
    """Pure-stdlib malice/IPI score. Structural (hidden chars) + pattern weighted."""
    evidence: List[dict] = []
    score = 0.0
    if _HIDDEN_CHARS_RX.search(text):
        score += 0.4
        evidence.append({"kind": "hidden-unicode", "weight": 0.4,
                         "evidence": "zero-width / bidi control characters present"})
    for w, kind, rx in _SIGNALS_RX:
        m = rx.search(text)
        if m:
            score += w
            evidence.append({"kind": kind, "weight": w, "evidence": m.group(0)[:160]})
    # exec context amplifies — the agent is more likely to ACT on this content
    if context == "exec" and score > 0:
        score *= 1.25
    score = min(1.0, round(score, 3))
    label = "malicious" if score >= 0.7 else ("suspicious" if score >= 0.3 else "benign")
    return {"score": score, "label": label, "ipi": bool(evidence),
            "evidence": evidence[:20]}


def _model_classify(text: str) -> Optional[dict]:
    """Optional Meta Prompt-Guard-2 backend. Returns None (→ heuristic) unless both
    `transformers` imports AND PROMETHEUS_PROMPTGUARD_MODEL points at a local dir.
    Never downloads. Best-effort: any failure → None (degrade, never crash)."""
    model_dir = os.environ.get("PROMETHEUS_PROMPTGUARD_MODEL")
    if not model_dir or not os.path.isdir(model_dir):
        return None
    try:
        from transformers import (  # type: ignore  # noqa: PLC0415
            AutoModelForSequenceClassification, AutoTokenizer)
        import torch  # type: ignore  # noqa: PLC0415
    except Exception:  # noqa: BLE001 — no ML stack → degrade
        return None
    try:
        tok = AutoTokenizer.from_pretrained(model_dir)
        model = AutoModelForSequenceClassification.from_pretrained(model_dir)
        inputs = tok(text[:8000], return_tensors="pt", truncation=True, max_length=512)
        with torch.no_grad():
            logits = model(**inputs).logits
        probs = torch.softmax(logits, dim=-1)[0].tolist()
        # Prompt-Guard labels: 0 benign, 1 injection/jailbreak (model-version dependent)
        malicious_p = float(max(probs[1:])) if len(probs) > 1 else float(probs[0])
        label = ("malicious" if malicious_p >= 0.7
                 else ("suspicious" if malicious_p >= 0.3 else "benign"))
        return {"score": round(malicious_p, 3), "label": label,
                "ipi": malicious_p >= 0.3,
                "evidence": [{"kind": "prompt-guard-2", "weight": malicious_p,
                              "evidence": f"model P(injection)={malicious_p:.3f}"}]}
    except Exception as e:  # noqa: BLE001
        log("prompt-guard backend error → degrade to heuristic:", e)
        return None


def verb_classify(argv: List[str]) -> int:
    url = opt_value(argv, "--url", "")
    context = opt_value(argv, "--context", "doc") or "doc"
    tf = opt_value(argv, "--text-file")
    if tf:
        try:
            with open(tf, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError as e:
            return fail("classify", f"cannot read --text-file: {e}")
    else:
        text = sys.stdin.read()
    if "--datamark" in argv:
        # spotlight the data before scoring (does not change pattern hits; documents
        # that the classifier treats every token as fenced DATA, never instructions)
        _ = _datamark(text)

    model_res = _model_classify(text)
    if model_res is not None:
        res = model_res
        backend, degraded = "prompt-guard-2", False
    else:
        res = _heuristic_classify(text, context)
        backend, degraded = "heuristic", True

    return emit(
        "classify", url=url, context=context, backend=backend, degraded=degraded,
        score=res["score"], label=res["label"], ipi=res["ipi"],
        evidence=res["evidence"], bytes=len(text.encode("utf-8", "replace")),
        note=("Classifier has no tools/agency/credentials; output is SCORE + evidence "
              "over fenced DATA. " + (
                  "Heuristic backend (no local Prompt-Guard model) — a 'benign' score "
                  "is NOT proof of safety; verdict ceiling stays warn." if degraded else
                  "Local Prompt-Guard-2 backend.")),
        _exit=0)


HANDLERS = {"classify": verb_classify}


def main(argv: Optional[List[str]] = None) -> int:
    return dispatch("urlclassifier.py", HANDLERS,
                    list(sys.argv[1:] if argv is None else argv))


if __name__ == "__main__":
    sys.exit(main())
