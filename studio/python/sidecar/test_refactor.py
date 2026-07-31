#!/usr/bin/env python3
"""Tests for refactor.py — AST verbs + the rope-backed WorkspaceEdit engine (APP-025).

Style matches the sibling suites (test_testmgr.py / test_envmgr.py): stdlib unittest,
in-process handler calls with redirect_stdout envelope capture, module-attribute seam
swaps for the optional dependency, tmpdir fixture project.

Load-bearing invariants pinned here:
  * the sidecar NEVER writes a project file (content + mtime unchanged after every verb);
  * no `.ropeproject` folder ever appears in the fixture (ropefolder=None);
  * with rope absent every mutating verb fails closed `code="rope-missing"` while the
    read-only AST verbs keep working;
  * every WorkspaceEdit is LSP-shaped: `changes` map of `file:///abs` → edits with
    0-based `range.start/end.{line,character}` + `newText`;
  * rename parity: the sidecar edit applies to the SAME result as the LSP-path
    whole-token edit through the same splice algorithm as text-edit-apply.ts;
  * CRLF fixture: offsets stay in sync (rope normalizes to \\n).

Run:  python3 -m unittest test_refactor -v
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import refactor  # noqa: E402

try:
    import rope  # noqa: F401

    HAVE_ROPE = True
except ImportError:
    HAVE_ROPE = False

MOD_SRC = (
    "def calc(a, b, c):\n"
    "    x = a + b\n"
    "    y = x * c\n"
    "    return y\n"
    "\n"
    "def caller():\n"
    "    return calc(1, 2, 3)\n"
    "\n"
    "def unused_helper():\n"
    "    return 42\n"
)
UTIL_SRC = "VALUE = 7\n"


def run_verb(handler, argv):
    """Invoke a handler in-process; return (envelope, exit_code). Exactly one stdout object."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = handler(argv)
    lines = [ln for ln in buf.getvalue().splitlines() if ln.strip()]
    assert len(lines) == 1, f"expected ONE stdout line, got {len(lines)}: {buf.getvalue()!r}"
    return json.loads(lines[0]), code


def apply_text_edits(text: str, edits):
    """Faithful reimplementation of text-edit-apply.ts computeLineStarts/offsetAt/
    applyTextEdits (\\n-only lines, clamp to text length, splice last-first, ties by
    later end first). Proves the sidecar's WorkspaceEdit produces the intended file
    through the SAME algorithm the Studio applier runs.
    """
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)

    def offset_at(line: int, char: int) -> int:
        if line < 0:
            return 0
        if line >= len(starts):
            return len(text)
        return min(starts[line] + max(0, char), len(text))

    spans = []
    for e in edits:
        a = offset_at(e["range"]["start"]["line"], e["range"]["start"]["character"])
        b = offset_at(e["range"]["end"]["line"], e["range"]["end"]["character"])
        spans.append((min(a, b), max(a, b), e["newText"]))
    spans.sort(key=lambda s: (s[0], s[1]), reverse=True)
    out = text
    for lo, hi, new in spans:
        out = out[:lo] + new + out[hi:]
    return out


class FixtureCase(unittest.TestCase):
    """tmpdir mini-project + the never-writes pin applied around EVERY command."""

    def setUp(self):
        # realpath: rope reports symlink-resolved real_path (macOS /var → /private/var)
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="refactor-fixture-"))
        self.mod = os.path.join(self.root, "mod.py")
        self.util = os.path.join(self.root, "util.py")
        with open(self.mod, "w", encoding="utf-8", newline="") as fh:
            fh.write(MOD_SRC)
        with open(self.util, "w", encoding="utf-8", newline="") as fh:
            fh.write(UTIL_SRC)
        self._snapshot = self._disk_state()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _disk_state(self):
        state = {}
        for base, dirs, files in os.walk(self.root):
            for name in files:
                p = os.path.join(base, name)
                with open(p, "rb") as fh:
                    state[p] = (os.stat(p).st_mtime_ns, fh.read())
        return state

    def assert_disk_untouched(self):
        self.assertEqual(self._snapshot, self._disk_state(), "sidecar wrote a project file")
        self.assertFalse(
            os.path.exists(os.path.join(self.root, ".ropeproject")),
            ".ropeproject appeared — Project must use ropefolder=None",
        )

    def run_checked(self, handler, argv):
        env, code = run_verb(handler, argv)
        self.assert_disk_untouched()
        return env, code

    def assert_workspace_edit(self, env, command):
        """Acceptance shape: ok:true, edit.changes non-empty, 0-based LSP positions, file:// uris."""
        self.assertTrue(env["ok"], msg=f"{command} failed: {env.get('error')}")
        self.assertEqual(env["command"], command)
        changes = env["edit"]["changes"]
        self.assertTrue(changes, "edit.changes is empty")
        for uri, edits in changes.items():
            self.assertTrue(uri.startswith("file:///"), uri)
            self.assertTrue(edits)
            for e in edits:
                self.assertIsInstance(e["newText"], str)
                for pos in (e["range"]["start"], e["range"]["end"]):
                    self.assertGreaterEqual(pos["line"], 0)
                    self.assertGreaterEqual(pos["character"], 0)
        self.assertEqual(env["files"], sorted(changes))
        return changes

    def applied(self, changes, path, original):
        return apply_text_edits(original, changes["file://" + path])


