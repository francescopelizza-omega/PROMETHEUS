// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/test-report.ts — PURE CI-report formatters for `prometheus test run` (CLI-093).
 *
 * Two additional output modes over the SAME per-test data CLI-007's `run` already collects — this
 * file does NOT touch the raw `--json` envelope shape (owned by CLI-007) nor watch mode (CLI-092):
 *   - toJUnitXml(report)        → a schema-valid JUnit-XML document (<testsuites>/<testsuite>/…)
 *   - toGithubAnnotations(report) → `::error file=…,line=…::…` lines for GitHub Actions
 *
 * Both are pure over the normalized `TestReport`; no new sidecar fields (a missing line degrades to
 * `line=1` rather than expanding testmgr's contract).
 */

/** One normalized test result (built from CLI-007's streamed `{event:"test",…}` records). */
export interface ReportCase {
  /** the node id, e.g. `tests/test_x.py::TestA::test_b`. */
  id: string;
  /** pass | fail | error | skip. */
  status: string;
  file?: string;
  line?: number;
  /** the short failure message / assertion text. */
  message?: string;
  /** captured traceback / output lines. */
  output?: string[];
  durationMs?: number;
}

export interface TestReport {
  suiteName: string;
  cases: ReportCase[];
  summary: { total: number; passed: number; failed: number; skipped: number; durationMs?: number };
}

const isFail = (s: string): boolean => s === "fail";
const isError = (s: string): boolean => s === "error";
const isSkip = (s: string): boolean => s === "skip";

/**
 * Strip every char OUTSIDE the XML-1.0 Char production so the document stays well-formed for picky
 * CI parsers: the illegal C0 controls (0x00–08, 0B, 0C, 0E–1F), the noncharacters U+FFFE/U+FFFF,
 * and — critically — any LONE surrogate (a valid astral char is a surrogate PAIR and is preserved).
 */
function stripIllegalXmlChars(s: string): string {
  return (
    s
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "")
      // lone high surrogate (not followed by a low) or lone low surrogate (not preceded by a high)
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
  );
}

/** Escape XML attribute value: the five entities, on control-char-sanitized text. */
function escapeAttr(s: string): string {
  return stripIllegalXmlChars(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Escape XML text body: `& < >` on control-char-sanitized text (quotes are legal in text). */
function escapeText(s: string): string {
  return stripIllegalXmlChars(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Split a node id into (classname, name): `file::Class::method` → ("file.Class", "method"). */
function splitId(id: string, suiteName: string): { classname: string; name: string } {
  const parts = id.split("::");
  if (parts.length <= 1) return { classname: suiteName, name: id };
  return { classname: parts.slice(0, -1).join(".") || suiteName, name: parts.at(-1) ?? id };
}

/** Seconds-as-float for a JUnit `time` attribute (ms → s); undefined/negative ⇒ 0. */
function secs(ms?: number): string {
  const v = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
  return v.toFixed(4);
}

/**
 * Render a JUnit-XML document (CLI-093). Always wraps a single `<testsuite>` in the `<testsuites>`
 * root (Jenkins/GitLab/Bamboo require it), carries every required attribute, and stays valid for an
 * empty run (`tests="0"`). `<failure>`/`<error>` carry the message as an attribute + the traceback
 * as the escaped text body; `<skipped/>` is a bare element.
 */
export function toJUnitXml(report: TestReport): string {
  const errors = report.cases.filter((c) => isError(c.status)).length;
  const failures = report.cases.filter((c) => isFail(c.status)).length;
  const skipped = report.cases.filter((c) => isSkip(c.status)).length;
  const tests = report.cases.length;
  const suiteTime = secs(report.summary.durationMs);
  const suiteName = escapeAttr(report.suiteName);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${suiteTime}">`,
    `  <testsuite name="${suiteName}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${suiteTime}">`,
  ];
  for (const c of report.cases) {
    const { classname, name } = splitId(c.id, report.suiteName);
    const attrs = `name="${escapeAttr(name)}" classname="${escapeAttr(classname)}" time="${secs(c.durationMs)}"`;
    if (isFail(c.status) || isError(c.status)) {
      const tag = isError(c.status) ? "error" : "failure";
      const msg = escapeAttr(c.message ?? c.status);
      const body = escapeText((c.output ?? []).join("\n") || c.message || "");
      lines.push(`    <testcase ${attrs}>`);
      lines.push(`      <${tag} message="${msg}" type="${tag}">${body}</${tag}>`);
      lines.push("    </testcase>");
    } else if (isSkip(c.status)) {
      lines.push(`    <testcase ${attrs}><skipped/></testcase>`);
    } else {
      lines.push(`    <testcase ${attrs}/>`);
    }
  }
  lines.push("  </testsuite>", "</testsuites>");
  return `${lines.join("\n")}\n`;
}

/** GitHub Actions command-message encoding: `%`, CR, LF (a raw newline truncates the annotation). */
function encodeAnnotationMessage(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Encode an annotation PROPERTY value (file/line/col) — also escape `,` and `:` (param delimiters). */
function encodeAnnotationProp(s: string): string {
  return encodeAnnotationMessage(s).replace(/,/g, "%2C").replace(/:/g, "%3A");
}

/**
 * GitHub Actions failure annotations (CLI-093): `::error file=<rel>,line=<n>::<message>` per
 * failure/error, most-significant first, capped at `max` (GitHub caps displayed annotations). The
 * file path must be repo-RELATIVE to attach to the diff; a missing line degrades to 1. Pure — the
 * caller decides whether to emit (explicit flag or `GITHUB_ACTIONS === "true"`).
 */
export function toGithubAnnotations(report: TestReport, max = 50): string[] {
  const failures = report.cases.filter((c) => isFail(c.status) || isError(c.status));
  const shown = failures.slice(0, max);
  const out = shown.map((c) => {
    const file = encodeAnnotationProp(c.file ?? "unknown");
    const line = c.line && c.line > 0 ? c.line : 1;
    const msg = encodeAnnotationMessage(
      c.message ?? ((c.output ?? []).join("\n") || `${c.id} ${c.status}`),
    );
    return `::error file=${file},line=${line}::${msg}`;
  });
  if (failures.length > shown.length) {
    out.push(
      `::warning::${failures.length - shown.length} more failure(s) not annotated (GitHub cap)`,
    );
  }
  return out;
}
