#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""localai_bridge.py — LIVE passthrough to prometheus.py's `localai` (file 05 §6).

The engine OWNS the open-model catalog + repoint recipes (``LOCAL_AI_ENDPOINTS`` /
``OPEN_AI_ENDPOINTS`` / ``AI_BILLING``). The Model Hub never re-implements them — it
RUNS the real engine (``prometheus.py localai endpoints|show <tool>``) and structures
the output. ``localai`` prints human tables (no ``--json`` path in the engine today),
so this is a best-effort parser over the REAL engine output — genuinely executing the
engine, not faking a catalog.

This is the seam where a served ``ServeProfile.base_url`` becomes an IDE/tool provider:
``repoint`` reads ``localai show <tool>`` to surface the exact env diff (base-URL +
dummy ``KEY=ollama`` placeholder — NEVER a real secret).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _envelope import log  # noqa: E402

_LOCALAI_TIMEOUT = int(os.environ.get("PROMETHEUS_LOCALAI_TIMEOUT", "60"))
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _strip_ansi(s: str) -> str:
    return _ANSI.sub("", s)


def find_prometheus() -> Optional[str]:
    """Locate prometheus.py (SAME precedence as locate_engine): env → sibling root → PATH."""
    env = os.environ.get("PROMETHEUS_PY")
    if env and Path(env).is_file():
        return env
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        cand = parent / "prometheus.py"
        if cand.is_file():
            return str(cand)
    return shutil.which("prometheus.py")


def _run_localai(args: List[str]) -> Dict[str, Any]:
    """Run `prometheus.py --json localai <args>` LIVE; return raw stdout or an error.

    FAIL-CLOSED in spirit: a missing engine / spawn failure / timeout yields
    ``{ok:false, error}`` so callers surface the failure (never fabricate a catalog).
    """
    pyx = find_prometheus()
    if not pyx:
        return {"ok": False, "error": "prometheus.py not found (PROMETHEUS_PY / sibling root / PATH)"}
    cmd = [sys.executable, pyx, "--json", "localai", *args]
    log("localai:", " ".join(cmd))
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=_LOCALAI_TIMEOUT)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"localai timed out after {_LOCALAI_TIMEOUT}s"}
    except (OSError, subprocess.SubprocessError) as exc:  # noqa: BLE001
        return {"ok": False, "error": f"localai could not run: {exc}"}
    if p.returncode != 0:
        tail = (p.stderr or p.stdout or "").strip()[-300:]
        return {"ok": False, "error": f"localai exit {p.returncode}: {tail}"}
    return {"ok": True, "stdout": p.stdout, "engine": pyx}


def _parse_envelope(stdout: str) -> Optional[Dict[str, Any]]:
    """Parse a v1 `localai` JSON envelope from stdout, or None for a legacy table."""
    s = stdout.strip()
    if not s.startswith("{"):
        return None
    try:
        obj = json.loads(s)
    except (ValueError, TypeError):
        return None
    return obj if isinstance(obj, dict) and isinstance(obj.get("version"), int) else None


# An endpoints row is "<name>  <url>" (>=2 spaces); url is http(s).  [legacy fallback]
_ENDPOINT_ROW = re.compile(r"^\s+(\S+)\s{2,}(https?://\S+)\s*$")


def endpoints() -> Dict[str, Any]:
    """LIVE ``localai endpoints`` → structured local + open-weight-API endpoints.

    Returns ``{ok, local:[{name,base_url}], open_api:[{name,base_url}], engine}``. Consumes
    the v1 JSON envelope (CLI-026); the table scrape is the pre-envelope fallback.
    """
    res = _run_localai(["endpoints"])
    if not res.get("ok"):
        return res
    env = _parse_envelope(res["stdout"])
    if env is not None:
        local = [{"name": k, "base_url": v} for k, v in (env.get("local") or {}).items()]
        open_api = [{"name": k, "base_url": v} for k, v in (env.get("open") or {}).items()]
        return {"ok": True, "local": local, "open_api": open_api,
                "count": len(local) + len(open_api), "engine": res.get("engine")}
    # legacy fallback: parse the human table (pre-envelope engine).
    local = []
    open_api = []
    for raw in res["stdout"].splitlines():
        line = _strip_ansi(raw)
        m = _ENDPOINT_ROW.match(line)
        if not m:
            continue
        name, url = m.group(1), m.group(2)
        row = {"name": name, "base_url": url}
        if "localhost" in url or "127.0.0.1" in url or "host.docker.internal" in url:
            local.append(row)
        else:
            open_api.append(row)
    return {"ok": True, "local": local, "open_api": open_api,
            "count": len(local) + len(open_api), "engine": res.get("engine")}


