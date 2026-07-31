#!/usr/bin/env python3
"""repo.py — the gated arbitrary-URL GitHub repo manager (file 06 §3, feature #5a).

A repo the user just wants to clone/read/use — distinct from the engine's pre-declared
``REPO_TOOLS`` (those still go through ``apps install``). This is the ONLY arbitrary-URL
clone path in Studio, and it is hard-wired through the SAME security spine the engine
uses for ``git_clone`` plugins (``prometheus.py:1280`` ``_GIT_SAFE_FLAGS`` +
``enforce_gate``). The sidecar NEVER decides "safe" (C5 GOLDEN RULE):

    git clone (SAFE FLAGS) → STAGING dir      (no hook/ext::/fsmonitor runs pre-scan)
    nemesis gate <staging>                    → ONE signed verdict (real binary)
    verdict allow  → promote staging → ~/.config/prometheus/repos/<id>/
                     + write the repo index entry + bind the verdict ref to the commit
    verdict warn   → keep STAGED (no promote); GUI confirms, force:true re-runs
    verdict block  → REFUSE + QUARANTINE the staging (kept for inspection, NOT deleted)
    verdict error  → FAIL-CLOSED → BLOCK (scanner missing / timeout / unparseable)
    force:true     → promote anyway over block/error/warn, flagged ``forced_danger``

The clone-time TOCTOU is closed by replicating ``_GIT_SAFE_FLAGS`` EXACTLY (hooksPath=
/dev/null, fsmonitor off, protocol.ext.allow=never, --no-recurse-submodules) so NOTHING
the fetched repo ships can run during clone/checkout/pull BEFORE nemesis scans the tree.

The REAL nemesis binary is located + invoked via ``nemesis_gate`` (the SAME runner the
model-hub uses): ``$NEMESIS_BIN`` → sibling PROMETHEUS root → ``which('nemesis')``;
``nemesis gate <tree> --sandbox auto --jail auto --sign --timeout 840``, fail-closed.

Verbs (each emits EXACTLY ONE JSON object on stdout via ``_envelope.emit``/``fail``):
    clone    --url U [--branch B] [--pin SHA] [--staged DIR] [--force]
    list     read ~/.config/prometheus/repos/index.json
    update   --id ID [--force]   re-stage new HEAD under safe flags → re-gate → promote
    pin      --id ID --sha SHA [--force]   --detach checkout under safe flags → re-gate
    branch   --id ID --branch B [--force]  switch branch under safe flags → re-gate
    rescan   --id ID [--gate-fresh]   re-run nemesis on the CURRENT tree (no fetch)
    remove   --id ID   drop the clone dir + index entry

Python 3 stdlib only. ``git`` (clone/checkout) + the real ``nemesis`` binary are the only
external processes; the GATE decision is fully unit-testable with a planted local staging
dir (no network), exactly like file 04/05.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _envelope import (  # noqa: E402
    dispatch,
    emit,
    fail,
    log,
    opt_value,
)
import nemesis_gate  # noqa: E402  (the SAME real-nemesis runner the model-hub uses)

PROG = "repo"

# --- _GIT_SAFE_FLAGS — REPLICATED EXACTLY from prometheus.py:1280 ------------- #
# These neutralize every repo-controlled code path that could fire DURING
# clone / checkout / pull — i.e. BEFORE the nemesis gate ever scans the tree.
# Closes the clone-time TOCTOU: no post-checkout/post-merge hook, no `ext::`
# submodule transport, and no fsmonitor helper can run before enforce_gate().
_GIT_SAFE_FLAGS = [
    "-c", "core.hooksPath=/dev/null",   # no hook (post-checkout/post-merge/...) runs
    "-c", "core.fsmonitor=",            # no fsmonitor helper program is spawned
    "-c", "protocol.ext.allow=never",   # refuse ext:: transport (submodule RCE vector)
]

_GIT_TIMEOUT = int(os.environ.get("PROMETHEUS_GIT_TIMEOUT", "600"))


# --- repo store layout ------------------------------------------------------- #

def repos_root() -> Path:
    """The Studio-managed repo root. ``$PROMETHEUS_REPOS_HOME`` overrides for tests."""
    env = os.environ.get("PROMETHEUS_REPOS_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".config" / "prometheus" / "repos"


def stage_root() -> Path:
    """The staging/quarantine root (mirrors the engine PURGE_DIR pattern)."""
    return repos_root() / ".stage"


def index_path() -> Path:
    """The repo index file (the list view's source of truth, reconciled by the GUI)."""
    return repos_root() / "index.json"


def live_dir_for(repo_id: str) -> Path:
    """Where an allowed clone lives once nemesis promotes it."""
    return repos_root() / _safe_id(repo_id)


def stage_dir_for(repo_id: str) -> Path:
    """Where a clone is staged (with safe flags) before the gate decides."""
    return stage_root() / _safe_id(repo_id)


# --- URL → stable id --------------------------------------------------------- #

_GIT_SUFFIX = re.compile(r"\.git/?$")


def parse_url(url: str) -> Dict[str, str]:
    """Derive ``{owner, name, id}`` from a clone URL (https / ssh / file://).

    The id is the stable key for every command ("owner__name"), filesystem-safe.
    Best-effort owner/name extraction; falls back to the last two path segments.
    """
    raw = url.strip()
    body = _GIT_SUFFIX.sub("", raw)
    # strip scheme://host or scp-like user@host:
    rest = body
    m = re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+/(.*)$", body)
    if m:
        rest = m.group(1)
    else:
        m2 = re.match(r"^[^/@]+@[^:]+:(.*)$", body)  # git@github.com:owner/name
        if m2:
            rest = m2.group(1)
    parts = [p for p in rest.split("/") if p]
    if len(parts) >= 2:
        owner, name = parts[-2], parts[-1]
    elif parts:
        owner, name = "", parts[-1]
    else:
        owner, name = "", "repo"
    return {"owner": owner, "name": name, "id": _safe_id(f"{owner}/{name}" if owner else name)}


def _safe_id(rid: str) -> str:
    """Turn an arbitrary repo id into a filesystem-safe single directory name."""
    s = rid.replace("/", "__").replace(":", "__").replace("..", "__")
    s = re.sub(r"[^A-Za-z0-9_.\-]", "_", s)
    return s.strip("._") or "repo"


# --- index read / write ------------------------------------------------------ #

def _read_index() -> List[Dict[str, Any]]:
    p = index_path()
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        log("repo index unreadable (treating as empty):", exc)
        return []
    if isinstance(data, dict):
        data = data.get("repos", [])
    return [r for r in data if isinstance(r, dict)]


def _write_index(repos: List[Dict[str, Any]]) -> None:
    p = index_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "repos": repos}
    p.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _find_entry(repos: List[Dict[str, Any]], repo_id: str) -> Optional[Dict[str, Any]]:
    for r in repos:
        if r.get("id") == repo_id:
            return r
    return None


