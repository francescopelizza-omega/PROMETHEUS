/**
 * terminal-view.ts — PURE renderer helpers for the Terminal Launcher (file 13 §1.2).
 *
 * The authoritative launcher reducer + profiles live in @prometheus/core's `terminal`
 * (tested there); the renderer drives PTYs over `window.prometheus.ide.*`. This module
 * owns only the renderer's display shaping (status glyphs, group ordering, append-only
 * scrollback) — unit-testable without a DOM.
 */

/** A terminal session row as the renderer holds it. */
/*
 * `SessionView`, `statusGlyph`, `groupSessions` and their two group constants lived here for
 * `TerminalLauncher.tsx` — the file-13 §1.2 v1 terminal, superseded by `TerminalPanel.tsx`,
 * which `routes/editor.tsx` is what actually mounts. Launcher is deleted; these went with it.
 * Everything below is LIVE: `appendScrollback` (Terminal, FloatingTerminalWindow, routes/chat)
 * and the OSC-133 block/search family (Terminal).
 */

/**
 * Append PTY output to a bounded scrollback string (keeps the last `maxChars` so a
 * runaway process can't blow up renderer memory — 07 §11 frame-drop spirit).
 */
export function appendScrollback(prev: string, chunk: string, maxChars = 100_000): string {
  const next = prev + chunk;
  return next.length > maxChars ? next.slice(next.length - maxChars) : next;
}