@unittest.skipUnless(HAVE_ROPE, "rope not installed")
class TestWorkspaceEditCommands(FixtureCase):
    def test_extract_method(self):
        env, code = self.run_checked(
            refactor._extract,
            ["--file", self.mod, "--start-line", "2", "--end-line", "3", "--name", "extracted"],
        )
        self.assertEqual(code, 0)
        changes = self.assert_workspace_edit(env, "extract")
        result = self.applied(changes, self.mod, MOD_SRC)
        self.assertIn("def extracted(a, b, c):", result)
        self.assertIn("y = extracted(a, b, c)", result)
        self.assertEqual(env["kind"], "method")

    def test_extract_variable(self):
        # extract the expression `a + b` (line 2, 1-based inclusive cols 9..13)
        env, _ = self.run_checked(
            refactor._extract,
            ["--file", self.mod, "--start-line", "2", "--end-line", "2", "--name", "total",
             "--kind", "variable", "--start-col", "9", "--end-col", "13"],
        )
        changes = self.assert_workspace_edit(env, "extract")
        self.assertEqual(env["kind"], "variable")
        result = self.applied(changes, self.mod, MOD_SRC)
        self.assertIn("total = a + b", result)
        self.assertIn("x = total", result)

    def test_inline(self):
        env, _ = self.run_checked(refactor._inline, ["--file", self.mod, "--line", "2", "--col", "5"])
        changes = self.assert_workspace_edit(env, "inline")
        result = self.applied(changes, self.mod, MOD_SRC)
        self.assertNotIn("x = a + b", result)
        self.assertIn("a + b", result)

    def test_move_lists_every_touched_uri(self):
        env, _ = self.run_checked(
            refactor._move, ["--file", self.mod, "--symbol", "unused_helper", "--dest", "util.py"]
        )
        changes = self.assert_workspace_edit(env, "move")
        self.assertEqual(sorted(changes), ["file://" + self.mod, "file://" + self.util])
        self.assertNotIn("unused_helper", self.applied(changes, self.mod, MOD_SRC))
        self.assertIn("def unused_helper():", self.applied(changes, self.util, UTIL_SRC))

    def test_move_missing_dest_fails_without_creating(self):
        env, code = self.run_checked(
            refactor._move, ["--file", self.mod, "--symbol", "unused_helper", "--dest", "newmod.py"]
        )
        self.assertFalse(env["ok"])
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(os.path.join(self.root, "newmod.py")))

    def test_change_signature_reorder(self):
        env, _ = self.run_checked(
            refactor._change_signature,
            ["--file", self.mod, "--line", "1", "--col", "5", "--order", "2,1,0"],
        )
        changes = self.assert_workspace_edit(env, "change-signature")
        result = self.applied(changes, self.mod, MOD_SRC)
        self.assertIn("def calc(c, b, a):", result)
        self.assertIn("calc(3, 2, 1)", result)
        self.assertEqual(env["order"], [2, 1, 0])

    def test_change_signature_remove(self):
        # drop param c (index 2), keep a,b order — call site loses its 3rd arg
        env, _ = self.run_checked(
            refactor._change_signature,
            ["--file", self.mod, "--line", "1", "--col", "5", "--order", "0,1", "--remove", "2"],
        )
        changes = self.assert_workspace_edit(env, "change-signature")
        result = self.applied(changes, self.mod, MOD_SRC)
        self.assertIn("def calc(a, b):", result)
        self.assertIn("calc(1, 2)", result)
        self.assertEqual(env["removed"], 2)

    def test_change_signature_remove_and_reorder_original_indices(self):
        # remove a (original index 0), then --order speaks ORIGINAL indices: c,b = 2,1
        env, _ = self.run_checked(
            refactor._change_signature,
            ["--file", self.mod, "--line", "1", "--col", "5", "--order", "2,1", "--remove", "0"],
        )
        changes = self.assert_workspace_edit(env, "change-signature")
        result = self.applied(changes, self.mod, MOD_SRC)
        self.assertIn("def calc(c, b):", result)
        self.assertIn("calc(3, 2)", result)

    def test_change_signature_remove_only_param_empty_order(self):
        path = os.path.join(self.root, "one.py")
        one_src = "def solo(a):\n    return 1\n\nx = solo(9)\n"
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(one_src)
        self._snapshot = self._disk_state()
        env, _ = self.run_checked(
            refactor._change_signature,
            ["--file", path, "--line", "1", "--col", "5", "--order", "", "--remove", "0"],
        )
        changes = self.assert_workspace_edit(env, "change-signature")
        result = self.applied(changes, path, one_src)
        self.assertIn("def solo():", result)
        self.assertIn("solo()", result)

    def test_change_signature_bad_order_rejected(self):
        env, code = self.run_checked(
            refactor._change_signature,
            ["--file", self.mod, "--line", "1", "--col", "5", "--order", "0,1"],
        )
        self.assertFalse(env["ok"])
        self.assertEqual(code, 2)
        self.assertIn("permutation", env["error"])

    def test_safe_delete_used_symbol_blocks_with_usages(self):
        env, code = self.run_checked(
            refactor._safe_delete, ["--file", self.mod, "--line", "1", "--col", "5"]
        )
        self.assertFalse(env["ok"])
        self.assertEqual(code, 2)
        self.assertEqual(env["code"], "usages-remain")
        self.assertEqual(env["symbol"], "calc")
        self.assertNotIn("edit", env)
        self.assertEqual(env["usages"], [{"uri": "file://" + self.mod, "line": 7}])  # 1-based

    def test_safe_delete_unused_symbol_emits_deletion(self):
        env, _ = self.run_checked(
            refactor._safe_delete, ["--file", self.mod, "--line", "9", "--col", "5"]
        )
        changes = self.assert_workspace_edit(env, "safe-delete")
        self.assertEqual(env["symbol"], "unused_helper")
        result = self.applied(changes, self.mod, MOD_SRC)
        self.assertNotIn("unused_helper", result)
        self.assertIn("def caller():", result)

    def test_rename(self):
        env, _ = self.run_checked(
            refactor._rename, ["--file", self.mod, "--line", "1", "--col", "5", "--new-name", "compute"]
        )
        changes = self.assert_workspace_edit(env, "rename")
        result = self.applied(changes, self.mod, MOD_SRC)
        self.assertIn("def compute(a, b, c):", result)
        self.assertIn("return compute(1, 2, 3)", result)
        self.assertNotIn("calc", result)

    def test_rename_parity_with_lsp_applier_path(self):
        """The LSP rename path emits whole-token edits; the sidecar may emit char-trimmed
        ones. PARITY = both produce byte-identical files through the applier splice."""
        env, _ = self.run_checked(
            refactor._rename, ["--file", self.mod, "--line", "1", "--col", "5", "--new-name", "compute"]
        )
        lsp_edit = {  # what pyright/pylsp returns for the same rename (0-based, whole token)
            "changes": {
                "file://" + self.mod: [
                    {"range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 8}}, "newText": "compute"},
                    {"range": {"start": {"line": 6, "character": 11}, "end": {"line": 6, "character": 15}}, "newText": "compute"},
                ]
            }
        }
        ours = apply_text_edits(MOD_SRC, env["edit"]["changes"]["file://" + self.mod])
        lsp = apply_text_edits(MOD_SRC, lsp_edit["changes"]["file://" + self.mod])
        self.assertEqual(ours, lsp)

    def test_explicit_root_multifile_rename(self):
        with open(self.util, "w", encoding="utf-8", newline="") as fh:
            fh.write("from mod import calc\n\nprint(calc(1, 2, 3))\n")
        self._snapshot = self._disk_state()
        env, _ = self.run_checked(
            refactor._rename,
            ["--file", self.mod, "--line", "1", "--col", "5", "--new-name", "compute",
             "--root", self.root],
        )
        changes = self.assert_workspace_edit(env, "rename")
        self.assertIn("file://" + self.util, changes)
        util_src = "from mod import calc\n\nprint(calc(1, 2, 3))\n"
        self.assertEqual(
            self.applied(changes, self.util, util_src),
            "from mod import compute\n\nprint(compute(1, 2, 3))\n",
        )

    def test_safe_delete_only_method_inserts_pass(self):
        path = os.path.join(self.root, "solo.py")
        solo_src = "class Only:\n    def solo(self):\n        return 3\n\nprint(Only)\n"
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(solo_src)
        self._snapshot = self._disk_state()
        env, _ = self.run_checked(refactor._safe_delete, ["--file", path, "--line", "2", "--col", "9"])
        changes = self.assert_workspace_edit(env, "safe-delete")
        result = self.applied(changes, path, solo_src)
        ast_mod = __import__("ast")
        ast_mod.parse(result)  # deletion must never emit a syntax-breaking edit
        self.assertIn("pass", result)
        self.assertNotIn("def solo", result)

    def test_safe_delete_parenthesized_decorator_span(self):
        path = os.path.join(self.root, "deco.py")
        deco_src = "@(\n    staticmethod\n)\ndef lonely():\n    return 1\n\nx = 2\n"
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(deco_src)
        self._snapshot = self._disk_state()
        env, _ = self.run_checked(refactor._safe_delete, ["--file", path, "--line", "4", "--col", "5"])
        changes = self.assert_workspace_edit(env, "safe-delete")
        result = self.applied(changes, path, deco_src)
        self.assertNotIn("@(", result)  # the PEP 614 `@(` line goes with the def
        __import__("ast").parse(result)

    def test_rename_col_counts_utf16_units(self):
        path = os.path.join(self.root, "emoji.py")
        # astral char in a string before the target: '😀' = 2 UTF-16 units, 1 code point
        emoji_src = 's = "\U0001f600"; alpha = 1\nprint(alpha)\n'
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(emoji_src)
        self._snapshot = self._disk_state()
        # editor col of 'alpha' start: 1-based UTF-16 → 10 ('s = "😀"; ' = 9 units)
        env, _ = self.run_checked(
            refactor._rename, ["--file", path, "--line", "1", "--col", "10", "--new-name", "beta"]
        )
        changes = self.assert_workspace_edit(env, "rename")
        result = self.applied(changes, path, emoji_src)
        self.assertIn("beta = 1", result)
        self.assertIn("print(beta)", result)

    def test_symlinked_root_uris_keep_raw_root(self):
        link = os.path.join(os.path.dirname(self.root), os.path.basename(self.root) + "-link")
        os.symlink(self.root, link)
        try:
            link_mod = os.path.join(link, "mod.py")
            env, _ = self.run_checked(
                refactor._rename,
                ["--file", link_mod, "--line", "1", "--col", "5", "--new-name", "compute",
                 "--root", link],
            )
            changes = self.assert_workspace_edit(env, "rename")
            # emitted URIs must keep the caller's RAW (symlink) root, matching Studio tab URIs
            self.assertIn("file://" + link_mod, changes)
        finally:
            os.unlink(link)

    def test_rename_to_keyword_rejected(self):
        for bad in ("class", "def", "match"):  # hard + soft keywords pass isidentifier()
            env, code = self.run_checked(
                refactor._rename,
                ["--file", self.mod, "--line", "1", "--col", "5", "--new-name", bad],
            )
            self.assertFalse(env["ok"], bad)
            self.assertEqual(code, 2, bad)
            self.assertIn("keyword", env["error"])

    def test_file_outside_root_rejected(self):
        env, code = self.run_checked(
            refactor._rename,
            ["--file", self.mod, "--line", "1", "--col", "5", "--new-name", "z",
             "--root", os.path.join(self.root, "sub-does-not-contain-file")],
        )
        self.assertFalse(env["ok"])
        self.assertEqual(code, 2)


@unittest.skipUnless(HAVE_ROPE, "rope not installed")
class TestCrlfOffsets(unittest.TestCase):
    """CRLF fixture: rope reads \\n-normalized text; 1-based argv line/col must land on
    the right symbol and the emitted positions must be correct for the NORMALIZED text."""

    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="refactor-crlf-"))
        self.mod = os.path.join(self.root, "m.py")
        self.raw = b"def f(a, b):\r\n    return a + b\r\n\r\ndef g():\r\n    return f(1, 2)\r\n"
        with open(self.mod, "wb") as fh:
            fh.write(self.raw)
        self.mtime = os.stat(self.mod).st_mtime_ns

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_rename_on_crlf_file(self):
        env, code = run_verb(
            refactor._rename, ["--file", self.mod, "--line", "1", "--col", "5", "--new-name", "add"]
        )
        self.assertTrue(env["ok"], msg=env.get("error"))
        self.assertEqual(code, 0)
        normalized = "def f(a, b):\n    return a + b\n\ndef g():\n    return f(1, 2)\n"
        result = apply_text_edits(normalized, env["edit"]["changes"]["file://" + self.mod])
        self.assertEqual(result, "def add(a, b):\n    return a + b\n\ndef g():\n    return add(1, 2)\n")
        # the no-write pin: exact bytes (incl. CRLF) + mtime untouched, no .ropeproject
        with open(self.mod, "rb") as fh:
            self.assertEqual(fh.read(), self.raw)
        self.assertEqual(os.stat(self.mod).st_mtime_ns, self.mtime)
        self.assertFalse(os.path.exists(os.path.join(self.root, ".ropeproject")))


