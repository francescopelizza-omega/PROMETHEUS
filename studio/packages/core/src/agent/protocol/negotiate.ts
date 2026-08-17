/**
 * agent/protocol/negotiate.ts — decide HOW a given model is asked to call tools, and learn.
 *
 * The state of things before this: `AiEndpoint.supportsTools` is a static boolean set at
 * construction by guessing. `connectors/localServe.ts` defaults it TRUE for every local
 * runner, `session/onboarding.ts` hard-codes TRUE for local runners with the comment "local
 * OpenAI-compatible runners expose native tool_calls", and `orchestration/backends.ts`
 * hard-codes FALSE for own-key cloud. None of that is measured. And it was a CLIFF: the CLI
 * read it once (`tools.length > 0 && endpoint.supportsTools`) and, if false, handed the model
 * an empty tool list forever. A wrong guess did not degrade — it removed the agent.
 *
 * Both guesses are wrong in practice, in opposite directions. A GGUF served by a llama.cpp
 * build without `--jinja`, or an Ollama model whose Modelfile carries no `.Tools` block,
 * answers a `tools:[…]` request with prose or a 400 — yet is marked capable. Meanwhile a
 * cloud model that function-calls perfectly is marked incapable.
 *
 * So capability is TREATED AS A HYPOTHESIS. The declared flag picks the opening move; what
 * the endpoint actually does decides the next one. Two observations are decisive:
 *
 *   1. the request was REJECTED for carrying tools  → native is impossible here, use text;
 *   2. tools were offered natively and the model replied with TEXT-protocol calls instead
 *      → the model can call tools, it just cannot do it the native way, so stop pretending.
 *
 * And regardless of transport, the response text is ALWAYS scanned for text-protocol calls.
 * That backstop is not redundancy for its own sake: emitting `<tool_call>` prose while a
 * perfectly good native channel sits unused is the single most common failure of small local
 * models, and dropping those calls is indistinguishable, to the user, from the model refusing
 * to work.
 *
 * PURE: a reducer and two predicates. The host owns the store.
 */

/** What goes on the wire for one turn. */
export type ToolTransport =
  /** send `tools:[…]`; read native `tool_calls`; still scan text as a backstop. */
  | "native"
  /** send no `tools`; teach the protocol in the preamble; read calls out of the text. */
  | "text"
  /** no tools are exposed at all — a plain chat turn. */
  | "none";

/** What this endpoint has been observed to actually do. Accumulated across a session. */
export interface ToolCapabilityState {
  /** the endpoint returned an error that names tools as the reason. */
  nativeRejected: boolean;
  /** turns where native `tool_calls` frames actually arrived. */
  nativeCalls: number;
  /** turns where tools were offered natively but the calls came back as TEXT. */
  textCallsWhileNative: number;
}

/** A fresh, unopinionated state — everything still to be learned. */
export function initialCapability(): ToolCapabilityState {
  return { nativeRejected: false, nativeCalls: 0, textCallsWhileNative: 0 };
}

/**
 * How many text-instead-of-native turns it takes to give up on native.
 *
 * One is too eager: a model can emit a stray `<tool_call>` in prose while function-calling
 * correctly, and demoting on that would cost the better channel for the rest of the session.
 * Two consecutive is a habit, not an accident.
 */
export const TEXT_FALLBACK_THRESHOLD = 2;

export interface NegotiationInput {
  /** how many tools the policy exposes this turn. */
  toolCount: number;
  /** the endpoint's DECLARED capability (`AiEndpoint.supportsTools`) — an opening guess. */
  declaredNative: boolean;
  /** what has actually been observed on this endpoint so far. */
  observed?: ToolCapabilityState;
}

/** Pick the transport for one turn. */
export function negotiateTransport(input: NegotiationInput): ToolTransport {
  if (input.toolCount <= 0) return "none";
  const o = input.observed;
  // Measured beats declared, in both directions.
  if (o?.nativeRejected) return "text";
  if (o && o.textCallsWhileNative >= TEXT_FALLBACK_THRESHOLD && o.nativeCalls === 0) return "text";
  if (o && o.nativeCalls > 0) return "native";
  return input.declaredNative ? "native" : "text";
}

/** What one completed turn revealed. */
export interface TurnObservation {
  transport: ToolTransport;
  /** native `tool_calls` frames seen this turn. */
  nativeCalls: number;
  /** calls recovered from the response TEXT this turn. */
  textCalls: number;
  /** the endpoint refused the request because it carried tools. */
  rejectedForTools?: boolean;
}

/** Fold one turn's outcome into the capability state. Pure; returns a new object. */
export function observeTurn(state: ToolCapabilityState, obs: TurnObservation): ToolCapabilityState {
  const next: ToolCapabilityState = { ...state };
  if (obs.rejectedForTools) next.nativeRejected = true;
  if (obs.nativeCalls > 0) {
    next.nativeCalls += obs.nativeCalls;
    // Native works after all. Clear the strikes so one bad turn cannot slowly demote a
    // capable endpoint over a long session.
    next.textCallsWhileNative = 0;
    return next;
  }
  if (obs.transport === "native" && obs.textCalls > 0) {
    next.textCallsWhileNative += 1;
  }
  return next;
}

/* ── recognising a tools-shaped rejection ───────────────────────────────────*/

/**
 * Phrases endpoints use when they cannot render tools.
 *
 * Deliberately narrow. A generic 400 must NOT demote the endpoint: a request rejected for a
 * context-length overflow or a bad `temperature` has nothing to do with tool support, and
 * treating it as proof would strand a capable model on the text protocol for the rest of the
 * session over an unrelated typo.
 */
const TOOL_REJECTION = [
  "does not support tools",
  "doesn't support tools",
  "tools are not supported",
  "tool use is not supported",
  "tool calling is not supported",
  "does not support tool",
  "no tool support",
  "template does not support tools",
  "unknown field: tools",
  "unrecognized request argument supplied: tools",
  "unsupported parameter: 'tools'",
  "tool_choice",
] as const;

/**
 * Whether an error response is the endpoint saying it cannot do tools.
 *
 * Requires BOTH a client-error status and a tools-specific phrase — either alone is a guess.
 */
export function looksLikeToolsRejection(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  const hay = body.toLowerCase();
  return TOOL_REJECTION.some((needle) => hay.includes(needle));
}

/**
 * Whether the preamble for this transport must teach the text call syntax.
 *
 * `native` says no, and that is the honest answer for the PREAMBLE — but the response is
 * still scanned for text calls (see the module header). Teaching the syntax on a native turn
 * would actively encourage the fallback we are trying not to need.
 */
export function preambleModeFor(transport: ToolTransport): "native" | "text" {
  return transport === "text" ? "text" : "native";
}
