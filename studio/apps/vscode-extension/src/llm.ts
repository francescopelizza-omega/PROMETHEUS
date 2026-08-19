/**
 * llm.ts — the `LLMClient` seam core's `runAgentTurn` asks for, for the VS Code host.
 *
 * The direct analogue of the desktop pane's `createRendererLlmClient`: core owns the `Thread`
 * and hands it back with the exposed `ToolDef`s; this adapts an OpenAI-compatible endpoint to
 * the `LlmTurn` event stream the loop consumes.
 *
 * TRANSPORT: core's TEXT protocol, not native `tools:[…]`.
 *
 * Core defines two ways for tools to reach a model (`agent/protocol`): NATIVE, which puts a
 * `tools` array in the request body and reads `delta.tool_calls` off the SSE, and TEXT, which
 * teaches the call syntax in a system preamble and scans the model's prose back out with
 * `ToolCallScanner`. This host uses TEXT, deliberately:
 *
 *   - The reusable transport in `@prometheus/core` (`createAiClient`) has no `tools` field on
 *     `ChatOpts` at all — the native path lives in `apps/cli/src/session/agent-runtime.ts`'s
 *     `toolTurn`, which is CLI application code, not a library this extension can import.
 *     Copying it here would fork it, and a forked tool-call transport that drifts is precisely
 *     the failure the desktop pane's header documents at length.
 *   - TEXT is the transport that works on the widest set of endpoints, which for a local-first
 *     product is most of them. It is not a degraded fallback here; it is core's own protocol,
 *     driven through core's own scanner and preamble renderer.
 *
 * Lifting `toolTurn` into core so all three hosts share ONE native transport is the right
 * follow-up, and it is a core refactor rather than an extension feature — see README.md.
 */

import type { AiEndpoint, WorkspacePolicy } from "@prometheus/core";
import { createAiClient } from "@prometheus/core";
import type { AgentTuning, LLMClient, LlmTurn, Thread } from "@prometheus/core/agent-loop";
import type { ScanEvent, TextToolCall } from "@prometheus/core/agent-protocol";
import {
  ToolCallScanner,
  preambleModeFor,
  renderToolPreamble,
  withToolPreamble,
} from "@prometheus/core/agent-protocol";
import type { ToolDef } from "@prometheus/core/agent-tools";

/** An OpenAI-shaped message, matching core's `Msg`. */
interface WireMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface EndpointLlmOptions {
  endpoint: AiEndpoint;
  policy?: WorkspacePolicy;
  signal?: AbortSignal;
  /** Injected for tests; defaults to the platform fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Adapt an endpoint to core's `LLMClient`.
 *
 * The contract that matters: a turn which produced tool calls yields `tool_call` events and NO
 * `final`, because `final` ENDS the turn and core would never run the tools. A turn with no
 * tool call yields `final`, which is what stops a text-only model looping forever.
 */
export function createEndpointLlmClient(opts: EndpointLlmOptions): LLMClient {
  const policy: WorkspacePolicy = opts.policy ?? { neverSendToCloud: false };
  const client = createAiClient(
    opts.endpoint,
    policy,
    opts.fetch ? { fetch: opts.fetch as never } : {},
  );
  // Set once this endpoint has produced at least one correctly-read `<tool_call>` — see
  // `withPreamble`'s `demonstrated` param. Monotonic across the whole client's lifetime (one
  // session), same as the CLI's and desktop pane's `ToolCapabilityState.textSyntaxCalls`; this
  // host has no native transport to negotiate, so a single flag is all the state it needs.
  let demonstrated = false;

  return {
    async *turn(thread: Thread, _tuning: AgentTuning, tools: ToolDef[]): AsyncIterable<LlmTurn> {
      const messages: WireMsg[] = thread.messages.map((m) => ({
        // An unpaired OpenAI `role:"tool"` message is rejected outright by strict endpoints,
        // and core's thread is full of them (that is how tool results re-enter). They carry
        // their own `[tool_result …]` header, so as a user turn they still read correctly.
        role: m.role === "tool" ? "user" : m.role,
        content: m.content,
      }));
      const outgoing = withPreamble(messages, tools, opts.endpoint.contextWindow, demonstrated);

      const scanner = new ToolCallScanner();
      const calls: TextToolCall[] = [];
      const drain = function* (events: ScanEvent[]): Generator<LlmTurn> {
        for (const ev of events) {
          if (ev.kind === "text") {
            if (ev.text) yield { kind: "text", text: ev.text };
          } else if (ev.kind === "call") {
            calls.push(ev.call);
          }
        }
      };

      for await (const chunk of client.chat(outgoing as never, {
        ...(opts.signal ? { signal: opts.signal } : {}),
      })) {
        // Scanned rather than yielded raw: the scanner both extracts the calls AND keeps the
        // `<tool_call>` markup out of the transcript, so the user reads prose instead of
        // protocol.
        if (chunk.delta) yield* drain(scanner.push(chunk.delta));
      }
      yield* drain(scanner.end());

      if (calls.length > 0) demonstrated = true;
      for (const call of calls)
        yield { kind: "tool_call", call: { name: call.name, args: call.args } };
      // No call ⇒ the model answered. `final` carries no text: it already streamed above, and
      // repeating it would duplicate the answer in the thread.
      if (calls.length === 0) yield { kind: "final" };
    },
  };
}

/**
 * Merge the tool preamble into the OUTGOING system message only.
 *
 * Outgoing-only because the preamble is derived from the exposed tool set — persisting it into
 * the thread would freeze one turn's tool list into the conversation forever. The measured
 * context window sizes the budget; without it the budget is the one sized for an 8192 window,
 * which drops every tool DESCRIPTION from the listing and leaves the model guessing at schemas.
 */
function withPreamble(
  messages: WireMsg[],
  tools: ToolDef[],
  contextWindow?: number,
  demonstrated?: boolean,
): WireMsg[] {
  if (tools.length === 0) return messages;
  const opts = {
    mode: preambleModeFor("text"),
    ...(contextWindow ? { contextWindow } : {}),
    ...(demonstrated ? { demonstrated } : {}),
  };
  const at = messages.findIndex((m) => m.role === "system");
  if (at === -1) {
    const { text } = renderToolPreamble(tools, opts);
    return [{ role: "system", content: text }, ...messages];
  }
  const { prompt } = withToolPreamble(messages[at]?.content ?? "", tools, opts);
  return messages.map((m, i) => (i === at ? { ...m, content: prompt } : m));
}
