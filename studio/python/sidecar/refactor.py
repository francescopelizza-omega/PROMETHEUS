#!/usr/bin/env python3
"""refactor.py — AST analysis + rope-backed WorkspaceEdit sidecar (file 14 §3.8, APP-025).

Read-only AST analysis of local code (no import, no exec, no network) backing the
structural side of refactoring + navigation, PLUS the mature `rope`-backed structural
refactors (extract/inline/move/change-signature/safe-delete/rename). The mutating verbs
never write a file: they emit an LSP-shaped WorkspaceEdit
(`{changes: {"file:///abs": [{range:{start:{line,character},end:{...}}, newText}]}}`,
0-based positions) for the Studio applier (text-edit-apply.ts) to preview and apply.

Verbs (read-only AST, pure stdlib — always available):
  structure --file <f>   functions/classes/methods tree → {ok, command, structure}
  imports   --file <f>   import statements              → {ok, command, imports}
  callgraph --file <f>   intra-module call edges        → {ok, command, edges}
  version

Verbs (AST-first generators, pure stdlib — always available, APP-028). Each walks
the real AST for fields/signatures and returns a WorkspaceEdit inserting the member
at the correct indentation (insert, never rewrite — ast loses comments):
  gen-init      --file F --line L [--attrs a,b]   __init__ from class-level fields
  gen-repr      --file F --line L [--attrs a,b]   __repr__ over instance fields
  gen-eq        --file F --line L [--attrs a,b]   __eq__ (isinstance + field tuple)
  gen-dataclass --file F --line L                 @dataclass conversion (decorator +
                field annotations + delete of the assignment-only __init__; a custom
                __init__ with logic beyond self.x=x fails code="unsupported")
  gen-property  --file F --line L --attr NAME     property + setter over _NAME
  gen-override  --file F --line L --method NAME   override stub (base in this module)
  gen-delegate  --file F --line L --attr F --method M   delegate method to a field
  gen-docstring --file F --line L                 signature-derived stub; idempotent
                (existing docstring → ok:true noop envelope with an empty edit)

Verbs (rope-backed, optional dep — fail closed with code="rope-missing" without rope):
  extract          --file F --start-line N --end-line M --name X [--kind method|variable]
                   [--start-col A --end-col B] [--root D]   (cols 1-based inclusive;
                   --kind variable needs an expression span, not a statement line)
  inline           --file F --line L --col C [--root D]
  move             --file F --symbol S --dest MODULE.py [--root D]
  change-signature --file F --line L --col C --order i,j,k [--remove n] [--root D]
                   (--order/--remove are ORIGINAL 0-based parameter indices)
  safe-delete      --file F --line L --col C [--root D]
  rename           --file F --line L --col C --new-name X [--root D]

argv speaks 1-based line/col; the emitted WorkspaceEdit speaks 0-based LSP positions
(character = UTF-16 code units, matching the TS applier's JS string indexing).
Contract: exactly one JSON object on stdout (C2/C7).
"""
from __future__ import annotations

import ast
import bisect
import difflib
import keyword
import os
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

from _envelope import dispatch, emit, fail, opt_value

PROG = "refactor"
VERSION = "1.1.0"


def _read(path: Optional[str]) -> ast.Module:
    if not path:
        raise ValueError("--file is required")
    with open(path, "r", encoding="utf-8") as fh:
        return ast.parse(fh.read(), filename=path)


def _structure(argv: Sequence[str]) -> int:
    path = opt_value(argv, "--file")
    try:
        tree = _read(path)
    except (OSError, SyntaxError, ValueError) as exc:
        return fail("structure", f"{type(exc).__name__}: {exc}")

    def walk(body: List[ast.stmt]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for item in body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out.append({"kind": "function", "name": item.name, "line": item.lineno, "args": [a.arg for a in item.args.args]})
            elif isinstance(item, ast.ClassDef):
                out.append({
                    "kind": "class",
                    "name": item.name,
                    "line": item.lineno,
                    "bases": [_name(b) for b in item.bases],
                    "members": walk(item.body),
                })
        return out

    return emit("structure", file=path, structure=walk(tree.body))


def _name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_name(node.value)}.{node.attr}"
    return "?"


def _imports(argv: Sequence[str]) -> int:
    path = opt_value(argv, "--file")
    try:
        tree = _read(path)
    except (OSError, SyntaxError, ValueError) as exc:
        return fail("imports", f"{type(exc).__name__}: {exc}")
    imports: List[Dict[str, Any]] = []
    for item in ast.walk(tree):
        if isinstance(item, ast.Import):
            for alias in item.names:
                imports.append({"module": alias.name, "as": alias.asname, "line": item.lineno})
        elif isinstance(item, ast.ImportFrom):
            mod = ("." * (item.level or 0)) + (item.module or "")
            for alias in item.names:
                imports.append({"module": mod, "name": alias.name, "as": alias.asname, "line": item.lineno})
    return emit("imports", file=path, imports=imports)


def _callgraph(argv: Sequence[str]) -> int:
    path = opt_value(argv, "--file")
    try:
        tree = _read(path)
    except (OSError, SyntaxError, ValueError) as exc:
        return fail("callgraph", f"{type(exc).__name__}: {exc}")
    edges: List[Dict[str, str]] = []
    for fn in ast.walk(tree):
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for call in ast.walk(fn):
                if isinstance(call, ast.Call):
                    callee = _call_name(call.func)
                    if callee:
                        edges.append({"from": fn.name, "to": callee})
    return emit("callgraph", file=path, edges=edges)


def _call_name(node: ast.expr) -> Optional[str]:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _version(_argv: Sequence[str]) -> int:
    return emit("version", version=VERSION)


# --- rope-backed WorkspaceEdit engine (APP-025) ------------------------------ #
#
# Invariants (never weaken):
#   * NEVER call project.do() — the sidecar proposes, Studio applies. New contents
#     come from the ChangeSet's ChangeContents objects only.
#   * Project(root, ropefolder=None) — no .ropeproject is ever written.
#   * rope is optional (metadata.py's PIL/exiftool pattern, but imported at CALL
#     time): absent → fail(code="rope-missing"); the AST verbs above keep working.

_ROPE_HINT = "structural refactoring needs the optional 'rope' package (pip install rope)"


def _load_rope() -> Optional[Dict[str, Any]]:
    """Call-time try-import of the optional rope dependency. None when absent."""
    try:
        from rope.base.project import Project
        from rope.contrib import findit
        from rope.refactor import change_signature, inline, move
        from rope.refactor.extract import ExtractMethod, ExtractVariable
        from rope.refactor.rename import Rename
    except ImportError:
        return None
    return {
        "Project": Project,
        "findit": findit,
        "change_signature": change_signature,
        "inline": inline,
        "move": move,
        "ExtractMethod": ExtractMethod,
        "ExtractVariable": ExtractVariable,
        "Rename": Rename,
    }


