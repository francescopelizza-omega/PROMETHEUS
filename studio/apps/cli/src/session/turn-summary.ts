// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/turn-summary.ts — a one-line, mechanical "what did this prompt do" summary.
 *
 * Feeds the `/restore` (`/recall`) picker's right-hand column: after every completed turn the
 * host persists this against the session's index record (`history-store.ts`'s
 * `updateSessionSummary`), so a user picking a session sees what actually HAPPENED, not just the
 * first prompt's opening words (that stays `descriptor` — a stable identity label; this is the
 * freshest state).
 *
 * Deliberately NOT a model call: an LLM round-trip per turn just to caption the turn would add
 * real latency/cost to every single prompt for a label nobody reads until they are browsing old
 * sessions. Tool activity is real signal the model already produced for free — reading it back
 * out of `AgentEvent`s costs nothing.
 */
import type { agent } from "@prometheus/core";

import { descriptorOf } from "./history-store.js";

const WRITE_TOOLS = new Set(["write_file", "apply_patch", "propose_edit"]);
const DELETE_TOOLS = new Set(["delete_file"]);
const MOVE_TOOLS = new Set(["move_file"]);
const RUN_TOOLS = new Set(["run_command"]);

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Collapse whitespace (incl. embedded newlines) to a single space. An MCP server's tool NAME
 * (unlike its already-sanitized description — see `mcp-tools.ts`'s `describe()`) reaches
 * `ToolCall.name` completely raw — this is what keeps a hostile/buggy server's
 * `"list\nfiles"`-shaped name from splitting `formatPicker`'s one-line-per-record layout once it
 * lands in a persisted `lastSummary`.
 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A short, human summary of one turn's actions, for the session-history picker. Pure. */
export function turnSummaryOf(prompt: string, events: readonly agent.AgentEvent[]): string {
  let writes = 0;
  let deletes = 0;
  let moves = 0;
  let runs = 0;
  const others = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== "tool_use") continue;
    const name = ev.call.name;
    if (WRITE_TOOLS.has(name)) writes++;
    else if (DELETE_TOOLS.has(name)) deletes++;
    else if (MOVE_TOOLS.has(name)) moves++;
    else if (RUN_TOOLS.has(name)) runs++;
    else others.add(oneLine(name));
  }
  const parts: string[] = [];
  if (writes > 0) parts.push(`edited ${plural(writes, "file")}`);
  if (deletes > 0) parts.push(`deleted ${plural(deletes, "file")}`);
  if (moves > 0) parts.push(`moved ${plural(moves, "file")}`);
  if (runs > 0) parts.push(`ran ${plural(runs, "command")}`);
  if (others.size > 0) parts.push(`used ${[...others].slice(0, 3).join(", ")}`);

  const promptBit = descriptorOf(prompt, 10);
  return parts.length > 0 ? `${parts.join(" · ")} — ${promptBit}` : promptBit;
}