class TestRopeMissing(FixtureCase):
    """rope absent → mutating verbs fail closed code='rope-missing'; AST verbs still ok."""

    def setUp(self):
        super().setUp()
        self._orig_load = refactor._load_rope
        refactor._load_rope = lambda: None

    def tearDown(self):
        refactor._load_rope = self._orig_load
        super().tearDown()

    def test_every_mutating_verb_fails_closed(self):
        cases = [
            (refactor._extract, ["--file", self.mod, "--start-line", "2", "--end-line", "3", "--name", "x"]),
            (refactor._inline, ["--file", self.mod, "--line", "2", "--col", "5"]),
            (refactor._move, ["--file", self.mod, "--symbol", "unused_helper", "--dest", "util.py"]),
            (refactor._change_signature, ["--file", self.mod, "--line", "1", "--col", "5", "--order", "0,1,2"]),
            (refactor._safe_delete, ["--file", self.mod, "--line", "9", "--col", "5"]),
            (refactor._rename, ["--file", self.mod, "--line", "1", "--col", "5", "--new-name", "z"]),
        ]
        for handler, argv in cases:
            env, code = self.run_checked(handler, argv)
            self.assertFalse(env["ok"], handler.__name__)
            self.assertEqual(env["code"], "rope-missing", handler.__name__)
            self.assertEqual(code, 2, handler.__name__)
            self.assertIn("pip install rope", env["error"])
            self.assertNotIn("edit", env)

    def test_real_import_error_branch(self):
        """Exercise _load_rope's ACTUAL ImportError path: poison every rope* entry in
        sys.modules with None (import of a None entry raises ImportError)."""
        refactor._load_rope = self._orig_load  # undo the seam swap; patch imports instead
        saved = {k: sys.modules[k] for k in list(sys.modules) if k == "rope" or k.startswith("rope.")}
        try:
            for k in saved:
                sys.modules[k] = None
            self.assertIsNone(refactor._load_rope())
            env, code = self.run_checked(
                refactor._rename, ["--file", self.mod, "--line", "1", "--col", "5", "--new-name", "z"]
            )
            self.assertFalse(env["ok"])
            self.assertEqual(env["code"], "rope-missing")
            self.assertEqual(code, 2)
        finally:
            sys.modules.update(saved)

    def test_read_only_verbs_still_work(self):
        env, code = self.run_checked(refactor._structure, ["--file", self.mod])
        self.assertTrue(env["ok"])
        self.assertEqual(code, 0)
        self.assertEqual([s["name"] for s in env["structure"]], ["calc", "caller", "unused_helper"])
        env, _ = self.run_checked(refactor._imports, ["--file", self.mod])
        self.assertTrue(env["ok"])
        env, _ = self.run_checked(refactor._callgraph, ["--file", self.mod])
        self.assertTrue(env["ok"])
        self.assertIn({"from": "caller", "to": "calc"}, env["edges"])


