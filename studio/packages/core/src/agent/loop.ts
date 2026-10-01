// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import { brokerDecision } from "../agents/toolBroker.js";
import type { ModelRef } from "../agents/types.js";
import { type EffortTier, tierIndex } from "../ai/effort/types.js";
/**
 * agent/loop.ts — the universal, tunable agent turn loop (file 11 §3.2).
 *
 * Drives a model → tool_call → (gate) → tool_result → model loop. The model client
 * (cloud Claude or a local-served model) and the tool runner (engine bridge) are
 * INJECTED, so the loop is environment-agnostic (the SAME module the GUI agent pane
 * uses) and unit-testable with fakes. The load-bearing invariants:
 *   - the agent may NEVER emit --force (§4) — a human must type the confirmation;
 *   - state-changing tools route through the §4.3 broker (read-only + tuning.yes is
 *     the only auto path; destructive ALWAYS confirms);
 *   - the nemesis gate fires inside the engine; a BLOCK verdict aborts the call
 *     (unless the human set gate:off) — there is no JS-side bypass.
 */
import type { ToolDef } from "../mcp/server/index.js";
import { canaryInstructionBlock, containsCanary, generateCanaryToken } from "./canary.js";
import { CONTINUATION_NUDGE, DEFAULT_MAX_NUDGES, announcesUnfinishedWork } from "./continuation.js";
import type { AgentEvent, GateVerdictTier } from "./events.js";
import { PROTOCOL_FEEDBACK_TOOL, protocolFeedbackMessage } from "./protocol/feedback.js";
import {
  type AgentToolPolicy,
  type ToolName,
  exposedTools,
  isForceArg,
  stripForce,
} from "./tools.js";

import { utf8Bytes, utf8Decode } from "./bytes.js";
import {
  type HookRunner,
  type HookSpec,
  firePostToolUseHooks,
  hookRefusal,
  runPreToolUseHooks,
} from "./hooks.js";
import { type PermissionModeId, decideToolForMode, planModeRefusal } from "./permission-modes.js";

/**
 * Re-exported because it is part of `AgentTuning`'s public shape, and a consumer that can
 * import the tuning must be able to name the field's type without a second subpath entry.
 */
export type { PermissionModeId, HookSpec, HookRunner };
import { DEFAULT_REPEAT_LIMIT, RepeatGuard, repeatRefusal } from "./repeat-guard.js";

export interface AgentTuning {
  model: ModelRef;
  systemPrompt: string;
  tools: AgentToolPolicy;
  gateMode: "enforce" | "warn" | "off";
  dryRun: boolean;
  verbosity: "quiet" | "normal" | "debug";
  yes: boolean;
  /**
   * Reasoning effort for the bound worker model (the `/think` command). Optional.
   *
   * Translated per-backend by `ai/effort` — NOT forwarded raw, because the same intent is
   * `reasoning_effort` on one endpoint, `think` on another, and unsendable on a third.
   *
   * `EffortTier`, not a hand-written union. This WAS a copy of the five rungs, and a copy of a
   * ladder is a ladder that drifts: adding `xhigh`/`ultra` widened the real one and left this
   * one behind, so a tier the user could select was not a tier the tuning could carry. The
   * import is type-only, so it costs the loop nothing at runtime.
   */
  effort?: EffortTier;
  /**
   * Send the effort knob even when `ai/effort/rules.ts` says this model has none
   * (`--force-effort`, `[agent] effortForce`).
   *
   * OFF by default. It re-opens exactly the failure `ai/effort` exists to close — a forwarded
   * `reasoning_effort` is a hard 400 on a GPT-4-class model, not a no-op — so it is the user's
   * explicit call, made once, for a model released after those rules were written. The
   * resolution reports `degraded.reason: "forced"` whenever it fires, so a forced knob is never
   * mistaken for one the table vouched for.
   */
  effortForce?: boolean;
  /** max model⇄tool rounds per turn (CLI-032); default 8. A hard runaway backstop — NOT a
   *  product limit: on reaching it the loop emits a `capped` event and the host offers
   *  `/continue` (CLI-072). Honored from config via `agent.maxIterations` (resolveTuning). */
  maxRounds?: number;
  /**
   * How many times one turn may be told "you described work but called no tool" before its
   * silence is taken as an answer. Defaults to `DEFAULT_MAX_NUDGES`; 0 disables the behaviour
   * entirely for a caller that wants the raw loop.
   */
  continuationNudges?: number;
  /**
   * Consecutive identical tool calls (name AND arguments) before the loop refuses one.
   * Default 3; `0` disables the guard.
   *
   * Unlike the §3.4 `callHistory` guard this defaults ON. An optional field that silently
   * defaults to off is how the previous doom-loop guard came to be dead in every host.
   */
  repeatLimit?: number;
  /**
   * The autonomy POSTURE in force (`agent/permission-modes.ts`). The loop honours the matrix's
   * **deny** verdict only — today that is exactly `plan`, whose read-only stance must hold on
   * EVERY surface rather than on the one host that happened to check it. Before this existed
   * the TUI enforced plan mode at its own confirm seam and the readline host, the headless
   * run and the whole desktop pane did not, so the same "⏸ plan mode on" meant three
   * different things.
   *
   * WHY DENY-ONLY: the matrix also says `allow` for `acceptEdits`/`bypassPermissions`, and
   * honouring that here would let a tuning field WIDEN what the §4.3 broker already decided.
   * A mode may only ever REMOVE a capability in this loop; granting one stays the host's job,
   * at the confirm seam, where a human (or an audited ladder level) is on the other end.
   *
   * Undefined ⇒ no mode override — exactly the behaviour before this field existed.
   */
  permissionMode?: PermissionModeId;
  /**
   * User-authored LIFECYCLE HOOKS (`agent/hooks.ts`), read from settings.
   *
   * Carried on the tuning rather than on `AgentTurnDeps` for one reason: `childTuning` spreads
   * the parent tuning, so a `spawn_agent` sub-agent inherits its parent's hooks automatically.
   * A PreToolUse hook the user wrote to guard `write_file` would be trivially escapable if
   * delegation dropped it.
   *
   * Absent (or absent `hookRunner`) ⇒ nothing runs, and the loop behaves exactly as it did
   * before hooks existed.
   */
  hooks?: readonly HookSpec[];
  /**
   * The injected executor for `hooks`. The loop stays PURE — no `node:child_process` here; a
   * host supplies the real spawn-backed runner (`agent/system/host/hook-runner.ts`) and tests
   * supply a fake.
   */
  hookRunner?: HookRunner;
}