def _rope_missing(command: str) -> int:
    return fail(command, _ROPE_HINT, code="rope-missing")


def _uri(abs_path: str) -> str:
    """Studio's canonical raw file:// URI (FileTree.tsx: `file://${node.path}`, unencoded)."""
    return "file://" + abs_path


def _utf16_len(s: str) -> int:
    """LSP `character` counts UTF-16 code units (astral chars count as 2)."""
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in s)


def _line_starts(text: str) -> List[int]:
    """Offset of each line start over rope's \\n-normalized text (resource.read())."""
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    return starts


def _split_lines(text: str) -> List[str]:
    """Split on \\n ONLY, keeping ends — NOT str.splitlines(), which also splits on
    \\x0c/\\x0b/\\u2028/... and would desync from _line_starts and the TS applier
    (both are \\n-only)."""
    if not text:
        return []
    lines = [ln + "\n" for ln in text.split("\n")]
    lines[-1] = lines[-1][:-1]  # undo the added \n on the final segment
    if lines[-1] == "":
        lines.pop()
    return lines


def _pos(starts: List[int], text: str, offset: int) -> Dict[str, int]:
    """Absolute char offset → 0-based LSP {line, character} (UTF-16 characters)."""
    line = bisect.bisect_right(starts, offset) - 1
    return {"line": line, "character": _utf16_len(text[starts[line]:offset])}


def _to_offset(text: str, line: int, col: int) -> int:
    """1-based argv line/col → absolute char offset into the SAME string rope reads.

    `col` counts UTF-16 code units (Monaco/LSP editor columns), NOT Python code
    points — symmetric with the UTF-16 `character` this sidecar emits. rope
    normalizes CRLF to \\n in resource.read(); callers must pass that string,
    never raw disk bytes, or CRLF files desync (APP-025 GOTCHA).
    """
    lines = _split_lines(text)
    if line < 1 or line > len(lines):
        raise ValueError(f"--line {line} out of range 1..{len(lines)}")
    content = lines[line - 1].rstrip("\n")
    if col < 1:
        raise ValueError(f"--col {col} out of range on line {line}")
    units = 0
    for i, ch in enumerate(content):
        if units == col - 1:
            return _line_starts(text)[line - 1] + i
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > col - 1:
            raise ValueError(f"--col {col} splits a surrogate pair on line {line}")
    if units == col - 1:  # one past the last char (EOL)
        return _line_starts(text)[line - 1] + len(content)
    raise ValueError(f"--col {col} out of range on line {line} (1..{units + 1})")


def _trim_common(a: str, b: str) -> Tuple[int, int]:
    """(prefix, suffix) char counts shared by a and b (non-overlapping)."""
    pre = 0
    while pre < len(a) and pre < len(b) and a[pre] == b[pre]:
        pre += 1
    suf = 0
    while suf < len(a) - pre and suf < len(b) - pre and a[len(a) - 1 - suf] == b[len(b) - 1 - suf]:
        suf += 1
    return pre, suf


def _edits_between(old: str, new: str) -> List[Dict[str, Any]]:
    """Minimal LSP TextEdits turning `old` into `new` (line-block diff; 1↔1 line
    replacements are trimmed to the changed char span so a rename yields the same
    token-sized edits the LSP path produces)."""
    old_lines = _split_lines(old)
    new_lines = _split_lines(new)
    starts = _line_starts(old)
    edits: List[Dict[str, Any]] = []
    matcher = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "replace" and i2 - i1 == 1 and j2 - j1 == 1:
            a, b = old_lines[i1], new_lines[j1]
            pre, suf = _trim_common(a, b)
            base = starts[i1]
            edits.append({
                "range": {
                    "start": _pos(starts, old, base + pre),
                    "end": _pos(starts, old, base + len(a) - suf),
                },
                "newText": b[pre:len(b) - suf],
            })
            continue
        start_off = starts[i1] if i1 < len(starts) else len(old)
        end_off = starts[i2] if i2 < len(starts) else len(old)
        edits.append({
            "range": {"start": _pos(starts, old, start_off), "end": _pos(starts, old, end_off)},
            "newText": "".join(new_lines[j1:j2]),
        })
    return edits


def _collect_contents(change: Any, out: List[Any]) -> None:
    """Flatten a rope ChangeSet into ChangeContents; refuse resource ops (the TS
    normalizer drops CreateFile/MoveResource, so emitting them would silently lose edits)."""
    if hasattr(change, "changes"):  # nested ChangeSet
        for child in change.changes:
            _collect_contents(child, out)
    elif hasattr(change, "new_contents") and hasattr(change, "resource"):
        out.append(change)
    else:
        raise ValueError(f"unsupported rope change type {type(change).__name__} (file create/move/delete edits are not emitted)")


def _is_outside(rel: str) -> bool:
    """True when a relpath escapes its base (NOT a mere '..'-prefixed dir name)."""
    return rel == ".." or rel.startswith(".." + os.sep)


def _uri_map(real_path: str, raw_root: str, real_root: str) -> str:
    """rope reports symlink-resolved real_path; Studio's canonical URIs use the
    caller's RAW root path (FileTree concatenates unresolved paths). Map the
    resolved prefix back so emitted URIs match open Monaco model URIs."""
    if raw_root != real_root and (real_path == real_root or real_path.startswith(real_root + os.sep)):
        return _uri(raw_root + real_path[len(real_root):])
    return _uri(real_path)


def _workspace_edit(changeset: Any, raw_root: str, real_root: str) -> Dict[str, Any]:
    """ChangeSet → LSP WorkspaceEdit WITHOUT project.do() (disk stays untouched)."""
    contents: List[Any] = []
    _collect_contents(changeset, contents)
    changes: Dict[str, List[Dict[str, Any]]] = {}
    for ch in contents:
        old = ch.resource.read()
        edits = _edits_between(old, ch.new_contents)
        if edits:
            changes.setdefault(_uri_map(ch.resource.real_path, raw_root, real_root), []).extend(edits)
    return {"changes": changes}


def _project_ctx(rope: Dict[str, Any], file_arg: Optional[str], root_arg: Optional[str]):
    """Resolve (project, resource, src, raw_root, real_root). Caller must project.close().

    Containment is checked on symlink-RESOLVED paths (a symlink inside the root
    pointing outside is rejected), while raw_root is kept for URI mapping.
    """
    if not file_arg:
        raise ValueError("--file is required")
    abs_file = os.path.abspath(file_arg)
    if not os.path.isfile(abs_file):
        raise ValueError(f"file not found: {abs_file}")
    raw_root = os.path.abspath(root_arg) if root_arg else os.path.dirname(abs_file)
    real_root = os.path.realpath(raw_root)
    rel = os.path.relpath(os.path.realpath(abs_file), real_root)
    if _is_outside(rel):
        raise ValueError(f"--file {abs_file} is outside --root {raw_root}")
    project = rope["Project"](raw_root, ropefolder=None)
    try:
        project.validate(project.root)  # sync rope's in-memory model with disk
        resource = project.get_resource(rel.replace(os.sep, "/"))
        src = resource.read()
    except Exception:
        project.close()
        raise
    return project, resource, src, raw_root, real_root


