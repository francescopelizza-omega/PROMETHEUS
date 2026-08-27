/**
 * agent/diff-view.ts — a PURE structured diff for the "surgical edit card" (CLI-EDIT).
 *
 * Given the OLD file text and the NEW file text (the result of applying propose_edit's hunks,
 * or a write_file overwrite), it produces line-numbered HUNKS with a few lines of context, and
 * — for a modified line paired with its replacement — TOKEN-LEVEL word spans so the renderer can
 * light up only what actually changed. No IO, no color; the CLI paints the returned structure.
 *
 * Line-level diff is an LCS (Myers-equivalent for the common case); word-level is a token LCS.
 * Both are bounded, and BOTH bounds are load-bearing:
 *   - a file above SIZE_GUARD lines skips the line-level table and returns a single whole-file
 *     replacement hunk (`truncated`), so a giant overwrite never hangs the render;
 *   - a line above WORD_GUARD tokens skips the word-level table and marks the whole line
 *     changed, so a minified one-liner cannot allocate a quadratic table and abort the process.
 * The second bound did not exist: this header asserted it while `wordSpans` ran unguarded.
 */

/** One word-level segment of a modified line: the text + whether it differs from the pair line. */
export interface WordSpan {
  text: string;
  changed: boolean;
}

/** One rendered row of a hunk. `oldNo`/`newNo` are 1-based file line numbers (null on the side a
 *  row doesn't exist — a `del` has no new number, an `add` has no old number). */
export interface DiffRow {
  kind: "context" | "del" | "add";
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** token spans (only on del/add rows that pair 1:1 with a counterpart) for word-level highlight. */
  spans?: WordSpan[];
}

/** A contiguous change region + its surrounding context, with the @@ header coordinates. */
export interface DiffHunkView {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  rows: DiffRow[];
}

/** The whole structured edit: hunks + totals. `truncated` ⇒ the file was too big to line-diff. */
export interface EditView {
  hunks: DiffHunkView[];
  added: number;
  removed: number;
  truncated: boolean;
}

const SIZE_GUARD = 4000; // lines; above this we don't build the O(n·m) LCS table

/**
 * Token budget for the WORD-level table, which is a second O(n·m) allocation the line guard
 * above does not cover.
 *
 * `SIZE_GUARD` bounds lines; `wordSpans` then builds `(m+1) × (n+1)` numbers over the TOKENS of
 * a single line, and `tokenize` emits one token per punctuation character. A minified or
 * generated one-liner is tens of thousands of tokens, so the table is quadratic in that: 50k
 * tokens each side is 2.5 billion array slots. A V8 heap OOM is a fatal abort, not a catchable
 * error, so the process died (exit 134) while the user was being asked to approve the edit —
 * the file being previewed is exactly the kind a model reformats. The module header claimed
 * "Both are bounded"; only one was.
 *
 * Over the budget the pair simply gets no word-level highlighting: the whole line reads as
 * changed, which is what a minified line means anyway.
 */
const WORD_GUARD = 2500; // tokens per side (~6.25M slots worst case)

type LineTag = { tag: " " | "-" | "+"; text: string };

/** Split a text into lines WITHOUT a trailing empty element for a final newline (so line counts
 *  match an editor's). An empty string is zero lines. */
function toLines(text: string): string[] {
  if (text === "") return [];
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = norm.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop(); // drop the trailing-newline empty
  return parts;
}

/** Line-level LCS diff → an ordered list of context/removed/added tags. */
function lineDiff(a: string[], b: string[]): LineTag[] {
  const m = a.length;
  const n = b.length;
  // LCS length table (m+1 × n+1).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: LineTag[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ tag: " ", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ tag: "-", text: a[i]! });
      i++;
    } else {
      out.push({ tag: "+", text: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ tag: "-", text: a[i++]! });
  while (j < n) out.push({ tag: "+", text: b[j++]! });
  return out;
}

/** Tokenize a line into whitespace-runs / word-runs / single punctuation, for word-level LCS. */
function tokenize(line: string): string[] {
  return line.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? (line === "" ? [] : [line]);
}

/** Token LCS → per-line spans marking which tokens changed (for a del line vs its add pair). */
function wordSpans(oldLine: string, newLine: string): { del: WordSpan[]; add: WordSpan[] } {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const m = a.length;
  const n = b.length;
  // Refuse the quadratic table on a pathological line rather than letting V8 abort the process.
  if (m > WORD_GUARD || n > WORD_GUARD) {
    return {
      del: oldLine === "" ? [] : [{ text: oldLine, changed: true }],
      add: newLine === "" ? [] : [{ text: newLine, changed: true }],
    };
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const del: WordSpan[] = [];
  const add: WordSpan[] = [];
  const push = (arr: WordSpan[], text: string, changed: boolean): void => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text;
    else arr.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push(del, a[i]!, false);
      push(add, b[j]!, false);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push(del, a[i]!, true);
      i++;
    } else {
      push(add, b[j]!, true);
      j++;
    }
  }
  while (i < m) push(del, a[i++]!, true);
  while (j < n) push(add, b[j++]!, true);
  return { del, add };
}

