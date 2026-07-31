/**
 * tui/clipboard.ts — OSC 52 "set clipboard" escape sequence (CLI-068).
 *
 * OSC 52 lets the TERMINAL put text on the SYSTEM clipboard — so copy works over SSH/tmux where no
 * filesystem clipboard tool (pbcopy/xclip/clip.exe) is reachable. WRITE-ONLY by design (we never
 * build a read-back path — most emulators disable it for security). PURE string builder: the app
 * writes the returned sequence RAW to the tty (it moves no cursor, so it's frame-safe).
 *
 * Format: `ESC ] 52 ; c ; <base64> ST` where ST = `ESC \` (spec-correct; strict parsers + the tmux
 * wrapper require ST over BEL). `c` = the clipboard selection (not `p`/primary). Under tmux, the
 * whole thing is wrapped in a DCS passthrough `ESC P tmux; … ESC \` with EVERY inner ESC DOUBLED
 * (the #1 tmux OSC-52 failure — tmux truncates at the first un-doubled ESC).
 */

const ESC = "\x1b";
const ST = `${ESC}\\`; // string terminator

/** The classic xterm cap on the base64 payload; base64 inflates 4/3, so cap on the ENCODED length. */
export const OSC52_MAX_B64 = 74994;

export interface Osc52Result {
  /** the raw sequence to write, or null when nothing was emitted. */
  sequence: string | null;
  /** why nothing was emitted: empty text, or the payload exceeded the cap. */
  reason?: "empty" | "too-large";
}

/**
 * Build the OSC 52 clipboard-set sequence for `text`. Empty/whitespace text → no-op (`reason:
 * "empty"`, never `ESC]52;c;ESC\` which some terminals read as CLEAR). Over the base64 cap → no-op
 * (`reason: "too-large"`) rather than a truncated half-sequence. When `tmux`, the sequence is
 * DCS-wrapped with escape-doubling for tmux passthrough.
 */
export function osc52Sequence(text: string, opts: { tmux?: boolean } = {}): Osc52Result {
  if (text.trim() === "") return { sequence: null, reason: "empty" };
  // standard base64 alphabet, `=` padding, NO line wrapping (Node's default).
  const b64 = Buffer.from(text, "utf8").toString("base64");
  if (b64.length > OSC52_MAX_B64) return { sequence: null, reason: "too-large" };

  const inner = `${ESC}]52;c;${b64}${ST}`;
  if (!opts.tmux) return { sequence: inner };
  // tmux DCS passthrough: double EVERY ESC in the inner payload, then wrap. The wrapper's own ST is
  // separate from the inner sequence's ST.
  const doubled = inner.replace(new RegExp(ESC, "g"), `${ESC}${ESC}`);
  return { sequence: `${ESC}Ptmux;${doubled}${ST}` };
}

/** The newest assistant message's text from a chat history (CLI-068), or "" if none. */
export function lastAssistantReply(history: readonly { role: string; content: unknown }[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role === "assistant") {
      return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    }
  }
  return "";
}

/**
 * Copy `text` to the clipboard: build the OSC 52 sequence, write it RAW via `rawWrite` (bypassing
 * the chrome repaint — it moves no cursor), and return a human status line. Over-limit / empty are
 * reported rather than emitting garbage. OSC 52 gives no ack, so success is "sent" (best-effort).
 */
export function copyReplyStatus(
  text: string,
  tmux: boolean,
  rawWrite: (s: string) => void,
): string {
  const { sequence, reason } = osc52Sequence(text, { tmux });
  if (!sequence) {
    return reason === "too-large"
      ? "copy: reply too large for the OSC 52 clipboard"
      : "copy: nothing to copy";
  }
  rawWrite(sequence);
  return "📋 sent to terminal clipboard (OSC 52)";
}
