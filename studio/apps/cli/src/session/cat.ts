/**
 * session/cat.ts — the `/cat` viewer: print a file into the transcript, with syntax colour.
 *
 * The sibling of `/ls` (session/ls.ts), and the same contract: it resolves against the SESSION
 * cwd (`ctx.cwd()`, which `/cd` and `/cwd` move) and never `process.cwd()`, it reads the file
 * itself rather than shelling out to `cat`, and it is a pure parse + read + format module so
 * both terminal hosts run identical code through the shared slash registry.
 *
 * Four things a naive `cat` into a TUI gets wrong, all handled here:
 *
 *  1. MARKDOWN. The TUI's `ctx.write` runs every line through `renderPaneText` (tui/app.ts),
 *     which markdown-parses anything `isFramingLine` does not catch — so a Python file's
 *     `# header` comment would render as an H1 and a `- item` as a bullet. Every line is
 *     therefore emitted behind a LINE-NUMBER GUTTER, which is markdown-inert by construction.
 *     `--plain` drops the numbers but keeps a two-space indent for the same reason.
 *
 *  2. CONTROL BYTES. `printAbove` strips only `\r` (tui/redraw.ts), so a raw ESC or BEL in a
 *     file reaches a raw-mode terminal and can move the cursor, repaint, or desync the TUI
 *     chrome — a file is untrusted input. C0 bytes are rendered in caret notation (`^[`, `^G`)
 *     exactly as `cat -v` does, so the content is still visible but inert.
 *
 *  3. BINARY. Nothing in the repo sniffs for binary content; `/cat logo.png` would spray a
 *     megabyte of mojibake. A NUL in the first 8 KB means binary, and it is refused with the
 *     size instead.
 *
 *  4. SIZE. There is no pager and no shared output cap in the CLI — every guard is a local
 *     constant (LS_MAX_ENTRIES, DEFAULT_READ_LINES, MAX_CHARS). This one is MAX_LINES/MAX_BYTES,
 *     and a truncated read always SAYS it was truncated.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { expandHome } from "@prometheus/core/agent-system-host";

import { shortCwd } from "../path-display.js";
import { c } from "../render.js";
import { CODE_STATE, detectLanguage, highlightLine, isHighlightable } from "../tui/highlight.js";
import type { ColorCaps } from "../tui/palette.js";

/** Default line cap. A transcript is not a pager; `--max N` (or `-a`) lifts it. */
export const CAT_MAX_LINES = 500;

/** Hard read ceiling, independent of the line cap — a single 40 MB line must not be read in. */
export const CAT_MAX_BYTES = 512 * 1024;

/** How much of the head is inspected for a NUL before deciding the file is binary. */
export const CAT_SNIFF_BYTES = 8192;

export interface CatOptions {
  /** show line numbers (default true — the gutter is also what makes output markdown-inert). */
  numbers: boolean;
  /** lift the line cap. */
  all: boolean;
  /** explicit line cap; undefined ⇒ CAT_MAX_LINES unless `all`. */
  max?: number;
}

export type CatArgs = { ok: true; file: string; opts: CatOptions } | { ok: false; error: string };

export type CatResult =
  | {
      ok: true;
      file: string;
      lines: string[];
      /** total lines in the part read (before the line cap was applied). */
      readLines: number;
      truncatedLines: boolean;
      truncatedBytes: boolean;
      bytes: number;
    }
  | { ok: false; file: string; error: string };

const USAGE = "/cat <file> [-n|--plain] [--max N] [-a]";

/**
 * Parse `/cat` arguments: exactly one path (relative to the session cwd, `~` expanded), plus
 * `-n`/`--number`, `--plain`/`-p`, `--max N` and `-a`/`--all`.
 *
 * Any unrecognised `-`-leading token is an ERROR rather than a filename — the option-injection
 * guard `parseLsArgs` and `safeToken` both use, so a typo'd flag is never silently read as a
 * path.
 */
export function parseCatArgs(rest: string, cwd: string): CatArgs {
  let numbers = true;
  let all = false;
  let max: number | undefined;
  const paths: string[] = [];
  const toks = rest.trim().split(/\s+/).filter(Boolean);

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i] as string;
    if (tok === "-n" || tok === "--number") numbers = true;
    else if (tok === "-p" || tok === "--plain") numbers = false;
    else if (tok === "-a" || tok === "--all") all = true;
    else if (tok === "--max") {
      const next = toks[++i];
      const n = Number(next);
      if (!next || !Number.isInteger(n) || n <= 0)
        return { ok: false, error: `--max needs a positive whole number — try ${USAGE}` };
      max = n;
    } else if (tok.startsWith("-")) {
      return { ok: false, error: `unknown option ${tok} — try ${USAGE}` };
    } else paths.push(tok);
  }

  if (paths.length === 0) return { ok: false, error: `usage: ${USAGE}` };
  if (paths.length > 1) return { ok: false, error: `one file at a time — ${USAGE}` };

  const file = resolve(cwd, expandHome(paths[0] as string));
  return { ok: true, file, opts: { numbers, all, ...(max !== undefined ? { max } : {}) } };
}

