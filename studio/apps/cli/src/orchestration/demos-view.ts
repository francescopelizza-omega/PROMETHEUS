// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/demos-view.ts — the live `/demos` orchestration view (pure renderers).
 *
 * The coordinator streams RunEvents as the swarm works; these turn each into one
 * high-contrast line shown above the composer, so the user watches the orchestrator
 * dispatch, subagents work + talk, children spawn, and results flow back. Pure: event +
 * color caps → string. The command (demos-cmd) wires onEvent → ctx.write(renderEvent(…)).
 */
import type { orchestration } from "@prometheus/core";

import { type ColorCaps, paint } from "../tui/palette.js";
import type { AgentBoardState, Board } from "./demos-status-board.js";

type RunEvent = orchestration.RunEvent;
type OrchestrationTopology = orchestration.OrchestrationTopology;
type RunResult = orchestration.RunResult;
type Message = orchestration.Message;

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};
const indent = (depth: number): string => "  ".repeat(Math.max(0, depth));

/** One run event → a colored line (or null to skip). */
export function renderEvent(e: RunEvent, caps: ColorCaps): string | null {
  switch (e.type) {
    case "agent-start":
      return `${indent(e.depth)}${paint("▶", "accent", caps)} ${paint(e.agent, "brand", caps)} ${paint(`· ${clip(e.task, 64)}`, "muted", caps)}`;
    case "dispatch":
      return `${paint("  ├─", "muted", caps)} ${paint(e.from, "brand", caps)} ${paint("→", "muted", caps)} ${paint(e.to, "command", caps)}: ${paint(clip(e.task, 56), "info", caps)}`;
    case "spawn":
      return `${paint("  ✦", "command", caps)} ${paint(`spawned ${e.child}`, "command", caps)} ${paint(`= ${e.backend}`, "modelOpen", caps)} ${paint(`(by ${e.parent})`, "muted", caps)}`;
    case "agent-end":
      return `${indent(e.depth)}${paint("◀", "modelOpen", caps)} ${paint(e.agent, "brand", caps)}: ${paint(clip(e.result, 72), "plain", caps)}`;
    case "blocked":
      return `${paint("  ✖", "danger", caps)} ${paint(e.agent, "brand", caps)} ${paint(`blocked: ${clip(e.reason, 64)}`, "danger", caps)}`;
    default:
      return null;
  }
}

/**
 * One persisted bus MESSAGE → a colored line, for `/demos replay` (CLI-073). The persisted run
 * log is the message bus (not the live RunEvent stream), so replay renders Messages — but through
 * THIS same demos-view projector + palette, so a replayed timeline looks identical in style to a
 * live run. Pure + side-effect-free (read-only inspection: it never invokes a backend).
 */
export function renderMessage(m: Message, caps: ColorCaps): string {
  const arrow =
    m.to && m.to !== m.from
      ? `${paint(m.from, "brand", caps)} ${paint("→", "muted", caps)} ${paint(m.to, "command", caps)}`
      : paint(m.from, "brand", caps);
  const body = clip(m.content, 72);
  switch (m.kind) {
    case "task":
      return `${paint("  ├─", "muted", caps)} ${arrow}: ${paint(body, "info", caps)}`;
    case "result":
      return `${paint("  ◀", "modelOpen", caps)} ${arrow}: ${paint(body, "plain", caps)}`;
    case "question":
      return `${paint("  ?", "question", caps)} ${arrow}: ${paint(body, "question", caps)}`;
    case "answer":
      return `${paint("  ↩", "accent", caps)} ${arrow}: ${paint(body, "plain", caps)}`;
    case "spawn":
      return `${paint("  ✦", "command", caps)} ${arrow}: ${paint(body, "modelOpen", caps)}`;
    case "error":
      return `${paint("  ✖", "danger", caps)} ${arrow}: ${paint(body, "danger", caps)}`;
    case "log":
      return `${paint("  ·", "muted", caps)} ${paint(m.from, "muted", caps)}: ${paint(body, "muted", caps)}`;
    default: // "msg"
      return `${paint("  ·", "muted", caps)} ${arrow}: ${paint(body, "muted", caps)}`;
  }
}

/** A header announcing the swarm about to run. */
export function renderRunHeader(t: OrchestrationTopology, goal: string, caps: ColorCaps): string {
  const roster = t.agents
    .map((a) => {
      const tag =
        a.backend.kind === "cli"
          ? a.backend.service
          : a.backend.kind === "api"
            ? `api:${a.backend.service ?? "?"}`
            : a.backend.kind === "local"
              ? `local:${a.backend.model ?? "?"}`
              : a.backend.kind;
      const star = a.name === t.orchestrator ? "★" : "•";
      return `  ${paint(star, a.name === t.orchestrator ? "brand" : "muted", caps)} ${paint(a.name, "accent", caps)} ${paint(`[${tag}]`, "modelOpen", caps)} ${paint(a.role, "muted", caps)}`;
    })
    .join("\n");
  return [
    paint("▣ /demos swarm", "brand", caps),
    `${paint("goal:", "muted", caps)} ${paint(clip(goal, 80), "question", caps)}`,
    roster,
    paint("─".repeat(40), "muted", caps),
  ].join("\n");
}

/** Icon + palette role per board state (CLI-074) — reuses the demos-view paint tokens (no raw hex). */
const BOARD_STYLE: Record<AgentBoardState, { icon: string; role: Parameters<typeof paint>[1] }> = {
  idle: { icon: "○", role: "muted" },
  busy: { icon: "●", role: "accent" },
  dead: { icon: "✖", role: "danger" },
};

/**
 * Render the live participant board (CLI-074): one fixed line per agent — state icon, id, state,
 * and the last message that touched it. `order` is the topology order (stable rows so a live
 * redraw overwrites in place). Pure: board + order + caps → string.
 */
export function renderBoard(board: Board, order: readonly string[], caps: ColorCaps): string {
  return order
    .map((id) => {
      const e = board[id] ?? { state: "idle" as AgentBoardState, lastActivityAt: 0 };
      const { icon, role } = BOARD_STYLE[e.state];
      const note = e.lastMessage ? ` ${paint(`· ${clip(e.lastMessage, 48)}`, "muted", caps)}` : "";
      return `  ${paint(icon, role, caps)} ${paint(id.padEnd(12), "brand", caps)} ${paint(e.state, role, caps)}${note}`;
    })
    .join("\n");
}

/** A summary line after the run (invocations, cost, agents). */
export function renderRunSummary(r: RunResult, caps: ColorCaps): string {
  const cost = r.spentUsd > 0 ? ` · $${r.spentUsd.toFixed(2)}` : "";
  return [
    paint("─".repeat(40), "muted", caps),
    `${paint("✓ swarm done", "modelOpen", caps)} ${paint(`· ${r.invocations} agent calls · ${r.agents.length} agents${cost}`, "muted", caps)}`,
    "",
    paint(r.answer || "(no answer)", "plain", caps),
  ].join("\n");
}