def _emit_edit(command: str, edit: Dict[str, Any], **extra: Any) -> int:
    if not edit["changes"]:
        return fail(command, "refactoring produced no textual changes", code="empty-edit", **extra)
    return emit(command, edit=edit, files=sorted(edit["changes"]), **extra)


def _int_opt(argv: Sequence[str], name: str) -> int:
    raw = opt_value(argv, name)
    if raw is None:
        raise ValueError(f"{name} is required")
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from None


def _ident_opt(argv: Sequence[str], name: str) -> str:
    raw = opt_value(argv, name)
    if not raw:
        raise ValueError(f"{name} is required")
    if not raw.isidentifier():
        raise ValueError(f"{name} must be a Python identifier, got {raw!r}")
    if keyword.iskeyword(raw) or keyword.issoftkeyword(raw):
        # isidentifier() accepts keywords — rope would happily emit broken code
        raise ValueError(f"{name} must not be a Python keyword, got {raw!r}")
    return raw


def _def_name_offset(src: str, node: ast.AST) -> int:
    """Char offset of a def/class NAME token (what rope wants pointed at).

    Word-boundary match, not str.index: `def f()` contains an `f` inside the
    `def` keyword itself, so a raw index() lands on the keyword.
    """
    starts = _line_starts(src)
    from_off = starts[node.lineno - 1] + node.col_offset  # type: ignore[attr-defined]
    m = re.compile(rf"\b{re.escape(node.name)}\b").search(src, from_off)  # type: ignore[attr-defined]
    if m is None:  # unreachable for ast-derived nodes; belt-and-braces
        raise ValueError(f"could not locate name {node.name!r} at line {node.lineno}")  # type: ignore[attr-defined]
    return m.start()


def _extract(argv: Sequence[str]) -> int:
    rope = _load_rope()
    if rope is None:
        return _rope_missing("extract")
    try:
        name = _ident_opt(argv, "--name")
        start_line = _int_opt(argv, "--start-line")
        end_line = _int_opt(argv, "--end-line")
        kind = opt_value(argv, "--kind", "method")
        if kind not in ("method", "variable"):
            raise ValueError(f"--kind must be method|variable, got {kind!r}")
        project, resource, src, raw_root, real_root = _project_ctx(rope, opt_value(argv, "--file"), opt_value(argv, "--root"))
        try:
            lines = _split_lines(src)
            if not (1 <= start_line <= end_line <= len(lines)):
                raise ValueError(f"line range {start_line}..{end_line} out of 1..{len(lines)}")
            starts = _line_starts(src)
            first = lines[start_line - 1]
            # default span = whole lines (indent-trimmed); optional 1-based inclusive
            # --start-col/--end-col (UTF-16 units) narrow it to an expression (rope's
            # ExtractVariable requires an expression, not a full statement line)
            start_col = opt_value(argv, "--start-col")
            end_col = opt_value(argv, "--end-col")
            if start_col is not None:
                begin = _to_offset(src, start_line, int(start_col))
            else:
                begin = starts[start_line - 1] + (len(first) - len(first.lstrip()))
            if end_col is not None:
                end = _to_offset(src, end_line, int(end_col)) + 1  # inclusive col → exclusive offset
            else:
                end = starts[end_line - 1] + len(lines[end_line - 1].rstrip("\n"))
            if begin >= end:
                raise ValueError(f"extract span {begin}..{end} is empty")
            cls = rope["ExtractMethod"] if kind == "method" else rope["ExtractVariable"]
            edit = _workspace_edit(cls(project, resource, begin, end).get_changes(name), raw_root, real_root)
        finally:
            project.close()
    except Exception as exc:  # noqa: BLE001 — one fail() envelope, never a crash
        return fail("extract", f"{type(exc).__name__}: {exc}")
    return _emit_edit("extract", edit, name=name, kind=kind)


def _inline(argv: Sequence[str]) -> int:
    rope = _load_rope()
    if rope is None:
        return _rope_missing("inline")
    try:
        project, resource, src, raw_root, real_root = _project_ctx(rope, opt_value(argv, "--file"), opt_value(argv, "--root"))
        try:
            offset = _to_offset(src, _int_opt(argv, "--line"), _int_opt(argv, "--col"))
            edit = _workspace_edit(rope["inline"].create_inline(project, resource, offset).get_changes(), raw_root, real_root)
        finally:
            project.close()
    except Exception as exc:  # noqa: BLE001
        return fail("inline", f"{type(exc).__name__}: {exc}")
    return _emit_edit("inline", edit)


def _move(argv: Sequence[str]) -> int:
    rope = _load_rope()
    if rope is None:
        return _rope_missing("move")
    try:
        symbol = _ident_opt(argv, "--symbol")
        dest = opt_value(argv, "--dest")
        if not dest:
            raise ValueError("--dest is required")
        project, resource, src, raw_root, real_root = _project_ctx(rope, opt_value(argv, "--file"), opt_value(argv, "--root"))
        try:
            node = next(
                (n for n in ast.parse(src).body
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == symbol),
                None,
            )
            if node is None:
                raise ValueError(f"top-level function/class {symbol!r} not found in --file")
            dest_abs = os.path.abspath(dest if os.path.isabs(dest) else os.path.join(raw_root, dest))
            dest_rel = os.path.relpath(os.path.realpath(dest_abs), real_root)
            if _is_outside(dest_rel):
                raise ValueError(f"--dest {dest_abs} is outside --root {raw_root}")
            if not os.path.isfile(dest_abs):
                raise ValueError(f"--dest module not found: {dest_abs} (the sidecar never creates files)")
            dest_res = project.get_resource(dest_rel.replace(os.sep, "/"))
            mover = rope["move"].create_move(project, resource, _def_name_offset(src, node))
            edit = _workspace_edit(mover.get_changes(dest_res), raw_root, real_root)
        finally:
            project.close()
    except Exception as exc:  # noqa: BLE001
        return fail("move", f"{type(exc).__name__}: {exc}")
    return _emit_edit("move", edit, symbol=symbol, dest=dest)


