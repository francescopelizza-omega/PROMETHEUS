// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
import { ModelIdlePausedError, ai, createAiClient } from "@prometheus/core";
import type { AgentTuning, LLMClient, LlmTurn, Thread } from "@prometheus/core/agent-loop";
import type { PreambleCtx, ScanEvent, TextToolCall } from "@prometheus/core/agent-protocol";
import {
  CORE_ROUND_CONTRIBUTORS,
  CORE_TURN_CONTRIBUTORS,
  ToolCallScanner,
  assemblePreamble,
  instructionBudget,
} from "@prometheus/core/agent-protocol";
import type { ToolDef } from "@prometheus/core/agent-tools";
import type { EffortResolution } from "@prometheus/core/ai-effort";

import {
  createReasoningTagSplitter,
  resolveCapability,
  resolveEffort,
  runtimeFromBaseUrl,
} from "@prometheus/core/ai-effort";
import { firstServedModel } from "./model-discovery.js";

/** An OpenAI-shaped message, matching core's `Msg`. */
interface WireMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * Resolve an endpoint's `apiKeyRef` for this host.
 *
 * `env:NAME` is the form the setting's own description leads with and the only one a VS Code
 * window can satisfy without a keychain prompt, so it is the form supported here; anything else
 * fails with a message that NAMES what is supported instead of the opaque "no key resolver".
 */
async function resolveApiKeyRef(ref: string): Promise<string> {
  const parsed = ai.parseKeyRef(ref);
  if (!parsed) throw new Error(`unrecognised api key reference "${ref}"`);
  if (parsed.kind !== "env") {
    throw new Error(
      `\`prometheus.apiKeyRef\` supports \`env:NAME\` in VS Code; got "${ref}". Export the key as an environment variable and reference it as env:NAME.`,
    );
  }
  const val = process.env[parsed.envVar];
  if (!val) {
    throw new Error(
      `\`prometheus.apiKeyRef\` is set to "${ref}" but the environment variable ` +
        `${parsed.envVar} is empty in this VS Code process.`,
    );
  }
  return val;
}