def _upsert_entry(entry: Dict[str, Any]) -> None:
    repos = _read_index()
    out = [r for r in repos if r.get("id") != entry["id"]]
    out.append(entry)
    out.sort(key=lambda r: str(r.get("id")))
    _write_index(out)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --- git under safe flags ---------------------------------------------------- #

def _git() -> Optional[str]:
    return shutil.which("git")


def _git_clone_argv(git: str, url: str, dest: str, branch: Optional[str]) -> List[str]:
    """Hardened ``git clone`` — replicates prometheus.py:_git_clone_argv exactly:
    shallow, no submodules, no hooks/ext-transport/fsmonitor. Nothing the cloned
    repo ships can execute before nemesis scans the staged tree."""
    argv = [git, *_GIT_SAFE_FLAGS, "clone", "--depth", "1", "--no-recurse-submodules"]
    if branch:
        argv += ["--branch", branch]
    argv += [url, dest]
    return argv


def _run_git(argv: List[str]) -> subprocess.CompletedProcess:
    log("git:", " ".join(argv))
    return subprocess.run(argv, capture_output=True, text=True, timeout=_GIT_TIMEOUT)


def _head_sha(tree: Path) -> Optional[str]:
    git = _git()
    if not git:
        return None
    try:
        p = subprocess.run([git, *_GIT_SAFE_FLAGS, "-C", str(tree), "rev-parse", "HEAD"],
                           capture_output=True, text=True, timeout=30)
        if p.returncode == 0:
            return p.stdout.strip() or None
    except (OSError, subprocess.SubprocessError) as exc:  # noqa: BLE001
        log("rev-parse failed:", exc)
    return None


# --- the gate decision over a STAGED tree ------------------------------------ #

def _quarantine(stage: Path) -> Path:
    """Move a refused staging dir aside (kept for inspection; never auto-deleted)."""
    qroot = stage_root() / ".quarantine"
    qroot.mkdir(parents=True, exist_ok=True)
    dest = qroot / f"{stage.name}.{int(time.time())}"
    try:
        shutil.move(str(stage), str(dest))
        return dest
    except (OSError, shutil.Error) as exc:  # noqa: BLE001
        log("quarantine move failed (left in place):", exc)
        return stage