# A show row is "  <key> : <value>"  [legacy fallback]
_SHOW_ROW = re.compile(r"^\s+([a-z _]+?)\s*:\s+(.*)$")


def show_tool(tool: str) -> Dict[str, Any]:
    """LIVE ``localai show <tool>`` → structured billing/patchability for an AI tool.

    Returns ``{ok, tool, fields:{track,mode,patchable,recipe,note}, patchable:bool, engine}``.
    Consumes the v1 JSON envelope (CLI-026); the table scrape is the pre-envelope fallback.
    """
    res = _run_localai(["show", tool])
    if not res.get("ok"):
        return res
    env = _parse_envelope(res["stdout"])
    if env is not None:
        if env.get("ok") is False:
            return {"ok": False, "error": env.get("error", f"unknown AI tool: {tool}"),
                    "engine": res.get("engine")}
        t = env.get("tool") or {}
        fields = {
            "track": str(t.get("track", "")),
            "mode": str(t.get("mode", "")),
            "patchable": "yes" if t.get("patchable") else "no",
            "recipe": str(t.get("recipe", "")),
            "note": str(t.get("note", "")),
        }
        return {"ok": True, "tool": tool, "fields": fields,
                "patchable": bool(t.get("patchable")), "engine": res.get("engine")}
    # legacy fallback: parse the human "key : value" table.
    fields = {}
    for raw in res["stdout"].splitlines():
        line = _strip_ansi(raw)
        m = _SHOW_ROW.match(line)
        if not m:
            continue
        key = m.group(1).strip().replace(" ", "_")
        if key == "free_local":
            key = "recipe"
        fields[key] = m.group(2).strip()
    if not fields:
        return {"ok": False, "error": f"unknown AI tool or no fields: {tool}",
                "engine": res.get("engine")}
    patchable = str(fields.get("patchable", "")).lower().startswith("yes")
    return {"ok": True, "tool": tool, "fields": fields,
            "patchable": patchable, "engine": res.get("engine")}


def repoint_diff(tool: str, base_url: str) -> Dict[str, Any]:
    """Compute the env diff to repoint ``tool`` at a local served ``base_url`` (§6).

    Reads ``localai show <tool>`` LIVE, then proposes the NON-SECRET env changes Studio
    would write: the OpenAI-compatible base-URL var + a dummy ``KEY=ollama`` placeholder
    (NEVER a real key — the engine secret rule). The engine's exact ``recipe`` string is
    surfaced verbatim so the user sees the authoritative instruction.
    """
    info = show_tool(tool)
    if not info.get("ok"):
        return info
    recipe = info["fields"].get("recipe", "")
    # Pull the var names the engine recipe references (BASEURL/BASE_URL/API_KEY/...).
    env_vars = sorted(set(re.findall(r"\b([A-Z][A-Z0-9_]*(?:BASE_?URL|API_?KEY|API_?BASE))\b", recipe)))
    base_var = next((v for v in env_vars if "URL" in v or "BASE" in v and "KEY" not in v), None)
    key_var = next((v for v in env_vars if "KEY" in v), None)
    proposed: Dict[str, str] = {}
    if base_var:
        proposed[base_var] = base_url
    if key_var:
        proposed[key_var] = "ollama"  # dummy, non-secret placeholder
    return {
        "ok": True, "tool": tool, "base_url": base_url,
        "patchable": info["patchable"],
        "recipe": recipe,
        "proposed_env": proposed,
        "referenced_env_vars": env_vars,
        "secret_policy": "base-URL + dummy KEY=ollama only; NEVER writes a real key.",
        "engine": info.get("engine"),
    }