def _change_signature(argv: Sequence[str]) -> int:
    rope = _load_rope()
    if rope is None:
        return _rope_missing("change-signature")
    try:
        order_raw = opt_value(argv, "--order")
        if order_raw is None:  # "" is legal: removing the only parameter leaves an empty order
            raise ValueError("--order is required (comma-separated ORIGINAL 0-based indices, e.g. 2,0,1)")
        try:
            order = [int(t) for t in order_raw.split(",") if t.strip() != ""]
        except ValueError:
            raise ValueError(f"--order must be comma-separated integers, got {order_raw!r}") from None
        remove_raw = opt_value(argv, "--remove")
        remove = int(remove_raw) if remove_raw is not None else None
        project, resource, src, raw_root, real_root = _project_ctx(rope, opt_value(argv, "--file"), opt_value(argv, "--root"))
        try:
            offset = _to_offset(src, _int_opt(argv, "--line"), _int_opt(argv, "--col"))
            changer = rope["change_signature"].ChangeSignature(project, resource, offset)
            count = len(changer.get_args())
            changers: List[Any] = []
            kept = list(range(count))  # both --order and --remove speak ORIGINAL indices
            if remove is not None:
                if not (0 <= remove < count):
                    raise ValueError(f"--remove {remove} out of range for {count} parameter(s)")
                changers.append(rope["change_signature"].ArgumentRemover(remove))
                kept.remove(remove)
            if sorted(order) != kept:
                raise ValueError(f"--order must be a permutation of the remaining original indices {kept}, got {order}")
            # rope's ArgumentReorderer wants post-removal positions
            changers.append(rope["change_signature"].ArgumentReorderer([kept.index(i) for i in order]))
            edit = _workspace_edit(changer.get_changes(changers), raw_root, real_root)
        finally:
            project.close()
    except Exception as exc:  # noqa: BLE001
        return fail("change-signature", f"{type(exc).__name__}: {exc}")
    return _emit_edit("change-signature", edit, order=order, removed=remove)


def _decorator_start_line(lines: List[str], deco: ast.expr) -> int:
    """1-based line of a decorator's `@` token. For PEP 614 parenthesized decorators
    (`@(\\n  name\\n)`) the ast expression starts BELOW the `@(` line — scan upward
    for the line whose first token is `@`."""
    probe = deco.lineno
    while probe >= 1:
        if lines[probe - 1].lstrip().startswith("@"):
            return probe
        probe -= 1
    return deco.lineno


def _safe_delete(argv: Sequence[str]) -> int:
    rope = _load_rope()
    if rope is None:
        return _rope_missing("safe-delete")
    try:
        line = _int_opt(argv, "--line")
        col = _int_opt(argv, "--col")
        project, resource, src, raw_root, real_root = _project_ctx(rope, opt_value(argv, "--file"), opt_value(argv, "--root"))
        try:
            req_off = _to_offset(src, line, col)
            target = None
            for node in ast.walk(ast.parse(src)):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    continue
                name_off = _def_name_offset(src, node)
                if node.lineno == line and name_off <= req_off <= name_off + len(node.name):
                    target = (node, name_off)
                    break
            if target is None:
                raise ValueError(f"no function/class NAME at {line}:{col} (point --line/--col at the definition's name)")
            node, name_off = target
            starts = _line_starts(src)
            lines_list = _split_lines(src)
            span_first = min([node.lineno] + [_decorator_start_line(lines_list, d) for d in node.decorator_list])
            span_start = starts[span_first - 1]
            span_end = starts[node.end_lineno] if node.end_lineno < len(starts) else len(src)
            occurrences = rope["findit"].find_occurrences(project, resource, name_off, unsure=False)
            usages = [
                {"uri": _uri_map(o.resource.real_path, raw_root, real_root), "line": o.lineno}  # 1-based, like structure/imports
                for o in occurrences
                if not (o.resource.real_path == resource.real_path and span_start <= o.offset < span_end)
            ]
            if usages:
                return fail(
                    "safe-delete",
                    f"{len(usages)} live usage(s) of {node.name!r} remain — not deleting",
                    code="usages-remain",
                    symbol=node.name,
                    usages=usages,
                )
            # deleting a block's only statement would leave invalid syntax (e.g. a
            # class whose sole method goes) — verify the residue parses, else `pass`
            new_text = ""
            try:
                ast.parse(src[:span_start] + src[span_end:])
            except SyntaxError:
                new_text = " " * node.col_offset + "pass\n"
                ast.parse(src[:span_start] + new_text + src[span_end:])  # must parse or the verb fails
            edit = {"changes": {_uri_map(resource.real_path, raw_root, real_root): [{
                "range": {"start": _pos(starts, src, span_start), "end": _pos(starts, src, span_end)},
                "newText": new_text,
            }]}}
        finally:
            project.close()
    except Exception as exc:  # noqa: BLE001
        return fail("safe-delete", f"{type(exc).__name__}: {exc}")
    return _emit_edit("safe-delete", edit, symbol=node.name)


def _rename(argv: Sequence[str]) -> int:
    rope = _load_rope()
    if rope is None:
        return _rope_missing("rename")
    try:
        new_name = _ident_opt(argv, "--new-name")
        project, resource, src, raw_root, real_root = _project_ctx(rope, opt_value(argv, "--file"), opt_value(argv, "--root"))
        try:
            offset = _to_offset(src, _int_opt(argv, "--line"), _int_opt(argv, "--col"))
            edit = _workspace_edit(rope["Rename"](project, resource, offset).get_changes(new_name), raw_root, real_root)
        finally:
            project.close()
    except Exception as exc:  # noqa: BLE001
        return fail("rename", f"{type(exc).__name__}: {exc}")
    return _emit_edit("rename", edit, new_name=new_name)


# --- AST-first code generators (APP-028) ------------------------------------ #
#
# Pure stdlib `ast` — no rope, no regex over source. Every verb walks the real
# AST for fields/signatures and emits a WorkspaceEdit that INSERTS whole lines
# (positions are always {line, character: 0}), so UTF-8 col_offset vs UTF-16
# character never diverges and comments/formatting are preserved (ast drops
# them; we splice into the original source, never unparse whole files).

def _gen_ctx(argv: Sequence[str]) -> Tuple[str, str, ast.Module, List[str]]:
    """(abs_path, src, tree, lines) for a generator verb. Text-mode read: universal
    newlines normalize CRLF, which is safe because every emitted position sits at
    character 0 of a line (line numbers are EOL-style-independent)."""
    path = opt_value(argv, "--file")
    if not path:
        raise ValueError("--file is required")
    abs_path = os.path.abspath(path)
    with open(abs_path, "r", encoding="utf-8") as fh:
        src = fh.read()
    return abs_path, src, ast.parse(src, filename=abs_path), src.split("\n")


def _innermost(tree: ast.Module, line: int, kinds: Tuple[type, ...]) -> Optional[ast.AST]:
    """The innermost node of `kinds` whose body spans 1-based `line` (containment
    implies the child starts at or after the parent, so max (lineno, col) wins)."""
    best: Optional[ast.AST] = None
    for node in ast.walk(tree):
        if isinstance(node, kinds) and node.lineno <= line <= (node.end_lineno or node.lineno):
            if best is None or (node.lineno, node.col_offset) > (best.lineno, best.col_offset):  # type: ignore[attr-defined]
                best = node
    return best


def _class_at(tree: ast.Module, argv: Sequence[str]) -> ast.ClassDef:
    line = _int_opt(argv, "--line")
    cls = _innermost(tree, line, (ast.ClassDef,))
    if cls is None:
        raise ValueError(f"no class at --line {line} (place the caret inside the class body)")
    return cls  # type: ignore[return-value]


