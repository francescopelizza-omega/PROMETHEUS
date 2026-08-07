import { brokerDecision } from "../agents/toolBroker.js";
import type { ModelRef } from "../agents/types.js";
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
import type { AgentEvent, GateVerdictTier } from "./events.js";
import {
  type AgentToolPolicy,
  type ToolName,
  exposedTools,
  isForceArg,
  stripForce,
} from "./tools.js";

export interface AgentTuning {
  model: ModelRef;
  systemPrompt: string;
  tools: AgentToolPolicy;
  gateMode: "enforce" | "warn" | "off";
  dryRun: boolean;
  verbosity: "quiet" | "normal" | "debug";
  yes: boolean;
  /** reasoning effort for the bound worker model (the `/think` command). Optional.
   *  Translated per-backend by `ai/effort` — NOT forwarded raw, because the same intent is
   *  `reasoning_effort` on one endpoint, `think` on another, and unsendable on a third. */
  effort?: "off" | "low" | "medium" | "high" | "max";
  /** max model⇄tool rounds per turn (CLI-032); default 8. A hard runaway backstop — NOT a
   *  product limit: on reaching it the loop emits a `capped` event and the host offers
   *  `/continue` (CLI-072). Honored from config via `agent.maxIterations` (resolveTuning). */
  maxRounds?: number;
}

/** Default cap on model⇄tool rounds in one turn (CLI-032). */
export const DEFAULT_MAX_ROUNDS = 8;

/** Byte budget for a single tool output folded back into the thread (head+tail, CLI-032). */
export const TOOL_OUTPUT_CAP_BYTES = 16 * 1024;

/**
 * Byte-cap a tool's output (multibyte-safe) for the follow-up round: under budget → verbatim;
 * over → head + `…[truncated N bytes]…` + tail (each half of the budget). Slices on Buffer
 * boundaries — a split UTF-8 sequence degrades to U+FFFD, never an under-counted char slice.
 */
export function capBytes(text: string, maxBytes: number = TOOL_OUTPUT_CAP_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, half).toString("utf8");
  const tail = buf.subarray(buf.byteLength - half).toString("utf8");
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
  | { kind: "final"; text?: string };

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
export type ConfirmResult = boolean | { approved: boolean; reason?: string };

export interface AgentTurnDeps {
  llm: LLMClient;
  runTool: ToolRunner;
  /** asked before a non-auto-approvable tool runs; default = deny. */
  confirm?: (call: ToolCall) => ConfirmResult | Promise<ConfirmResult>;
}