def _promote(stage: Path, live: Path) -> None:
    """Atomically promote the staged tree to the live repo location."""
    live.parent.mkdir(parents=True, exist_ok=True)
    if live.exists():
        shutil.rmtree(live, ignore_errors=True)
    shutil.move(str(stage), str(live))


def _verdict_ref(v: Dict[str, Any], commit: Optional[str]) -> Dict[str, Any]:
    """The NemesisVerdictRef the GUI stores (file 06 §2): we store the REF, never a
    recomputed verdict. The engine signs verdicts (HMAC) and binds them to a commit."""
    return {
        "verdict": v.get("verdict", "error"),
        "score": v.get("risk_score", 100),
        "commit": commit or "",
        "signedAt": v.get("scanned_at", _now()),
        "findingsRef": str((v.get("signature") or {}).get("value") or ""),
        "reasons": list(v.get("blocking_reasons") or [])[:8],
        "recommendation": v.get("recommendation", ""),
    }


def _gate_staged(
    *,
    repo_id: str,
    url: str,
    owner: str,
    name: str,
    branch: str,
    stage: Path,
    pin: Optional[str] = None,
    force: bool = False,
    linked_catalog_item_id: Optional[str] = None,
) -> Dict[str, Any]:
    """THE GATE DECISION over an ALREADY-STAGED clone. NEVER promotes ungated.

    Runs the REAL nemesis over ``stage``, then:
        allow            → promote stage → live + write index entry + verdict ref
        warn  (no force) → keep staged (status=warn, NOT promoted)
        block/error      → REFUSE + QUARANTINE (status=blocked, stage kept)
        force            → promote over block/error/warn, flag ``forced_danger``

    Returns a result dict the caller wraps in the JSON envelope.
    """
    live = live_dir_for(repo_id)
    result: Dict[str, Any] = {
        "id": repo_id, "url": url, "owner": owner, "name": name, "branch": branch,
        "stage_dir": str(stage), "local_path": str(live),
    }
    if pin:
        result["pinnedCommit"] = pin

    if not stage.is_dir():
        v = nemesis_gate.error_verdict(f"staging dir does not exist: {stage}")
        result.update(promoted=False, blocked=True, status="blocked",
                      verdict="error", gate=nemesis_gate.verdict_summary(v),
                      verdict_ref=_verdict_ref(v, None),
                      message="nothing staged — fail-closed BLOCK.")
        return result

    commit = pin or _head_sha(stage)
    result["commit"] = commit

    # The real fail-closed scanner over the STAGED tree (no hook/ext/fsmonitor ran).
    v = nemesis_gate.nemesis_gate(str(stage))
    verdict = v.get("verdict", "error")
    result["gate"] = nemesis_gate.verdict_summary(v)
    result["verdict"] = verdict
    ref = _verdict_ref(v, commit)
    result["verdict_ref"] = ref

    if verdict == "warn" and not force:
        result.update(
            promoted=False, needs_confirm=True, status="warn",
            message="nemesis WARN — review findings, then re-run with force:true to promote.",
        )
        return result

    if verdict in ("block", "error") and not force:
        quarantine = _quarantine(stage)
        why = "UNVERIFIABLE (scanner error)" if verdict == "error" else f"nemesis {verdict.upper()}"
        result.update(
            promoted=False, blocked=True, status="blocked",
            quarantined=str(quarantine),
            message=f"refused — {why}; staged clone quarantined for inspection "
                    "(NOT deleted). Re-run with force:true (typed confirm) to override.",
        )
        return result

    forced = verdict in ("block", "error", "warn") and force

    # allow (or forced): promote the EXACT vetted tree from stage → live, index it.
    _promote(stage, live)
    entry = {
        "id": repo_id,
        "url": url,
        "owner": owner,
        "name": name,
        "localPath": str(live),
        "branch": branch,
        "pinnedCommit": pin,
        "lastFetched": _now(),
        "lastVerdict": ref,
        "status": "cloned",
        "linkedCatalogItemId": linked_catalog_item_id,
    }
    _upsert_entry(entry)
    result.update(promoted=True, status="cloned", entry=entry)

    if forced:
        result["forced_danger"] = {
            "label": repo_id, "verdict": verdict,
            "risk_score": v.get("risk_score"),
            "blocking_reasons": list(v.get("blocking_reasons") or [])[:8],
        }
        result["message"] = (f"⚠ FORCED promote of {verdict.upper()} repo "
                             f"({repo_id}) — flagged for audit.")
    else:
        result["message"] = f"promoted {repo_id} → {live}"
    return result


