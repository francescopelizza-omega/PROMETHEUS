/**
 * repl/state.ts — the REPL state machine (file 11 §3, PURE reducer).
 *
 * Holds the transcript, the live AgentTuning, the active pane, cwd, and input
 * history. A pure reducer applies ReplEvents (message append, pane switch/cycle,
 * clear, tuning change, history). `tuneFromSlash` maps a §3.1 tuning slash to a
 * tuning patch. The Ink view dispatches events; the brain stays framework-free.
 */
import type { AgentTuning } from "../agent/loop.js";
import { parseModelRef } from "../cli-profiles/profile.js";
import { type PaneId, cyclePane } from "./panes.js";

export interface ReplMessage {
  role: "you" | "prom" | "system";
  text: string;
}

export interface ReplState {
  transcript: ReplMessage[];
  tuning: AgentTuning;
  activePane: PaneId;
  cwd: string;
  history: string[];
}

export function initialReplState(tuning: AgentTuning, cwd: string): ReplState {
  return { transcript: [], tuning, activePane: "transcript", cwd, history: [] };
}

export type ReplEvent =
  | { type: "message"; role: ReplMessage["role"]; text: string }
  | { type: "set-pane"; pane: PaneId }
  | { type: "cycle-pane"; dir?: 1 | -1 }
  | { type: "clear" }
  | { type: "tune"; patch: Partial<AgentTuning> }
  | { type: "cwd"; dir: string }
  | { type: "history"; input: string };

/** Pure reducer: apply one event to the state, returning a new state. */
export function reduce(state: ReplState, event: ReplEvent): ReplState {
  switch (event.type) {
    case "message":
      return {
        ...state,
        transcript: [...state.transcript, { role: event.role, text: event.text }],
      };
    case "set-pane":
      return { ...state, activePane: event.pane };
    case "cycle-pane":
      return { ...state, activePane: cyclePane(state.activePane, event.dir ?? 1) };
    case "clear":
      return { ...state, transcript: [] };
    case "tune":
      return { ...state, tuning: { ...state.tuning, ...event.patch } };
    case "cwd":
      return { ...state, cwd: event.dir };
    case "history":
      // de-dup consecutive identical inputs
      if (state.history.at(-1) === event.input) return state;
      return { ...state, history: [...state.history, event.input] };
    default:
      return state;
  }
}

/**
 * Map a §3.1 tuning slash (/model /system /tools /gate /dry-run /verbosity /yes) to a
 * tuning patch. Returns null for a non-tuning slash or an unparseable value.
 */
export function tuneFromSlash(
  name: string,
  rest: string,
  tuning: AgentTuning,
): Partial<AgentTuning> | null {
  const v = rest.trim();
  switch (name) {
    case "model":
      return v ? { model: parseModelRef(v) } : null;
    case "system":
      return v ? { systemPrompt: v } : null;
    case "tools":
      if (v === "on") return { tools: { ...tuning.tools, enabled: true } };
      if (v === "off") return { tools: { ...tuning.tools, enabled: false } };
      return null; // "list" is a view action, not a tuning change
    case "gate":
      return v === "enforce" || v === "warn" || v === "off" ? { gateMode: v } : null;
    case "dry-run":
      if (v === "on") return { dryRun: true };
      if (v === "off") return { dryRun: false };
      return null;
    case "verbosity":
      return v === "quiet" || v === "normal" || v === "debug" ? { verbosity: v } : null;
    case "yes":
      if (v === "on") return { yes: true };
      if (v === "off") return { yes: false };
      return null;
    default:
      return null;
  }
}