/**
 * Default cap on model⇄tool rounds in one turn (CLI-032).
 *
 * Raised from 8. Eight rounds is under a third of what an ordinary refactor costs — read the
 * file, grep the callers, read two of them, edit three, run the tests, read the failure, fix,
 * re-run — so the agent hit the cap on routine work and handed a half-finished job back to
 * the user. This is a RUNAWAY BACKSTOP, not a product limit, and it only stops a loop that
 * `capped` + `/continue` would otherwise resume anyway.
 *
 * It is safe to raise precisely because the cap is not the only bound: every round is gated,
 * a destructive tool still stops for a human, and `tuning.maxRounds` (config
 * `agent.maxIterations`) overrides this for anyone who wants the old ceiling.
 */
export const DEFAULT_MAX_ROUNDS = 32;

/**
 * The round ceiling at the TOP of the effort ladder.
 *
 * The ONE resource-shaped thing an effort tier may legitimately move. A higher step budget
 * wins only where the extra steps GATHER NEW INFORMATION — another file read, another grep,
 * another test run — which is exactly what an agentic turn spends rounds on, and is why this is
 * in scope while the other tempting knobs are not: temperature is not an effort control in
 * either direction (low temperature is best for single-shot reasoning), and `max_tokens`
 * headroom removes a failure mode without adding any effort at all.
 *
 * 50% headroom rather than a blank cheque, because rounds that do NOT gather new information
 * are pure burn, and the cap is a runaway backstop before it is a product limit.
 */
export const MAX_EFFORT_MAX_ROUNDS = 48;

/**
 * The DEFAULT round ceiling for an effort tier. An explicit `tuning.maxRounds` (config
 * `agent.maxIterations`) always wins over this — a user who pinned a ceiling asked for that
 * ceiling, and `/think max` must not quietly raise it back up.
 *
 * Only the TOP rungs move it. Lowering the ceiling for `off`/`low` would be the wrong shape
 * entirely: those tiers ask for less DELIBERATION, not for less work, and a turn that runs out
 * of rounds fails to finish rather than answering more briefly.
 *
 * `xhigh` and `ultra` count as top rungs. The comparison was `effort === "max"`, so when the
 * ladder grew they landed on the DEFAULT ceiling — the same budget as `off` — and the vendor's
 * own description of `xhigh` is "long-running agentic and coding tasks (over 30 minutes)",
 * i.e. precisely the turns that need the extra rounds. A tier-index comparison cannot fall
 * behind the ladder the way an equality check did.
 */
export function roundsForEffort(effort: AgentTuning["effort"]): number {
  if (!effort) return DEFAULT_MAX_ROUNDS;
  return tierIndex(effort) >= tierIndex("xhigh") ? MAX_EFFORT_MAX_ROUNDS : DEFAULT_MAX_ROUNDS;
}

/** Byte budget for a single tool output folded back into the thread (head+tail, CLI-032). */
export const TOOL_OUTPUT_CAP_BYTES = 16 * 1024;

/**
 * Byte-cap a tool's output (multibyte-safe) for the follow-up round: under budget → verbatim;
 * over → head + `…[truncated N bytes]…` + tail (each half of the budget). Slices on BYTE
 * boundaries — a split UTF-8 sequence degrades to U+FFFD, never an under-counted char slice.
 */
export function capBytes(text: string, maxBytes: number = TOOL_OUTPUT_CAP_BYTES): string {
  const buf = utf8Bytes(text);
  if (buf.byteLength <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const head = utf8Decode(buf.subarray(0, half));
  const tail = utf8Decode(buf.subarray(buf.byteLength - half));
  return `${head}\n…[truncated ${buf.byteLength - 2 * half} bytes]…\n${tail}`;
}

export interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
  id?: string;
}

export interface ThreadMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * On an `assistant` message: the calls it made, when the transport supplied ids.
   * On a `tool` message: which call it answers.
   *
   * Both are OPTIONAL and purely additive. `content` remains the complete, self-describing
   * transcript — the text transport has no ids at all and relies on it entirely, and any
   * consumer that ignores these fields behaves exactly as before.
   *
   * They exist so a NATIVE transport can rebuild the paired form its provider was trained on
   * (`assistant.tool_calls` + `{role:"tool", tool_call_id}`) instead of flattening every
   * result into a plain `user` message, which is what it had to do when there was no id to
   * pair with.
   */
  toolCalls?: readonly { id: string; name: string; args: Record<string, unknown> }[];
  toolCallId?: string;
}

export interface Thread {
  messages: ThreadMessage[];
}

/** A turn the model emits — a wrapper STATUS note (progress/waiting/timeout, NOT persisted),
 *  a reasoning delta (thinking, NOT persisted), a text delta, a tool call, or the final answer. */
export type LlmTurn =
  | { kind: "status"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "final"; text?: string }
  /** the transport went idle (agent/idle-watchdog.ts) mid-turn — a PAUSE, not completion. See
   *  `AgentEvent{kind:"paused"}`, which this becomes at the loop level. */
  | { kind: "paused"; idleMs: number };

/** The model client the loop drives (cloud OR local-served). Injected. */
export interface LLMClient {
  turn(thread: Thread, tuning: AgentTuning, tools: ToolDef[]): AsyncIterable<LlmTurn>;
}

/** The outcome of running a tool through the engine bridge (verdict when gated). */
export interface ToolOutcome {
  ok: boolean;
  summary: string;
  data?: unknown;
  verdict?: { verdict: GateVerdictTier; riskScore?: number };
}

/** Execute an (already broker-approved) tool call via the engine bridge. Injected. */
export type ToolRunner = (tool: ToolDef, args: Record<string, unknown>) => Promise<ToolOutcome>;

