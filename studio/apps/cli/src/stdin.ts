/**
 * stdin.ts — read a piped/redirected prompt from stdin for a one-shot `prometheus chat` (CLI-083).
 *
 * Only fires when bin.ts detects a non-TTY stdin AND no positional message was given, so the two
 * stdin consumers (this read + the interactive readline confirm) never compete for the stream. The
 * read is bounded (a size cap enforced DURING the drain, not after) so a multi-GB pipe can't OOM.
 */

/** Default cap on a stdin-sourced prompt (bytes). Surfaced in the over-limit error. */
export const STDIN_PROMPT_CAP_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * Should `prometheus chat` read its prompt from stdin (CLI-083)? Only for `chat` with NO positional
 * message (a positional takes precedence — stdin is a fallback source), NOT the `--cli` terminal
 * path, and only when stdin is piped/redirected (`isTTY !== true` — it is `undefined` for a pipe,
 * not `false`, so `=== false` alone would miss it; mirrors bin.ts's `=== true` interactive gate).
 */
export function shouldReadStdinPrompt(
  command: readonly string[],
  positionals: readonly string[],
  flags: Record<string, unknown>,
  isTTY: boolean | undefined,
): boolean {
  return stdinPromptSink(command, positionals, flags, isTTY) !== null;
}

/** Where a stdin-sourced prompt has to be DELIVERED for the run to actually use it. */
export type StdinPromptSink =
  /** `chat` reads its message from `positionals[0]`. */
  | "positional"
  /** the headless one-shot reads its prompt from the `-p` flag's VALUE. */
  | "flag";

/**
 * Which sink should a piped prompt fill — or null when stdin is not the prompt source?
 *
 * `chat` was the only case this knew about, so the OTHER documented form silently did nothing:
 * `--help` line 74 advertises `cat task.md | prometheus -p` ("stdin is the prompt when none is
 * given"), but a bare `-p` parses as the BOOLEAN `true` rather than a string, `oneShotPrompt`
 * requires a non-empty string, and the run fell through to the help screen and exited 0 — the
 * piped task discarded, with a success code. Measured against the built binary.
 *
 * The two sinks are genuinely different destinations, which is why this reports which one rather
 * than just "yes": pushing a positional would not reach `oneShotPrompt`, and setting the flag
 * would not reach `chat`.
 */
export function stdinPromptSink(
  command: readonly string[],
  positionals: readonly string[],
  flags: Record<string, unknown>,
  isTTY: boolean | undefined,
): StdinPromptSink | null {
  // A real TTY means a human is typing; the interactive readline owns the stream.
  if (isTTY === true) return null;
  if (command[0] === "chat" && positionals.length === 0 && flags.cli === undefined) {
    return "positional";
  }
  // A BARE `-p` / `--print` / `--prompt`: present, but with no value of its own. A flag that
  // already carries a string is an explicit prompt and takes precedence — stdin is the fallback.
  const bareOneShot = ONE_SHOT_FLAGS.some((k) => flags[k] === true);
  const valued = ONE_SHOT_FLAGS.some((k) => typeof flags[k] === "string" && flags[k] !== "");
  if (bareOneShot && !valued && positionals.length === 0 && flags.cli === undefined) {
    return "flag";
  }
  return null;
}

/** The flags `session/one-shot.ts`'s `oneShotPrompt` reads, in its order. */
const ONE_SHOT_FLAGS = ["p", "print", "prompt"] as const;

/** The outcome of a stdin-prompt read: the trimmed-non-empty prompt, or a clear error string. */
export interface StdinPromptResult {
  text?: string;
  error?: string;
}

/**
 * Drain stdin (or an injected async source) to EOF as the prompt text. Enforces `capBytes` mid-read
 * (aborting once exceeded), decodes UTF-8, strips a leading BOM, and treats an empty / whitespace-
 * only payload as "no prompt provided". Never throws — an I/O error becomes a `{error}` result.
 */
export async function readStdinPrompt(
  stream: AsyncIterable<Buffer | Uint8Array | string> = process.stdin,
  capBytes: number = STDIN_PROMPT_CAP_BYTES,
): Promise<StdinPromptResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      total += buf.length;
      if (total > capBytes) {
        const mb = Math.floor(capBytes / (1024 * 1024));
        return {
          error: `stdin prompt exceeds the ${mb} MiB limit — pass it as an argument instead`,
        };
      }
      chunks.push(buf);
    }
  } catch (e) {
    return { error: `could not read stdin: ${e instanceof Error ? e.message : String(e)}` };
  }
  let text = Buffer.concat(chunks).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip a leading UTF-8 BOM
  if (text.trim().length === 0) {
    return { error: "no prompt provided (stdin was empty)" };
  }
  return { text };
}
