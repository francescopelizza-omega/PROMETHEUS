/**
 * generate-actions.test.ts — the pure Generate-menu state math (APP-028).
 *
 * Pins the load-bearing invariants: the local-AI fallback produces a
 * WorkspaceEdit-SHAPED proposal (never a write), template edits land at the right
 * line with the right comment style, attrs parsing stays identifier-strict, and
 * the action table stays in lockstep with the palette ids.
 *
 * Run: node --import ../../../../../apps/cli/dev-register.mjs --test generate-actions.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GENERATE_ACTIONS,
  GENERATE_TRANSFORM_BY_ID,
  aiGenMessages,
  aiMemberEdit,
  copyrightEditFor,
  hasCopyrightHeader,
  newFileEdit,
  newFileTarget,
  offersAiFallback,
  parseAttrsList,
  stripCodeFences,
} from "./generate-actions.js";

test("GENERATE_ACTIONS: 8 gen verbs + 2 template actions, unique ids, python-only flags", () => {
  assert.equal(GENERATE_ACTIONS.length, 10);
  const ids = GENERATE_ACTIONS.map((a) => a.commandId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.startsWith("generate.")));
  const gen = GENERATE_ACTIONS.filter((a) => a.transform.startsWith("gen"));
  assert.equal(gen.length, 8);
  assert.ok(gen.every((a) => a.pythonOnly));
  const tpl = GENERATE_ACTIONS.filter((a) => !a.transform.startsWith("gen"));
  assert.deepEqual(
    tpl.map((a) => a.transform),
    ["newFileTemplate", "copyrightHeader"],
  );
  assert.ok(tpl.every((a) => !a.pythonOnly));
  // the dispatch table mirrors the action list exactly
  assert.equal(Object.keys(GENERATE_TRANSFORM_BY_ID).length, 10);
  assert.equal(GENERATE_TRANSFORM_BY_ID["generate.init"], "genInit");
  assert.equal(GENERATE_TRANSFORM_BY_ID["generate.copyright"], "copyrightHeader");
});

test("parseAttrsList: empty → undefined, identifiers → list, junk → null", () => {
  assert.equal(parseAttrsList(""), undefined);
  assert.equal(parseAttrsList("   "), undefined);
  assert.deepEqual(parseAttrsList("x, tag ,_y"), ["x", "tag", "_y"]);
  assert.deepEqual(parseAttrsList("solo"), ["solo"]);
  assert.equal(parseAttrsList("a.b"), null);
  assert.equal(parseAttrsList("--evil"), null);
  assert.equal(parseAttrsList("1bad"), null);
  assert.equal(parseAttrsList("ok, a b"), null);
});

test("offersAiFallback: only the AST-insufficient codes", () => {
  assert.ok(offersAiFallback("no-fields"));
  assert.ok(offersAiFallback("not-found"));
  assert.ok(offersAiFallback("unsupported"));
  assert.ok(!offersAiFallback("member-exists"));
  assert.ok(!offersAiFallback("rope-missing"));
  assert.ok(!offersAiFallback(undefined));
});

test("stripCodeFences: fenced, language-tagged, and bare text", () => {
  assert.equal(stripCodeFences("```python\ndef x():\n    pass\n```"), "def x():\n    pass");
  assert.equal(stripCodeFences("```\ncode\n```"), "code");
  assert.equal(stripCodeFences("  def y(): ...\n"), "def y(): ...");
});

test("aiMemberEdit: a WorkspaceEdit-shaped INSERT below the caret line — never a write", () => {
  const edit = aiMemberEdit(
    "file:///p/m.py",
    12,
    "```python\n    def __repr__(self):\n        return 'X'\n```",
  );
  const edits = edit.changes["file:///p/m.py"];
  assert.ok(Array.isArray(edits));
  assert.equal(edits?.length, 1);
  const e = edits?.[0];
  // 1-based caret line 12 → insert at 0-based line 12 (the NEXT line), char 0
  assert.deepEqual(e?.range.start, { line: 12, character: 0 });
  assert.deepEqual(e?.range.end, { line: 12, character: 0 });
  assert.equal(e?.newText, "    def __repr__(self):\n        return 'X'\n");
  // shape check: exactly the normalizeWorkspaceEdit input — plain data, no methods
  assert.deepEqual(JSON.parse(JSON.stringify(edit)), edit);
});

test("aiGenMessages: system pins raw-code-only; user carries task + context", () => {
  const msgs = aiGenMessages("Generate: __repr__", "python", "class X: ...");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]?.role, "system");
  assert.match(msgs[0]?.content ?? "", /ONLY the raw code/);
  assert.match(msgs[1]?.content ?? "", /Generate: __repr__/);
  assert.match(msgs[1]?.content ?? "", /class X: \.\.\./);
});

test("newFileTarget: workspace-relative only, traversal refused", () => {
  assert.deepEqual(newFileTarget("/proj", "pkg/new.py"), { uri: "file:///proj/pkg/new.py" });
  assert.deepEqual(newFileTarget("/proj/", "a.txt"), { uri: "file:///proj/a.txt" });
  assert.equal(typeof newFileTarget("/proj", ""), "string");
  assert.equal(typeof newFileTarget("/proj", "/abs.py"), "string");
  assert.equal(typeof newFileTarget("/proj", "C:\\x.py"), "string");
  assert.equal(typeof newFileTarget("/proj", "../out.py"), "string");
  assert.equal(typeof newFileTarget("/proj", "a/../../b.py"), "string");
});

test("newFileEdit: full template content inserted at 0:0", () => {
  const edit = newFileEdit("file:///proj/new.py", "python", { filename: "new.py" });
  const e = edit.changes["file:///proj/new.py"]?.[0];
  assert.deepEqual(e?.range.start, { line: 0, character: 0 });
  assert.ok(e?.newText.startsWith('"""new.py — TODO: describe."""'));
});

test("copyrightEditFor: comment style + shebang hop; idempotent via null", () => {
  const vars = { year: 2026, owner: "Xplora" };
  const py = copyrightEditFor(
    "file:///p/m.py",
    "#!/usr/bin/env python3\nimport os\n",
    "python",
    vars,
  );
  const e = py?.changes["file:///p/m.py"]?.[0];
  assert.deepEqual(e?.range.start, { line: 1, character: 0 });
  assert.equal(e?.newText, "# Copyright (c) 2026 Xplora. All rights reserved.\n");
  const ts = copyrightEditFor("file:///p/a.ts", "export {};\n", "typescript", vars);
  assert.match(ts?.changes["file:///p/a.ts"]?.[0]?.newText ?? "", /^\/\*\n \* Copyright/);
  // already-present → null (the host renders "already present" instead of a dupe)
  assert.equal(
    copyrightEditFor("file:///p/m.py", "# Copyright (c) 2020 Old Co.\ncode\n", "python", vars),
    null,
  );
  assert.ok(hasCopyrightHeader("/*\n * Copyright © 2019 X\n */\n"));
  assert.ok(!hasCopyrightHeader("print('no header')\n"));
});
