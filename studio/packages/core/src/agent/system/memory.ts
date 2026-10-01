// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/memory.ts — the `memory_write` / `memory_read` tool DEFS (durable cross-session
 * facts). Sibling to `fs-mutate.ts`: definitions only, PURE, no IO — the host
 * (`host/memory-store.ts`) implements discovery, validation-application and persistence.
 *
 * WHY A SEPARATE TOOL FROM `/memory` (session/steering.ts). `/memory` shows the model
 * AGENTS.md / CLAUDE.md / PROMETHEUS.md — static files a human maintains, re-read fresh every
 * turn. This is the opposite direction: the AGENT writing down something IT learned, that
 * should outlive this one thread. Same project, same "read it back next time" goal, entirely
 * different authorship and lifecycle — hence a different store, not a new section of the same
 * file.
 *
 * `memory_write`'S DESCRIPTION IS A GATE, NOT DECORATION. The single biggest risk of an
 * agent-writable persistent store is that it fills up with noise nobody reads: a copy of the
 * repo's own README, "user asked me to fix the login bug" (the task, not a fact about the
 * project), a code pattern any `grep` would re-derive. Every one of those makes the index the
 * NEXT session reads longer and less trustworthy. The description therefore states the
 * negative space explicitly (mirrors how `agent/system/tools.ts` states the positive one) —
 * a model skimming tool descriptions should come away knowing what NOT to call this for.
 *
 * `memory_write` carries no `readOnlyHint` (it mutates the project's memory store) and no
 * `destructiveHint` (create-or-update of a small note is not the same risk as deleting a file);
 * it classifies as `config`, same tier as `mkdir`. `memory_read` is `readOnlyHint` — cheap,
 * auto-approved, the model should reach for it as freely as `read_file`.
 */
import type { ToolDef, ToolSchema } from "../tools.js";

const req = (description: string): ToolSchema[string] => ({
  type: "string",
  required: true,
  description,
});
const optStr = (description: string): ToolSchema[string] => ({ type: "string", description });

/** Host-dispatched: never an engine verb (same discipline as Tier R/W). */
function hostOnly(name: string): () => string[] {
  return () => {
    throw new Error(`${name} is served by the host runtime, not by prometheus.py`);
  };
}

export const MEMORY_WRITE_TOOL: ToolDef = {
  name: "memory_write",
  title: "Record a durable project fact",
  description:
    "Record ONE durable, non-obvious fact about THIS project that should be remembered in " +
    "future, UNRELATED conversations — not just this one. Organize by TOPIC: writing again " +
    "with the same `name` REPLACES that topic's note, it does not append a log entry. " +
    "Examples of what belongs here: a deployment gotcha discovered the hard way, a decision " +
    "and the reason for it, an external constraint (a flaky CI runner, an API's undocumented " +
    "rate limit), a convention that isn't written down anywhere else. " +
    "Do NOT use this for: ephemeral task state (what you are doing right now — that belongs " +
    "in your own working notes, not here); anything a fresh `read_file`/`grep` of the repo " +
    "would tell you again just as easily (code structure, function signatures, file layout); " +
    "or anything already covered by this project's AGENTS.md / CLAUDE.md — if it belongs " +
    "there, propose an edit to that file instead of writing a memory entry. " +
    "`why` is required and is not saved verbatim — it is the check that the fact actually " +
    "clears this bar before it is written.",
  schema: {
    name: req(
      'a short topic title, e.g. "deploy: staging migration order". Reusing an existing ' +
        "name overwrites that topic's note.",
    ),
    description: req("one line: what this fact is (shown in the index other sessions read)"),
    category: req('a short grouping label, e.g. "infra", "conventions", "gotcha", "decision"'),
    why: req(
      "one sentence: why must this survive into a DIFFERENT conversation, not just this one? " +
        '"it was useful just now" is not enough.',
    ),
    body: req("the durable fact itself, in full — this is what memory_read returns later"),
  },
  annotations: {},
  toArgv: hostOnly("memory_write"),
};

export const MEMORY_READ_TOOL: ToolDef = {
  name: "memory_read",
  title: "Read project memory",
  description:
    "Read this project's durable memory. Omit `topic` to get the INDEX — a cheap summary of " +
    "every recorded topic's name/category/description, already folded into your system " +
    "prompt at session start, so you rarely need to call this with no arguments. Pass `topic` " +
    "(the name shown in the index) to read that ONE entry's full note before relying on it.",
  schema: {
    topic: optStr("the topic name from the index; omit to re-fetch the index itself"),
  },
  annotations: { readOnlyHint: true },
  toArgv: hostOnly("memory_read"),
};

/** The memory tool pair, kept SEPARATE from `SYSTEM_TOOLS` (same reasoning as Tier W: a host
 *  opts in explicitly, and the desktop pane's dispatch table must admit them too). */
export const SYSTEM_MEMORY_TOOLS: readonly ToolDef[] = Object.freeze([
  MEMORY_WRITE_TOOL,
  MEMORY_READ_TOOL,
]);

export const SYSTEM_MEMORY_TOOL_NAMES: readonly string[] = Object.freeze(
  SYSTEM_MEMORY_TOOLS.map((t) => t.name),
);

/** Whether `name` is one of the two memory tools. */
export function isMemoryTool(name: string): boolean {
  return SYSTEM_MEMORY_TOOL_NAMES.includes(name);
}
