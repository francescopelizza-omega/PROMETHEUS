// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * route-table.ts — the SINGLE source of truth for the routed-verb set (CLI-050).
 *
 * A LEAF module (imported by both index.ts and commands/help.ts, imports neither) so the router's
 * `RECOGNIZED` set, the `help` usage screen, and the `help --json` commands array all derive from
 * ONE list — a verb can never ship routed-but-unlisted (or listed-but-unrouted). The full routed
 * set is the §2 nouns + prom-native verbs (RECOGNIZED_VERBS) UNION the user-facing single-token
 * CommandSpec ids (`specIdFor` routes those); the internal engine-subcommand aliases (env-list =
 * `env list`, …) are excluded — users type the §2 form, not the hyphenated alias.
 */
import { listCommandSpecs } from "@prometheus/core";

/**
 * The §2 nouns + prom-native verbs the dispatcher recognizes DIRECTLY (not via a CommandSpec).
 * `index.ts` builds its `RECOGNIZED` Set from this — keep it the ground truth of direct routing.
 */
export const RECOGNIZED_VERBS: readonly string[] = [
  // Directly routed in `index.ts` but absent from this list until now, so neither the shell
  // completion nor the router's "did you mean" could offer them even though all three run:
  // `prometheus completion bash`, `prometheus man`, `prometheus ls`. This list's own docstring
  // calls itself the ground truth of direct routing, so the omission was the bug.
  "completion",
  "man",
  "ls",
  "scan",
  "superscan",
  "doctor",
  "health",
  "matrix",
  "inventory",
  "gate",
  "list",
  "info",
  "secure",
  "plugin",
  "skill",
  "env",
  "model",
  "repo",
  "metadata",
  "app",
  "worldsim",
  "pentest",
  "localai",
  "provider",
  "agents",
  "mcp",
  "chat",
  "repl",
  "tui",
  "session",
  "sessions",
  "schedule",
  "tasks",
  "persona",
  "budget",
  "meet",
  "profile",
  "config",
  "updates",
  "keymap",
  "test",
  "diagram",
  "refactor",
  "tokens",
  "version",
  "help",
];

/** CommandSpec ids that are INTERNAL engine-subcommand aliases, not user-typed single-token verbs. */
const INTERNAL_SPEC_IDS = new Set([
  "env-list",
  "model-hw",
  "provider-list",
  "secure-scan",
  "nemesis",
]);

/**
 * The canonical routed-verb list = the direct §2/native verbs UNION the user-facing single-token
 * CommandSpec ids. Deduped + sorted so the `help --json` commands array is deterministic. This is
 * the ONE list both help surfaces render from; a new CommandSpec verb appears here automatically.
 */
export const ROUTED_VERBS: readonly string[] = [
  ...new Set([
    ...RECOGNIZED_VERBS,
    ...listCommandSpecs("CLI")
      .map((s) => s.id)
      .filter((id) => !INTERNAL_SPEC_IDS.has(id)),
  ]),
].sort();