def _leading_ws(line_text: str) -> str:
    return line_text[: len(line_text) - len(line_text.lstrip(" \t"))]


def _class_indents(lines: List[str], cls: ast.ClassDef) -> Tuple[str, str]:
    """(member_indent, one_level) read from the REAL source lines — never assume
    4 spaces; tabs-vs-spaces comes from the class's own body."""
    first = cls.body[0]
    if first.lineno == cls.lineno:
        raise ValueError(f"one-line class body (class {cls.name}: ...) is not supported")
    class_indent = _leading_ws(lines[cls.lineno - 1])
    member_indent = _leading_ws(lines[first.lineno - 1])
    unit = member_indent[len(class_indent):] if member_indent.startswith(class_indent) else ""
    return member_indent, unit or ("\t" if "\t" in member_indent else "    ")


def _insert_edit(line0: int, text: str) -> Dict[str, Any]:
    pos = {"line": line0, "character": 0}
    return {"range": {"start": dict(pos), "end": dict(pos)}, "newText": text}


def _gen_emit(command: str, path: str, edits: List[Dict[str, Any]], **extra: Any) -> int:
    return _emit_edit(command, {"changes": {_uri(path): edits}}, **extra)


def _member_insert_line(cls: ast.ClassDef) -> int:
    """0-based line index where a new member goes: the line AFTER the class's last
    statement (end_lineno is 1-based; the next line's 0-based index equals it)."""
    return cls.body[-1].end_lineno or cls.body[-1].lineno


def _is_classvar(ann: ast.expr) -> bool:
    """typing.ClassVar annotations mark CLASS attributes, not instance fields."""
    target = ann.value if isinstance(ann, ast.Subscript) else ann
    return (isinstance(target, ast.Name) and target.id == "ClassVar") or (
        isinstance(target, ast.Attribute) and target.attr == "ClassVar"
    )


def _class_fields(cls: ast.ClassDef) -> List[Dict[str, Optional[str]]]:
    """Class-level instance fields in source order: AnnAssign (minus ClassVar) and
    single-Name Assign (minus dunders) → {name, ann, default}."""
    out: List[Dict[str, Optional[str]]] = []
    seen: set = set()
    for stmt in cls.body:
        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            if _is_classvar(stmt.annotation) or stmt.target.id in seen:
                continue
            seen.add(stmt.target.id)
            out.append({
                "name": stmt.target.id,
                "ann": ast.unparse(stmt.annotation),
                "default": ast.unparse(stmt.value) if stmt.value is not None else None,
            })
        elif isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            name = stmt.targets[0].id
            if name.startswith("__") and name.endswith("__") or name in seen:
                continue
            seen.add(name)
            out.append({"name": name, "ann": None, "default": ast.unparse(stmt.value)})
    return out


def _find_member(cls: ast.ClassDef, name: str) -> Optional[ast.stmt]:
    for stmt in cls.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.name == name:
            return stmt
    return None