class TestHelpers(unittest.TestCase):
    def test_to_offset_round_trip(self):
        text = "abc\ndef\n"
        self.assertEqual(refactor._to_offset(text, 1, 1), 0)
        self.assertEqual(refactor._to_offset(text, 2, 1), 4)
        self.assertEqual(refactor._to_offset(text, 2, 4), 7)  # one past last char (EOL)
        for bad in ((0, 1), (3, 1), (1, 5)):
            with self.assertRaises(ValueError):
                refactor._to_offset(text, *bad)

    def test_pos_utf16_astral(self):
        text = "x = '\U0001f600' + y\n"  # astral emoji = 2 UTF-16 units
        starts = refactor._line_starts(text)
        after_emoji = text.index("' + y")
        self.assertEqual(refactor._pos(starts, text, after_emoji)["character"], 7)

    def test_to_offset_utf16_input(self):
        text = "x = '\U0001f600' + y\n"
        # 'y' is code-point index 10, but UTF-16 col 12 (emoji counts twice)
        self.assertEqual(refactor._to_offset(text, 1, 12), text.index("y"))
        with self.assertRaises(ValueError):  # col landing inside the surrogate pair
            refactor._to_offset(text, 1, 7)

    def test_edits_between_minimal_token_edit(self):
        edits = refactor._edits_between("def calc(a):\n", "def compute(a):\n")
        self.assertEqual(len(edits), 1)
        self.assertEqual(edits[0]["range"]["start"], {"line": 0, "character": 5})
        self.assertEqual(edits[0]["range"]["end"], {"line": 0, "character": 8})
        self.assertEqual(edits[0]["newText"], "ompute")

    def test_edits_between_insertion_and_deletion(self):
        old = "a\nb\nc\n"
        self.assertEqual(apply_text_edits(old, refactor._edits_between(old, "a\nX\nb\nc\n")), "a\nX\nb\nc\n")
        self.assertEqual(apply_text_edits(old, refactor._edits_between(old, "a\nc\n")), "a\nc\n")
        self.assertEqual(refactor._edits_between(old, old), [])

    def test_split_lines_is_newline_only(self):
        # \x0c (form feed) must NOT split — str.splitlines would, desyncing offsets
        text = "a\x0cb\nc\n"
        self.assertEqual(refactor._split_lines(text), ["a\x0cb\n", "c\n"])
        self.assertEqual(refactor._split_lines(""), [])
        self.assertEqual(refactor._split_lines("x"), ["x"])
        edits = refactor._edits_between(text, "a\x0cb\nX\nc\n")
        self.assertEqual(apply_text_edits(text, edits), "a\x0cb\nX\nc\n")

    def test_handlers_table(self):
        for verb in ("structure", "imports", "callgraph", "version", "extract", "inline",
                     "move", "change-signature", "safe-delete", "rename",
                     "gen-init", "gen-repr", "gen-eq", "gen-dataclass", "gen-property",
                     "gen-override", "gen-delegate", "gen-docstring"):
            self.assertIn(verb, refactor.HANDLERS)


