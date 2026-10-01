// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/exec-stream.ts — turn raw child-process chunks into whole lines for the terminal.
 *
 * A `data` event is a CHUNK, not a line: it can split a line in half, carry three of them, or
 * arrive as a single byte. Writing chunks straight to the TUI produces two visible problems —
 * half-lines appear as their own rows, and the write rate fights the 120ms spinner for the
 * parked row (`redraw.ts`'s `printAbove` vs `transient`).
 *
 * So: buffer, emit only complete lines, and flush the remainder when the stream ends. Same
 * discipline as engine-bridge's `pumpLines`, which exists for exactly this reason.
 */

/**
 * Strip ANSI escape sequences.
 *
 * A streamed command's own colour codes are not just cosmetic noise here — a stray cursor-move
 * or erase-line sequence would repaint the surrounding TUI chrome, because this output goes
 * through `printAbove` into the same terminal the renderer is driving.
 */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export interface StreamSink {
  (chunk: string): void;
  /** Emit any trailing partial line (a final line that arrived without a newline). */
  flush(): void;
}

/**
 * Build a chunk sink that calls `onLine` once per complete line.
 *
 * Blank lines are dropped: a build log's vertical spacing is noise once every line carries a
 * `⎿` prefix, and every line not written is one less repaint racing the spinner.
 */
export function makeStreamSink(onLine: (line: string) => void): StreamSink {
  let buf = "";
  const sink = ((chunk: string): void => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "").replace(ANSI, "");
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line.trim()) onLine(line);
    }
  }) as StreamSink;
  sink.flush = (): void => {
    const rest = buf.replace(ANSI, "").trim();
    buf = "";
    if (rest) onLine(rest);
  };
  return sink;
}
