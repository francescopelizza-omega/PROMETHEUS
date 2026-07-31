/**
 * stdin.ts — read a piped/redirected prompt from stdin for a one-shot `prom chat` (CLI-083).
 *
 * Only fires when bin.ts detects a non-TTY stdin AND no positional message was given, so the two
 * stdin consumers (this read + the interactive readline confirm) never compete for the stream. The
 * read is bounded (a size cap enforced DURING the drain, not after) so a multi-GB pipe can't OOM.
 */

/** Default cap on a stdin-sourced prompt (bytes). Surfaced in the over-limit error. */
export const STDIN_PROMPT_CAP_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * Should `prom chat` read its prompt from stdin (CLI-083)? Only for `chat` with NO positional
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
  return (
    command[0] === "chat" && positionals.length === 0 && flags.cli === undefined && isTTY !== true
  );
}

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