GEN_SRC = (
    '"""Module doc."""\n'
    "import os\n"
    "\n"
    "\n"
    "class Point:\n"
    "    kind: ClassVar[str] = 'point'\n"
    "    x: int\n"
    "    y: int = 2\n"
    "    tag = 'p'\n"
    "\n"
    "    def area(self):\n"
    "        return self.x * self.y\n"
)

GEN_HIER = (
    "class Base:\n"
    "    def run(self, task: str, /, count: int = 1, *extra, retries: int = 3, **kw) -> bool:\n"
    "        return True\n"
    "\n"
    "\n"
    "class Engine:\n"
    "    async def start(self, mode: str) -> None:\n"
    "        pass\n"
    "\n"
    "\n"
    "class Worker(Base):\n"
    "    def __init__(self, engine):\n"
    "        self._speed = 1\n"
    "        self.engine = Engine()\n"
)


class TestGenerators(FixtureCase):
    """APP-028 gen-* verbs — pure stdlib ast, no rope required.

    Every test: run the verb (disk-untouched pin), apply the WorkspaceEdit through
    the SAME splice algorithm as text-edit-apply.ts, `compile()` the result, and
    re-parse to assert the member landed INSIDE the target class (compile alone
    misses still-parseable indentation mistakes, e.g. a module-level def)."""

    def setUp(self):
        super().setUp()
        self.gen = os.path.join(self.root, "gen.py")
        with open(self.gen, "w", encoding="utf-8", newline="") as fh:
            fh.write(GEN_SRC)
        self.hier = os.path.join(self.root, "hier.py")
        with open(self.hier, "w", encoding="utf-8", newline="") as fh:
            fh.write(GEN_HIER)
        self._snapshot = self._disk_state()

    def write_fixture(self, name, src):
        """Add a per-test fixture file and re-arm the never-writes snapshot."""
        path = os.path.join(self.root, name)
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(src)
        self._snapshot = self._disk_state()
        return path

    def gen_applied(self, verb, argv, src=None, path=None):
        env, code = self.run_checked(refactor.HANDLERS[verb], argv)
        self.assertEqual(code, 0, env.get("error"))
        changes = self.assert_workspace_edit(env, verb)
        result = self.applied(changes, path or self.gen, src if src is not None else GEN_SRC)
        compile(result, "<post-edit>", "exec")
        return env, result

    def member_of(self, result, cls_name, member):
        """Re-parse and return the member def INSIDE cls_name (None if absent/module-level)."""
        import ast as _ast

        tree = _ast.parse(result)
        for node in _ast.walk(tree):
            if isinstance(node, _ast.ClassDef) and node.name == cls_name:
                for stmt in node.body:
                    if isinstance(stmt, (_ast.FunctionDef, _ast.AsyncFunctionDef)) and stmt.name == member:
                        return stmt
        return None

    def test_gen_init_fields_and_defaults_ordering(self):
        env, result = self.gen_applied("gen-init", ["--file", self.gen, "--line", "7"])
        self.assertEqual(env["member"], "__init__")
        self.assertEqual(env["target"], "Point")
        # ClassVar skipped; non-default x first; annotated default spaced; bare default tight
        self.assertIn("def __init__(self, x: int, y: int = 2, tag='p'):", result)
        self.assertIn("        self.x = x", result)
        self.assertNotIn("self.kind", result)
        self.assertIsNotNone(self.member_of(result, "Point", "__init__"))

    def test_gen_init_attrs_override_and_member_exists(self):
        env, result = self.gen_applied(
            "gen-init", ["--file", self.gen, "--line", "7", "--attrs", "x,tag"]
        )
        self.assertIn("def __init__(self, x: int, tag='p'):", result)
        env2, _ = run_verb(refactor.HANDLERS["gen-init"], ["--file", self.hier, "--line", "12"])
        self.assertFalse(env2["ok"])
        self.assertEqual(env2["code"], "member-exists")

    def test_gen_repr_from_class_fields(self):
        _, result = self.gen_applied("gen-repr", ["--file", self.gen, "--line", "7"])
        self.assertIn('return f"Point(x={self.x!r}, y={self.y!r}, tag={self.tag!r})"', result)
        self.assertIsNotNone(self.member_of(result, "Point", "__repr__"))

    def test_gen_repr_prefers_init_self_assignments(self):
        _, result = self.gen_applied(
            "gen-repr", ["--file", self.hier, "--line", "12"], src=GEN_HIER, path=self.hier
        )
        self.assertIn('return f"Worker(_speed={self._speed!r}, engine={self.engine!r})"', result)
        self.assertIsNotNone(self.member_of(result, "Worker", "__repr__"))

    def test_gen_repr_no_fields_fails_with_code(self):
        dyn = self.write_fixture("dyn.py", "class Dyn:\n    def go(self):\n        return 1\n")
        env, code = run_verb(refactor.HANDLERS["gen-repr"], ["--file", dyn, "--line", "1"])
        self.assertFalse(env["ok"])
        self.assertEqual(env["code"], "no-fields")
        self.assertEqual(code, 2)

    def test_gen_eq_single_field_tuple_stays_a_tuple(self):
        _, result = self.gen_applied(
            "gen-eq", ["--file", self.gen, "--line", "7", "--attrs", "x"]
        )
        self.assertIn("return (self.x,) == (other.x,)", result)
        self.assertIn("if not isinstance(other, Point):", result)
        self.assertIsNotNone(self.member_of(result, "Point", "__eq__"))

    def test_gen_dataclass_converts_assignment_only_init(self):
        src = (
            "import os\n\n\n"
            "class Config:\n"
            '    """Doc."""\n\n'
            "    def __init__(self, host: str, port: int = 8080):\n"
            "        self.host = host\n"
            "        self.port = port\n"
            "        self.debug = False\n\n"
            "    def url(self):\n"
            "        return self.host\n"
        )
        conv = self.write_fixture("conv.py", src)
        env, code = self.run_checked(refactor.HANDLERS["gen-dataclass"], ["--file", conv, "--line", "4"])
        self.assertEqual(code, 0, env.get("error"))
        changes = self.assert_workspace_edit(env, "gen-dataclass")
        result = self.applied(changes, conv, src)
        compile(result, "<post-edit>", "exec")
        self.assertIn("from dataclasses import dataclass\n", result)
        self.assertIn("@dataclass\nclass Config:", result)
        self.assertIn("    host: str\n", result)
        self.assertIn("    port: int = 8080\n", result)
        self.assertIn("    debug: bool = False\n", result)
        self.assertNotIn("__init__", result)  # the old ctor is DELETED, not rewritten
        self.assertIn("def url(self):", result)
        self.assertEqual(env["fields"], ["host", "port", "debug"])

    def test_gen_dataclass_refuses_custom_init_logic(self):
        bad = self.write_fixture(
            "bad.py",
            "class C:\n    def __init__(self, x):\n        self.x = x * 2\n",
        )
        env, _ = run_verb(refactor.HANDLERS["gen-dataclass"], ["--file", bad, "--line", "1"])
        self.assertFalse(env["ok"])
        self.assertEqual(env["code"], "unsupported")

    def test_gen_dataclass_already_dataclass_refused(self):
        dc = self.write_fixture(
            "dc.py", "from dataclasses import dataclass\n\n\n@dataclass\nclass D:\n    x: int\n"
        )
        env, _ = run_verb(refactor.HANDLERS["gen-dataclass"], ["--file", dc, "--line", "5"])
        self.assertFalse(env["ok"])
        self.assertEqual(env["code"], "member-exists")

    def test_gen_property_backing_field(self):
        _, result = self.gen_applied(
            "gen-property", ["--file", self.hier, "--line", "12", "--attr", "speed"],
            src=GEN_HIER, path=self.hier,
        )
        self.assertIn("    @property\n    def speed(self):\n        return self._speed", result)
        self.assertIn("    @speed.setter\n    def speed(self, value) -> None:\n        self._speed = value", result)
        self.assertIsNotNone(self.member_of(result, "Worker", "speed"))

    def test_gen_property_annotated_backing(self):
        src = "class A:\n    _size: int = 0\n"
        ann = self.write_fixture("ann.py", src)
        env, code = self.run_checked(refactor.HANDLERS["gen-property"], ["--file", ann, "--line", "1", "--attr", "_size"])
        changes = self.assert_workspace_edit(env, "gen-property")
        result = self.applied(changes, ann, src)
        compile(result, "<post-edit>", "exec")
        self.assertIn("def size(self) -> int:", result)
        self.assertIn("def size(self, value: int) -> None:", result)

    def test_gen_override_full_signature_and_forwarding(self):
        _, result = self.gen_applied(
            "gen-override", ["--file", self.hier, "--line", "12", "--method", "run"],
            src=GEN_HIER, path=self.hier,
        )
        # posonly `/`, defaults, *extra, kwonly retries, **kw all preserved + forwarded
        self.assertIn(
            "def run(self, task: str, /, count: int = 1, *extra, retries: int = 3, **kw) -> bool:",
            result,
        )
        self.assertIn("return super().run(task, count, *extra, retries=retries, **kw)", result)
        self.assertIsNotNone(self.member_of(result, "Worker", "run"))

    def test_gen_override_unknown_base_method(self):
        env, _ = run_verb(
            refactor.HANDLERS["gen-override"], ["--file", self.hier, "--line", "12", "--method", "nope"]
        )
        self.assertFalse(env["ok"])
        self.assertEqual(env["code"], "not-found")

    def test_gen_delegate_resolved_signature_async(self):
        _, result = self.gen_applied(
            "gen-delegate",
            ["--file", self.hier, "--line", "12", "--attr", "engine", "--method", "start"],
            src=GEN_HIER, path=self.hier,
        )
        # Engine.start is async — the delegate must await it
        self.assertIn("async def start(self, mode: str) -> None:", result)
        self.assertIn("return await self.engine.start(mode)", result)
        self.assertIsNotNone(self.member_of(result, "Worker", "start"))

    def test_gen_delegate_unresolvable_falls_back_to_star_args(self):
        _, result = self.gen_applied(
            "gen-delegate",
            ["--file", self.hier, "--line", "12", "--attr", "engine", "--method", "mystery"],
            src=GEN_HIER, path=self.hier,
        )
        self.assertIn("def mystery(self, *args, **kwargs):", result)
        self.assertIn("return self.engine.mystery(*args, **kwargs)", result)

    def test_gen_docstring_signature_derived(self):
        src = (
            "def fetch(url: str, timeout: float = 5.0, *paths, retries: int = 3, **extra) -> bytes:\n"
            "    return b''\n"
        )
        doc = self.write_fixture("doc.py", src)
        env, code = self.run_checked(refactor.HANDLERS["gen-docstring"], ["--file", doc, "--line", "1"])
        changes = self.assert_workspace_edit(env, "gen-docstring")
        result = self.applied(changes, doc, src)
        compile(result, "<post-edit>", "exec")
        # exactly the signature's params, tail-aligned defaults, return annotation
        self.assertIn("    Args:\n", result)
        self.assertIn("        url (str): TODO.\n", result)
        self.assertIn("        timeout (float): TODO. Defaults to 5.0.\n", result)
        self.assertIn("        *paths: TODO.\n", result)
        self.assertIn("        retries (int): TODO. Defaults to 3.\n", result)
        self.assertIn("        **extra: TODO.\n", result)
        self.assertIn("    Returns:\n        bytes: TODO.\n", result)

    def test_gen_docstring_async_nested_tabs_and_idempotency(self):
        src = (
            "class Outer:\n"
            "\tclass Inner:\n"
            "\t\tasync def go(self, n: int = 1) -> str:\n"
            "\t\t\treturn 'x'\n"
        )
        tabbed = self.write_fixture("tabbed.py", src)
        env, code = self.run_checked(refactor.HANDLERS["gen-docstring"], ["--file", tabbed, "--line", "3"])
        changes = self.assert_workspace_edit(env, "gen-docstring")
        result = self.applied(changes, tabbed, src)
        compile(result, "<post-edit>", "exec")
        self.assertIn('\t\t\t"""TODO: describe go.\n', result)  # the class's OWN tab indent
        stub = self.member_of(result, "Inner", "go")
        self.assertIsNotNone(stub)
        # idempotency: re-run on the stubbed source → ok:true NOOP with an EMPTY edit
        self.write_fixture("tabbed.py", result)
        env2, code2 = run_verb(refactor.HANDLERS["gen-docstring"], ["--file", tabbed, "--line", "3"])
        self.assertTrue(env2["ok"])
        self.assertTrue(env2["noop"])
        self.assertEqual(env2["edit"], {"changes": {}})
        self.assertEqual(env2["files"], [])
        self.assertEqual(code2, 0)

    def test_gen_docstring_no_params_no_return_single_line(self):
        src = "def tick():\n    pass\n"
        plain = self.write_fixture("plain.py", src)
        env, _ = self.run_checked(refactor.HANDLERS["gen-docstring"], ["--file", plain, "--line", "1"])
        result = self.applied(self.assert_workspace_edit(env, "gen-docstring"), plain, src)
        compile(result, "<post-edit>", "exec")
        self.assertIn('    """TODO: describe tick."""\n', result)
        self.assertNotIn("Args:", result)
        self.assertNotIn("Returns:", result)

    def test_gen_member_indent_detected_from_tabs(self):
        src = "class T:\n\tx: int\n"
        tabbed = self.write_fixture("tabcls.py", src)
        env, _ = self.run_checked(refactor.HANDLERS["gen-init"], ["--file", tabbed, "--line", "1"])
        result = self.applied(self.assert_workspace_edit(env, "gen-init"), tabbed, src)
        compile(result, "<post-edit>", "exec")
        self.assertIn("\tdef __init__(self, x: int):\n\t\tself.x = x\n", result)
        self.assertIsNotNone(self.member_of(result, "T", "__init__"))

    def test_gen_one_line_class_refused(self):
        one = self.write_fixture("one.py", "class O: x = 1\n")
        env, code = run_verb(refactor.HANDLERS["gen-repr"], ["--file", one, "--line", "1"])
        self.assertFalse(env["ok"])
        self.assertEqual(code, 2)

    def test_gen_no_class_at_line_fails(self):
        env, _ = run_verb(refactor.HANDLERS["gen-init"], ["--file", self.gen, "--line", "2"])
        self.assertFalse(env["ok"])
        self.assertIn("no class at --line", env["error"])

    def test_gen_verbs_never_write(self):
        # the FixtureCase pin, exercised across every generator on one run each
        for verb, argv in [
            ("gen-init", ["--file", self.gen, "--line", "7"]),
            ("gen-repr", ["--file", self.gen, "--line", "7"]),
            ("gen-eq", ["--file", self.gen, "--line", "7"]),
            ("gen-property", ["--file", self.hier, "--line", "12", "--attr", "speed"]),
            ("gen-override", ["--file", self.hier, "--line", "12", "--method", "run"]),
            ("gen-delegate", ["--file", self.hier, "--line", "12", "--attr", "engine", "--method", "start"]),
            ("gen-docstring", ["--file", self.hier, "--line", "12"]),
        ]:
            self.run_checked(refactor.HANDLERS[verb], argv)


class TestSubprocessContract(unittest.TestCase):
    """One JSON object on stdout through the real CLI (the bridge contract)."""

    def test_version_via_subprocess(self):
        import subprocess

        proc = subprocess.run(
            [sys.executable, str(HERE / "refactor.py"), "version"],
            capture_output=True, text=True, timeout=60,
        )
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1)
        obj = json.loads(lines[0])
        self.assertTrue(obj["ok"])
        self.assertEqual(obj["command"], "version")
        self.assertEqual(proc.returncode, 0)

    def test_unknown_verb_fails_closed(self):
        import subprocess

        proc = subprocess.run(
            [sys.executable, str(HERE / "refactor.py"), "explode"],
            capture_output=True, text=True, timeout=60,
        )
        obj = json.loads(proc.stdout.strip())
        self.assertFalse(obj["ok"])
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
