/**
 * reflow.test.ts — the resize orphan, reproduced against a model of the terminal.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A PTY TEST.
 *
 * The reported bug was a line of PROMETHEUS chrome holding FOUR concatenated top borders of
 * 133, 105, 2 and 119 columns — `cols-1` for three window widths the session had passed
 * through. One stranded `╭────╮` per resize.
 *
 * A pty cannot reproduce that. A pty is a byte pipe with a window size; it has no screen and
 * never reflows anything. REWRAP IS THE EMULATOR'S BEHAVIOUR — Terminal.app and iTerm2 re-flow
 * their scrollback when the window narrows, whatever DECAWM said when the bytes were written —
 * so a test that spawns a pty proves nothing about it, and "run it and drag the window" is not
 * a test. The only way to assert on this in CI is to MODEL the terminal, which is what `Term`
 * below does: logical lines, physical rows derived from the current width, and a cursor that
 * moves in physical rows. Narrowing changes no text and re-derives every row — the rewrap.
 *
 * The invariant under test is the one the whole inline renderer rests on:
 * `frame.lines.length === physical rows`. A repaint climbs `parkedRow` rows to reach the block
 * top and erases downward. If a row above the caret became two rows, the climb lands short,
 * `ESC[0J` erases from BELOW the top border, and the border is stranded in the scrollback.
 *
 * The control test at the bottom is the load-bearing half: it drives the same harness with the
 * OLD behaviour and asserts the orphan appears. Without it this file could pass because the
 * model is too weak to show the bug, which is the failure mode a regression test cannot afford.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type FrameInput, renderFrame } from "./frame.js";
import { Renderer, reflowSlack } from "./redraw.js";
import { initialTuiState } from "./reducer.js";
import type { StatusModel } from "./status.js";
import { stringWidth } from "./width.js";

const STATUS: StatusModel = {
  permMode: "default",
  authLevel: 1,
  model: "qwen",
  modelSource: "local",
  tools: true,
  gate: "enforce",
  dryRun: false,
  profile: "default",
  cwd: "~/p",
};

const input = (cols: number, text: string): FrameInput => ({
  state: initialTuiState({ input: text, cursor: text.length }),
  status: STATUS,
  caps: "none",
  cols,
  rows: 24,
});

/** The display-column prefix of `s` that occupies exactly `n` columns. */
function sliceCols(s: string, n: number): string {
  if (n <= 0) return "";
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    w += stringWidth(ch);
    if (w > n) return s.slice(0, i);
  }
  return s;
}

/**
 * A terminal, modelled the way Terminal.app behaves — enough of one to settle this question.
 *
 * Text is kept as LOGICAL lines. How many physical rows each occupies is derived from the
 * current width every time it is asked, so `resize()` re-flows the whole screen without
 * touching a character: exactly what narrowing a real window does.
 */
class Term {
  lines: string[] = [""];
  /** cursor: logical line index, and display column WITHIN that logical line. */
  li = 0;
  lc = 0;
  wrap = true;
  // a plain field + assignment, NOT `constructor(public cols: number)`: node's type-stripping
  // runs this file directly and a parameter property is erasable-syntax-illegal there.
  cols: number;

  constructor(cols: number) {
    this.cols = cols;
  }

  private rowsOf(s: string): number {
    return Math.max(1, Math.ceil(stringWidth(s) / this.cols));
  }
  private physTop(i: number): number {
    let n = 0;
    for (let k = 0; k < i; k++) n += this.rowsOf(this.lines[k] as string);
    return n;
  }
  /** the physical row the cursor is on. */
  physRow(): number {
    return this.physTop(this.li) + Math.floor(this.lc / this.cols);
  }
  /** move the cursor to an absolute physical row, landing at that row's first column. */
  private seekPhys(target: number): void {
    let t = Math.max(0, target);
    for (let i = 0; i < this.lines.length; i++) {
      const r = this.rowsOf(this.lines[i] as string);
      if (t < r) {
        this.li = i;
        this.lc = t * this.cols;
        return;
      }
      t -= r;
    }
    this.li = this.lines.length - 1;
    this.lc = 0;
  }

  /** Narrowing changes no text — only how many rows it takes. That IS the rewrap. */
  resize(cols: number): void {
    this.cols = cols;
  }

  /** The whole screen as physical rows, which is what a person actually sees. */
  screen(): string[] {
    const out: string[] = [];
    for (const line of this.lines) {
      const rows = this.rowsOf(line);
      for (let r = 0; r < rows; r++) {
        const upToEnd = sliceCols(line, this.cols * (r + 1));
        const upToStart = sliceCols(line, this.cols * r);
        out.push(upToEnd.slice(upToStart.length));
      }
    }
    return out;
  }