# --- verb: clone ------------------------------------------------------------- #

def v_clone(argv: List[str]) -> int:
    """Clone an arbitrary URL with SAFE FLAGS into staging → REAL nemesis gate → promote.

    ``--staged <dir>`` drives the gate over an already-populated staging dir (a completed
    bridge clone, or a test fixture) — the SECURITY-load-bearing path, fully offline.
    Without ``--staged`` we clone the URL ourselves (needs git + network), then gate.
    """
    url = opt_value(argv, "--url")
    if not url:
        return fail("clone", "need --url <git url>")
    branch = opt_value(argv, "--branch") or "main"
    pin = opt_value(argv, "--pin")
    force = "--force" in argv
    staged = opt_value(argv, "--staged")  # an already-cloned dir to gate (offline/test)
    # belt-and-braces: a leading-dash value would be read as a git OPTION when appended
    # to the argv (spawn is shell:false, but argv option-injection still applies).
    for _field, _val in (("url", url), ("branch", branch), ("pin", pin)):
        if _val and _val.startswith("-"):
            return fail("clone", f"{_field} must not start with a dash")

    meta = parse_url(url)
    repo_id = meta["id"]
    stage = stage_dir_for(repo_id)

    if staged:
        # bytes already on disk → gate the staged tree directly (no fetch).
        result = _gate_staged(
            repo_id=repo_id, url=url, owner=meta["owner"], name=meta["name"],
            branch=branch, stage=Path(staged).expanduser(), pin=pin, force=force,
        )
        return _emit_gate("clone", result)

    git = _git()
    if not git:
        return fail("clone", "git not found on PATH", url=url, id=repo_id)

    # fresh staging dir (clean any prior attempt — a blocked tree never lingers live).
    if stage.exists():
        shutil.rmtree(stage, ignore_errors=True)
    stage.parent.mkdir(parents=True, exist_ok=True)

    try:
        p = _run_git(_git_clone_argv(git, url, str(stage), branch if not pin else None))
    except subprocess.TimeoutExpired:
        shutil.rmtree(stage, ignore_errors=True)
        return fail("clone", f"git clone timed out after {_GIT_TIMEOUT}s", url=url, id=repo_id)
    except (OSError, subprocess.SubprocessError) as exc:  # noqa: BLE001
        shutil.rmtree(stage, ignore_errors=True)
        return fail("clone", f"git clone could not run: {exc}", url=url, id=repo_id)
    if p.returncode != 0:
        shutil.rmtree(stage, ignore_errors=True)
        tail = (p.stderr or p.stdout or "").strip()[-400:]
        return fail("clone", f"git clone failed (exit {p.returncode}): {tail}",
                    url=url, id=repo_id)

    if pin:
        # detached checkout of the requested SHA under safe flags before scanning.
        cp = subprocess.run([git, *_GIT_SAFE_FLAGS, "-C", str(stage),
                             "checkout", "--detach", pin],
                           capture_output=True, text=True, timeout=_GIT_TIMEOUT)
        if cp.returncode != 0:
            shutil.rmtree(stage, ignore_errors=True)
            return fail("clone", f"git checkout --detach {pin} failed: "
                                 f"{(cp.stderr or '').strip()[-300:]}", url=url, id=repo_id)

    result = _gate_staged(
        repo_id=repo_id, url=url, owner=meta["owner"], name=meta["name"],
        branch=branch, stage=stage, pin=pin, force=force,
    )
    return _emit_gate("clone", result)


def _emit_gate(command: str, result: Dict[str, Any]) -> int:
    """Map a gate result onto the envelope (ok=False + exit 2 only on a real BLOCK)."""
    if result.get("blocked") and not result.get("promoted"):
        return emit(command, _exit=2, ok=False, **result)
    return emit(command, **result)


# --- verb: list -------------------------------------------------------------- #

def v_list(argv: List[str]) -> int:
    repos = _read_index()
    # reconcile the on-disk truth: a clone dir that vanished is "missing".
    for r in repos:
        lp = r.get("localPath")
        if lp and not Path(lp).is_dir():
            r["status"] = "missing"
    return emit("list", repos=repos, count=len(repos),
                index=str(index_path()), root=str(repos_root()))


