#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""diagram.py — AST → UML / dependency diagrams (file 14 §3.17).

Read-only AST walk of local code → a Mermaid (and Graphviz DOT) diagram **string** in
the envelope (no import, no exec, no `dot` binary spawn, no network). The viewer renders
the string with bundled mermaid.js / viz.js.

Verbs:
  uml  --path <dir>   class inheritance/members → {ok, command, mermaid, dot}
  deps --path <dir>   module import graph        → {ok, command, mermaid, dot, cycles}
  version

Pure stdlib (ast, os). Contract: exactly one JSON object on stdout (C2/C7).
"""
from __future__ import annotations

import ast
import os
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

from _envelope import dispatch, emit, fail, log, opt_value

PROG = "diagram"
VERSION = "1.0.0"

_SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".tox"}


def _py_files(root: str) -> List[str]:
    out: List[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for name in sorted(filenames):
            if name.endswith(".py"):
                out.append(os.path.join(dirpath, name))
    return out


def _base_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return "?"


def _uml(argv: Sequence[str]) -> int:
    root = opt_value(argv, "--path", ".") or "."
    if not os.path.isdir(root):
        return fail("uml", f"not a directory: {root}")
    classes: Dict[str, List[str]] = {}  # class → bases
    members: Dict[str, List[str]] = {}  # class → method names
    for path in _py_files(root):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), filename=path)
        except (OSError, SyntaxError, ValueError) as exc:
            log(f"skip {path}: {exc}")
            continue
        for item in ast.walk(tree):
            if isinstance(item, ast.ClassDef):
                classes[item.name] = [_base_name(b) for b in item.bases]
                members[item.name] = [
                    m.name for m in item.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))
                ]
    mermaid = _uml_mermaid(classes, members)
    dot = _uml_dot(classes)
    return emit("uml", path=os.path.abspath(root), classCount=len(classes), mermaid=mermaid, dot=dot)


def _uml_mermaid(classes: Dict[str, List[str]], members: Dict[str, List[str]]) -> str:
    lines = ["classDiagram"]
    for cls in sorted(classes):
        for m in members.get(cls, [])[:20]:
            lines.append(f"  {cls} : +{m}()")
        for base in classes[cls]:
            if base in classes:
                lines.append(f"  {base} <|-- {cls}")
    return "\n".join(lines)


def _uml_dot(classes: Dict[str, List[str]]) -> str:
    lines = ["digraph UML {", "  rankdir=BT;", "  node [shape=box];"]
    for cls in sorted(classes):
        lines.append(f'  "{cls}";')
        for base in classes[cls]:
            if base in classes:
                lines.append(f'  "{cls}" -> "{base}";')
    lines.append("}")
    return "\n".join(lines)


def _module_name(path: str, root: str) -> str:
    rel = os.path.relpath(path, root)
    return rel[:-3].replace(os.sep, ".") if rel.endswith(".py") else rel


def _deps(argv: Sequence[str]) -> int:
    root = opt_value(argv, "--path", ".") or "."
    if not os.path.isdir(root):
        return fail("deps", f"not a directory: {root}")
    edges: List[Tuple[str, str]] = []
    modules = set()
    for path in _py_files(root):
        mod = _module_name(path, root)
        modules.add(mod)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), filename=path)
        except (OSError, SyntaxError, ValueError) as exc:
            log(f"skip {path}: {exc}")
            continue
        for item in ast.walk(tree):
            if isinstance(item, ast.ImportFrom) and item.module:
                edges.append((mod, item.module.split(".")[0]))
            elif isinstance(item, ast.Import):
                for alias in item.names:
                    edges.append((mod, alias.name.split(".")[0]))
    internal = [(a, b) for (a, b) in edges if any(m == b or m.startswith(f"{b}.") or m.split(".")[0] == b for m in modules)]
    cycles = _find_cycles(internal)
    mermaid = _deps_mermaid(internal)
    dot = _deps_dot(internal)
    return emit("deps", path=os.path.abspath(root), moduleCount=len(modules), mermaid=mermaid, dot=dot, cycles=cycles)


def _deps_mermaid(edges: List[Tuple[str, str]]) -> str:
    lines = ["graph LR"]
    for a, b in sorted(set(edges)):
        lines.append(f'  {_safe(a)}["{a}"] --> {_safe(b)}["{b}"]')
    return "\n".join(lines)


def _deps_dot(edges: List[Tuple[str, str]]) -> str:
    lines = ["digraph deps {", "  rankdir=LR;"]
    for a, b in sorted(set(edges)):
        lines.append(f'  "{a}" -> "{b}";')
    lines.append("}")
    return "\n".join(lines)


def _safe(name: str) -> str:
    return "n_" + "".join(c if c.isalnum() else "_" for c in name)


def _find_cycles(edges: List[Tuple[str, str]]) -> List[List[str]]:
    """Report simple back-edge cycles (DSM-lite) via DFS."""
    graph: Dict[str, List[str]] = {}
    for a, b in edges:
        graph.setdefault(a, []).append(b)
    cycles: List[List[str]] = []
    visiting: List[str] = []
    visited: set[str] = set()

    def dfs(node: str) -> None:
        if node in visiting:
            i = visiting.index(node)
            cycles.append(visiting[i:] + [node])
            return
        if node in visited:
            return
        visiting.append(node)
        for nxt in graph.get(node, []):
            dfs(nxt)
        visiting.pop()
        visited.add(node)

    for n in list(graph):
        dfs(n)
    # dedupe
    seen = set()
    uniq: List[List[str]] = []
    for c in cycles:
        key = tuple(sorted(c))
        if key not in seen:
            seen.add(key)
            uniq.append(c)
    return uniq


def _er(argv: Sequence[str]) -> int:
    """APP-087: render a DB schema (sqlrunner `schema` JSON) as a mermaid erDiagram.
    Schema comes from `--schema <file>` or stdin: `{tables:[{name,columns:[{name,dtype,
    pk,fk?:{table,to}}]}]}`. FK edges to a table NOT in the exported set degrade to no
    edge (never a dangling reference)."""
    import json
    src = opt_value(argv, "--schema")
    try:
        raw = open(src, encoding="utf-8").read() if src else sys.stdin.read()
        schema = json.loads(raw)
    except (OSError, ValueError) as exc:
        return fail("er", f"could not read schema JSON: {exc}")
    tables = schema.get("tables") if isinstance(schema, dict) else schema
    if not isinstance(tables, list):
        return fail("er", "schema has no `tables` array")
    mermaid = _er_mermaid(tables)
    return emit("er", tableCount=len(tables), mermaid=mermaid)


def _er_name(name: str) -> str:
    """A mermaid-ER-safe identifier: alnum/underscore only (entity + attribute names
    can't carry spaces/dots/quotes), WITHOUT _safe's `n_` prefix so names stay readable.
    A name that sanitizes to empty falls back to `_`."""
    out = "".join(c if (c.isalnum() or c == "_") else "_" for c in name)
    return out or "_"


def _er_mermaid(tables: List[dict]) -> str:
    names = {str(t.get("name", "")) for t in tables if isinstance(t, dict)}
    lines = ["erDiagram"]
    edges: List[str] = []
    for t in tables:
        if not isinstance(t, dict):
            continue
        ent = _er_name(str(t.get("name", "")))
        lines.append(f"  {ent} {{")
        for col in t.get("columns", []):
            if not isinstance(col, dict):
                continue
            dtype = _er_name(str(col.get("dtype") or "text"))
            cname = _er_name(str(col.get("name", "")))
            marks = " PK" if col.get("pk") else ""
            fk = col.get("fk")
            if isinstance(fk, dict):
                marks += " FK"
                target = str(fk.get("table", ""))
                # only draw an edge when the referenced table is in the exported set.
                if target in names:
                    edges.append(f'  {_er_name(target)} ||--o{{ {ent} : "{col.get("name", "")}"')
            lines.append(f"    {dtype} {cname}{marks}")
        lines.append("  }")
    lines.extend(edges)
    return "\n".join(lines)


def _version(_argv: Sequence[str]) -> int:
    return emit("version", version=VERSION)


HANDLERS = {"uml": _uml, "deps": _deps, "er": _er, "version": _version}


if __name__ == "__main__":
    import sys

    raise SystemExit(dispatch(PROG, HANDLERS, sys.argv[1:]))