  write(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i] as string;
      if (ch === "\x1b" && s[i + 1] === "[") {
        const m = /^\x1b\[([?0-9;]*)([A-Za-z])/.exec(s.slice(i));
        if (m) {
          this.csi(m[1] as string, m[2] as string);
          i += m[0].length;
          continue;
        }
      }
      if (ch === "\r") {
        // Carriage return goes to the start of the PHYSICAL row, which inside a wrapped
        // logical line is NOT column 0 of that line. This is the detail the bug turns on.
        this.lc = Math.floor(this.lc / this.cols) * this.cols;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.li += 1;
        if (this.li >= this.lines.length) this.lines.push("");
        this.lc = 0;
        i++;
        continue;
      }
      // printable: overwrite at the cursor, pad if we are past the end of the line
      const line = this.lines[this.li] as string;
      const head = sliceCols(line, this.lc);
      const padded = head + " ".repeat(Math.max(0, this.lc - stringWidth(head)));
      const tail = line.slice(sliceCols(line, this.lc + stringWidth(ch)).length);
      const next = padded + ch + tail;
      // Autowrap OFF clips at the right margin of the CURRENT PHYSICAL ROW — not at the width
      // of the whole logical line. Inside a line that has rewrapped into several rows the
      // cursor can legitimately sit at column 106 of a 106-wide screen, which is row 1 column 0,
      // and writing there must extend the line. Clipping against `cols` instead swallowed every
      // byte of the repaint and made the harness report a clean screen for a broken one.
      const margin = (Math.floor(this.lc / this.cols) + 1) * this.cols;
      this.lines[this.li] = this.wrap ? next : sliceCols(next, margin);
      this.lc += stringWidth(ch);
      i++;
    }
  }

  private csi(params: string, final: string): void {
    if (params === "?7") {
      this.wrap = final === "h";
      return;
    }
    if (params === "?25") return; // cursor visibility — no effect on layout
    const n = Number.parseInt(params || "0", 10) || 0;
    if (final === "A") {
      this.seekPhys(this.physRow() - Math.max(1, n));
      return;
    }
    if (final === "C") {
      this.lc += n;
      return;
    }
    if (final === "J" && n === 0) {
      // erase from the cursor to the end of the screen
      this.lines[this.li] = sliceCols(this.lines[this.li] as string, this.lc);
      this.lines = this.lines.slice(0, this.li + 1);
      return;
    }
  }
}

/** Lay down some transcript, then paint the chrome under it — the normal steady state. */
function boot(cols: number): { term: Term; r: Renderer; frame: ReturnType<typeof renderFrame> } {
  const term = new Term(cols);
  const r = new Renderer((s) => term.write(s));
  term.write("transcript line one\r\ntranscript line two\r\ntranscript line three\r\n");
  const frame = renderFrame(input(cols, "hello"));
  r.paint(frame);
  return { term, r, frame };
}

/** What `app.ts` computes on SIGWINCH — replicated so the test drives the real arithmetic. */
function slackFor(frame: ReturnType<typeof renderFrame>, cols: number): number {
  const parked = Math.max(0, Math.min(frame.cursorRow, frame.lines.length - 1));
  const above = frame.lines.slice(0, parked).map(stringWidth);
  const caretOverflow = Math.floor(frame.cursorCol / Math.max(1, cols));
  return reflowSlack(above, cols) + caretOverflow;
}

const borders = (term: Term): number => term.screen().filter((l) => l.includes("╭")).length;

test("the block is exactly as tall as the renderer believes, at every width", () => {
  // The invariant everything else rests on. If this breaks, the cursor arithmetic cannot help.
  for (const cols of [40, 60, 80, 106, 120, 134]) {
    const term = new Term(cols);
    const r = new Renderer((s) => term.write(s));
    const frame = renderFrame(input(cols, "hello"));
    r.paint(frame);
    assert.equal(
      term.screen().length,
      frame.lines.length,
      `cols=${cols}: ${frame.lines.length} logical lines became ${term.screen().length} rows`,
    );
  }
});

test("narrowing the window leaves ONE top border, and the transcript untouched", () => {
  // 120 -> 106 are two of the widths from the reported screenshot, whose orphans measured
  // 119 and 105 columns: `cols-1` for each.
  const { term, r, frame } = boot(120);
  assert.equal(borders(term), 1, "precondition: one border before the resize");

  term.resize(106);
  const next = renderFrame(input(106, "hello"));
  r.paint(next, slackFor(frame, 106));

  assert.equal(borders(term), 1, "a resize stranded a top border in the scrollback");
  const screen = term.screen();
  for (const line of ["transcript line one", "transcript line two", "transcript line three"]) {
    assert.ok(
      screen.some((l) => l.includes(line)),
      `the repaint erased scrollback above the chrome: "${line}" is gone`,
    );
  }
});

test("repeated narrowing does not accumulate orphans", () => {
  // The screenshot had FOUR borders on one line, not two — the damage compounds per resize.
  const { term, r, frame } = boot(134);
  let prev = frame;
  for (const cols of [120, 106, 94]) {
    term.resize(cols);
    const next = renderFrame(input(cols, "hello"));
    r.paint(next, slackFor(prev, cols));
    prev = next;
    assert.equal(borders(term), 1, `orphan after narrowing to ${cols}`);
  }
});

test("widening needs no slack and is unaffected", () => {
  const { term, r, frame } = boot(80);
  term.resize(120);
  const next = renderFrame(input(120, "hello"));
  assert.equal(slackFor(frame, 120), 0, "a wider window cannot have rewrapped anything");
  r.paint(next, slackFor(frame, 120));
  assert.equal(borders(term), 1);
});

test("CONTROL: the old behaviour (no slack) DOES strand a border in this harness", () => {
  // Without this the file could pass because the model is too weak to show the bug. It drives
  // the identical path with slack forced to 0 — what `onResize` did before — and requires the
  // orphan to appear. If this ever stops failing-as-expected, the harness has gone blind and
  // the four tests above are worthless.
  const { term, r, frame } = boot(120);
  term.resize(106);
  assert.ok(slackFor(frame, 106) > 0, "the fixture must actually rewrap, or it proves nothing");

  const next = renderFrame(input(106, "hello"));
  r.paint(next, 0); // <- the bug
  assert.ok(
    borders(term) > 1,
    "harness blind: the old no-slack repaint should have stranded a border and did not",
  );
});