export interface EndpointLlmOptions {
  endpoint: AiEndpoint;
  policy?: WorkspacePolicy;
  signal?: AbortSignal;
  /**
   * The CURRENT turn's abort signal, read fresh on every turn.
   *
   * `signal` is fixed at construction, and this client is constructed once per session rebuild —
   * so nothing could ever supply the per-turn signal that "Cancel Current Turn" trips. The
   * result was a Cancel that did not stop generation: tokens kept arriving until the round
   * finished on its own, and the fetch was never aborted.
   */
  getSignal?: () => AbortSignal | undefined;
  /** Injected for tests; defaults to the platform fetch. */
  fetch?: typeof globalThis.fetch;
  /** this client's inactivity-pause threshold — see `@prometheus/core`'s `agent/idle-watchdog`.
   *  Undefined ⇒ `DEFAULT_IDLE_TIMEOUT_MS` (10 min). No settings UI surfaces this yet (unlike
   *  the CLI's `/timeout` and Desktop's settings field) — this host simply inherits the shared
   *  client's default rather than going completely unprotected as it did before this option
   *  existed. */
  idleTimeoutMs?: number;
  /** test-only clock injection for the idle watchdog, mirroring the CLI's identical fields. */
  idleWatchdogNow?: () => number;
  idleWatchdogSetTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  idleWatchdogClearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * Bring Ollama up before the first request if it's merely stopped — mirrors the desktop's
   * `ai-ipc.ts` seam exactly, INCLUDING why it's opt-in rather than defaulted to the real
   * `ai.ensureOllamaRunning`: this file's tests drive a mocked `fetch` with exact-call-count
   * assertions, and a default-on probe would both miscount calls and, the moment the mocked
   * probe reads as "unreachable", fall through to REAL `canStart`/`listenersOnPort`/
   * `startModelServer` shell-outs from inside a unit test. `extension.ts`'s real activation
   * path passes `ai.ensureOllamaRunning` explicitly; tests simply omit it.
   */
  ensureOllamaRunningFn?: typeof ai.ensureOllamaRunning;
  /** LM Studio's twin of `ensureOllamaRunningFn` above — same opt-in reasoning, same real
   *  activation-path wiring (`ai.ensureLmStudioRunning`). */
  ensureLmStudioRunningFn?: typeof ai.ensureLmStudioRunning;
  /** mirrors `AiClientDeps.onLocalActivity` — feeds the idle-shutdown watchdog's clock. */
  onLocalActivity?: () => void;
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
  /**
   * The endpoint's model id, resolved at FIRST USE.
   *
   * `prometheus.model` ships empty on purpose: the old default was the literal
   * `prometheus-local`, a model nothing in this repo ever creates, so a user's first message
   * came back `HTTP 404 … model 'prometheus-local' not found`. Any other hardcoded tag is just as
   * absent on someone else's machine, so the id is DISCOVERED from the endpoint — and discovered
   * HERE rather than during activation, because activation must not await a network probe.
   *
   * Memoised: one probe per client, and the client is rebuilt whenever the settings change.
   */
  let resolving:
    | Promise<{ endpoint: AiEndpoint; client: ReturnType<typeof createAiClient> }>
    | undefined;
  const fetchImpl = (opts.fetch ?? globalThis.fetch) as typeof globalThis.fetch;
  const resolveClient = (): Promise<{
    endpoint: AiEndpoint;
    client: ReturnType<typeof createAiClient>;
  }> => {
    resolving ??= (async () => {
      let endpoint = opts.endpoint;
      // Runner-specific and opt-in — see `EndpointLlmOptions.ensureOllamaRunningFn`'s doc.
      // Runs once per client (this whole block is memoised via `resolving`), never per turn.
      // Dispatched by the endpoint's OWN runner id so an LM Studio endpoint never has Ollama
      // started underneath it, or vice versa — an unmatched/other-runner endpoint gets neither.
      //
      // LOCAL ONLY. `runnerForBaseUrl` now refuses a non-loopback host itself, but the guard is
      // repeated here because this is the seam that SPAWNS a process: pointing the editor at a
      // beefier LAN box (`http://192.168.1.50:11434/v1`) is a first-class use of a local-first
      // product, and it must never start `ollama serve` plus a detached watchdog on the laptop
      // for a request bound elsewhere. Locality is derived from the URL rather than read off
      // `endpoint.locality`, so a caller-supplied field can never widen the gate — the same
      // discipline as ai-ipc.ts's `localityOfUrl(req.endpoint.baseUrl)`.
      const endpointRunnerId = ai.isLocalUrl(endpoint.baseUrl)
        ? ai.runnerForBaseUrl(endpoint.baseUrl)?.id
        : undefined;
      const ensureRunnerRunningFn =
        endpointRunnerId === "ollama"
          ? opts.ensureOllamaRunningFn
          : endpointRunnerId === "lmstudio"
            ? opts.ensureLmStudioRunningFn
            : undefined;
      if (ensureRunnerRunningFn) {
        const ensured = await ensureRunnerRunningFn({
          ...(endpoint.model?.trim() ? { modelId: endpoint.model } : {}),
          fetchFn: fetchImpl,
        });
        // The machine-wide launch guard refused the cold start, so the runner is deliberately
        // still down. The desktop pauses the turn on exactly this (ai-ipc.ts's
        // `pausedReason: "resources-critical"`); dropping the reason here let the request go out
        // to a dead endpoint and reported it as "no model found … start a local runner" — the one
        // thing the user must NOT do while the machine is at its memory ceiling.
        if (ensured.reason === "resource-ceiling") {
          // Transient by nature, so drop the memo: otherwise `resolving` stays a REJECTED promise
          // for this client's whole life and "free memory and try again" is unactionable until a
          // settings change happens to rebuild the client.
          resolving = undefined;
          const why = ensured.resourceReason ? ` (${ensured.resourceReason})` : "";
          throw new Error(
            `Not starting the local model server: this machine is at its resource ceiling${why}. Free memory and send the message again.`,
          );
        }
      }
      if (!endpoint.model?.trim()) {
        const found = await firstServedModel(endpoint.baseUrl, fetchImpl);
        if (!found) {
          throw new Error(
            `No model found at ${endpoint.baseUrl}. Start a local runner (e.g. \`ollama serve\` with a model pulled), or set \`prometheus.model\` and \`prometheus.baseUrl\` in Settings.`,
          );
        }
        endpoint = { ...endpoint, id: `vscode:${found}`, model: found };
      }
      return {
        endpoint,
        client: createAiClient(endpoint, policy, {
          ...(opts.fetch ? { fetch: opts.fetch as never } : {}),
          // `prometheus.apiKeyRef` is a CONTRIBUTED setting (package.json) and `extension.ts`
          // puts it on the endpoint — but no key resolver was ever passed here, so the moment a
          // user filled it in, every turn threw "no key resolver; cannot resolve apiKeyRef"
          // before a single request left the machine. Measured: with the setting empty a turn
          // answers; with `env:MY_KEY` it throws even when MY_KEY is exported.
          resolveKey: resolveApiKeyRef,
          ...(opts.onLocalActivity ? { onLocalActivity: opts.onLocalActivity } : {}),
        }),
      };
    })();
    return resolving;
  };
  // Set once this endpoint has produced at least one correctly-read `<tool_call>` — see
  // `withPreamble`'s `demonstrated` param. Monotonic across the whole client's lifetime (one
  // session), same as the CLI's and desktop pane's `ToolCapabilityState.textSyntaxCalls`; this
  // host has no native transport to negotiate, so a single flag is all the state it needs.
  let demonstrated = false;
  // The endpoint's effort CAPABILITY is fixed for the client's lifetime (a property of the
  // model+runtime, not of any one turn) — resolved once here, mirroring the CLI's
  // `makeLlmClient`. Before this, `turn()`'s own `tuning` parameter was unused entirely: VS Code
  // never sent an effort tier as a request parameter AND `effort-text` (the textual fallback)
  // was permanently dead code, regardless of what tier the user asked for.
  // Resolved from the endpoint the client ACTUALLY uses, so a discovered model id keys the
  // effort rules rather than the empty string the settings held.
  const capabilityFor = (endpoint: AiEndpoint) =>
    resolveCapability({
      modelId: endpoint.model ?? endpoint.id,
      runtime: runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality),
      locality: endpoint.locality,
      probedCapabilities: endpoint.probedCapabilities,
    }).cap;

  return {
    async *turn(thread: Thread, tuning: AgentTuning, tools: ToolDef[]): AsyncIterable<LlmTurn> {
      const { endpoint, client } = await resolveClient();
      const capability = capabilityFor(endpoint);
      const effort = tuning.effort ? resolveEffort(tuning.effort, capability) : undefined;
      const messages: WireMsg[] = thread.messages.map((m) => ({
        // An unpaired OpenAI `role:"tool"` message is rejected outright by strict endpoints,
        // and core's thread is full of them (that is how tool results re-enter). They carry
        // their own `[tool_result …]` header, so as a user turn they still read correctly.
        role: m.role === "tool" ? "user" : m.role,
        content: m.content,
      }));
      const outgoing = withPreamble(
        messages,
        tools,
        endpoint.locality,
        endpoint.contextWindow,
        demonstrated,
        effort,
      );

      const scanner = new ToolCallScanner();
      /**
       * Strip an R1-style model's inline `<think>…</think>` before the scanner sees it.
       *
       * This host has no separate thinking channel, so the deliberation is DROPPED rather than
       * routed — the right trade here: a dropped thought costs the user nothing they had
       * before, while leaking it prefixes every answer with paragraphs of deliberation AND
       * feeds that deliberation to the tool-call scanner below, where a model reasoning aloud
       * about a call could trip the text protocol into making one.
       *
       * A no-op pass-through when the capability names no tag.
       */
      const reasoningSplit = createReasoningTagSplitter(capability.reasoningTag);
      /** Flush the splitter's tail into the scanner at end of stream. */
      const drainReasoningTail = function* (): Generator<LlmTurn> {
        const tail = reasoningSplit.end();
        if (tail.text) yield* drain(scanner.push(tail.text));
      };
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

      try {
        // the LIVE turn's signal wins; `opts.signal` stays supported for a fixed-signal caller
        const turnSignal = opts.getSignal?.() ?? opts.signal;
        for await (const chunk of client.chat(outgoing as never, {
          ...(turnSignal ? { signal: turnSignal } : {}),
          ...(effort ? { effort } : {}),
          ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
          ...(opts.idleWatchdogNow ? { idleWatchdogNow: opts.idleWatchdogNow } : {}),
          ...(opts.idleWatchdogSetTimeout
            ? { idleWatchdogSetTimeout: opts.idleWatchdogSetTimeout }
            : {}),
          ...(opts.idleWatchdogClearTimeout
            ? { idleWatchdogClearTimeout: opts.idleWatchdogClearTimeout }
            : {}),
        })) {
          // Scanned rather than yielded raw: the scanner both extracts the calls AND keeps the
          // `<tool_call>` markup out of the transcript, so the user reads prose instead of
          // protocol.
          if (chunk.delta) {
            const split = reasoningSplit.push(chunk.delta);
            if (split.text) yield* drain(scanner.push(split.text));
          }
        }
      } catch (err) {
        /**
         * A transport failure must say WHERE it failed and what to do.
         *
         * Node's fetch rejects with the bare string "fetch failed" for every network-level
         * problem — nothing running on the port, DNS, TLS, a refused connection. That is what
         * the user saw in the chat panel: two words, no URL, no next step. It is also the
         * commonest first-run failure, because the default endpoint is a local runner that may
         * simply not be started.
         */
        if (
          err instanceof Error &&
          !(err instanceof ModelIdlePausedError) &&
          /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket hang up/i.test(err.message)
        ) {
          throw new Error(
            `cannot reach the model endpoint at ${endpoint.baseUrl} (${err.message}). Start the local runner (e.g. \`ollama serve\`), or change \`prometheus.baseUrl\` in Settings.`,
            { cause: err },
          );
        }
        if (!(err instanceof ModelIdlePausedError)) throw err;
        // The shared client's own idle watchdog (`ai/client.ts`) paused a silent request — this
        // host had NO inactivity protection at all before that watchdog existed, so a cold-
        // loading or wedged local model hung the extension forever. A pause, not a failure:
        // whatever prose already streamed above is already in the caller's thread.
        yield* drainReasoningTail();
        yield* drain(scanner.end());
        if (calls.length > 0) demonstrated = true;
        for (const call of calls)
          yield { kind: "tool_call", call: { name: call.name, args: call.args } };
        yield { kind: "paused", idleMs: err.idleMs };
        return;
      }
      yield* drainReasoningTail();
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
 * Merge the preamble dispatch pipeline's output into the OUTGOING system message only.
 *
 * Outgoing-only because the assembled text is derived from the exposed tool set and the
 * endpoint's own capability — persisting it into the thread would freeze one turn's tool list
 * and effort tier into the conversation forever. This host has no separate turn-scope assembly
 * point (there is no per-turn `runMessageTurn`-equivalent here, unlike the CLI) and always uses
 * the TEXT transport (see this file's header) — so both the once-per-turn contributors
 * (tool-discipline, pre-write-recheck, effort-text) and the round-scope one (tool-catalog) are
 * assembled together here, every round, exactly as the desktop pane's own `withPreamble` does.
 */
function withPreamble(
  messages: WireMsg[],
  tools: ToolDef[],
  locality: "local" | "cloud",
  contextWindow?: number,
  demonstrated?: boolean,
  effort?: EffortResolution,
): WireMsg[] {
  if (tools.length === 0) return messages;
  const ctx: PreambleCtx = {
    surface: "vscode",
    isSubAgent: false,
    readOnly: false,
    locality,
    ...(contextWindow ? { contextWindow } : {}),
    transport: "text",
    ...(demonstrated ? { demonstratedToolSyntax: demonstrated } : {}),
    // Without these, `effort-text` was dead code here — see `turn()`'s own comment.
    ...(effort ? { effortTier: effort.requested, effortMechanism: effort.mechanism } : {}),
    tools,
  };
  const assembled = assemblePreamble(
    [...CORE_TURN_CONTRIBUTORS, ...CORE_ROUND_CONTRIBUTORS],
    ctx,
    instructionBudget(contextWindow),
  );
  if (!assembled.personaAppend) return messages;
  const at = messages.findIndex((m) => m.role === "system");
  if (at === -1) return [{ role: "system", content: assembled.personaAppend }, ...messages];
  const base = (messages[at]?.content ?? "").trim();
  const merged = base ? `${base}\n\n${assembled.personaAppend}` : assembled.personaAppend;
  return messages.map((m, i) => (i === at ? { ...m, content: merged } : m));
}
