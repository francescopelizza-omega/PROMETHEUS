// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/fs-mutate.ts — Tier W: the file operations that CHANGE the tree.
 *
 * `system/tools.ts` is Tier R, and its header states the rule these obey: "Mutating tools go
 * in a later tier, in their own file, with their own annotations." Everything in Tier R is
 * `readOnlyHint`, which `classifyAuth` reads FIRST to auto-approve at A1 — so a mutating tool
 * added there would silently inherit that auto-approval. Hence a separate file and a separate
 * exported set, so a host opts in deliberately.
 *
 * Why these exist at all: the catalog could read, search, write and edit a file, but it could
 * not DELETE, RENAME or CREATE A DIRECTORY. The only route to any of those was `run_command`
 * — a shell-shaped detour for three structured operations, sitting at a higher permission
 * tier, where the model has to get quoting right and the human has to read a command line to
 * work out which file is about to disappear. "Rename this module" is an ordinary refactor,
 * and it should not require the agent to reach for a shell.
 *
 * ANNOTATIONS, and why each is what it is:
 *   - `delete_file` and `move_file` are `destructiveHint`, so the §4.3 broker ALWAYS routes
 *     them to a human — never auto-approved, not even under `tuning.yes`. Both can destroy
 *     data that no checkpoint captured.
 *   - `mkdir` carries no annotation, so it classifies as `config` (A3), matching `job_kill`.
 *     Creating a directory destroys nothing, but it is still a write to the tree and it is
 *     not something A1 "read freely" should cover.
 *
 * PURE: definitions only, no IO. The host implements dispatch, applies the working-set path
 * guard, and captures pre-images for revert exactly as it does for `write_file`.
 */

import type { ToolDef, ToolSchema } from "../tools.js";

const req = (description: string): ToolSchema[string] => ({
  type: "string",
  required: true,
  description,
});
const flag = (description: string): ToolSchema[string] => ({
  type: "boolean",
  default: false,
  description,
});

/** Host-dispatched: never an engine verb (same discipline as Tier R and `write_file`). */
function hostOnly(name: string): () => string[] {
  return () => {
    throw new Error(`${name} is served by the host runtime, not by prometheus.py`);
  };
}

/**
 * Delete a file, or a directory when `recursive` is set.
 *
 * `recursive` is a separate flag rather than inferred, because "delete this directory and
 * everything under it" is a different decision from "delete this file" and the human
 * approving it should see which one they are being asked.
 */
export const DELETE_FILE_TOOL: ToolDef = {
  name: "delete_file",
  title: "Delete a file or directory",
  description:
    "Delete a file. Set `recursive` to delete a directory and everything inside it. " +
    "The previous contents of a deleted FILE are captured first, so the change can be " +
    "reverted; a recursive directory delete cannot be undone. Requires human approval.",
  schema: {
    path: req("the file or directory to delete, relative to the working directory"),
    recursive: flag("delete a directory and all of its contents (cannot be undone)"),
  },
  annotations: { destructiveHint: true },
  toArgv: hostOnly("delete_file"),
};

/** Move or rename a path. Refuses to clobber unless `overwrite` is set. */
export const MOVE_FILE_TOOL: ToolDef = {
  name: "move_file",
  title: "Move or rename a file",
  description:
    "Move or rename a file or directory. Fails if the destination exists unless `overwrite` " +
    "is set. Missing parent directories of the destination are created. Requires human approval.",
  schema: {
    from: req("the existing path"),
    to: req("the new path"),
    overwrite: flag("replace the destination if it already exists"),
  },
  annotations: { destructiveHint: true },
  toArgv: hostOnly("move_file"),
};

/** Create a directory (and any missing parents). Creating nothing destroys nothing. */
export const MKDIR_TOOL: ToolDef = {
  name: "mkdir",
  title: "Create a directory",
  description:
    "Create a directory, including any missing parent directories. Succeeds quietly if it " +
    "already exists.",
  schema: { path: req("the directory to create, relative to the working directory") },
  annotations: {},
  toArgv: hostOnly("mkdir"),
};

/**
 * The Tier-W set, kept SEPARATE from `SYSTEM_TOOLS`.
 *
 * A host adds these explicitly. In particular the desktop agent pane does not: it dispatches
 * system tools over an IPC channel that has no implementation for them, and offering a tool
 * that cannot execute teaches the model to keep proposing it.
 */
export const SYSTEM_FS_WRITE_TOOLS: readonly ToolDef[] = Object.freeze([
  DELETE_FILE_TOOL,
  MOVE_FILE_TOOL,
  MKDIR_TOOL,
]);

/** Names only — for a host's dispatch table and for tests. */
export const SYSTEM_FS_WRITE_TOOL_NAMES: readonly string[] = Object.freeze(
  SYSTEM_FS_WRITE_TOOLS.map((t) => t.name),
);

/** Whether `name` is one of the Tier-W file mutators. */
export function isFsWriteTool(name: string): boolean {
  return SYSTEM_FS_WRITE_TOOL_NAMES.includes(name);
}