/** Build the structured, line-numbered, word-level edit view. `context` = lines shown each side. */
export function buildEditView(
  oldText: string,
  newText: string,
  opts: { context?: number } = {},
): EditView {
  const context = Math.max(0, opts.context ?? 2);
  const a = toLines(oldText);
  const b = toLines(newText);

  // size guard: a huge file → one whole-file replacement hunk, no O(n·m) table.
  if (a.length + b.length > SIZE_GUARD * 2) {
    const rows: DiffRow[] = [];
    a.forEach((t, k) => rows.push({ kind: "del", oldNo: k + 1, newNo: null, text: t }));
    b.forEach((t, k) => rows.push({ kind: "add", oldNo: null, newNo: k + 1, text: t }));
    return {
      hunks: [{ oldStart: 1, oldCount: a.length, newStart: 1, newCount: b.length, rows }],
      added: b.length,
      removed: a.length,
      truncated: true,
    };
  }

  const tags = lineDiff(a, b);
  // attach 1-based file line numbers as we walk.
  type NumRow = { tag: " " | "-" | "+"; text: string; oldNo: number | null; newNo: number | null };
  const rows: NumRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  for (const t of tags) {
    if (t.tag === " ") rows.push({ ...t, oldNo: ++oldNo, newNo: ++newNo });
    else if (t.tag === "-") {
      rows.push({ ...t, oldNo: ++oldNo, newNo: null });
      removed++;
    } else {
      rows.push({ ...t, oldNo: null, newNo: ++newNo });
      added++;
    }
  }

  // group into hunks: a change run plus `context` unchanged lines on each side; merge runs whose
  // context windows touch (≤ 2·context apart) so nearby edits share one hunk.
  const changedIdx = rows.map((r, k) => (r.tag === " " ? -1 : k)).filter((k) => k >= 0);
  const hunks: DiffHunkView[] = [];
  if (changedIdx.length === 0) return { hunks: [], added: 0, removed: 0, truncated: false };

  let start = Math.max(0, (changedIdx[0] as number) - context);
  let end = Math.min(rows.length - 1, (changedIdx[0] as number) + context);
  const flush = (): void => {
    const slice = rows.slice(start, end + 1);
    const firstOld = slice.find((r) => r.oldNo !== null)?.oldNo ?? 1;
    const firstNew = slice.find((r) => r.newNo !== null)?.newNo ?? 1;
    const oldCount = slice.filter((r) => r.oldNo !== null).length;
    const newCount = slice.filter((r) => r.newNo !== null).length;
    // pair del↔add runs inside this hunk for word-level spans.
    const drows: DiffRow[] = slice.map((r) => ({
      kind: r.tag === " " ? "context" : r.tag === "-" ? "del" : "add",
      oldNo: r.oldNo,
      newNo: r.newNo,
      text: r.text,
    }));
    attachWordSpans(drows);
    hunks.push({ oldStart: firstOld, oldCount, newStart: firstNew, newCount, rows: drows });
  };
  for (let c = 1; c < changedIdx.length; c++) {
    const idx = changedIdx[c] as number;
    if (idx - context <= end + 1) {
      end = Math.min(rows.length - 1, idx + context); // extend the current hunk
    } else {
      flush();
      start = Math.max(0, idx - context);
      end = Math.min(rows.length - 1, idx + context);
    }
  }
  flush();
  return { hunks, added, removed, truncated: false };
}

/** For each maximal del-run immediately followed by an add-run, word-diff the 1:1 paired lines. */
function attachWordSpans(rows: DiffRow[]): void {
  let k = 0;
  while (k < rows.length) {
    if (rows[k]!.kind !== "del") {
      k++;
      continue;
    }
    const delStart = k;
    while (k < rows.length && rows[k]!.kind === "del") k++;
    const dels = rows.slice(delStart, k);
    const addStart = k;
    while (k < rows.length && rows[k]!.kind === "add") k++;
    const adds = rows.slice(addStart, k);
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      const { del, add } = wordSpans(dels[p]!.text, adds[p]!.text);
      dels[p]!.spans = del;
      adds[p]!.spans = add;
    }
  }
}
