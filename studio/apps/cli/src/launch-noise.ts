/**
 * launch-noise.ts — wipe the launcher's rebuild log the moment the CLI first draws.
 *
 * When the sources are newer than the bundle, `bin/prometheus` rebuilds it first and streams
 * the pnpm/tsc/esbuild log to the terminal — useful while it runs, noise once Prometheus is up:
 * the TUI paints inline (no alternate screen), so the whole log sat above the session for good.
 *
 * The launcher counts the terminal ROWS that log occupied and hands the number over in
 * PROMETHEUS_LAUNCH_ERASE_ROWS, only after a SUCCESSFUL rebuild (a failed one stays on screen:
 * it is the only record of why). Here the erase is deferred to the first write that would put
 * something visible on the terminal — the TUI's banner, the readline host's banner, or any
 * startup warning that happens to come first. Erasing exactly then is what makes the row count
 * safe: nothing can have been printed between the log and the erase, so "the N rows directly
 * above the cursor" are always precisely the log, never a warning or the user's own prompt.
 *
 * The variable is removed from the environment at once, so no child process (a tmux window,
 * a nested `prometheus`) ever erases a second time.
 */

export const LAUNCH_ERASE_ENV = "PROMETHEUS_LAUNCH_ERASE_ROWS";

/** The slice of a writable stream this needs (process.stdout / process.stderr, or a fake). */
export interface NoiseStream {
  isTTY?: boolean;
  // method syntax on purpose: process.stdout's overloaded write must be assignable here
  write(chunk: unknown, ...rest: unknown[]): boolean;
}

// CSI (incl. private modes), OSC (BEL- or ST-terminated), and two-byte ESC sequences: none of
// them put a character on screen.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Would writing `chunk` put anything on screen (a glyph or a new row)? */
export function isVisibleChunk(chunk: unknown): boolean {
  const text =
    typeof chunk === "string"
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk).toString("utf8")
        : "";
  return text.replace(ESCAPES, "").replace(/\r/g, "").length > 0;
}

/** `rows` up, to column 0, erase to the end of the screen. The rows are the launcher's log. */
export function eraseSequence(rows: number): string {
  return `\x1b[${rows}A\r\x1b[0J`;
}

/**
 * Arm the one-shot erase. Returns a disarm function (tests, and callers that want to drop the
 * erase without doing it). A no-op when the launcher asked for nothing, or when neither stream
 * is a terminal (the log was never on screen, or the output is being captured).
 */
export function armLaunchNoiseErase(
  env: NodeJS.ProcessEnv = process.env,
  streams: readonly NoiseStream[] = [process.stdout, process.stderr],
): () => void {
  const raw = env[LAUNCH_ERASE_ENV];
  // `delete`, not `= undefined`: node would put the STRING "undefined" in a child's env.
  delete env[LAUNCH_ERASE_ENV];
  const rows = Number.parseInt(raw ?? "", 10);
  const ttys = streams.filter((s) => s.isTTY === true);
  if (!Number.isFinite(rows) || rows <= 0 || ttys.length === 0) return () => {};

  const originals = new Map<NoiseStream, NoiseStream["write"]>();
  let armed = true;
  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    for (const [s, w] of originals) s.write = w;
  };
  for (const s of ttys) {
    const original = s.write;
    originals.set(s, original);
    s.write = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
      if (armed && isVisibleChunk(chunk)) {
        disarm();
        original.call(s, eraseSequence(rows));
      }
      return original.call(this ?? s, chunk, ...rest);
    };
  }
  return disarm;
}