/**
 * A confirm answer. A bare `boolean` keeps the legacy contract; the object form lets a
 * rejection carry a REASON, which the loop surfaces as a `tool_result{ok:false}` (so the
 * model can re-plan) instead of the terminal `blocked` event (CLI-010).
 */
export type ConfirmResult =
  | boolean
  | {
      approved: boolean;
      reason?: string;
      /**
       * "…and don't ask again", at this scope.
       *
       * The loop itself ignores this — it is read by `withRememberedGrants`, which wraps the
       * host's confirm and owns the memory. Declared here because it is part of the ANSWER a
       * host returns, and a host that offers the affordance needs somewhere to put it.
       */
      remember?: "once" | "session" | "project" | "user";
    };

export interface AgentTurnDeps {
  llm: LLMClient;
  runTool: ToolRunner;
  /** asked before a non-auto-approvable tool runs; default = deny. */
  confirm?: (call: ToolCall) => ConfirmResult | Promise<ConfirmResult>;
  /**
   * Cancel the whole turn — ESC in the TUI, Ctrl-C in the readline host.
   *
   * Both hosts have minted an `AbortController` per turn since CLI-002, and both trip it on
   * the interrupt key. It reached exactly one consumer: the SSE stream. So pressing ESC
   * stopped the tokens arriving and the loop CARRIED ON — it started the next round, called
   * the model again, and ran whatever tools that round asked for. The user had cancelled, the
   * agent had not, and the only evidence was that the terminal went quiet for a while and then
   * a file changed.
   *
   * Checked in three places below, and all three are necessary:
   *   - before each ROUND, so a cancelled turn does not start another one;
   *   - before each TOOL CALL, because one round can carry several and the user who pressed
   *     ESC did not consent to the rest of the batch;
   *   - inside the runner (via `makeToolRunner`), so an already-running child process dies
   *     rather than finishing its `npm install` after the turn is over.
   */
  signal?: AbortSignal;
  /**
   * Called if the model's own text output ever contains this turn's planted canary token — see
   * `canary.ts`. A near-zero-false-positive signal that something (an injected instruction the
   * earlier defense-in-depth layers missed) got the model to act against an explicit
   * instruction. Optional: omitting it skips planting a canary entirely (no token generated, no
   * extra system text), so tests and any host that hasn't wired an audit sink yet pay no cost.
   */
  onCanaryTripped?: (info: { textSnippet: string }) => void;
}

function withDryRun(args: Record<string, unknown>, dryRun: boolean): Record<string, unknown> {
  return dryRun ? { ...args, dryRun: true } : args;
}

/**
 * Does the tool implement `dryRun` ITSELF, i.e. does its own schema declare the field?
 *
 * `withDryRun` above only INJECTS the flag into the args. A tool whose schema never declared it
 * simply ignored the extra key: with `/dry-run on`, `delete_file` still deleted the file and
 * `mkdir` still created the directory — measured against the compiled runner, not read. The
 * engine verbs DO declare it (`prometheus_install`'s schema even defaults it to `true`) and
 * forward `--dry-run` to produce a real gated preview, so those must still run.
 *
 * Schema membership is the test rather than a hand-written list of mutators, because a list
 * beside the tools is exactly the shape that drifts when a tool is added — and it would have to
 * be duplicated in each of the four hosts to boot.
 */
function honoursDryRun(tool: ToolDef): boolean {
  return Object.hasOwn(tool.schema as Record<string, unknown>, "dryRun");
}

/**
 * Enforce `/dry-run` for tools that cannot enforce it themselves.
 *
 * Reads still run — previewing a plan is useless if the agent cannot look at anything — so the
 * short-circuit applies only to tools that are NOT `readOnlyHint`. Lives HERE, at the one place
 * the loop dispatches a tool, so all four hosts (CLI readline, CLI TUI, desktop pane, VS Code)
 * inherit it from one decision instead of four copies.
 */
export function dryRunSkipped(tool: ToolDef, dryRun: boolean): boolean {
  if (!dryRun) return false;
  if (tool.annotations?.readOnlyHint === true) return false;
  return !honoursDryRun(tool);
}

interface ToolMsgFields {
  ok?: boolean;
  summary?: string;
  data?: unknown;
  denied?: boolean;
  blocked?: boolean;
  timedOut?: boolean;
  reason?: string;
}

/**
 * Render a call the model made, for the assistant message folded back into the thread.
 *
 * Without this the thread records only the RESULTS. A model that answers with nothing but a
 * tool call — which is the norm, not the exception — contributed no assistant text, so the
 * fold pushed no assistant message at all and the next round read as: user asks a question,
 * then a `[tool_result]` appears from nowhere. The model has no memory of having asked for
 * it. Pointed at a real gemma4:12b, it responded to that by calling `list_dir` again, or by
 * stopping with an empty answer, in three runs out of four.
 *
 * The canonical text form is used on purpose: it is byte-identical to what the model itself
 * emits, so the transcript reads back as its own output rather than as a paraphrase.
 */
export function renderToolCallRecord(call: ToolCall): string {
  return `<tool_call>${JSON.stringify({ name: call.name, arguments: call.args })}</tool_call>`;
}

/** Serialize a tool outcome as the `{role:"tool"}` message fed back to the model (CLI-032). */
function toolResultMessage(tool: string, f: ToolMsgFields): string {
  const head = `[tool_result ${tool}]`;
  if (f.blocked) return `${head}\nblocked: ${f.reason ?? "yes"}`;
  if (f.denied) {
    return `${head}\ndenied by user: ${f.reason ?? "declined"} — re-plan; do NOT re-propose the same command.`;
  }
  const lines = [head];
  const exit =
    f.data &&
    typeof f.data === "object" &&
    typeof (f.data as { exitCode?: unknown }).exitCode === "number"
      ? (f.data as { exitCode: number }).exitCode
      : undefined;
  if (exit !== undefined) lines.push(`exit: ${exit}`); // verbatim, never capped
  if (f.timedOut) lines.push("timedOut: true");
  lines.push(`ok: ${f.ok === true}`);
  if (f.summary) lines.push(capBytes(f.summary));
  return lines.join("\n");
}

