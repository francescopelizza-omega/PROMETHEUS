/**
 * cat.test.ts — `/cat` prints a file, and refuses the four things a naive cat gets wrong.
 *
 * The guards are the test surface, not the happy path: a binary file, a control byte, an
 * oversized file and an option typo are each a way to corrupt or flood a raw-mode terminal.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CAT_MAX_LINES, formatCat, parseCatArgs, readTextFile } from "./cat.js";

const DIR = mkdtempSync(join(tmpdir(), "prom-cat-"));
const OPTS = { numbers: true, all: false };
const write = (name: string, body: string | Buffer): string => {
  const p = join(DIR, name);
  writeFileSync(p, body);
  return p;
};

test("parse: a bare /cat is a usage line, not a crash", () => {
  const r = parseCatArgs("", DIR);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : "", /usage: \/cat/);
});

test("parse: an unknown flag is an error, never a filename", () => {
  // the option-injection guard: `-x` must not be resolved as a relative path.
  const r = parseCatArgs("-x notes.txt", DIR);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : "", /unknown option -x/);
});

test("parse: --max needs a positive integer", () => {
  assert.equal(parseCatArgs("--max 0 f.txt", DIR).ok, false);
  assert.equal(parseCatArgs("--max abc f.txt", DIR).ok, false);
  const ok = parseCatArgs("--max 12 f.txt", DIR);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true ? ok.opts.max : 0, 12);
});

test("parse: --plain turns the line numbers off, one file at a time", () => {
  const r = parseCatArgs("--plain a.txt", DIR);
  assert.equal(r.ok === true && r.opts.numbers, false);
  assert.equal(parseCatArgs("a.txt b.txt", DIR).ok, false);
});

test("parse: the path resolves against the SESSION cwd, not process.cwd()", () => {
  const r = parseCatArgs("sub/file.txt", "/session/root");
  assert.equal(r.ok === true ? r.file : "", "/session/root/sub/file.txt");
});

test("a text file comes back line by line, with a trailing newline dropped", () => {
  const p = write("hello.txt", "alpha\nbeta\n");
  const r = readTextFile(p, OPTS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok === true ? r.lines : [], ["alpha", "beta"]);
  assert.equal(r.ok === true ? r.truncatedLines : true, false);
});

test("a binary file is REFUSED with its size — never sprayed at the terminal", () => {
  const p = write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  const r = readTextFile(p, OPTS);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : "", /binary file/);
});

test("control bytes are shown in caret notation, so ESC cannot repaint the TUI", () => {
  const p = write("evil.txt", "safe\u001b[2Jwiped\u0007\n");
  const r = readTextFile(p, OPTS);
  assert.equal(r.ok, true);
  const line = r.ok === true ? (r.lines[0] as string) : "";
  assert.ok(!line.includes("\u001b"), `raw ESC survived: ${JSON.stringify(line)}`);
  assert.ok(!line.includes("\u0007"), "raw BEL survived");
  assert.match(line, /\^\[/); // ESC → ^[
  assert.match(line, /\^G/); // BEL → ^G
  // TAB is left alone: files rely on it and terminals lay it out correctly.
  const t = readTextFile(write("tabs.txt", "a\tb\n"), OPTS);
  assert.equal(t.ok === true ? t.lines[0] : "", "a\tb");
});

test("a long file is cut at the cap and SAYS so", () => {
  const p = write(
    "long.txt",
    `${Array.from({ length: CAT_MAX_LINES + 50 }, (_, i) => i).join("\n")}\n`,
  );
  const r = readTextFile(p, OPTS);
  assert.equal(r.ok === true ? r.lines.length : 0, CAT_MAX_LINES);
  assert.equal(r.ok === true ? r.truncatedLines : false, true);
  const out = formatCat(r, "none", OPTS);
  assert.match(out.join("\n"), /-a for everything/);
  // -a lifts it.
  const all = readTextFile(p, { numbers: true, all: true });
  assert.equal(all.ok === true ? all.lines.length : 0, CAT_MAX_LINES + 50);
});

test("a missing file and a directory each get a human sentence", () => {
  const miss = readTextFile(join(DIR, "nope.txt"), OPTS);
  assert.match(miss.ok === false ? miss.error : "", /no such file/);
  const dir = readTextFile(DIR, OPTS);
  assert.match(dir.ok === false ? dir.error : "", /is a directory — try \/ls/);
});

test("every rendered line carries a gutter, which is what keeps markdown out", () => {
  // A python comment is the case that broke: `# heading` would render as an H1 in the TUI.
  const p = write("script.py", "# not a heading\n- not a bullet\n");
  const out = formatCat(readTextFile(p, OPTS), "none", OPTS);
  const body = out.slice(1); // drop the header
  for (const line of body) {
    assert.ok(/^\s*\d+ │ /.test(line), `no gutter on: ${JSON.stringify(line)}`);
  }
  // --plain drops the numbers but still indents, for the same reason.
  const plain = formatCat(readTextFile(p, { numbers: false, all: false }), "none", {
    numbers: false,
    all: false,
  });
  for (const line of plain.slice(1)) assert.ok(line.startsWith("  "), line);
});

test("caps 'none' emits no escape bytes at all — piped output stays clean", () => {
  const p = write("code.ts", "const x: number = 1;\nexport default x;\n");
  const out = formatCat(readTextFile(p, OPTS), "none", OPTS).join("\n");
  assert.ok(!out.includes("\u001b"), "colour leaked into a caps:none render");
});

test("an empty file says so rather than rendering nothing", () => {
  const out = formatCat(readTextFile(write("empty.txt", ""), OPTS), "none", OPTS);
  assert.match(out.join("\n"), /\(empty file\)/);
});