def _init_self_fields(cls: ast.ClassDef) -> List[str]:
    """Names bound as `self.X = ...` anywhere inside __init__ (source order, deduped)."""
    init = _find_member(cls, "__init__")
    if not isinstance(init, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return []
    names: List[str] = []
    for node in ast.walk(init):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if (
                    isinstance(t, ast.Attribute)
                    and isinstance(t.value, ast.Name)
                    and t.value.id == "self"
                    and t.attr not in names
                ):
                    names.append(t.attr)
    return names


def _attrs_opt(argv: Sequence[str]) -> Optional[List[str]]:
    raw = opt_value(argv, "--attrs")
    if raw is None:
        return None
    attrs = [a.strip() for a in raw.split(",") if a.strip()]
    if not attrs:
        raise ValueError("--attrs must list at least one attribute name")
    for a in attrs:
        if not a.isidentifier():
            raise ValueError(f"--attrs entry {a!r} is not a Python identifier")
    return attrs


def _repr_eq_fields(cls: ast.ClassDef, argv: Sequence[str]) -> List[str]:
    """Instance-field names for __repr__/__eq__: --attrs override, else __init__
    self-assignments first (ground truth for instances) + class-level fields."""
    attrs = _attrs_opt(argv)
    if attrs is not None:
        return attrs
    names = _init_self_fields(cls)
    for f in _class_fields(cls):
        if f["name"] not in names:
            names.append(f["name"])  # type: ignore[arg-type]
    return names


_NO_FIELDS_HINT = "no derivable instance fields (dynamic attributes?) — pass --attrs or use the local-AI generator"


def _member_lines(indent: str, unit: str, lines: List[str]) -> str:
    """Indent a member template (relative indents encoded as leading \\t units) and
    prefix a blank separator line."""
    out = ["\n"]
    for ln in lines:
        depth = len(ln) - len(ln.lstrip("\t"))
        out.append(f"{indent}{unit * depth}{ln.lstrip(chr(9))}\n" if ln else "\n")
    return "".join(out)


def _gen_init(argv: Sequence[str]) -> int:
    try:
        path, _src, tree, lines = _gen_ctx(argv)
        cls = _class_at(tree, argv)
        if _find_member(cls, "__init__") is not None:
            return fail("gen-init", f"{cls.name} already defines __init__", code="member-exists")
        indent, unit = _class_indents(lines, cls)
        attrs = _attrs_opt(argv)
        fields = _class_fields(cls)
        if attrs is not None:
            by_name = {f["name"]: f for f in fields}
            fields = [by_name.get(a, {"name": a, "ann": None, "default": None}) for a in attrs]
        if not fields:
            return fail("gen-init", _NO_FIELDS_HINT, code="no-fields")
        # defaulted params must trail — reorder stably (dataclass-style field order)
        fields = [f for f in fields if f["default"] is None] + [f for f in fields if f["default"] is not None]
        params = ["self"]
        for f in fields:
            p = str(f["name"])
            if f["ann"]:
                p += f": {f['ann']}"
                if f["default"]:
                    p += f" = {f['default']}"
            elif f["default"]:
                p += f"={f['default']}"
            params.append(p)
        body = [f"def __init__({', '.join(params)}):"] + [
            f"\tself.{f['name']} = {f['name']}" for f in fields
        ]
        edit = _insert_edit(_member_insert_line(cls), _member_lines(indent, unit, body))
    except Exception as exc:  # noqa: BLE001 — one fail() envelope, never a crash
        return fail("gen-init", f"{type(exc).__name__}: {exc}")
    return _gen_emit("gen-init", path, [edit], target=cls.name, member="__init__")


def _gen_repr(argv: Sequence[str]) -> int:
    try:
        path, _src, tree, lines = _gen_ctx(argv)
        cls = _class_at(tree, argv)
        if _find_member(cls, "__repr__") is not None:
            return fail("gen-repr", f"{cls.name} already defines __repr__", code="member-exists")
        indent, unit = _class_indents(lines, cls)
        names = _repr_eq_fields(cls, argv)
        if not names:
            return fail("gen-repr", _NO_FIELDS_HINT, code="no-fields")
        inner = ", ".join(f"{n}={{self.{n}!r}}" for n in names)
        body = ["def __repr__(self):", f'\treturn f"{cls.name}({inner})"']
        edit = _insert_edit(_member_insert_line(cls), _member_lines(indent, unit, body))
    except Exception as exc:  # noqa: BLE001
        return fail("gen-repr", f"{type(exc).__name__}: {exc}")
    return _gen_emit("gen-repr", path, [edit], target=cls.name, member="__repr__")


def _gen_eq(argv: Sequence[str]) -> int:
    try:
        path, _src, tree, lines = _gen_ctx(argv)
        cls = _class_at(tree, argv)
        if _find_member(cls, "__eq__") is not None:
            return fail("gen-eq", f"{cls.name} already defines __eq__", code="member-exists")
        indent, unit = _class_indents(lines, cls)
        names = _repr_eq_fields(cls, argv)
        if not names:
            return fail("gen-eq", _NO_FIELDS_HINT, code="no-fields")
        tail = "," if len(names) == 1 else ""
        mine = ", ".join(f"self.{n}" for n in names) + tail
        theirs = ", ".join(f"other.{n}" for n in names) + tail
        body = [
            "def __eq__(self, other):",
            f"\tif not isinstance(other, {cls.name}):",
            "\t\treturn NotImplemented",
            f"\treturn ({mine}) == ({theirs})",
        ]
        edit = _insert_edit(_member_insert_line(cls), _member_lines(indent, unit, body))
    except Exception as exc:  # noqa: BLE001
        return fail("gen-eq", f"{type(exc).__name__}: {exc}")
    return _gen_emit("gen-eq", path, [edit], target=cls.name, member="__eq__")


def _const_type_name(node: ast.expr) -> str:
    if isinstance(node, ast.Constant) and node.value is not None:
        return type(node.value).__name__
    return "object"


def _dataclass_decorated(cls: ast.ClassDef) -> bool:
    for deco in cls.decorator_list:
        target = deco.func if isinstance(deco, ast.Call) else deco
        if isinstance(target, ast.Name) and target.id == "dataclass":
            return True
        if isinstance(target, ast.Attribute) and target.attr == "dataclass":
            return True
    return False


def _dataclass_import(tree: ast.Module) -> Tuple[str, bool]:
    """(decorator_text, import_needed) honoring how the module already imports it."""
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "dataclasses":
            for alias in node.names:
                if alias.name == "dataclass":
                    return f"@{alias.asname or 'dataclass'}", False
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "dataclasses":
                    return f"@{alias.asname or 'dataclasses'}.dataclass", False
    return "@dataclass", True


def _import_insert_line(tree: ast.Module, before_line: int) -> int:
    """0-based line for a new top-level import: after the last import preceding
    `before_line`, else after the module docstring, else line 0."""
    line0 = 0
    body = tree.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        line0 = body[0].end_lineno or body[0].lineno
    for node in body:
        if isinstance(node, (ast.Import, ast.ImportFrom)) and (node.end_lineno or node.lineno) < before_line:
            line0 = max(line0, node.end_lineno or node.lineno)
    return line0


def _gen_dataclass(argv: Sequence[str]) -> int:
    try:
        path, _src, tree, lines = _gen_ctx(argv)
        cls = _class_at(tree, argv)
        if _dataclass_decorated(cls):
            return fail("gen-dataclass", f"{cls.name} is already a dataclass", code="member-exists")
        indent, _unit = _class_indents(lines, cls)
        class_indent = _leading_ws(lines[cls.lineno - 1])
        init = _find_member(cls, "__init__")
        fields: List[Dict[str, Optional[str]]] = []
        if init is not None and isinstance(init, (ast.FunctionDef, ast.AsyncFunctionDef)):
            a = init.args
            if isinstance(init, ast.AsyncFunctionDef) or a.vararg or a.kwarg or a.kwonlyargs or a.posonlyargs:
                return fail(
                    "gen-dataclass",
                    "__init__ signature uses */**/keyword-only/positional-only parameters — convert manually",
                    code="unsupported",
                )
            args = a.args[1:]  # skip self
            defaults: List[Optional[ast.expr]] = [None] * (len(args) - len(a.defaults)) + list(a.defaults)
            by_arg = {arg.arg: (arg, d) for arg, d in zip(args, defaults)}
            assigned: set = set()
            for i, stmt in enumerate(init.body):
                if i == 0 and isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str):
                    continue  # docstring
                if isinstance(stmt, ast.Pass):
                    continue
                if not (
                    isinstance(stmt, ast.Assign)
                    and len(stmt.targets) == 1
                    and isinstance(stmt.targets[0], ast.Attribute)
                    and isinstance(stmt.targets[0].value, ast.Name)
                    and stmt.targets[0].value.id == "self"
                ):
                    return fail(
                        "gen-dataclass",
                        "__init__ has logic beyond simple self.x = x assignments — convert manually",
                        code="unsupported",
                    )
                name = stmt.targets[0].attr
                if isinstance(stmt.value, ast.Name) and stmt.value.id in by_arg:
                    arg, d = by_arg[stmt.value.id]
                    assigned.add(stmt.value.id)
                    fields.append({
                        "name": name,
                        "ann": ast.unparse(arg.annotation) if arg.annotation else (
                            _const_type_name(d) if d is not None else "object"
                        ),
                        "default": ast.unparse(d) if d is not None else None,
                    })
                elif isinstance(stmt.value, ast.Constant):
                    fields.append({
                        "name": name,
                        "ann": _const_type_name(stmt.value),
                        "default": ast.unparse(stmt.value),
                    })
                else:
                    return fail(
                        "gen-dataclass",
                        f"self.{name} is assigned a computed value — convert manually",
                        code="unsupported",
                    )
            unassigned = [arg.arg for arg in args if arg.arg not in assigned]
            if unassigned:
                return fail(
                    "gen-dataclass",
                    f"__init__ parameter(s) {', '.join(unassigned)} are never stored on self — convert manually",
                    code="unsupported",
                )
        already = {f["name"] for f in _class_fields(cls) if f["ann"] is not None}
        new_fields = [f for f in fields if f["name"] not in already]
        edits: List[Dict[str, Any]] = []
        decorator, import_needed = _dataclass_import(tree)
        if import_needed:
            edits.append(_insert_edit(_import_insert_line(tree, cls.lineno), "from dataclasses import dataclass\n"))
        deco_line0 = (
            min([cls.lineno] + [_decorator_start_line(lines, d) for d in cls.decorator_list]) - 1
        )
        edits.append(_insert_edit(deco_line0, f"{class_indent}{decorator}\n"))
        if new_fields or init is not None:
            first = cls.body[0]
            field_line0 = first.lineno - 1
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                field_line0 = first.end_lineno or first.lineno  # after the class docstring
            text = "".join(
                f"{indent}{f['name']}: {f['ann']}" + (f" = {f['default']}" if f["default"] else "") + "\n"
                for f in new_fields
            )
            if init is not None and not new_fields and len(cls.body) == 1:
                text = f"{indent}pass\n"  # deleting the only member must not empty the body
            if text:
                edits.append(_insert_edit(field_line0, text))
        if init is not None:
            del_first = min([init.lineno] + [_decorator_start_line(lines, d) for d in init.decorator_list])
            edits.append({
                "range": {
                    "start": {"line": del_first - 1, "character": 0},
                    "end": {"line": init.end_lineno or init.lineno, "character": 0},
                },
                "newText": "",
            })
    except Exception as exc:  # noqa: BLE001
        return fail("gen-dataclass", f"{type(exc).__name__}: {exc}")
    return _gen_emit("gen-dataclass", path, edits, target=cls.name, fields=[f["name"] for f in new_fields])


