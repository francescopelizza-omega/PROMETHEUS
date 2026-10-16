#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""disk_map.py — the disk-space sidecar: a JSON face on ``studio/python/tools/disk_space.py``.

Verbs (contract: ``CONTRACT.md`` § disk_map.py — one JSON object on stdout, exit 0 / 2):

  mounts                                   filesystems: size, used, free, percent
  map PATH [--depth-cap N] [--min-size S] [--min-node S] [--max-nodes N] [--engine E]
                                           the size tree + a summary (capped payload)
  levels PATH [--depth N] [--top K]        ``du --max-depth=N PATH | sort -rh`` for N = 1..depth
  largest-files PATH [--top K]             the biggest files below PATH
  delete PATH… [--trash|--permanent] [--confirm] [--ack-high-risk]
                                           a PLAN unless --confirm; every protection re-checked
  cleanup-plan                             Linux cleanup findings; root actions come back as
                                           exact commands for the privileged gate, never run
  privileged-rescan PATH [--depth-cap N] [--depth N] [--min-size S]
                                           the exact command that rescans PATH as root — for
                                           the privileged gate to show, and run on approval
  privileged-explorer [PATH]               the exact command that opens the interactive tool as
                                           root (Studio: "Open disk space as administrator")

The tool is REUSED, not copied: it is loaded by path under its own module name (a plain
``import disk_space`` would be ambiguous next to this file's directory on sys.path). Its CLI
entry point is never called — ``main()`` re-executes itself through sudo unless told not to —
only its measuring and deleting functions.

This sidecar never runs as root and never elevates. Root work is returned as a command; the
privileged gate shows it to a human and runs it only on that human's approval.

Paths that are not valid UTF-8 are reported with a lossy ``path`` for display and an exact
``rawPath`` (``hex:<bytes>``) that every verb accepts back, so such a file can still be acted on.
"""
from __future__ import annotations

import hashlib
import heapq
import importlib.util
import os
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

from _envelope import dispatch, emit, fail, log

PROG = "disk_map"
VERSION = "1.0.0"

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL_PATH = os.path.normpath(os.path.join(HERE, "..", "tools", "disk_space.py"))
IS_LINUX = sys.platform.startswith("linux")

DEFAULT_MAX_NODES = 20_000
GIB = 1024 ** 3
#: a permanent delete this large asks for a typed confirmation, as the tool's own TUI does
BIG_PERMANENT_DELETE = 10 * GIB
NOT_ROOT = ("disk_map refuses to run as root — run it as your user; a root rescan goes through "
            "the privileged gate, which asks a human first")

_TOOL = None


def load_tool():
    """Load disk_space.py once, under a module name of its own."""
    global _TOOL
    if _TOOL is None:
        name = "prometheus_disk_space_tool"
        spec = importlib.util.spec_from_file_location(name, TOOL_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"disk_space.py not found at {TOOL_PATH}")
        mod = importlib.util.module_from_spec(spec)
        # registered BEFORE exec: its dataclasses resolve their own module by name
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
        _TOOL = mod
    return _TOOL


# ── arguments ────────────────────────────────────────────────────────────────


def parse(argv: Sequence[str], values: Sequence[str], flags: Sequence[str]) -> Tuple[Dict[str, str], List[str]]:
    """Options before ``--`` (value options take the next token or ``=value``); positionals.

    Everything after ``--`` is positional, so a folder named ``-rf`` is a path, never an option.
    An unknown option is an error rather than a silently ignored typo.
    """
    opts: Dict[str, str] = {}
    pos: List[str] = []
    i = 0
    args = list(argv)
    while i < len(args):
        a = args[i]
        if a == "--":
            pos.extend(args[i + 1:])
            break
        if a.startswith("--"):
            key, eq, val = a.partition("=")
            if key in values:
                if not eq:
                    if i + 1 >= len(args):
                        raise ValueError(f"{key} needs a value")
                    i += 1
                    val = args[i]
                opts[key] = val
            elif key in flags and not eq:
                opts[key] = "1"
            else:
                raise ValueError(f"unknown option {a}")
        elif a.startswith("-") and len(a) > 1:
            raise ValueError(f"unknown option {a} (put paths that start with '-' after --)")
        else:
            pos.append(a)
        i += 1
    return opts, pos


def as_path(text: str) -> str:
    """A user-supplied path → absolute, symlinks NOT resolved (deleting a link must hit the link)."""
    if text.startswith("hex:"):
        text = os.fsdecode(bytes.fromhex(text[4:]))
    return os.path.abspath(os.path.expanduser(text))


def jpath(p: str) -> Dict[str, str]:
    """JSON fields for a path: ``path``, plus an exact ``rawPath`` when it is not valid UTF-8."""
    try:
        p.encode("utf-8")
        return {"path": p}
    except UnicodeEncodeError:
        raw = os.fsencode(p)
        return {"path": raw.decode("utf-8", "replace"), "rawPath": "hex:" + raw.hex()}


def jname(name: str) -> str:
    try:
        name.encode("utf-8")
        return name
    except UnicodeEncodeError:
        return os.fsencode(name).decode("utf-8", "replace")


def int_opt(opts: Dict[str, str], key: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(opts.get(key, default))
    except ValueError as exc:
        raise ValueError(f"{key} must be a whole number") from exc
    return max(lo, min(hi, v))


def size_opt(tool, opts: Dict[str, str], key: str, default: str) -> int:
    return tool.parse_size(opts.get(key, default))


def not_root(command: str) -> Optional[int]:
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return fail(command, NOT_ROOT)
    return None


def context(tool):
    # its own log would land in ~/.cache/disk_space — a sidecar run writes nothing of its own
    return tool.Context(log_path=os.devnull)


def scan_map(tool, root: str, opts: Dict[str, str]):
    """Measure ``root`` with the tool's engine, streaming progress to stderr."""
    ctx = context(tool)
    dm = tool.DiskMap(
        ctx,
        root,
        engine=opts.get("--engine", "auto"),
        depth_cap=int_opt(opts, "--depth-cap", 12, 1, 64),
        one_fs=True,
        workers=0,
        survey=True,
        min_node=size_opt(tool, opts, "--min-node", "256K"),
    )
    done = threading.Event()

    def progress() -> None:
        while not done.wait(2.0):
            log(f"progress: {dm.phase} {dm.current or ''}".rstrip())

    t = threading.Thread(target=progress, daemon=True)
    t.start()
    try:
        dm.scan()
    finally:
        done.set()
    if dm.phase == "error":
        raise RuntimeError(dm.message or "the scan failed")
    return ctx, dm


def need_dir(command: str, pos: List[str]) -> Tuple[Optional[str], Optional[int]]:
    if len(pos) != 1:
        return None, fail(command, "expected exactly one PATH")
    root = as_path(pos[0])
    if not os.path.isdir(root):
        return None, fail(command, f"not a folder: {root}")
    return root, None


# ── verbs ────────────────────────────────────────────────────────────────────


def v_mounts(argv: List[str]) -> int:
    cmd = "disk.mounts"
    refused = not_root(cmd)
    if refused is not None:
        return refused
    parse(argv, [], [])
    tool = load_tool()
    ctx = context(tool)
    rows = []
    for m in ctx.mounts:
        rows.append({
            "source": m.source, "target": m.target, "fstype": m.fstype,
            "total": m.total, "used": m.used, "free": m.free,
            "usePct": round(m.use_pct, 1), "disk": m.disk, "onOsDisk": m.on_os_disk,
        })
    return emit(cmd, mounts=rows)


def tree_json(tool, node, max_nodes: int, min_size: int) -> Tuple[Dict[str, Any], int, bool]:
    """Breadth-first, biggest-first, until ``max_nodes`` — so a cap drops the SMALLEST detail."""
    def entry(n) -> Dict[str, Any]:
        d: Dict[str, Any] = {"name": jname(n.name), **jpath(tool.display_path(n.path)),
                             "size": n.size, "dir": n.is_dir}
        items = (max(n.n_dirs, 0) + max(n.n_files, 0)) if (n.n_dirs >= 0 or n.n_files >= 0) else None
        if items is not None:
            d["items"] = items
        if n.flags & tool.F_MOUNT:
            d["mount"] = True
        if n.flags & tool.F_FRONTIER:
            d["frontier"] = True
        if n.flags & tool.F_ERROR:
            d["unreadable"] = True
        return d

    root = entry(node)
    count = 1
    truncated = False
    queue: List[Tuple[Any, Dict[str, Any]]] = [(node, root)]
    while queue:
        n, d = queue.pop(0)
        if not n.is_dir or not n.children:
            continue
        kids = sorted((c for c in n.children.values() if c.size >= min_size), key=lambda c: -c.size)
        out = []
        for c in kids:
            if count >= max_nodes:
                d["more"] = len(kids) - len(out)
                truncated = True
                break
            cd = entry(c)
            out.append(cd)
            count += 1
            queue.append((c, cd))
        if out:
            d["children"] = out
    return root, count, truncated


def v_map(argv: List[str]) -> int:
    cmd = "disk.map"
    refused = not_root(cmd)
    if refused is not None:
        return refused
    opts, pos = parse(argv, ["--depth-cap", "--min-size", "--min-node", "--max-nodes", "--engine"], [])
    root, err = need_dir(cmd, pos)
    if err is not None:
        return err
    tool = load_tool()
    _ctx, dm = scan_map(tool, root, opts)
    tree, nodes, truncated = tree_json(
        tool, dm.root, int_opt(opts, "--max-nodes", DEFAULT_MAX_NODES, 1, 500_000),
        size_opt(tool, opts, "--min-size", "0"),
    )
    summary = dm.summary()
    summary["unreadable"] = summary.get("errors", 0)
    return emit(cmd, summary=summary, tree=tree, nodes=nodes, truncated=truncated)


def v_levels(argv: List[str]) -> int:
    cmd = "disk.levels"
    refused = not_root(cmd)
    if refused is not None:
        return refused
    opts, pos = parse(argv, ["--depth", "--top", "--depth-cap", "--min-node", "--engine"], [])
    root, err = need_dir(cmd, pos)
    if err is not None:
        return err
    tool = load_tool()
    depth = int_opt(opts, "--depth", 10, 1, 64)
    top = int_opt(opts, "--top", 20, 1, 1000)
    _ctx, dm = scan_map(tool, root, opts)
    deepest = max(1, min(depth, dm.survey_max_depth or depth, dm.depth_cap))
    levels = []
    for n in range(1, deepest + 1):
        rows = [{**jpath(tool.display_path(x.path)), "size": x.size}
                for x in dm.at_depth(dm.root, n, exact=False, limit=top)]
        levels.append({"depth": n, "rows": rows})
    return emit(cmd, root=jpath(tool.display_path(dm.root_path))["path"], levels=levels,
                summary=dm.summary())


def v_largest_files(argv: List[str]) -> int:
    cmd = "disk.files"
    refused = not_root(cmd)
    if refused is not None:
        return refused
    opts, pos = parse(argv, ["--top"], [])
    root, err = need_dir(cmd, pos)
    if err is not None:
        return err
    tool = load_tool()
    top = int_opt(opts, "--top", 100, 1, 5000)
    dm = tool.DiskMap(context(tool), root, survey=False)
    files = [{**jpath(p), "size": size, "mtime": mtime}
             for size, p, mtime in dm.largest_files(dm.root, limit=top)]
    return emit(cmd, root=root, files=files)


#: how long a delete PLAN may spend measuring before it reports a lower bound instead
PLAN_SIZE_BUDGET_S = 15.0


def tree_size(path: str, deadline: float) -> Tuple[int, bool]:
    """Allocated bytes below ``path`` (one filesystem, symlinks not followed) — the plan's size.

    Returns ``(bytes, exact)``: past ``deadline`` the walk stops and the figure is a lower bound,
    so a plan for a huge folder answers in seconds instead of re-measuring the disk.
    """
    try:
        st = os.lstat(path)
    except OSError:
        return 0, True
    total = st.st_blocks * 512
    if not os.path.isdir(path) or os.path.islink(path):
        return total, True
    dev = st.st_dev
    stack = [path]
    while stack:
        if time.monotonic() > deadline:
            return total, False
        p = stack.pop()
        try:
            with os.scandir(p) as it:
                for e in it:
                    try:
                        s = e.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    total += s.st_blocks * 512
                    if e.is_dir(follow_symlinks=False) and s.st_dev == dev:
                        stack.append(e.path)
        except OSError:
            continue
    return total, True


def outermost(paths: List[str]) -> List[str]:
    """Drop duplicates and anything inside another selected path (the TUI does the same)."""
    out: List[str] = []
    for p in sorted(set(paths), key=len):
        if not any(p == q or p.startswith(q.rstrip("/") + "/") for q in out):
            out.append(p)
    return out


def plan_delete(tool, ctx, paths: List[str], mode: str) -> Dict[str, Any]:
    """What a delete would do, item by item. Nothing is changed."""
    items = []
    worst = None
    total = 0
    deadline = time.monotonic() + PLAN_SIZE_BUDGET_S
    for p in outermost(paths):
        item: Dict[str, Any] = {**jpath(p), "mode": mode, "size": 0, "risk": None,
                                "reason": "", "protected": None}
        if not os.path.lexists(p):
            item["protected"] = "does not exist"
            items.append(item)
            continue
        item["protected"] = tool.path_protected(ctx, None, p)
        if item["protected"]:
            # never measured: a refused path is not going anywhere, and "/" or a home folder
            # would mean walking the whole disk just to say no
            items.append(item)
            continue
        size, exact = tree_size(p, deadline)
        item["size"] = size
        if not exact:
            item["sizeAtLeast"] = True
        risk, why = tool.path_risk(ctx, p, size)
        item["risk"], item["reason"] = risk, why
        if mode == "trash":
            trash, twhy = tool.trash_dir_for(ctx, p)
            item["trashDir"] = trash
            if not trash:
                item["reason"] = f"{why}; no Trash: {twhy}"
        total += size
        if worst is None or tool.RISK_ORDER.get(risk, 0) > tool.RISK_ORDER.get(worst, 0):
            worst = risk
        items.append(item)
    requires = worst == tool.RISK_HIGH or (mode == "permanent" and total >= BIG_PERMANENT_DELETE)
    return {"items": items, "worstRisk": worst, "total": total, "requiresPhrase": bool(requires)}


def execute_delete(tool, ctx, paths: List[str], mode: str) -> List[Dict[str, Any]]:
    """Delete, re-checking EVERY protection now — never trusting what a plan said earlier."""
    results = []
    for p in outermost(paths):
        r: Dict[str, Any] = {**jpath(p), "ok": False}
        if not os.path.lexists(p):
            r["msg"] = "does not exist"
        else:
            reason = tool.path_protected(ctx, None, p)
            if reason:
                r["msg"] = f"refused: {reason}"
            else:
                ok, msg = (tool.move_to_trash(ctx, p) if mode == "trash"
                           else tool.delete_permanently(ctx, p))
                r["ok"], r["msg"] = ok, msg
        results.append(r)
    return results


def v_delete(argv: List[str]) -> int:
    cmd = "disk.delete"
    refused = not_root(cmd)
    if refused is not None:
        return refused
    opts, pos = parse(argv, [], ["--trash", "--permanent", "--confirm", "--ack-high-risk"])
    if "--trash" in opts and "--permanent" in opts:
        return fail(cmd, "choose --trash or --permanent, not both")
    if not pos:
        return fail(cmd, "expected one or more PATHs")
    mode = "permanent" if "--permanent" in opts else "trash"
    paths = [as_path(p) for p in pos]
    tool = load_tool()
    ctx = context(tool)
    plan = plan_delete(tool, ctx, paths, mode)
    if "--confirm" not in opts:
        return emit(cmd, planned=True, mode=mode, **plan,
                    note="nothing changed — re-run with --confirm to delete"
                         + (" (and --ack-high-risk: this plan needs a typed confirmation)"
                            if plan["requiresPhrase"] else ""))
    if plan["requiresPhrase"] and "--ack-high-risk" not in opts:
        return fail(cmd, "this delete is high-risk or very large: it needs --ack-high-risk, which "
                         "a UI passes only after the human typed the confirmation", **plan)
    results = execute_delete(tool, ctx, paths, mode)
    return emit(cmd, executed=True, mode=mode, results=results,
                deleted=sum(1 for r in results if r["ok"]))


def script_info(path: str) -> Dict[str, Any]:
    data = open(path, "rb").read()
    return {"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def tool_command(*args: str) -> List[str]:
    """``python3 -I disk_space.py --no-sudo --log /dev/null …`` — for the privileged gate.

    The tool never self-elevates (``--no-sudo``). ``-I`` (isolated mode) matters because this
    argv runs as ROOT: without it Python puts the script's own directory — ``tools/``, writable
    by the user — first on ``sys.path``, so a planted ``tools/shlex.py`` would be imported by
    root ahead of the stdlib, invisible to the SHA-256 the human is shown for disk_space.py.
    """
    return [sys.executable, "-I", TOOL_PATH, "--no-sudo", "--log", os.devnull, *args]


def v_privileged_rescan(argv: List[str]) -> int:
    cmd = "disk.privileged-rescan"
    refused = not_root(cmd)
    if refused is not None:
        return refused
    opts, pos = parse(argv, ["--depth-cap", "--min-size", "--depth"], [])
    root, err = need_dir(cmd, pos)
    if err is not None:
        return err
    tool = load_tool()
    depth_cap = int_opt(opts, "--depth-cap", 12, 1, 64)
    # how deep the printed tree goes: without it the tool prints every level it measured (64),
    # which for `/` is far more JSON than any caller can hold
    depth = int_opt(opts, "--depth", 6, 1, 64)
    min_size = opts.get("--min-size", "1M")
    tool.parse_size(min_size)  # validate before handing it to a root process
    argv_out = tool_command("--map-json", root, "--depth-cap", str(depth_cap), "--depth", str(depth),
                            "--min-size", min_size)
    return emit(cmd, argv=argv_out, script=script_info(TOOL_PATH), cwd="/",
                why=f"measure folders under {root} that your user cannot read")


def v_privileged_explorer(argv: List[str]) -> int:
    cmd = "disk.privileged-explorer"
    refused = not_root(cmd)
    if refused is not None:
        return refused
    _, pos = parse(argv, [], [])
    extra: List[str] = []
    if pos:
        root, err = need_dir(cmd, pos)
        if err is not None:
            return err
        extra = ["--map", root]
    return emit(cmd, argv=tool_command(*extra), script=script_info(TOOL_PATH), cwd="/",
                why="explore the whole disk as root, including folders your user cannot read")


def v_cleanup_plan(argv: List[str]) -> int:
    cmd = "disk.cleanup-plan"
    refused = not_root(cmd)
    if refused is not None:
        return refused
    parse(argv, [], [])
    if not IS_LINUX:
        return emit(cmd, findings=[], note="cleanup procedures (Docker, swap) are Linux-only")
    tool = load_tool()
    ctx = context(tool)
    result = tool.Scanner(ctx).scan()
    findings = []
    for f in result.findings:
        acts = []
        for a in f.actions:
            needs_input = [getattr(i, "key", getattr(i, "name", "")) for i in (a.inputs or [])]
            acts.append({
                "id": a.id, "title": a.title, "risk": a.risk, "needsRoot": bool(a.needs_root),
                "needsInput": needs_input, "preview": a.preview_lines(),
                "requiresReboot": bool(a.requires_reboot), "recommended": bool(a.recommended),
                # the exact command for the privileged gate; never run here
                "command": None if needs_input else tool_command("--apply", f"{f.id}:{a.id}", "--yes"),
            })
        findings.append({"id": f.id, "title": f.title, "category": f.category, "size": f.size,
                         "reclaimable": f.reclaimable, "mountpoint": f.mountpoint,
                         "risk": f.risk, "summary": f.summary, "actions": acts})
    return emit(cmd, findings=findings, errors=[list(e) for e in result.errors])


def guarded(command: str, fn):
    """A failure inside a verb is still reported under that verb's namespaced name."""
    def run(argv: List[str]) -> int:
        try:
            return fn(argv)
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001 — fail-closed: always one envelope
            log("traceback:", repr(exc))
            return fail(command, f"{type(exc).__name__}: {exc}")
    return run


HANDLERS = {
    "mounts": guarded("disk.mounts", v_mounts),
    "map": guarded("disk.map", v_map),
    "levels": guarded("disk.levels", v_levels),
    "largest-files": guarded("disk.files", v_largest_files),
    "delete": guarded("disk.delete", v_delete),
    "privileged-rescan": guarded("disk.privileged-rescan", v_privileged_rescan),
    "privileged-explorer": guarded("disk.privileged-explorer", v_privileged_explorer),
    "cleanup-plan": guarded("disk.cleanup-plan", v_cleanup_plan),
}


def main(argv: Sequence[str]) -> int:
    # a ValueError from argument parsing is a fail-closed envelope like any other (dispatch)
    return dispatch(PROG, HANDLERS, argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