function withDryRun(args: Record<string, unknown>, dryRun: boolean): Record<string, unknown> {
  return dryRun ? { ...args, dryRun: true } : args;
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
  const maxRounds = Math.max(1, tuning.maxRounds ?? DEFAULT_MAX_ROUNDS);

  for (let round = 0; round < maxRounds; round++) {
    let assistantText = "";
    let sawFinal = false;
    const toolMessages: string[] = [];

    // multi-round visibility (CLI): after the first round, tell the user we're continuing
    // (the model asked for another tool step) so a long agentic turn never looks like a hang.
    if (round > 0) {
      yield { kind: "status", text: `continuing — round ${round + 1}/${maxRounds}` };
    }

    for await (const turn of deps.llm.turn(thread, tuning, tools)) {
      if (turn.kind === "status") {
        // wrapper progress note (waiting/timeout/etc.): surface live, never persist.
        yield { kind: "status", text: turn.text };
        continue;
      }
      if (turn.kind === "reasoning") {
        // thinking tokens: surface as live feedback but NEVER fold into assistantText /
        // the persisted thread (reasoning is ephemeral, not part of the answer).
        yield { kind: "reasoning", text: turn.text };
        continue;
      }
      if (turn.kind === "text") {
        assistantText += turn.text;
        yield { kind: "text", text: turn.text };
        continue;
      }
      if (turn.kind === "final") {
        if (turn.text) {
          assistantText += turn.text;
          yield { kind: "text", text: turn.text };
        }
        sawFinal = true;
        break;
      }

      const call = turn.call;
      // INVARIANT (§4): the agent may NEVER use --force.
      if (isForceArg(call.args)) {
        const reason =
          "the agent is forbidden from using --force; a human must type the confirmation";
        yield { kind: "blocked", tool: call.name, reason };
        toolMessages.push(toolResultMessage(call.name, { blocked: true, reason }));
        continue;
      }
      const tool = byName.get(call.name);
      if (!tool) {
        const reason = `tool "${call.name}" is not exposed`;
        yield { kind: "blocked", tool: call.name, reason };
        toolMessages.push(toolResultMessage(call.name, { blocked: true, reason }));
        continue;
      }

      // §4.3 broker: read-only + tuning.yes is the only auto path; destructive always confirms.
      const decision = brokerDecision({
        ref: call.name,
        annotations: tool.annotations,
        grant: { ref: call.name, autoApprove: tuning.yes },
      });
      if (decision.action === "block") {
        yield { kind: "blocked", tool: call.name, reason: decision.reason };
        toolMessages.push(toolResultMessage(call.name, { blocked: true, reason: decision.reason }));
        continue;
      }
      if (decision.action === "confirm") {
        const answer: ConfirmResult = deps.confirm ? await deps.confirm(call) : false;
        const approved = typeof answer === "boolean" ? answer : answer.approved;
        if (!approved) {
          const reason = typeof answer === "object" ? answer.reason : undefined;
          if (reason) {
            // a REASONED rejection → a normal tool_result so the model re-plans (CLI-010).
            yield { kind: "tool_result", call, ok: false, summary: `user rejected: ${reason}` };
          } else {
            yield { kind: "blocked", tool: call.name, reason: "declined at confirmation" };
          }
          // EITHER way the decline re-enters the thread so the model re-plans (CLI-032).
          toolMessages.push(
            toolResultMessage(call.name, {
              denied: true,
              reason: reason ?? "declined at confirmation",
            }),
          );
          continue;
        }
      }

      yield { kind: "tool_use", call };
      let outcome: ToolOutcome;
      try {
        outcome = await deps.runTool(tool, withDryRun(stripForce(call.args), tuning.dryRun));
      } catch (e) {
        const summary = e instanceof Error ? e.message : String(e);
        yield { kind: "tool_result", call, ok: false, summary };
        toolMessages.push(toolResultMessage(call.name, { ok: false, summary }));
        continue;
      }

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
          yield { kind: "blocked", tool: call.name, reason };
          toolMessages.push(toolResultMessage(call.name, { blocked: true, reason }));
          continue;
        }
        if (outcome.verdict.verdict === "error" && tuning.gateMode === "enforce") {
          const reason = "scan failed (fail-closed) — aborted";
          yield { kind: "blocked", tool: call.name, reason };
          toolMessages.push(toolResultMessage(call.name, { blocked: true, reason }));
          continue;
        }
      }

      yield {
        kind: "tool_result",
        call,
        ok: outcome.ok,
        summary: outcome.summary,
        data: outcome.data,
      };
      toolMessages.push(
        toolResultMessage(call.name, {
          ok: outcome.ok,
          summary: outcome.summary,
          data: outcome.data,
        }),
      );
    }

    // The turn completes when the model said `final` or asked for no tool this round.
    if (sawFinal || toolMessages.length === 0) break;
    // Otherwise fold this round's assistant text + tool results into the thread and loop.
    if (assistantText) thread.messages.push({ role: "assistant", content: assistantText });
    for (const tm of toolMessages) thread.messages.push({ role: "tool", content: tm });
    if (round + 1 >= maxRounds) {
      // CLI-072: the model STILL wanted a tool at the last allowed round — a PAUSE, not a
      // failure. Emit a distinct capped event (with this round's tool results already folded
      // into the thread above) so the host can offer `/continue` to resume with full state.
      yield { kind: "capped", rounds: maxRounds, canContinue: true };
      break;
    }
  }

  yield { kind: "done" };
}

/** A sensible default tuning (the `default` profile resolves to ~this). */
export function defaultTuning(model: ModelRef): AgentTuning {
  return {
    model,
    systemPrompt:
      "You are Prometheus, an agentic coding assistant running on the user's own machine with REAL tools. " +
      "To DO anything to the system you MUST call the matching tool — `write_file` to create a NEW file (pass the full content), " +
      "`propose_edit` to change an EXISTING file, and the prometheus verbs to run/scan/install. " +
      "To MODIFY an existing file, ALWAYS use `propose_edit` with the SMALLEST exact hunks (each hunk's `old` must be a unique, verbatim span of the current file — include a little surrounding context so it matches ONE place); " +
      "do NOT rewrite a whole existing file with `write_file` — that is for brand-new files only, and overwriting loses precision. " +
      "NEVER satisfy a 'create/write/edit this file' request by only printing the code in your reply: printing does nothing on disk. " +
      "Call the tool with the exact content instead, then confirm what you did. " +
      "Every action is permission-gated — the user is asked to approve before it runs — so act directly and let the gate handle safety. " +
      "Always scan before installing; prefer free/local tools; never use --force.",
    tools: { enabled: true, allow: [], deny: [] },
    gateMode: "enforce",
    dryRun: false,
    verbosity: "normal",
    yes: false,
  };
}