def _field_annotation(cls: ast.ClassDef, names: Sequence[str]) -> Optional[str]:
    for stmt in cls.body:
        if (
            isinstance(stmt, ast.AnnAssign)
            and isinstance(stmt.target, ast.Name)
            and stmt.target.id in names
            and not _is_classvar(stmt.annotation)
        ):
            return ast.unparse(stmt.annotation)
    return None


def _gen_property(argv: Sequence[str]) -> int:
    try:
        path, _src, tree, lines = _gen_ctx(argv)
        cls = _class_at(tree, argv)
        attr = _ident_opt(argv, "--attr")
        prop = attr.lstrip("_") or attr
        backing = attr if attr.startswith("_") else f"_{attr}"
        if _find_member(cls, prop) is not None:
            return fail("gen-property", f"{cls.name} already defines {prop}", code="member-exists")
        indent, unit = _class_indents(lines, cls)
        ann = _field_annotation(cls, (backing, attr))
        ret = f" -> {ann}" if ann else ""
        val = f"value: {ann}" if ann else "value"
        body = [
            "@property",
            f"def {prop}(self){ret}:",
            f"\treturn self.{backing}",
            "",
            f"@{prop}.setter",
            f"def {prop}(self, {val}) -> None:",
            f"\tself.{backing} = value",
        ]
        edit = _insert_edit(_member_insert_line(cls), _member_lines(indent, unit, body))
    except Exception as exc:  # noqa: BLE001
        return fail("gen-property", f"{type(exc).__name__}: {exc}")
    return _gen_emit("gen-property", path, [edit], target=cls.name, member=prop)


def _format_params(a: ast.arguments) -> str:
    """Render an ast.arguments as source. Defaults tail-align to posonly+args;
    kw_defaults align 1:1 with kwonlyargs (None = required) — the two alignment
    rules the docstring/override generators share."""
    def one(arg: ast.arg, default: Optional[ast.expr]) -> str:
        t = arg.arg
        if arg.annotation is not None:
            t += f": {ast.unparse(arg.annotation)}"
            if default is not None:
                t += f" = {ast.unparse(default)}"
        elif default is not None:
            t += f"={ast.unparse(default)}"
        return t

    pos = list(a.posonlyargs) + list(a.args)
    defaults: List[Optional[ast.expr]] = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
    parts = [one(arg, d) for arg, d in zip(pos, defaults)]
    if a.posonlyargs:
        parts.insert(len(a.posonlyargs), "/")
    if a.vararg is not None:
        va = f"*{a.vararg.arg}"
        if a.vararg.annotation is not None:
            va += f": {ast.unparse(a.vararg.annotation)}"
        parts.append(va)
    elif a.kwonlyargs:
        parts.append("*")
    for arg, d in zip(a.kwonlyargs, a.kw_defaults):
        parts.append(one(arg, d))
    if a.kwarg is not None:
        kw = f"**{a.kwarg.arg}"
        if a.kwarg.annotation is not None:
            kw += f": {ast.unparse(a.kwarg.annotation)}"
        parts.append(kw)
    return ", ".join(parts)


def _forward_args(a: ast.arguments) -> str:
    """The call-through argument list matching _format_params (skips self/cls)."""
    pos = list(a.posonlyargs) + list(a.args)
    if pos and pos[0].arg in ("self", "cls"):
        pos = pos[1:]
    parts = [arg.arg for arg in pos]
    if a.vararg is not None:
        parts.append(f"*{a.vararg.arg}")
    parts.extend(f"{arg.arg}={arg.arg}" for arg in a.kwonlyargs)
    if a.kwarg is not None:
        parts.append(f"**{a.kwarg.arg}")
    return ", ".join(parts)


def _resolve_class(tree: ast.Module, name: str) -> Optional[ast.ClassDef]:
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node
    return None


def _find_base_method(tree: ast.Module, cls: ast.ClassDef, method: str) -> Optional[ast.stmt]:
    """BFS the in-module base classes for `method` (imported bases are opaque)."""
    queue = [b.id for b in cls.bases if isinstance(b, ast.Name)]
    seen: set = set()
    while queue:
        base_name = queue.pop(0)
        if base_name in seen:
            continue
        seen.add(base_name)
        base = _resolve_class(tree, base_name)
        if base is None:
            continue
        found = _find_member(base, method)
        if found is not None:
            return found
        queue.extend(b.id for b in base.bases if isinstance(b, ast.Name))
    return None


def _gen_override(argv: Sequence[str]) -> int:
    try:
        path, _src, tree, lines = _gen_ctx(argv)
        cls = _class_at(tree, argv)
        method = _ident_opt(argv, "--method")
        if _find_member(cls, method) is not None:
            return fail("gen-override", f"{cls.name} already defines {method}", code="member-exists")
        base = _find_base_method(tree, cls, method)
        if base is None or not isinstance(base, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return fail(
                "gen-override",
                f"method {method!r} not found on {cls.name}'s bases in this module",
                code="not-found",
            )
        indent, unit = _class_indents(lines, cls)
        ret = f" -> {ast.unparse(base.returns)}" if base.returns is not None else ""
        is_async = isinstance(base, ast.AsyncFunctionDef)
        head = f"{'async ' if is_async else ''}def {method}({_format_params(base.args)}){ret}:"
        call = f"super().{method}({_forward_args(base.args)})"
        body = [head, f"\treturn {'await ' if is_async else ''}{call}"]
        edit = _insert_edit(_member_insert_line(cls), _member_lines(indent, unit, body))
    except Exception as exc:  # noqa: BLE001
        return fail("gen-override", f"{type(exc).__name__}: {exc}")
    return _gen_emit("gen-override", path, [edit], target=cls.name, member=method)


def _delegate_target_class(tree: ast.Module, cls: ast.ClassDef, attr: str) -> Optional[ast.ClassDef]:
    """Best-effort in-module resolution of a field's class: `attr: Type` annotation
    or `self.attr = Type(...)` in __init__."""
    for stmt in cls.body:
        if (
            isinstance(stmt, ast.AnnAssign)
            and isinstance(stmt.target, ast.Name)
            and stmt.target.id == attr
            and isinstance(stmt.annotation, ast.Name)
        ):
            return _resolve_class(tree, stmt.annotation.id)
    init = _find_member(cls, "__init__")
    if isinstance(init, (ast.FunctionDef, ast.AsyncFunctionDef)):
        for node in ast.walk(init):
            if (
                isinstance(node, ast.Assign)
                and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Attribute)
                and isinstance(node.targets[0].value, ast.Name)
                and node.targets[0].value.id == "self"
                and node.targets[0].attr == attr
                and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Name)
            ):
                return _resolve_class(tree, node.value.func.id)
    return None