/** The "+ New terminal ▾" menu item shape the renderer renders (mirrors core profiles). */
export interface MenuItemView {
  id: string;
  title: string;
  subtitle?: string;
  kind: "shell" | "ai-preset" | "env";
  /** an AI preset that isn't on PATH renders disabled with this hint (§1.4). */
  disabledHint?: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * APP-091: terminal find-box search + OSC-133 command blocks.
 *
 * ALL of this is PURE (no xterm/DOM import) so it is node:test-able. Terminal.tsx owns
 * the live xterm side: it reconstructs the buffer rows into logical lines (joinWrappedRows),
 * runs searchLines over them, maps a match back to a buffer row to scrollTo + decorate, and
 * registers the OSC-133 handler that feeds parseOsc133 → reduceBlocks + xterm markers.
 * ────────────────────────────────────────────────────────────────────────── */

/** One OSC-133 command block: the prompt line (jump target), the typed command, exit code. */
export interface CommandBlock {
  /** the buffer line of the prompt-start (OSC 133;A) — the Cmd-Up/Down jump target. */
  line: number;
  /** the command text typed at this prompt (filled at output-start when known). */
  command?: string;
  /** the command's exit status (from OSC 133;D;<code>). */
  exitCode?: number;
}

/** A parsed OSC-133 marker: the shell-integration lifecycle point + (for D) the exit code. */
export interface Osc133Parsed {
  kind: "A" | "B" | "C" | "D";
  exitCode?: number;
}

/**
 * Parse an OSC-133 payload (the text AFTER `133;`). Handles the bare forms `A`/`B`/`C`/`D`,
 * the exit-carrying `D;0`, and extra `;`-params (`A;aid=…;cl=…`) by reading only field 0
 * (+ field 1 for D's numeric exit). Returns null for anything that is not an A/B/C/D marker.
 */
export function parseOsc133(payload: string): Osc133Parsed | null {
  if (!payload) return null;
  const parts = payload.split(";");
  const kind = parts[0];
  if (kind !== "A" && kind !== "B" && kind !== "C" && kind !== "D") return null;
  if (kind === "D") {
    const raw = parts[1];
    if (raw !== undefined && /^-?\d+$/.test(raw)) return { kind, exitCode: Number(raw) };
  }
  return { kind };
}

/** A block-reducer input event: a parsed marker + the buffer line it landed on (+ optional
 *  command text captured by the caller between B and C). */
export interface BlockMarker {
  kind: "A" | "B" | "C" | "D";
  line: number;
  exitCode?: number;
  command?: string;
}

/**
 * Fold one OSC-133 marker into the command-block list (PURE, immutable). `A` opens a new
 * block at its line; `C` fills the current block's command (when the caller read it from the
 * buffer); `D` closes it with the exit code; `B` is a no-op on the list (its region is the
 * caller's concern). A stray `C`/`D` before any `A` is ignored — a shell with no OSC-133
 * integration emits none, so the list simply stays empty (graceful degradation, AC5).
 */
export function reduceBlocks(blocks: readonly CommandBlock[], marker: BlockMarker): CommandBlock[] {
  switch (marker.kind) {
    case "A":
      return [...blocks, { line: marker.line }];
    case "B":
      return blocks as CommandBlock[];
    case "C": {
      if (blocks.length === 0 || marker.command === undefined) return blocks as CommandBlock[];
      const next = blocks.slice();
      next[next.length - 1] = { ...next[next.length - 1]!, command: marker.command };
      return next;
    }
    case "D": {
      if (blocks.length === 0) return blocks as CommandBlock[];
      const next = blocks.slice();
      next[next.length - 1] = {
        ...next[next.length - 1]!,
        ...(marker.exitCode !== undefined ? { exitCode: marker.exitCode } : {}),
      };
      return next;
    }
  }
}

/** One buffer row as read from xterm: its text + whether it is a soft-wrap continuation. */
export interface BufferRow {
  text: string;
  wrapped: boolean;
}

/** One reconstructed LOGICAL line: the joined text + the buffer row it starts on. */
export interface LogicalLine {
  text: string;
  startRow: number;
}

/**
 * Join xterm buffer rows into LOGICAL lines: a soft-wrapped row (`wrapped:true`) is a
 * continuation of the previous logical line, so a match that straddles the wrap boundary is
 * found as one string (a naive per-row search would split it). Each logical line remembers
 * its first buffer row so a match offset can be mapped back to a row for scrollTo.
 */
export function joinWrappedRows(rows: readonly BufferRow[]): LogicalLine[] {
  const out: LogicalLine[] = [];
  rows.forEach((row, i) => {
    if (row.wrapped && out.length > 0) {
      out[out.length - 1]!.text += row.text;
    } else {
      out.push({ text: row.text, startRow: i });
    }
  });
  return out;
}

/** A search hit: the logical-line index + the char span within that logical line. */
export interface SearchMatch {
  line: number;
  start: number;
  end: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

/**
 * Find every occurrence of `query` across `lines` (PURE — the buffer-walk fallback for when
 * `@xterm/addon-search` is absent). Literal by default (regex metacharacters escaped); `regex`
 * treats the query as a pattern; `wholeWord` anchors on word boundaries; `caseSensitive` drops
 * the `i` flag. An invalid regex yields NO matches (the caller shows the zero/warn state).
 */
export function searchLines(
  lines: readonly string[],
  query: string,
  opts: SearchOptions = {},
): SearchMatch[] {
  if (!query) return [];
  let re: RegExp;
  try {
    let pat = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (opts.wholeWord) pat = `\\b(?:${pat})\\b`;
    re = new RegExp(pat, opts.caseSensitive ? "g" : "gi");
  } catch {
    return []; // invalid regex → zero matches
  }
  const out: SearchMatch[] = [];
  lines.forEach((text, line) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      if (m[0] === "") {
        re.lastIndex += 1; // guard against a zero-width match spinning forever
      } else {
        out.push({ line, start: m.index, end: m.index + m[0].length });
      }
      m = re.exec(text);
    }
  });
  return out;
}

/**
 * The next active-match index when stepping `dir` (+1 next / −1 prev) through `count` matches,
 * WRAPPING at the ends. `current` −1 (no active match yet) seeds forward→first, back→last.
 * Returns −1 when there are no matches.
 */
export function stepMatch(count: number, current: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** The find-box readout: "0/0" with no matches (zero/warn state), else 1-based "index/count". */
export function matchReadout(activeIndex: number, count: number): string {
  if (count <= 0) return "0/0";
  return `${activeIndex + 1}/${count}`;
}

/**
 * The prompt block to jump to when stepping `dir` from the current viewport `topLine`. Blocks
 * are sorted by their `line`; Cmd-Down picks the first block BELOW the viewport top, Cmd-Up the
 * last block ABOVE it. Returns null when there is no block in that direction (a no-op jump).
 */
export function adjacentBlockLine(
  blocks: readonly CommandBlock[],
  topLine: number,
  dir: 1 | -1,
): number | null {
  const lines = blocks.map((b) => b.line).sort((a, b) => a - b);
  if (dir === 1) {
    const next = lines.find((l) => l > topLine);
    return next ?? null;
  }
  const prev = [...lines].reverse().find((l) => l < topLine);
  return prev ?? null;
}