# --- verb: update / pin / branch (re-stage → re-gate) ------------------------ #

def _restage_from_live(entry: Dict[str, Any], repo_id: str) -> Optional[Path]:
    """Copy the current live clone into a fresh staging dir so a re-checkout/re-fetch
    happens under safe flags off the live tree without touching the promoted copy until
    the new tree passes the gate."""
    live = Path(entry.get("localPath") or live_dir_for(repo_id))
    if not live.is_dir():
        return None
    stage = stage_dir_for(repo_id)
    if stage.exists():
        shutil.rmtree(stage, ignore_errors=True)
    stage.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(live, stage)
    return stage


def _resolve_entry(repo_id: Optional[str]) -> tuple[Optional[Dict[str, Any]], Optional[int]]:
    if not repo_id:
        return None, fail("update", "need --id <repo id>")
    entry = _find_entry(_read_index(), repo_id)
    if not entry:
        return None, fail("update", f"unknown repo id: {repo_id}",
                          hint="run `list` to see managed repo ids")
    return entry, None


def v_update(argv: List[str]) -> int:
    """Re-stage the new HEAD under safe flags → re-gate → promote on allow (pin-aware)."""
    repo_id = opt_value(argv, "--id")
    force = "--force" in argv
    entry, err = _resolve_entry(repo_id)
    if err is not None:
        return err
    assert entry is not None
    git = _git()
    stage = _restage_from_live(entry, repo_id)  # type: ignore[arg-type]
    if stage is None:
        return fail("update", f"clone dir missing for {repo_id}; re-clone with `clone`")
    if entry.get("pinnedCommit"):
        # pinned repos never auto-advance HEAD; just re-gate the pinned tree.
        log("update: repo is pinned — re-gating the pinned tree without fetch")
    elif git:
        cp = subprocess.run([git, *_GIT_SAFE_FLAGS, "-C", str(stage), "pull", "--ff-only"],
                           capture_output=True, text=True, timeout=_GIT_TIMEOUT)
        if cp.returncode != 0:
            log("update: ff-only pull noop/failed (re-gating current tree):",
                (cp.stderr or "").strip()[-200:])
    result = _gate_staged(
        repo_id=repo_id, url=entry["url"], owner=entry.get("owner", ""),  # type: ignore[arg-type]
        name=entry.get("name", ""), branch=entry.get("branch", "main"),
        stage=stage, pin=entry.get("pinnedCommit"), force=force,
        linked_catalog_item_id=entry.get("linkedCatalogItemId"),
    )
    return _emit_gate("update", result)


def v_pin(argv: List[str]) -> int:
    """``--detach`` checkout of --sha under safe flags → re-gate the pinned tree."""
    repo_id = opt_value(argv, "--id")
    sha = opt_value(argv, "--sha")
    if sha and sha.startswith("-"):
        return fail("pin", "sha must not start with a dash")
    force = "--force" in argv
    entry, err = _resolve_entry(repo_id)
    if err is not None:
        return err
    assert entry is not None
    if not sha:
        return fail("pin", "need --sha <commit>")
    git = _git()
    stage = _restage_from_live(entry, repo_id)  # type: ignore[arg-type]
    if stage is None:
        return fail("pin", f"clone dir missing for {repo_id}; re-clone with `clone`")
    if git:
        cp = subprocess.run([git, *_GIT_SAFE_FLAGS, "-C", str(stage),
                             "checkout", "--detach", sha],
                           capture_output=True, text=True, timeout=_GIT_TIMEOUT)
        if cp.returncode != 0:
            shutil.rmtree(stage, ignore_errors=True)
            return fail("pin", f"git checkout --detach {sha} failed: "
                               f"{(cp.stderr or '').strip()[-300:]}", id=repo_id)
    result = _gate_staged(
        repo_id=repo_id, url=entry["url"], owner=entry.get("owner", ""),  # type: ignore[arg-type]
        name=entry.get("name", ""), branch=entry.get("branch", "main"),
        stage=stage, pin=sha, force=force,
        linked_catalog_item_id=entry.get("linkedCatalogItemId"),
    )
    return _emit_gate("pin", result)