def _gen_delegate(argv: Sequence[str]) -> int:
    try:
        path, _src, tree, lines = _gen_ctx(argv)
        cls = _class_at(tree, argv)
        attr = _ident_opt(argv, "--attr")
        method = _ident_opt(argv, "--method")
        if _find_member(cls, method) is not None:
            return fail("gen-delegate", f"{cls.name} already defines {method}", code="member-exists")
        indent, unit = _class_indents(lines, cls)
        target_cls = _delegate_target_class(tree, cls, attr)
        target = _find_member(target_cls, method) if target_cls is not None else None
        if isinstance(target, (ast.FunctionDef, ast.AsyncFunctionDef)):
            ret = f" -> {ast.unparse(target.returns)}" if target.returns is not None else ""
            is_async = isinstance(target, ast.AsyncFunctionDef)
            head = f"{'async ' if is_async else ''}def {method}({_format_params(target.args)}){ret}:"
            call = f"self.{attr}.{method}({_forward_args(target.args)})"
            body = [head, f"\treturn {'await ' if is_async else ''}{call}"]
        else:
            # target signature unresolvable in this module — generic pass-through
            body = [
                f"def {method}(self, *args, **kwargs):",
                f"\treturn self.{attr}.{method}(*args, **kwargs)",
            ]
        edit = _insert_edit(_member_insert_line(cls), _member_lines(indent, unit, body))
    except Exception as exc:  # noqa: BLE001
        return fail("gen-delegate", f"{type(exc).__name__}: {exc}")
    return _gen_emit("gen-delegate", path, [edit], target=cls.name, member=method)


def _docstring_params(fn: ast.AST) -> List[Tuple[str, Optional[str], Optional[str]]]:
    """(display_name, annotation, default) rows in signature order — posonly+args
    with TAIL-aligned defaults, *vararg, kwonly with 1:1 kw_defaults, **kwarg."""
    a = fn.args  # type: ignore[attr-defined]
    rows: List[Tuple[str, Optional[str], Optional[str]]] = []
    pos = list(a.posonlyargs) + list(a.args)
    defaults: List[Optional[ast.expr]] = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
    for i, (arg, d) in enumerate(zip(pos, defaults)):
        if i == 0 and arg.arg in ("self", "cls"):
            continue
        rows.append((
            arg.arg,
            ast.unparse(arg.annotation) if arg.annotation is not None else None,
            ast.unparse(d) if d is not None else None,
        ))
    if a.vararg is not None:
        rows.append((
            f"*{a.vararg.arg}",
            ast.unparse(a.vararg.annotation) if a.vararg.annotation is not None else None,
            None,
        ))
    for arg, d in zip(a.kwonlyargs, a.kw_defaults):
        rows.append((
            arg.arg,
            ast.unparse(arg.annotation) if arg.annotation is not None else None,
            ast.unparse(d) if d is not None else None,
        ))
    if a.kwarg is not None:
        rows.append((
            f"**{a.kwarg.arg}",
            ast.unparse(a.kwarg.annotation) if a.kwarg.annotation is not None else None,
            None,
        ))
    return rows


def _gen_docstring(argv: Sequence[str]) -> int:
    try:
        path, _src, tree, lines = _gen_ctx(argv)
        line = _int_opt(argv, "--line")
        fn = _innermost(tree, line, (ast.FunctionDef, ast.AsyncFunctionDef))
        if fn is None:
            raise ValueError(f"no function at --line {line} (place the caret inside a def)")
        if ast.get_docstring(fn) is not None:  # type: ignore[arg-type]
            # idempotent: existing docstring → ok:true NO-OP envelope (deliverable 2)
            return emit(
                "gen-docstring",
                edit={"changes": {}},
                files=[],
                noop=True,
                target=fn.name,  # type: ignore[attr-defined]
                reason="docstring already present",
            )
        first = fn.body[0]  # type: ignore[attr-defined]
        if lines[first.lineno - 1][: first.col_offset].strip():
            raise ValueError("one-line function body (def f(): ...) is not supported")
        indent = _leading_ws(lines[first.lineno - 1])
        rows = _docstring_params(fn)
        returns = fn.returns  # type: ignore[attr-defined]
        ret_ann = (
            ast.unparse(returns)
            if returns is not None and not (isinstance(returns, ast.Constant) and returns.value is None)
            else None
        )
        name = fn.name  # type: ignore[attr-defined]
        if not rows and ret_ann is None:
            text = f'{indent}"""TODO: describe {name}."""\n'
        else:
            out = [f'{indent}"""TODO: describe {name}.', ""]
            if rows:
                out.append(f"{indent}Args:")
                for pname, ann, default in rows:
                    desc = f"{pname} ({ann}): TODO." if ann else f"{pname}: TODO."
                    if default is not None:
                        desc += f" Defaults to {default}."
                    out.append(f"{indent}    {desc}")
            if ret_ann is not None:
                if rows:
                    out.append("")
                out.append(f"{indent}Returns:")
                out.append(f"{indent}    {ret_ann}: TODO.")
            out.append(f'{indent}"""')
            text = "\n".join(out) + "\n"
        edit = _insert_edit(first.lineno - 1, text)
    except Exception as exc:  # noqa: BLE001
        return fail("gen-docstring", f"{type(exc).__name__}: {exc}")
    return _gen_emit("gen-docstring", path, [edit], target=name, member="__doc__")


HANDLERS = {
    "structure": _structure,
    "imports": _imports,
    "callgraph": _callgraph,
    "version": _version,
    "extract": _extract,
    "inline": _inline,
    "move": _move,
    "change-signature": _change_signature,
    "safe-delete": _safe_delete,
    "rename": _rename,
    "gen-init": _gen_init,
    "gen-repr": _gen_repr,
    "gen-eq": _gen_eq,
    "gen-dataclass": _gen_dataclass,
    "gen-property": _gen_property,
    "gen-override": _gen_override,
    "gen-delegate": _gen_delegate,
    "gen-docstring": _gen_docstring,
}


if __name__ == "__main__":
    import sys

    raise SystemExit(dispatch(PROG, HANDLERS, sys.argv[1:]))
