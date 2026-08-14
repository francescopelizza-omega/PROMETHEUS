/**
 * agent/protocol/feedback.ts — telling a model its call was unreadable, in a way it can act on.
 *
 * A transport that reads calls out of TEXT will sometimes get text that was clearly meant to
 * be a call and cannot be read as one: truncated JSON, a missing name, a reply that was
 * nothing but protocol residue. Dropping those silently is the worst option — a small model
 * repeats the identical broken syntax until the round cap, because nothing ever told it
 * anything was wrong.
 *
 * The first attempt at this rode the loop's "tool is not exposed" branch, by emitting a call
 * to a pseudo-tool named `malformed_tool_call`. That did deliver a message, but the WRONG
 * one: the loop replaced the diagnosis with `tool "malformed_tool_call" is not exposed`, so
 * the model learned that it had called a tool that does not exist — and the actual reason,
 * which is the entire point, was thrown away. It also invited the model to believe
 * `malformed_tool_call` was something it had chosen to call.
 *
 * So the loop recognises this name explicitly and renders the reason verbatim, plus a
 * restatement of the correct syntax. PURE.
 */

/**
 * The reserved call name a transport uses to report an unreadable call.
 *
 * Not a tool: nothing dispatches it, and it is never in any catalog or preamble. It is the
 * one name the loop treats as "this is the transport talking, not the model".
 */
export const PROTOCOL_FEEDBACK_TOOL = "malformed_tool_call";

/** Args the transport attaches: why it could not be read, and what was actually written. */
export interface ProtocolFeedbackArgs {
  reason?: unknown;
  wrote?: unknown;
}

/** The canonical syntax, repeated in the correction because that is what needs to change. */
const RESEND =
  'Re-send it exactly as: <tool_call>{"name":"TOOL","arguments":{…}}</tool_call> ' +
  "— one line, valid JSON, nothing after it.";

/**
 * Render the `{role:"tool"}` message the model reads.
 *
 * The echo of what it wrote is capped hard: a truncated 8KB `write_file` payload would
 * otherwise be quoted back in full, and the correction would be buried in the thing being
 * corrected.
 */
export function protocolFeedbackMessage(args: ProtocolFeedbackArgs): string {
  const reason =
    typeof args.reason === "string" && args.reason.trim()
      ? args.reason.trim()
      : "your last message could not be read as a tool call";
  const lines = ["[protocol error]", reason];
  if (typeof args.wrote === "string" && args.wrote.trim()) {
    const wrote = args.wrote.trim();
    lines.push(`you wrote: ${wrote.length > 200 ? `${wrote.slice(0, 200)}…` : wrote}`);
  }
  lines.push(RESEND);
  return lines.join("\n");
}