/**
 * Run one agent turn, streaming AgentEvents in order. MULTI-ROUND (CLI-032): after tools
 * run, their (byte-capped) results + a user-decline refusal re-enter the thread as
 * `{role:"tool"}` messages and the model is re-invoked for a follow-up round, bounded by
 * `tuning.maxRounds` (default 8). A stream that ends with `final` — or with no tool call —
 * completes the turn (so a text-only LLM stays single-round). The gate invariants
 * (never-force, broker confirm-default-deny, nemesis BLOCK abort) re-run EVERY round.
 */
export async function* runAgentTurn(
  thread: Thread,
  tuning: AgentTuning,
  deps: AgentTurnDeps,
): AsyncIterable<AgentEvent> {
  const tools = exposedTools(tuning.tools);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const maxRounds = Math.max(1, tuning.maxRounds ?? roundsForEffort(tuning.effort));
  /** Continuation nudges spent this TURN (never per round) — see the `toolMessages` branch. */
  let nudges = 0;
  const maxNudges = tuning.continuationNudges ?? DEFAULT_MAX_NUDGES;
  /**
   * The canary tripwire (`canary.ts`) — a fresh token per turn, only generated when a caller has
   * somewhere to send a trip (no cost otherwise). Planted on a COPY of the thread handed to the
   * model, never on `thread` itself: `thread` is the caller's own persisted conversation
   * (mutated in place elsewhere in this function, by design, so it survives a mid-round abort),
   * and a security tripwire has no business surviving into a saved/exported transcript.
   */
  const canaryToken = deps.onCanaryTripped ? generateCanaryToken() : undefined;
  /**
   * Checked against a bounded TAIL of each stream — assistant text and reasoning tracked
   * separately, via `channel` — rather than each raw chunk in isolation. A chunk boundary is an
   * ordinary streaming/network artifact, not adversarial model behavior, and the token (32 hex
   * chars) can legitimately land split across two chunks; checking only the current chunk missed
   * exactly that case. The window only needs to be a little larger than the token so a split
   * anywhere in it is still caught, without re-scanning the whole ever-growing turn on every
   * chunk. Reasoning is checked too — a leak visible only in "thinking" output (several hosts
   * stream it to the user) is still a leak. Fires at most once per turn: once tripped, the
   * breach is already known and re-scanning would only spam the audit sink with the same finding.
   */
  const CANARY_TAIL = 256;
  const canaryTails = { assistant: "", reasoning: "" };
  let canaryTripped = false;
  const checkCanary = (text: string, channel: "assistant" | "reasoning"): void => {
    if (!canaryToken || canaryTripped) return;
    const next = (canaryTails[channel] + text).slice(-CANARY_TAIL);
    canaryTails[channel] = next;
    if (containsCanary(next, canaryToken)) {
      canaryTripped = true;
      deps.onCanaryTripped?.({ textSnippet: next });
    }
  };
  /**
   * ONE guard for the whole turn, constructed OUTSIDE the round loop.
   *
   * A per-round counter cannot see a model that repeats across rounds, which is the only way a
   * doom loop actually happens: round after round of `read_file` on the same path, each one a
   * fresh round with a run length of one.
   */
  const repeatLimit = tuning.repeatLimit ?? DEFAULT_REPEAT_LIMIT;
  const repeats = new RepeatGuard(repeatLimit);
  /** set when the guard gives up: the model repeated even after being refused. */
  let repeatAbort = false;
  /**
   * Fail-soft hook diagnostics awaiting a `status` yield.
   *
   * A queue rather than a direct yield because `runPreToolUseHooks`/`firePostToolUseHooks` take
   * a plain callback and this is a generator — a callback cannot yield. Drained at the next
   * safe point so a hook that is silently broken is VISIBLE rather than mysteriously inert.
   */
  const hookErrors: string[] = [];
  const onHookError = (m: string): void => {
    hookErrors.push(m);
  };
  /**
   * Every `firePostToolUseHooks` promise, across every round, so the turn can wait for them
   * ALL to settle before it ends.
   *
   * `firePostToolUseHooks` is deliberately fire-and-forget PER CALL (see its own doc comment):
   * awaiting it there would put a user's shell script on the critical path of every tool call.
   * But that meant a hook failure on a round's (or the turn's) LAST call had no later
   * PreToolUse drain point left to surface through — the queue was pushed to after the only
   * place that ever read it, or after `{kind:"done"}` had already been yielded. Collecting the
   * promises here and awaiting them once, at the very end of the turn rather than after every
   * call, keeps the per-call latency the design wants while still guaranteeing every failure
   * gets reported before the turn is done.
   */
  const pendingPostHooks: Promise<void>[] = [];

  /**
   * The turn was CANCELLED by the human.
   *
   * Tracked separately from `repeatAbort` because it means something different to the host: a
   * repeat-abort is the agent giving up on a model, a cancel is the user giving up on the
   * agent. Neither emits `capped` — `/continue` would resume exactly the thing that was
   * interrupted.
   */
  let cancelled = false;
  /** Has the human asked for this turn to stop? */
  const aborted = (): boolean => deps.signal?.aborted === true;

  for (let round = 0; round < maxRounds; round++) {
    // Before the round starts: an abort that landed while the previous round's tools ran must
    // not be answered by calling the model again.
    if (aborted()) {
      cancelled = true;
      break;
    }
    let assistantText = "";
    let sawFinal = false;
    // set when THIS round's transport went idle rather than finishing — see `LlmTurn{kind:"paused"}`.
    let pausedThisRound = false;
    let pausedIdleMs = 0;
    /** This round's tool results, each tagged with the call it answers (when there was an id). */
    const toolMessages: { content: string; callId?: string }[] = [];
    /** Every call the model asked for this round, including ones that were refused. */
    const roundCalls: ToolCall[] = [];

    // multi-round visibility (CLI): after the first round, tell the user we're continuing
    // (the model asked for another tool step) so a long agentic turn never looks like a hang.
    if (round > 0) {
      yield { kind: "status", text: `continuing — round ${round + 1}/${maxRounds}` };
    }

    // `try/finally`, not straight-line code after the loop: an external consumer that stops
    // iterating `runAgentTurn` mid-round (its own `for await` breaking, e.g. on an abort it
    // noticed before this loop did) invokes THIS generator's `.return()`, which unwinds from
    // wherever it was suspended — possibly between two tool calls in the same round, after the
    // first one already succeeded and was already shown to the user. Without a `finally` here,
    // that already-real result never reached `thread.messages` at all: the round vanished from
    // the model's memory even though its effect (e.g. a file write) had already happened.
    const llmThread: Thread = canaryToken
      ? {
          ...thread,
          messages: [
            ...thread.messages,
            { role: "system", content: canaryInstructionBlock(canaryToken) },
          ],
        }
      : thread;
    try {
      for await (const turn of deps.llm.turn(llmThread, tuning, tools)) {
        if (turn.kind === "status") {
          // wrapper progress note (waiting/timeout/etc.): surface live, never persist.
          yield { kind: "status", text: turn.text };
          continue;
        }
        if (turn.kind === "reasoning") {
          // thinking tokens: surface as live feedback but NEVER fold into assistantText /
          // the persisted thread (reasoning is ephemeral, not part of the answer). Still
          // canary-checked: several hosts stream this straight to the user, so a leak that
          // surfaces only here is still a leak.
          checkCanary(turn.text, "reasoning");
          yield { kind: "reasoning", text: turn.text };
          continue;
        }
        if (turn.kind === "text") {
          assistantText += turn.text;
          checkCanary(turn.text, "assistant");
          yield { kind: "text", text: turn.text };
          continue;
        }
        if (turn.kind === "final") {
          if (turn.text) {
            assistantText += turn.text;
            checkCanary(turn.text, "assistant");
            yield { kind: "text", text: turn.text };
          }
          sawFinal = true;
          break;
        }
        if (turn.kind === "paused") {
          // The already-streamed prose (yielded above, accumulated into `assistantText`) is
          // everything worth keeping — a tool call still mid-argument-stream at pause time is
          // NOT reconstructed: resuming re-asks the model, which regenerates it. `roundCalls`/
          // `toolMessages` are correctly empty here because a transport only reaches this from
          // mid-stream, before any of THIS round's tool calls have been fully parsed and executed.
          pausedThisRound = true;
          pausedIdleMs = turn.idleMs;
          break;
        }

        const call = turn.call;
        /**
         * The human cancelled — do not start this call.
         *
         * Checked BEFORE `roundCalls.push`, so a cancelled call is not narrated back to the
         * model as something it asked for and got an answer to. One round can carry several
         * tool calls; pressing ESC after the first is a refusal of the rest, not of nothing.
         */
        if (aborted()) {
          cancelled = true;
          break;
        }
        // Recorded BEFORE any gate: a refused call is still something the model asked for, and
        // it must see that it asked, or it re-proposes the identical refused call next round.
        roundCalls.push(call);

        /**
         * The repeat guard runs ABOVE the broker, so it can see the calls the broker
         * auto-approves — which is where the real loop lives. A model stuck on `read_file` never
         * reaches a confirm at all, so a guard under the confirm path could never have seen it.
         *
         * It runs above EVERY `continue` in this block — the --force refusal, the transport's
         * malformed-call feedback, and the catalog lookup — because each of those returns early,
         * and an early return the guard never sees is a doom loop it cannot stop. Measured on
         * compiled core: a repeated exposed tool stopped after 4 model rounds, while a repeated
         * `--force` call and a repeated `malformed_tool_call` each ran the FULL 32 and ended
         * `capped` — offering the human a `/continue` that would resume the same loop.
         *
         * A HALLUCINATED tool name is the single
         * most repeatable thing a model does and it used to be invisible here: the "is not
         * exposed" branch `continue`d before `observe` was ever reached. Measured on compiled
         * core — a model repeating an exposed tool was stopped after 4 rounds, while one
         * repeating a name that does not exist ran all 32 and then reported `capped`, burning
         * eight times the budget on a call that could never succeed.
         */
        const verdict = repeats.observe(call);
        if (verdict !== "ok") {
          const reason = repeatRefusal(call, repeatLimit);
          toolMessages.push({
            content: toolResultMessage(call.name, { blocked: true, reason }),
            ...(call.id ? { callId: call.id } : {}),
          });
          yield { kind: "tool_result", call, ok: false, summary: reason };
          if (verdict === "abort") {
            // It repeated after being told. Ending the turn is the only remaining move that
            // does not burn the user's budget on a model that is not listening.
            repeatAbort = true;
            yield {
              kind: "blocked",
              tool: call.name,
              reason: `${call.name} repeated identically after being refused — ending the turn`,
            };
            break;
          }
          continue;
        }
        // INVARIANT (§4): the agent may NEVER use --force.
        if (isForceArg(call.args)) {
          const reason =
            "the agent is forbidden from using --force; a human must type the confirmation";
          // Recorded BEFORE the yield: an external consumer that stops iterating the instant it
          // sees this event forces a `.return()` right here, which skips any code written AFTER
          // the yield entirely — so the fold this feeds (in the `finally` below) must already
          // have its entry by the time the event is produced, not after.
          toolMessages.push({
            content: toolResultMessage(call.name, { blocked: true, reason }),
            ...(call.id ? { callId: call.id } : {}),
          });
          yield { kind: "blocked", tool: call.name, reason };
          continue;
        }
        // The transport telling us it could not READ a call — not the model calling a tool.
        // Handled before the catalog lookup, because falling through to "tool is not exposed"
        // replaces the diagnosis with a message about a tool that was never called, and the
        // reason the transport went to the trouble of producing is exactly what the model needs.
        if (call.name === PROTOCOL_FEEDBACK_TOOL) {
          const reason =
            typeof call.args.reason === "string"
              ? call.args.reason
              : "your last message could not be read as a tool call";
          toolMessages.push({
            content: protocolFeedbackMessage(call.args),
            ...(call.id ? { callId: call.id } : {}),
          });
          yield { kind: "blocked", tool: call.name, reason };
          continue;
        }

        /**
         * The catalog lookup, now BELOW the repeat guard (see above) so a hallucinated name is
         * counted like any other repeat. The FIRST occurrence still lands here and still tells
         * the model the tool does not exist — only a model that ignores that answer and asks
         * again meets the guard.
         */
        const tool = byName.get(call.name);
        if (!tool) {
          const reason = `tool "${call.name}" is not exposed`;
          toolMessages.push({
            content: toolResultMessage(call.name, { blocked: true, reason }),
            ...(call.id ? { callId: call.id } : {}),
          });
          yield { kind: "blocked", tool: call.name, reason };
          continue;
        }

        /**
         * PERMISSION MODE (plan) — a hard DENY above the broker, below the repeat guard.
         *
         * Placed here on purpose: above the broker so the refusal cannot be reached by any
         * auto-approve path (`tuning.yes` lifts read-only tools straight past `confirm`, so a
         * check living only in a host's confirm seam never sees them), and below the repeat
         * guard so a model that keeps re-proposing the same refused mutation still gets told to
         * stop rather than looping on a polite "no".
         *
         * The refusal rides the CLI-032 tool-result channel as the structured `planModeRefusal`
         * object, which is the SAME shape the TUI's confirm seam already returns — so a model
         * sees one refusal contract whichever surface denied it, and can re-plan from it.
         */
        const mode = tuning.permissionMode;
        if (mode && decideToolForMode(mode, tool.annotations) === "deny") {
          const reason = JSON.stringify(planModeRefusal(call.name));
          toolMessages.push({
            content: toolResultMessage(call.name, { denied: true, reason }),
            ...(call.id ? { callId: call.id } : {}),
          });
          yield { kind: "blocked", tool: call.name, reason: `blocked by ${mode} mode` };
          continue;
        }

        /**
         * PreToolUse HOOKS — a user-authored veto, above the broker, below plan mode.
         *
         * Above the broker for the same reason plan mode is: `tuning.yes` lifts read-only tools
         * straight past `confirm`, so a hook that only ran at a host's confirm seam would never
         * see the majority of calls. Below plan mode because a mode deny is cheaper and needs no
         * subprocess — there is no point spawning a shell to ask about a call already refused.
         *
         * The refusal is the SAME `{denied:true, tool, …, hint}` contract plan mode uses, so a
         * model sees one refusal shape whichever layer said no.
         */
        const hookDenial = await runPreToolUseHooks(tuning.hooks, tuning.hookRunner, call, {
          onError: onHookError,
        });
        // Fail-soft diagnostics: a broken hook is reported ONCE per turn as a status line, never
        // as an error that ends anything. Drained here (not inside the catch) so the note lands
        // in stream order next to the call it concerns.
        while (hookErrors.length > 0) {
          yield { kind: "status", text: `hook: ${hookErrors.shift()}` };
        }
        // The human may have cancelled WHILE the hook subprocess ran — a hook that took a moment
        // to answer (or a slow/hung one that timed out) must not have its answer, allow or deny,
        // still spend into a tool run the user already asked to stop.
        if (aborted()) {
          cancelled = true;
          const reason = "cancelled — the turn was interrupted";
          toolMessages.push({
            content: toolResultMessage(call.name, { denied: true, reason }),
            ...(call.id ? { callId: call.id } : {}),
          });
          yield { kind: "blocked", tool: call.name, reason };
          break;
        }
        if (hookDenial) {
          const reason = JSON.stringify(hookRefusal(call.name, hookDenial.command));
          toolMessages.push({
            content: toolResultMessage(call.name, { denied: true, reason }),
            ...(call.id ? { callId: call.id } : {}),
          });
          yield {
            kind: "blocked",
            tool: call.name,
            reason: `blocked by hook: ${hookDenial.command}`,
          };
          continue;
        }

        // §4.3 broker: read-only + tuning.yes is the only auto path; destructive always confirms.
        const decision = brokerDecision({
          ref: call.name,
          annotations: tool.annotations,
          grant: { ref: call.name, autoApprove: tuning.yes },
        });
        if (decision.action === "block") {
          toolMessages.push({
            content: toolResultMessage(call.name, { blocked: true, reason: decision.reason }),
            ...(call.id ? { callId: call.id } : {}),
          });
          yield { kind: "blocked", tool: call.name, reason: decision.reason };
          continue;
        }
        if (decision.action === "confirm") {
          const answer: ConfirmResult = deps.confirm ? await deps.confirm(call) : false;
          // The human may have hit Ctrl-C WHILE this confirmation was pending — a host whose
          // confirm seam doesn't itself race the abort signal (the CLI's readline prompt did
          // not) can still resolve with a stale `true` a moment later. That must never run the
          // tool: an abort landing here overrides whatever the answer says, approved or not.
          if (aborted()) {
            cancelled = true;
            const reason = "cancelled — the turn was interrupted";
            toolMessages.push({
              content: toolResultMessage(call.name, { denied: true, reason }),
              ...(call.id ? { callId: call.id } : {}),
            });
            yield { kind: "blocked", tool: call.name, reason };
            break;
          }
          const approved = typeof answer === "boolean" ? answer : answer.approved;
          if (!approved) {
            const reason = typeof answer === "object" ? answer.reason : undefined;
            // EITHER way the decline re-enters the thread so the model re-plans (CLI-032).
            toolMessages.push({
              content: toolResultMessage(call.name, {
                denied: true,
                reason: reason ?? "declined at confirmation",
              }),
              ...(call.id ? { callId: call.id } : {}),
            });
            if (reason) {
              // a REASONED rejection → a normal tool_result so the model re-plans (CLI-010).
              yield { kind: "tool_result", call, ok: false, summary: `user rejected: ${reason}` };
            } else {
              yield { kind: "blocked", tool: call.name, reason: "declined at confirmation" };
            }
            continue;
          }
        }

        yield { kind: "tool_use", call };
        let outcome: ToolOutcome;
        try {
          outcome = dryRunSkipped(tool, tuning.dryRun)
            ? {
                ok: true,
                summary: `dry-run: ${call.name} was NOT executed. Turn dry-run off to apply it.`,
              }
            : await deps.runTool(tool, withDryRun(stripForce(call.args), tuning.dryRun));
        } catch (e) {
          const summary = e instanceof Error ? e.message : String(e);
          // PostToolUse still fires on a THROWN tool. An observer that only ever sees the happy
          // path is exactly the wrong shape for the audit/alerting these hooks exist for.
          pendingPostHooks.push(
            ...firePostToolUseHooks(
              tuning.hooks,
              tuning.hookRunner,
              call,
              { ok: false, summary },
              { onError: onHookError },
            ),
          );
          toolMessages.push({
            content: toolResultMessage(call.name, { ok: false, summary }),
            ...(call.id ? { callId: call.id } : {}),
          });
          yield { kind: "tool_result", call, ok: false, summary };
          continue;
        }

        /**
         * PostToolUse — FIRE AND FORGET, deliberately not awaited HERE.
         *
         * A post hook is an observer. Awaiting it before the NEXT tool call would put a user's
         * shell script on the critical path of every one of them, which is how "the agent
         * randomly hangs" bugs are made. Its exit code is ignored: the call already happened,
         * there is nothing left to deny. The promise is still collected in `pendingPostHooks`,
         * so the turn waits for it (and reports any failure) before it ends — see that field.
         */
        pendingPostHooks.push(
          ...firePostToolUseHooks(tuning.hooks, tuning.hookRunner, call, outcome, {
            onError: onHookError,
          }),
        );

        if (outcome.verdict) {
          yield {
            kind: "verdict",
            tool: call.name,
            verdict: outcome.verdict.verdict,
            riskScore: outcome.verdict.riskScore,
          };
          // gate-first: a BLOCK aborts unless the human turned the gate off; a scan
          // failure (error) aborts under enforce (fail-closed).
          if (outcome.verdict.verdict === "block" && tuning.gateMode !== "off") {
            const reason = "nemesis gate BLOCK — aborted";
            toolMessages.push({
              content: toolResultMessage(call.name, { blocked: true, reason }),
              ...(call.id ? { callId: call.id } : {}),
            });
            yield { kind: "blocked", tool: call.name, reason };
            continue;
          }
          if (outcome.verdict.verdict === "error" && tuning.gateMode === "enforce") {
            const reason = "scan failed (fail-closed) — aborted";
            toolMessages.push({
              content: toolResultMessage(call.name, { blocked: true, reason }),
              ...(call.id ? { callId: call.id } : {}),
            });
            yield { kind: "blocked", tool: call.name, reason };
            continue;
          }
        }

        toolMessages.push({
          content: toolResultMessage(call.name, {
            ok: outcome.ok,
            summary: outcome.summary,
            data: outcome.data,
          }),
          ...(call.id ? { callId: call.id } : {}),
        });
        yield {
          kind: "tool_result",
          call,
          ok: outcome.ok,
          summary: outcome.summary,
          data: outcome.data,
        };
      }
    } finally {
      // A tool RAN this round, so its result belongs in the thread — even if the stream also
      // carried `final`. The two are not in conflict as far as this loop is concerned: `final`
      // says the model stopped generating, and a tool result says there is something new for it
      // to read. Checking `sawFinal` BEFORE this fold is what made the CLI single-round: its
      // transport ends every turn with an unconditional `final`, so tools ran, their output was
      // dropped on the floor, and the model was never asked what it made of them.
      //
      // Runs on every exit from the loop above — normal completion, any `break` (final/cancel/
      // repeat-abort), AND a `.return()`-driven teardown — so whatever was accumulated by the
      // time this round stopped is never lost, even if the round did not finish normally.
      if (toolMessages.length > 0) {
        // The assistant turn is its prose PLUS the calls it made. Folding only the prose left a
        // model that spoke purely in tool calls with no assistant message at all, so the next
        // round could not tell what it had asked for — see `renderToolCallRecord`.
        const narration = [assistantText.trim(), ...roundCalls.map(renderToolCallRecord)]
          .filter(Boolean)
          .join("\n");
        // The structured pairing rides ALONGSIDE the text, never instead of it: a native
        // transport rebuilds `assistant.tool_calls` + `tool_call_id` from it, and a text
        // transport ignores it and reads `content`, which says the same thing in prose.
        const identified = roundCalls.filter(
          (c): c is ToolCall & { id: string } => typeof c.id === "string" && c.id !== "",
        );
        if (narration) {
          thread.messages.push({
            role: "assistant",
            content: narration,
            ...(identified.length > 0
              ? {
                  toolCalls: identified.map((c) => ({ id: c.id, name: c.name, args: c.args })),
                }
              : {}),
          });
        }
        for (const tm of toolMessages) {
          thread.messages.push({
            role: "tool",
            content: tm.content,
            ...(tm.callId ? { toolCallId: tm.callId } : {}),
          });
        }
      }
    }
    // The repeat guard gave up: the model reissued an identical call after being refused, so
    // the turn ends here rather than at the round cap. `capped` is deliberately NOT emitted —
    // this is not a pause the human should be invited to `/continue`, it is a model that is
    // not responding to feedback, and offering to resume it would resume the loop.
    if (repeatAbort) break;
    /**
     * The human cancelled. Announce it and stop.
     *
     * The `blocked` event (rather than silence) is what makes ESC legible: the transcript
     * shows why the agent stopped, and the reason lands in the same channel every other
     * refusal uses, so no host needs a special case to render it. `capped` is deliberately
     * NOT emitted — offering `/continue` after a cancel resumes the thing the user cancelled.
     */
    if (cancelled || aborted()) {
      cancelled = true;
      yield { kind: "blocked", reason: "cancelled — the turn was interrupted" };
      break;
    }
    /**
     * The transport paused on inactivity (agent/idle-watchdog.ts). Fold whatever prose it
     * produced before going quiet — exactly the same fold `capped` uses for its own last
     * round's tool results — so `/continue` (or simply the user's next message, which already
     * carries `thread` forward via `carryForward`) picks up from here with nothing lost and no
     * new user message appended. A distinct `paused` event, not a fake `capped`/`done`, so the
     * host can render "paused — will resume" rather than "finished" or "hit the step cap".
     */
    if (pausedThisRound) {
      // No double-push: if this round ALSO had tool calls before the transport went idle, the
      // fold above (toolMessages.length > 0) already pushed a narration message containing
      // this exact assistantText alongside the tool-call/result record — pushing it again here
      // would duplicate the model's own prose in the thread. Only fold here for the pure
      // "paused mid-prose, no tool call this round" case, mirroring the terminal-answer
      // branch's identical guard just below.
      if (toolMessages.length === 0 && assistantText.trim()) {
        thread.messages.push({ role: "assistant", content: assistantText });
      }
      yield { kind: "paused", reason: "idle-timeout", idleMs: pausedIdleMs, canContinue: true };
      break;
    }
    // The turn completes when the model asked for no tool this round — that is the only
    // signal that means "I am answering" rather than "I am working". `sawFinal` alone cannot
    // end a round in which tools ran, because showing the model what they returned IS the
    // round's purpose.
    if (toolMessages.length === 0) {
      /**
       * Fold the TERMINAL answer into the thread.
       *
       * The fold above only runs for a round that produced tool messages, so the one round
       * that carries the actual answer was never folded. That was harmless while the thread
       * was a scratch buffer for the multi-round loop and the hosts appended `res.reply`
       * themselves — but the thread is now the CROSS-TURN memory (`carryForward`), so leaving
       * the answer out means the agent remembers everything it read and nothing it said.
       * "What did you just tell me?" becomes unanswerable, and it re-derives conclusions it
       * had already reached.
       *
       * No double-push: a round with BOTH text and tool calls folds through the branch above,
       * whose `narration` already contains `assistantText`, and never reaches here.
       */
      /**
       * "I am about to do X" is not X.
       *
       * A round with no tool call is normally the answer — but a model that ends on
       * "Let me get started." has announced work and performed none, and ending there reports a
       * finished turn for a task nobody did. Observed live: `mkdir` in round 1, a plan in round
       * 2, turn over at 2 of 48, ten requested files never written. The same model carried
       * straight on when told by hand that nothing had been created, so the intent was real and
       * only the tool call was missing.
       *
       * Bounded, visible, and it does not force the outcome: the nudge explicitly permits "the
       * task is already complete", so a model that really has finished says so and the NEXT round
       * ends the turn through the ordinary path. `nudges` counts against the turn, never the
       * round, so this cannot become a loop of its own.
       */
      if (
        nudges < maxNudges &&
        round + 1 < maxRounds &&
        announcesUnfinishedWork(assistantText) &&
        !cancelled
      ) {
        nudges += 1;
        if (assistantText.trim()) {
          thread.messages.push({ role: "assistant", content: assistantText });
        }
        thread.messages.push({ role: "user", content: CONTINUATION_NUDGE });
        // Said out loud: a turn that silently continues after appearing to finish is worse than
        // one that stops, because the user cannot tell what the agent thinks it is doing.
        yield {
          kind: "status",
          text: `the model described work without doing it — asking it to act (nudge ${nudges}/${maxNudges})`,
        };
        continue;
      }
      if (assistantText.trim()) {
        thread.messages.push({ role: "assistant", content: assistantText });
      }
      break;
    }
    if (round + 1 >= maxRounds) {
      // CLI-072: the model STILL wanted a tool at the last allowed round — a PAUSE, not a
      // failure. Emit a distinct capped event (with this round's tool results already folded
      // into the thread above) so the host can offer `/continue` to resume with full state.
      yield { kind: "capped", rounds: maxRounds, canContinue: true };
      break;
    }
  }

  // Give every fire-and-forget PostToolUse hook a last chance to settle and report through
  // `onHookError` before the turn is declared done — see `pendingPostHooks`. These promises
  // never reject (hooks.ts swallows every failure into `onError`), so this never throws.
  await Promise.all(pendingPostHooks);
  while (hookErrors.length > 0) {
    yield { kind: "status", text: `hook: ${hookErrors.shift()}` };
  }
  yield { kind: "done" };
}