/**
 * Render one C0 control byte the way `cat -v` does: `^[` for ESC, `^G` for BEL, `^?` for DEL.
 * TAB is left alone (terminals lay it out correctly and files rely on it).
 */
function caretEscape(text: string): string {
  // The class is written with \u escapes rather than literal bytes so the source stays
  // readable and greppable; matching control characters is the whole job of this function.
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return `^${code === 0x7f ? "?" : String.fromCharCode(code + 64)}`;
  });
}

/** Read a file's head as text. Never throws — every failure is a human sentence. */
export function readTextFile(file: string, opts: CatOptions): CatResult {
  let size: number;
  try {
    const st = statSync(file);
    if (st.isDirectory())
      return { ok: false, file, error: `${shortCwd(file)} is a directory — try /ls ${file}` };
    size = st.size;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      ok: false,
      file,
      error:
        code === "ENOENT"
          ? `no such file: ${shortCwd(file)}`
          : code === "EACCES" || code === "EPERM"
            ? `permission denied: ${shortCwd(file)}`
            : `cannot read ${shortCwd(file)}: ${(e as Error).message}`,
    };
  }

  const want = Math.min(size, CAT_MAX_BYTES);
  const buf = Buffer.alloc(want);
  let got = 0;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    got = readSync(fd, buf, 0, want, 0);
  } catch (e) {
    return { ok: false, file, error: `cannot read ${shortCwd(file)}: ${(e as Error).message}` };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the fd is process-scoped and the process is short-lived; a failed close is not fatal */
      }
    }
  }

  // BINARY: a NUL in the head. Checked on the raw bytes, before any decode invents replacement
  // characters that would hide it.
  if (buf.subarray(0, Math.min(got, CAT_SNIFF_BYTES)).includes(0)) {
    return {
      ok: false,
      file,
      error: `${shortCwd(file)} is a binary file (${size.toLocaleString("en-US")} bytes) — not printed`,
    };
  }

  const text = buf.subarray(0, got).toString("utf8");
  const raw = text.split("\n");
  // A trailing newline yields a final empty element that is not a line.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const readLines = raw.length;

  const cap = opts.all ? Number.POSITIVE_INFINITY : (opts.max ?? CAT_MAX_LINES);
  const kept = readLines > cap ? raw.slice(0, cap) : raw;

  return {
    ok: true,
    file,
    lines: kept.map((l) => caretEscape(l.replace(/\r$/, ""))),
    readLines,
    truncatedLines: readLines > cap,
    truncatedBytes: got < size,
    bytes: size,
  };
}

/**
 * Render a read as transcript lines: a header naming the file and its size, then the content
 * behind a dim line-number gutter, syntax-highlighted from the file EXTENSION.
 *
 * `caps === "none"` makes both `c.*` and `highlightLine` identities, so a piped or NO_COLOR
 * session gets clean text — the same degrade rule the rest of the TUI follows.
 */
export function formatCat(result: CatResult, caps: ColorCaps, opts: CatOptions): string[] {
  // `c.*` is driven by render.ts's own module-global switch, NOT by `caps` — and it has no
  // getter, so a pure module cannot ask it. Gating the chrome here is what makes `caps:"none"`
  // mean what the docstring says: zero escape bytes, so a piped `/cat` is a usable file.
  const off = caps === "none";
  const dim = (s: string): string => (off ? s : c.dim(s));
  const bold = (s: string): string => (off ? s : c.bold(s));

  if (!result.ok) return [off ? result.error : c.red(result.error)];

  const { file, lines, readLines, truncatedLines, truncatedBytes, bytes } = result;
  const ext = file.includes(".") ? (file.split(".").pop() ?? "") : "";
  const lang = detectLanguage(ext);
  const colored = isHighlightable(lang) && caps !== "none";

  const shown = lines.length;
  const counts = [
    `${shown} line${shown === 1 ? "" : "s"}`,
    `${bytes.toLocaleString("en-US")} bytes`,
    ...(colored ? [lang] : []),
  ].join(", ");
  const out = [`${bold(shortCwd(file))}  ${dim(counts)}`];

  if (shown === 0) {
    out.push(dim("  (empty file)"));
    return out;
  }

  const gutter = String(shown).length;
  let state = CODE_STATE;
  lines.forEach((line, i) => {
    let body = line;
    if (colored) {
      const { text, state: next } = highlightLine(line, lang, state, caps);
      body = text;
      state = next;
    }
    // The gutter is not decoration: a leading `  12 │ ` is what keeps the TUI's markdown pass
    // from reading a `#` comment as a heading. --plain still indents for the same reason.
    const prefix = opts.numbers ? dim(`${String(i + 1).padStart(gutter)} │ `) : "  ";
    out.push(prefix + body);
  });

  if (truncatedLines || truncatedBytes) {
    const why = truncatedBytes
      ? `first ${CAT_MAX_BYTES.toLocaleString("en-US")} bytes`
      : `first ${shown} of ${readLines.toLocaleString("en-US")} lines`;
    out.push(dim(`  … ${why} — /cat ${shortCwd(file)} -a for everything`));
  }
  return out;
}