def v_branch(argv: List[str]) -> int:
    """Switch branch under safe flags → re-gate (pin is cleared)."""
    repo_id = opt_value(argv, "--id")
    branch = opt_value(argv, "--branch")
    if branch and branch.startswith("-"):
        return fail("branch", "branch must not start with a dash")
    force = "--force" in argv
    entry, err = _resolve_entry(repo_id)
    if err is not None:
        return err
    assert entry is not None
    if not branch:
        return fail("branch", "need --branch <name>")
    git = _git()
    stage = _restage_from_live(entry, repo_id)  # type: ignore[arg-type]
    if stage is None:
        return fail("branch", f"clone dir missing for {repo_id}; re-clone with `clone`")
    if git:
        cp = subprocess.run([git, *_GIT_SAFE_FLAGS, "-C", str(stage),
                             "checkout", branch],
                           capture_output=True, text=True, timeout=_GIT_TIMEOUT)
        if cp.returncode != 0:
            log("branch: local checkout failed (re-gating current tree):",
                (cp.stderr or "").strip()[-200:])
    result = _gate_staged(
        repo_id=repo_id, url=entry["url"], owner=entry.get("owner", ""),  # type: ignore[arg-type]
        name=entry.get("name", ""), branch=branch, stage=stage, pin=None, force=force,
        linked_catalog_item_id=entry.get("linkedCatalogItemId"),
    )
    return _emit_gate("branch", result)


# --- verb: rescan (re-run nemesis on the CURRENT tree, no fetch) ------------- #

def v_rescan(argv: List[str]) -> int:
    """Re-run the REAL nemesis over the CURRENT live tree (no git fetch/checkout).

    ``--gate-fresh`` forces a full feed re-download + bypasses the verdict cache
    (``PROMETHEUS_GATE_FRESH`` → nemesis ``--no-cache``), surfaced as the GUI's
    "Re-scan with fresh threat feeds". Updates the index verdict ref; never promotes.
    """
    repo_id = opt_value(argv, "--id")
    entry, err = _resolve_entry(repo_id)
    if err is not None:
        return err
    assert entry is not None
    live = Path(entry.get("localPath") or live_dir_for(repo_id))  # type: ignore[arg-type]
    if not live.is_dir():
        entry["status"] = "missing"
        _upsert_entry(entry)
        return emit("rescan", ok=False, _exit=2, id=repo_id, status="missing",
                    message=f"clone dir missing for {repo_id}; re-clone with `clone`")

    gate_fresh = "--gate-fresh" in argv
    prev = os.environ.get("PROMETHEUS_GATE_FRESH")
    if gate_fresh:
        os.environ["PROMETHEUS_GATE_FRESH"] = "1"
    try:
        v = nemesis_gate.nemesis_gate(str(live))
    finally:
        if gate_fresh:
            if prev is None:
                os.environ.pop("PROMETHEUS_GATE_FRESH", None)
            else:
                os.environ["PROMETHEUS_GATE_FRESH"] = prev

    commit = entry.get("pinnedCommit") or _head_sha(live)
    verdict = v.get("verdict", "error")
    ref = _verdict_ref(v, commit)
    entry["lastVerdict"] = ref
    # a blocked re-scan flips the visible status; allow/warn keep it cloned.
    entry["status"] = "blocked" if verdict in ("block", "error") else "cloned"
    _upsert_entry(entry)
    return emit("rescan", id=repo_id, verdict=verdict,
                gate=nemesis_gate.verdict_summary(v), verdict_ref=ref,
                gate_fresh=gate_fresh, status=entry["status"], local_path=str(live))


# --- verb: remove ------------------------------------------------------------ #

def v_remove(argv: List[str]) -> int:
    """Drop the clone dir + index entry (the generic-repo analogue of apps uninstall)."""
    repo_id = opt_value(argv, "--id")
    if not repo_id:
        return fail("remove", "need --id <repo id>")
    repos = _read_index()
    entry = _find_entry(repos, repo_id)
    live = Path((entry or {}).get("localPath") or live_dir_for(repo_id))
    removed_dir = False
    if live.is_dir():
        try:
            shutil.rmtree(live)
            removed_dir = True
        except OSError as exc:
            return fail("remove", f"could not remove clone dir {live}: {exc}", id=repo_id)
    out = [r for r in repos if r.get("id") != repo_id]
    removed_entry = len(out) != len(repos)
    _write_index(out)
    return emit("remove", id=repo_id, removed_dir=removed_dir,
                removed_entry=removed_entry, local_path=str(live),
                found=bool(entry), remaining=len(out))


HANDLERS = {
    "clone": v_clone,
    "list": v_list,
    "update": v_update,
    "pin": v_pin,
    "branch": v_branch,
    "rescan": v_rescan,
    "remove": v_remove,
}


def main(argv: List[str]) -> int:
    return dispatch(PROG, HANDLERS, argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