/**
 * The TOOL-DISCIPLINE rules — the load-bearing half of the system prompt, and the part
 * that is identical for every surface. Exported so the GUI composes the SAME sentences
 * instead of maintaining a weaker paraphrase (HANDOFF_2 §9 "GUI chat = CLI agent").
 *
 * Each sentence is here because a model got it wrong: the "printing does nothing on disk"
 * rule exists because models answer "create hello.py" by pretty-printing the file and
 * stopping, and the `propose_edit`-with-smallest-hunks rule exists because they otherwise
 * rewrite a whole file to change one line.
 *
 * NOTE (preamble dispatch): this text is now ALSO registered as a `PreambleContributor`
 * (`agent/protocol/contributors/tool-discipline.ts`), which is how the live CLI session finally
 * receives it — `cliProfiles.resolveTuning()` never called `defaultTuning()` below, so this
 * string was reachable only from tests and Desktop's hand-assembled `AGENT_PANE_SYSTEM`. This
 * export is UNCHANGED and stays exactly as it is for the hosts that still compose their own
 * persona string with it inline.
 */
export const AGENT_TOOL_DISCIPLINE =
  "To DO anything to the system you MUST call the matching tool. " +
  "To MODIFY an existing file, ALWAYS use `propose_edit` with the SMALLEST exact hunks (each hunk's `old` must be a unique, verbatim span of the current file — include a little surrounding context so it matches ONE place). " +
  "NEVER satisfy a 'create/write/edit this file' request by only printing the code in your reply: printing does nothing on disk. " +
  "Call the tool with the exact content instead, then confirm what you did. " +
  "Every action is permission-gated — the user is asked to approve before it runs — so act directly and let the gate handle safety. " +
  "Prefer reading the relevant files before acting; when you have enough information, answer directly without calling a tool.";

/** A sensible default tuning (the `default` profile resolves to ~this). */
export function defaultTuning(model: ModelRef): AgentTuning {
  return {
    model,
    // one sentence per line, joined — readable in source, a single paragraph to the model.
    systemPrompt: [
      "You are Prometheus, an agentic coding assistant running on the user's own machine with REAL tools.",
      "`write_file` creates a NEW file (pass the full content); `propose_edit` changes an EXISTING one; the prometheus verbs run/scan/install.",
      AGENT_TOOL_DISCIPLINE,
      "Do NOT rewrite a whole existing file with `write_file` — that is for brand-new files only, and overwriting loses precision.",
      "Always scan before installing; prefer free/local tools; never use --force.",
    ].join(" "),
    tools: { enabled: true, allow: [], deny: [] },
    gateMode: "enforce",
    dryRun: false,
    verbosity: "normal",
    yes: false,
  };
}
