#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""structsearch.py — structural search-and-replace (SSR) over Python ASTs (MDS parity 06).

Read-only AST *shape* matching (not text): a pattern template like ``print($X)`` matches every
``print(...)`` call regardless of the argument, binding ``$X`` to the matched sub-expression's
source. Metavariables (``$NAME``) are pre-transformed to sentinel identifiers so the template is
valid Python, parsed with ``ast``, then compared against each file's AST by a recursive node
matcher (NOT ``ast.dump`` string compare — that leaks ``ctx``/lineno and loses per-binding capture).

Pure stdlib (``ast``, ``re``, ``os``): no import/exec of the target code, no network. Emits ONE
JSON object via the shared C7 envelope (``_envelope.emit``/``fail``, exit 2 fail-closed). Verbs:

  version                                             → {ok, command, version}
  match   --path <dir|file> --pattern <tmpl>          → {ok, command, matches:[…], count}
  replace --path … --pattern <tmpl> --rewrite <tmpl>  → {ok, command, plan:[{file, edits:[…]}], count}
          [--confirm]                                    (writes to disk ONLY with --confirm)

The IDE uses `match` (read-only) from IPC; `replace` returns a non-destructive PLAN and only
touches disk under an explicit ``--confirm`` (mirrors metadata.py's confirm discipline).
"""
from __future__ import annotations

import ast
import os
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

import _envelope as env

PROG = "structsearch"
VERSION = "1.0.0"

# dirs never walked (mirror the engine ignore list) + the per-run file cap.
_IGNORE_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "out", "build", ".next", "target", "coverage"}
_MAX_FILES = 5000
_MAX_TMPL = 4000  # template length cap (defense; the TS validator caps too)

_METAVAR_RE = re.compile(r"\$([A-Za-z_]\w*)")
_SENTINEL_PREFIX = "__ssr_"
_SENTINEL_SUFFIX = "__"


def _to_sentinels(template: str) -> str:
    """``$X`` → ``__ssr_X__`` so the template tokenizes + parses as valid Python."""
    return _METAVAR_RE.sub(lambda m: f"{_SENTINEL_PREFIX}{m.group(1)}{_SENTINEL_SUFFIX}", template)


def _metavar_name(node: ast.AST) -> Optional[str]:
    """The metavariable name if ``node`` is a sentinel ``Name`` (``__ssr_X__`` → ``X``), else None."""
    if isinstance(node, ast.Name):
        nid = node.id
        if nid.startswith(_SENTINEL_PREFIX) and nid.endswith(_SENTINEL_SUFFIX):
            return nid[len(_SENTINEL_PREFIX) : -len(_SENTINEL_SUFFIX)]
    return None


def _pattern_node(template: str) -> ast.AST:
    """Parse the metavar-transformed template → the single node to match (an expression body's
    ``.value`` so ``print($X)`` matches Call nodes; a statement stays a statement)."""
    mod = ast.parse(_to_sentinels(template), mode="exec")
    if not mod.body:
        raise ValueError("empty pattern")
    top = mod.body[0]
    return top.value if isinstance(top, ast.Expr) else top


def _seg(src: str, node: ast.AST) -> str:
    """The source text of ``node`` (3.8+ get_source_segment; '' when position is absent)."""
    try:
        s = ast.get_source_segment(src, node)
    except Exception:  # noqa: BLE001
        s = None
    return s if s is not None else ""


def _match(p: ast.AST, t: ast.AST, binds: Dict[str, str], src: str) -> bool:
    """Recursively match pattern node ``p`` against target ``t``; captures metavar bindings.
    Ignores ``ctx`` (Load/Store) + position (iter_fields omits lineno). A metavar matches ANY
    subtree; a REPEATED metavar must bind a structurally-equal segment (PyCharm consistency)."""
    mv = _metavar_name(p)
    if mv is not None:
        seg = _seg(src, t)
        if mv in binds:
            return _norm(binds[mv]) == _norm(seg)  # consistency for repeated $X
        binds[mv] = seg
        return True
    if type(p) is not type(t):
        return False
    for field, pval in ast.iter_fields(p):
        if field == "ctx":  # Load()/Store()/Del() — never part of the shape
            continue
        if not _match_field(pval, getattr(t, field, None), binds, src):
            return False
    return True


def _match_field(pv: Any, tv: Any, binds: Dict[str, str], src: str) -> bool:
    if isinstance(pv, ast.AST):
        return isinstance(tv, ast.AST) and _match(pv, tv, binds, src)
    if isinstance(pv, list):
        if not isinstance(tv, list) or len(pv) != len(tv):
            return False
        return all(_match_field(a, b, binds, src) for a, b in zip(pv, tv))
    return pv == tv  # primitive (str/int/float/bool/None constant value)


def _norm(s: str) -> str:
    """Collapse whitespace for repeated-metavar consistency comparison."""
    return re.sub(r"\s+", " ", s).strip()


def _char_col(line_text: str, byte_off: int) -> int:
    """Convert a 0-based UTF-8 BYTE column to a 0-based CHARACTER column (multibyte-safe)."""
    raw = line_text.encode("utf-8")
    return len(raw[: max(0, byte_off)].decode("utf-8", errors="ignore"))


def _iter_py_files(path: str) -> List[str]:
    if os.path.isfile(path):
        return [path] if path.endswith(".py") else []
    out: List[str] = []
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in _IGNORE_DIRS and not os.path.islink(os.path.join(root, d))]
        for f in files:
            if f.endswith(".py"):
                out.append(os.path.join(root, f))
                if len(out) >= _MAX_FILES:
                    return out
    return out


def _matches_in_file(
    pattern: ast.AST, file: str, unread: Optional[List[Dict[str, Any]]] = None
) -> List[Dict[str, Any]]:
    """Matches in one file. Files that could not be READ or PARSED are appended to ``unread``.

    Skipping them is right — one unparseable file must never abort the walk — but skipping them
    SILENTLY is what made the result a lie: a genuine no-match and "2 of your 3 files were never
    searched" both came back as ``{"count": 0, "matches": []}``. That is the same defect
    ``_resolve_path`` below already documents for a missing path, one level further down.
    """
    try:
        with open(file, "r", encoding="utf-8") as fh:
            src = fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        if unread is not None:
            unread.append({"file": file, "reason": f"{type(exc).__name__}: {exc}"})
        return []
    try:
        tree = ast.parse(src)
    except SyntaxError as exc:
        # non-Python / invalid → skip, never abort the walk — but SAY so.
        if unread is not None:
            unread.append({"file": file, "reason": f"SyntaxError: {exc.msg} (line {exc.lineno})"})
        return []
    lines = src.splitlines()
    ptype = type(pattern)
    out: List[Dict[str, Any]] = []
    for node in ast.walk(tree):
        if type(node) is not ptype:
            continue
        binds: Dict[str, str] = {}
        if _match(pattern, node, binds, src):
            line = getattr(node, "lineno", 0)
            col = getattr(node, "col_offset", 0)
            line_text = lines[line - 1] if 0 < line <= len(lines) else ""
            out.append(
                {
                    "file": file,
                    "line": line,
                    "col": _char_col(line_text, col) + 1,  # 1-based char column
                    "end_line": getattr(node, "end_lineno", line),
                    "end_col": getattr(node, "end_col_offset", col),
                    "snippet": _seg(src, node),
                    "bindings": binds,
                }
            )
    return out


def _run_match(
    pattern_tmpl: str, path: str
) -> Tuple[List[Dict[str, Any]], int, List[Dict[str, Any]]]:
    pattern = _pattern_node(pattern_tmpl)
    matches: List[Dict[str, Any]] = []
    unread: List[Dict[str, Any]] = []
    for file in _iter_py_files(path):
        matches.extend(_matches_in_file(pattern, file, unread))
    return matches, len(matches), unread


def _apply_rewrite(rewrite_tmpl: str, bindings: Dict[str, str]) -> str:
    """Substitute captured ``$X`` bindings into the rewrite template as TEXT (preserves the
    user's formatting; unbound metavars are left literal so a typo is visible, not silent)."""
    return _METAVAR_RE.sub(lambda m: bindings.get(m.group(1), m.group(0)), rewrite_tmpl)


# --- verbs ------------------------------------------------------------------ #


def _version(argv: Sequence[str]) -> int:
    return env.emit("version", version=VERSION)


def _resolve_path(argv: Sequence[str]) -> str:
    path = env.opt_value(argv, "--path")
    if not path:
        raise ValueError("missing --path")
    # FAIL CLOSED on a path that is not there.
    #
    # `_iter_py_files` returns [] for a missing path — `os.path.isfile` is False and `os.walk`
    # yields nothing — so the verb answered `{"count": 0, "matches": [], "ok": true}`: a SUCCESS
    # that is byte-identical to "I searched and this symbol does not exist". Measured: the same
    # pattern against a real file returns 32 matches and against `/tmp/no-such-file.py` returns
    # 0 with ok:true. A caller (the agent, the Structural Search panel) then concludes the symbol
    # is absent when what actually happened is that the path was wrong.
    if not os.path.exists(path):
        raise ValueError(f"path does not exist: {path}")
    return path


def _resolve_tmpl(argv: Sequence[str], name: str) -> str:
    val = env.opt_value(argv, name)
    if not val:
        raise ValueError(f"missing {name}")
    if len(val) > _MAX_TMPL:
        raise ValueError(f"{name} too long")
    # validate the pattern parses (as a sentinel-transformed template) — fail-closed on garbage.
    ast.parse(_to_sentinels(val), mode="exec")
    return val


def _match_verb(argv: Sequence[str]) -> int:
    path = _resolve_path(argv)
    pattern = _resolve_tmpl(argv, "--pattern")
    matches, count, unread = _run_match(pattern, path)
    # `unreadable` rides the envelope ALWAYS (empty list when everything parsed), so a caller
    # can distinguish "no matches" from "not everything was searched" without guessing.
    return env.emit("match", matches=matches, count=count, unreadable=unread)


def _replace_verb(argv: Sequence[str]) -> int:
    path = _resolve_path(argv)
    pattern = _resolve_tmpl(argv, "--pattern")
    rewrite = _resolve_tmpl(argv, "--rewrite")
    confirm = env.has_flag(argv, "--confirm")

    matches, count, unread = _run_match(pattern, path)
    # group per-file, build non-overlapping edits applied RIGHT-TO-LEFT (descending) so an
    # earlier edit never shifts a later span.
    by_file: Dict[str, List[Dict[str, Any]]] = {}
    for m in matches:
        edit = {
            "line": m["line"],
            "end_line": m["end_line"],
            "old": m["snippet"],
            "new": _apply_rewrite(rewrite, m["bindings"]),
        }
        by_file.setdefault(m["file"], []).append(edit)

    plan = [{"file": f, "edits": sorted(edits, key=lambda e: -e["line"])} for f, edits in sorted(by_file.items())]

    written = 0
    skipped: List[Dict[str, Any]] = []
    if confirm:
        # Actual write: apply each edit AT ITS MATCHED LINE, right-to-left per file (only touched
        # under --confirm, mirroring metadata.py's confirm gate).
        #
        # This used to be `text.replace(edit["old"], edit["new"], 1)`, which always hits the FIRST
        # occurrence of that snippet anywhere in the file and ignores `line` entirely — so the
        # right-to-left ordering the comment above promises was inert, because line numbers never
        # reached the write. When the same snippet text also appeared earlier in a comment, a
        # docstring or a string literal, the codemod rewrote THAT and left the real call site
        # untouched, while the envelope reported `written: 1` against a plan naming the correct
        # line. A destructive on-disk edit to the wrong place, reported as a success.
        for entry in plan:
            try:
                with open(entry["file"], "r", encoding="utf-8") as fh:
                    text = fh.read()
                changed = False
                for edit in entry["edits"]:
                    old_text = edit["old"]
                    if not old_text:
                        continue
                    idx = _offset_of_line(text, edit["line"])
                    if idx is None:
                        skipped.append({"file": entry["file"], "line": edit["line"],
                                        "reason": "line no longer exists"})
                        continue
                    found = text.find(old_text, idx)
                    # The match must START on the line the AST reported. Anything else means the
                    # file moved under us, and guessing is exactly what caused the corruption.
                    line_end = _offset_of_line(text, edit["line"] + 1)
                    if found == -1 or (line_end is not None and found >= line_end):
                        skipped.append({"file": entry["file"], "line": edit["line"],
                                        "reason": "snippet not found at its matched line"})
                        continue
                    text = text[:found] + edit["new"] + text[found + len(old_text):]
                    changed = True
                if changed:
                    with open(entry["file"], "w", encoding="utf-8") as fh:
                        fh.write(text)
                    written += 1
            except OSError:
                continue

    return env.emit("replace", plan=plan, count=count, written=written,
                    confirmed=confirm, skipped=skipped, unreadable=unread)


def _offset_of_line(text: str, line: int) -> Optional[int]:
    """Character offset where 1-based `line` starts, or None when the file has fewer lines.

    Recomputed per edit rather than cached: edits are applied right-to-left, so earlier offsets
    stay valid, but two edits on the SAME line would shift each other.
    """
    if line <= 1:
        return 0 if line == 1 else None
    pos = 0
    seen = 1
    while seen < line:
        nl = text.find("\n", pos)
        if nl == -1:
            return None
        pos = nl + 1
        seen += 1
    return pos


HANDLERS = {
    "version": _version,
    "match": _match_verb,
    "replace": _replace_verb,
}


if __name__ == "__main__":
    import sys

    raise SystemExit(env.dispatch(PROG, HANDLERS, sys.argv[1:]))
