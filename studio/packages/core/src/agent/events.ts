/**
 * agent/events.ts — the agent turn event stream (file 11 §3.2).
 *
 * `runAgentTurn` yields these in order: text deltas, a tool_use when the model
 * decides to call a tool, a verdict when a state-changing tool was gated, a
 * tool_result with the engine outcome, a blocked event when policy/gate stops a
 * call, and a final done. The CLI transcript + the GUI agent pane both render this
 * same stream.
 */
import type { ToolCall } from "./loop.js";

export type GateVerdictTier = "allow" | "warn" | "block" | "error";

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; call: ToolCall }
  | { kind: "verdict"; tool: string; verdict: GateVerdictTier; riskScore?: number }
  | { kind: "tool_result"; call: ToolCall; ok: boolean; summary: string; data?: unknown }
  | { kind: "blocked"; tool?: string; reason: string }
  // the turn hit its iteration cap with MORE tool work pending (CLI-072). A distinct,
  // additive event (not a fake `final`/`text`) so the host can offer `/continue` to
  // resume with the full prior tool state. `canContinue` is true whenever the model
  // still wanted a tool at the last allowed round. Existing `for await` switch/if
  // chains ignore this variant safely (it is purely additive).
  | { kind: "capped"; rounds: number; canContinue: boolean }
  | { kind: "done" };
