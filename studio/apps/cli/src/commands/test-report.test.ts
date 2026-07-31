/**
 * test-report.test.ts — pure JUnit-XML + GitHub-annotation formatters (CLI-093).
 * Covers pass / fail / empty for both formats; XML escaping + control-char stripping; annotation
 * URL-encoding + repo-relative path + line degradation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type TestReport, toGithubAnnotations, toJUnitXml } from "./test-report.js";

const passing: TestReport = {
  suiteName: "prom test",
  cases: [
    { id: "tests/test_a.py::TestA::test_ok", status: "pass", durationMs: 12 },
    { id: "tests/test_a.py::TestA::test_skip", status: "skip" },
  ],
  summary: { total: 2, passed: 1, failed: 0, skipped: 1, durationMs: 20 },
};

const failing: TestReport = {
  suiteName: "prom test",
  cases: [
    { id: "tests/test_b.py::test_pass", status: "pass" },
    {
      id: "tests/test_b.py::test_fail",
      status: "fail",
      file: "tests/test_b.py",
      line: 42,
      message: 'assert 1 == 2 & "x" <y>',
      output: ["Traceback:", "  line with \x1b[31mESC\x1b[0m color", "AssertionError"],
    },
    { id: "tests/test_b.py::test_err", status: "error", file: "tests/test_b.py", message: "boom" },
  ],
  summary: { total: 3, passed: 1, failed: 1, skipped: 0, durationMs: 50 },
};

const empty: TestReport = {
  suiteName: "prom test",
  cases: [],
  summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
};

test("toJUnitXml: passing run → <testsuites> root + required attrs + <skipped/> (CLI-093)", () => {
  const xml = toJUnitXml(passing);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<testsuites tests="2" failures="0" errors="0" skipped="1" time="0\.0200">/);
  assert.match(xml, /<testsuite name="prom test" tests="2" failures="0" errors="0" skipped="1"/);
  assert.match(
    xml,
    /<testcase name="test_ok" classname="tests\/test_a\.py\.TestA" time="0\.0120"\/>/,
  );
  assert.match(xml, /<testcase name="test_skip"[^>]*><skipped\/><\/testcase>/);
  assert.match(xml, /<\/testsuites>\n$/);
});

test("toJUnitXml: failures + errors → <failure>/<error> with escaping + ESC stripped (CLI-093)", () => {
  const xml = toJUnitXml(failing);
  assert.match(xml, /failures="1" errors="1"/);
  // attribute escaping of & " < >
  assert.match(
    xml,
    /<failure message="assert 1 == 2 &amp; &quot;x&quot; &lt;y&gt;" type="failure">/,
  );
  assert.match(xml, /<error message="boom" type="error">/);
  // the raw ESC control char (0x1b) must NOT survive into the XML body
  assert.ok(!xml.includes("\x1b"), "illegal control char stripped");
  assert.match(xml, /AssertionError/); // traceback body preserved
});

test("toJUnitXml: empty run → a valid tests=0 suite, never an empty file (CLI-093)", () => {
  const xml = toJUnitXml(empty);
  assert.match(xml, /<testsuites tests="0" failures="0" errors="0" skipped="0"/);
  assert.match(xml, /<testsuite name="prom test" tests="0"/);
  assert.match(xml, /<\/testsuites>/);
});

test("toGithubAnnotations: one ::error per failure/error, url-encoded, repo-relative, line≥1 (CLI-093)", () => {
  const anns = toGithubAnnotations(failing);
  assert.equal(anns.length, 2); // fail + error (pass excluded)
  assert.equal(anns[0], '::error file=tests/test_b.py,line=42::assert 1 == 2 & "x" <y>');
  // the error case had no line → degrades to 1
  assert.match(anns[1] ?? "", /::error file=tests\/test_b\.py,line=1::boom/);
});

test("toGithubAnnotations: newline/percent encoding so a multi-line message never truncates (CLI-093)", () => {
  const r: TestReport = {
    suiteName: "s",
    cases: [{ id: "x::y", status: "fail", file: "a.py", line: 3, message: "line1\nline2 100%\rX" }],
    summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
  };
  const [ann] = toGithubAnnotations(r);
  assert.match(ann ?? "", /line1%0Aline2 100%25%0DX$/); // LF→%0A, %→%25, CR→%0D
  assert.ok(!(ann ?? "").includes("\n"), "no raw newline (would truncate the annotation)");
});

test("toGithubAnnotations: passing/empty run → no annotations (CLI-093)", () => {
  assert.deepEqual(toGithubAnnotations(passing), []);
  assert.deepEqual(toGithubAnnotations(empty), []);
});

test("toGithubAnnotations: caps at max, notes the overflow (CLI-093)", () => {
  const many: TestReport = {
    suiteName: "s",
    cases: Array.from({ length: 5 }, (_, i) => ({
      id: `x::t${i}`,
      status: "fail" as const,
      file: "a.py",
      line: i + 1,
      message: `f${i}`,
    })),
    summary: { total: 5, passed: 0, failed: 5, skipped: 0 },
  };
  const anns = toGithubAnnotations(many, 3);
  assert.equal(anns.length, 4); // 3 errors + 1 overflow warning
  assert.match(anns[3] ?? "", /::warning::2 more failure/);
});

test("toJUnitXml: lone surrogates + U+FFFE/FFFF are stripped (well-formed XML); a valid astral pair survives", () => {
  const r = {
    suiteName: "s",
    cases: [{ id: "x::y", status: "fail", message: "bad\uD800text￾ok\uDFFF end 😀" }],
    summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
  };
  const xml = toJUnitXml(r);
  assert.ok(!/[￾￿]/.test(xml), "no noncharacters");
  // no LONE surrogate remains (a valid astral char = a paired high+low, which is preserved).
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(xml));
  assert.ok(xml.includes("😀"), "valid astral emoji preserved");
  assert.match(xml, /message="badtextok end 😀"/);
});
