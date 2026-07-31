/**
 * agents/orchestrator.ts — the single-agent ReAct loop (file 09 §4.2).
 *
 *   user task ─▶ model.next ─▶ {final | tool_call}
 *                                   │ tool_call
 *                                   ▼
 *                       ToolBroker (allowlist + §4.3 policy) ─▶ auto | confirm | block
 *                                   │ auto / confirmed
 *                                   ▼  dispatch ─▶ result ─▶ back to model
 *
 * The model client + tool dispatcher + annotation lookup + confirm callback are all
 * INJECTED, so the loop is pure + testable with fakes (no real model, no engine).
 * Every tool call passes through `brokerDecision` — the chokepoint can never be
 * bypassed; a destructive tool is never auto-fired.
 */
import type { ToolAnnotations } from "../mcp/server/index.js";
import { brokerDecision, grantFor } from "./toolBroker.js";
import type { AgentDef } from "./types.js";

export interface ToolCall {
  ref: string;
  args: Record<string, unknown>;
  id?: string;
}

export type ModelTurn = { kind: "final"; text: string } | { kind: "tool_call"; call: ToolCall };

export interface RunMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** The model the loop drives (local via Model Hub OR cloud) — injected. */
export interface ModelClient {
  next(messages: RunMessage[]): Promise<ModelTurn>;
}

/** Dispatch a (already broker-approved) tool call to its handler — injected. */
export type ToolDispatcher = (call: ToolCall) => Promise<unknown>;

export interface RunStep {
  ref: string;
  action: "auto" | "confirm" | "block" | "denied";
  result?: unknown;
  reason?: string;
}

export type RunStatus = "done" | "max-steps" | "error";

export interface RunResult {
  status: RunStatus;
  answer?: string;
  messages: RunMessage[];
  steps: RunStep[];
}

export interface OrchestratorDeps {
  model: ModelClient;
  dispatch: ToolDispatcher;
  annotationsFor(ref: string): ToolAnnotations | undefined;
  /** asked for any tool the broker marks "confirm"; default = deny (false). */
  confirm?(call: ToolCall): boolean | Promise<boolean>;
  maxSteps?: number;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Run an agent on a task through the ReAct loop. */
export async function runAgent(
  agent: AgentDef,
  task: string,
  deps: OrchestratorDeps,
): Promise<RunResult> {
  const maxSteps = deps.maxSteps ?? 16;
  const messages: RunMessage[] = [
    { role: "system", content: agent.system },
    { role: "user", content: task },
  ];
  const steps: RunStep[] = [];
  const counts = new Map<string, number>();

  for (let i = 0; i < maxSteps; i++) {
    let turn: ModelTurn;
    try {
      turn = await deps.model.next(messages);
    } catch (e) {
      return {
        status: "error",
        answer: e instanceof Error ? e.message : String(e),
        messages,
        steps,
      };
    }

    if (turn.kind === "final") {
      messages.push({ role: "assistant", content: turn.text });
      return { status: "done", answer: turn.text, messages, steps };
    }

    const call = turn.call;
    const grant = grantFor(agent.tools, call.ref);
    const annotations = deps.annotationsFor(call.ref);
    const callsSoFar = counts.get(call.ref) ?? 0;
    const decision = brokerDecision({ ref: call.ref, annotations, grant, callsSoFar });

    if (decision.action === "block") {
      steps.push({ ref: call.ref, action: "block", reason: decision.reason });
      messages.push({ role: "tool", content: `BLOCKED: ${decision.reason}` });
      continue;
    }
    if (decision.action === "confirm") {
      const approved = deps.confirm ? await deps.confirm(call) : false;
      if (!approved) {
        steps.push({ ref: call.ref, action: "denied", reason: decision.reason });
        messages.push({ role: "tool", content: `DENIED by policy: ${decision.reason}` });
        continue;
      }
    }

    const finalAction = decision.action === "auto" ? "auto" : "confirm";
    try {
      const result = await deps.dispatch(call);
      counts.set(call.ref, callsSoFar + 1);
      steps.push({ ref: call.ref, action: finalAction, result });
      messages.push({ role: "tool", content: safeJson(result) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      steps.push({ ref: call.ref, action: finalAction, reason: msg });
      messages.push({ role: "tool", content: `ERROR: ${msg}` });
    }
  }

  return { status: "max-steps", messages, steps };
}
