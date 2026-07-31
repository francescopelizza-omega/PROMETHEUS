/**
 * templates.test.ts — new-file + copyright-header templates (APP-028).
 *
 * Every export is pinned: fileTemplate per kind (substitution + shape),
 * copyrightHeader per comment style, templateKindForLanguage mapping,
 * headerInsertLine (shebang + Python coding cookie), TEMPLATE_KINDS, and the
 * substitution rules (defaults, no re-scan of substituted values, unknown
 * tokens pass through).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TEMPLATE_KINDS,
  copyrightHeader,
  fileTemplate,
  headerInsertLine,
  templateKindForLanguage,
} from "./templates.js";

const VARS = { year: 2026, owner: "Xplora Group", filename: "worker.py" };

test("fileTemplate python: docstring + main guard, vars substituted", () => {
  const t = fileTemplate("python", VARS);
  assert.ok(t.startsWith('"""worker.py — TODO: describe."""\n'));
  assert.match(t, /def main\(\) -> None:\n {4}pass\n/);
  assert.match(t, /if __name__ == "__main__":\n {4}main\(\)\n$/);
  assert.ok(!t.includes("{filename}"));
});

test("fileTemplate typescript: block comment + export {}", () => {
  const t = fileTemplate("typescript", { filename: "util.ts" });
  assert.ok(t.startsWith("/**\n * util.ts — TODO: describe.\n */\n"));
  assert.ok(t.endsWith("export {};\n"));
});

test("fileTemplate plain: filename line only", () => {
  assert.equal(fileTemplate("plain", { filename: "NOTES.txt" }), "NOTES.txt\n");
});

test("fileTemplate defaults: missing filename → untitled; year defaults to current", () => {
  const t = fileTemplate("python");
  assert.ok(t.startsWith('"""untitled — TODO: describe."""'));
  const y = copyrightHeader("plain", {});
  assert.match(y, /^Copyright \(c\) \d{4} \. All rights reserved\.\n$/);
});

test("copyrightHeader is comment-style aware", () => {
  assert.equal(
    copyrightHeader("python", VARS),
    "# Copyright (c) 2026 Xplora Group. All rights reserved.\n",
  );
  assert.equal(
    copyrightHeader("typescript", VARS),
    "/*\n * Copyright (c) 2026 Xplora Group. All rights reserved.\n */\n",
  );
  assert.equal(
    copyrightHeader("plain", VARS),
    "Copyright (c) 2026 Xplora Group. All rights reserved.\n",
  );
});

test("substitution never re-scans substituted values", () => {
  const h = copyrightHeader("plain", { year: 1, owner: "{filename}", filename: "x" });
  // the owner's literal "{filename}" must NOT be replaced in a second pass
  assert.equal(h, "Copyright (c) 1 {filename}. All rights reserved.\n");
});

test("unknown {tokens} pass through verbatim", () => {
  // python f-string braces in a filename survive
  const t = fileTemplate("plain", { filename: "{weird}" });
  assert.equal(t, "{weird}\n");
});

test("templateKindForLanguage maps monaco ids, degrades to plain", () => {
  assert.equal(templateKindForLanguage("python"), "python");
  assert.equal(templateKindForLanguage("typescript"), "typescript");
  assert.equal(templateKindForLanguage("javascript"), "typescript");
  assert.equal(templateKindForLanguage("typescriptreact"), "typescript");
  assert.equal(templateKindForLanguage("rust"), "plain");
  assert.equal(templateKindForLanguage(undefined), "plain");
});

test("headerInsertLine: 0 by default, after shebang, after python coding cookie", () => {
  assert.equal(headerInsertLine("import os\n", "python"), 0);
  assert.equal(headerInsertLine("#!/usr/bin/env python3\nimport os\n", "python"), 1);
  assert.equal(
    headerInsertLine("#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nimport os\n", "python"),
    2,
  );
  // the coding-cookie hop is python-only
  assert.equal(headerInsertLine("#!/usr/bin/env node\n// x\n", "typescript"), 1);
  assert.equal(headerInsertLine("", "plain"), 0);
});

test("TEMPLATE_KINDS lists every kind once", () => {
  assert.deepEqual([...TEMPLATE_KINDS], ["python", "typescript", "plain"]);
  for (const k of TEMPLATE_KINDS) {
    assert.equal(typeof fileTemplate(k, VARS), "string");
    assert.equal(typeof copyrightHeader(k, VARS), "string");
  }
});
