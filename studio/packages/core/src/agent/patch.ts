// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/patch.ts — one edit across N files, all of it or none of it.
 *
 * `propose_edit` takes `{path, hunks}` — a single file. A rename-and-update-its-callers
 * refactor is therefore N separate tool calls, N separate approvals, and — the part that
 * actually bites — NO ATOMICITY: calls 1 to 3 apply, call 4's hunk no longer matches because
 * the file moved under it, and the working tree is left half-migrated. The user is then
 * holding a broken repo and a model that believes it succeeded.
 *
 * So `apply_patch` resolves EVERYTHING first and writes only if everything resolved. The two
 * phases are the whole design:
 *
 *   1. **Resolve.** Every hunk in every file is matched against that file's current bytes via
 *      the same `applyProposedEdit` + `RUNGS` ladder `propose_edit` uses. Nothing is written.
 *   2. **Commit.** Only if phase 1 succeeded for every file. A failure in phase 1 writes
 *      nothing at all and names the file and hunk that failed, so the model can re-read and
 *      retry rather than guess which half landed.
 *
 * Reusing `applyProposedEdit` is not a convenience — a second matching implementation would
 * drift from the ladder, and the ladder is the part that makes exact-match editing survive
 * whitespace and line-ending differences.
 *
 * PURE: the caller supplies the current text of each file and writes the results. No node, no
 * IO — which is also what makes the all-or-nothing property testable without a filesystem.
 */

import { applyProposedEdit } from "./edit.js";
import type { EditHunk } from "./edit.js";
import type { ToolDef } from "./tools.js";

/** One file's worth of a patch. */
export interface PatchFile {
  path: string;
  hunks: EditHunk[];
  /**
   * How many hunks for this file were MALFORMED and thrown away by the parser.
   *
   * A dropped hunk applies fewer edits than the model intended while the tool still reports
   * `ok` — and `describePatch` then reports the reduced count as though it were the whole patch.
   * That is bad for any edit tool and worse for this one, whose entire promise is that the
   * change is atomic: a half-applied refactor is exactly the state apply_patch exists to avoid.
   * The single-file sibling already surfaces this (`parseHunksResult.dropped`, which the CLI
   * runtime treats as a hard failure); this parser dropped silently, so the caller could not.
   */
  dropped: number;
}

/** What a resolved file will become — held until every file has resolved. */
export interface ResolvedFile {
  path: string;
  next: string;
  applied: number;
}

export type PatchResult =
  | { ok: true; files: ResolvedFile[]; totalHunks: number }
  | { ok: false; path: string; hunk: number; code: string; message: string };

/** Read the current text of a file, or null when it does not exist. */
export type ReadFile = (path: string) => string | null;

/**
 * Resolve a whole patch. Returns every file's new content, or the FIRST failure.
 *
 * Stops at the first failure on purpose: the model needs one precise thing to fix, and
 * reporting six cascading failures from one stale read buries it.
 */
export function resolvePatch(files: readonly PatchFile[], read: ReadFile): PatchResult {
  if (files.length === 0) {
    return { ok: false, path: "", hunk: 0, code: "empty", message: "the patch has no files" };
  }
  const resolved: ResolvedFile[] = [];
  let totalHunks = 0;
  for (const file of files) {
    if (!file.path) {
      return { ok: false, path: "", hunk: 0, code: "empty", message: "a patch entry has no path" };
    }
    if (!Array.isArray(file.hunks) || file.hunks.length === 0) {
      return {
        ok: false,
        path: file.path,
        hunk: 0,
        code: "empty",
        message: `no hunks for ${file.path}`,
      };
    }
    const current = read(file.path);
    if (current === null) {
      return {
        ok: false,
        path: file.path,
        hunk: 0,
        code: "no-file",
        message: `no such file: ${file.path} (apply_patch edits EXISTING files; use write_file to create one)`,
      };
    }
    /**
     * `{ fallback: true }` — the ladder, not just the exact rung.
     *
     * This called `applyProposedEdit` with no options, so `opts.fallback` was falsy and
     * `resolveHunk` returned after the EXACT match: the trailing-whitespace, indent, blank-skip
     * and anchor rungs never ran. The module header two dozen lines up says every hunk is matched
     * "via the same `applyProposedEdit` + `RUNGS` ladder `propose_edit` uses", and adds that
     * reusing it "is not a convenience — a second matching implementation would drift from the
     * ladder". It drifted anyway, through a default: `propose_edit`'s real call site passes the
     * flag and this one did not, so the ATOMIC multi-file tool failed on exactly the whitespace
     * drift its single-file sibling recovers from.
     */
    const r = applyProposedEdit(current, file.hunks, { fallback: true });
    if (!r.ok) {
      return { ok: false, path: file.path, hunk: r.hunk, code: r.code, message: r.message };
    }
    resolved.push({ path: file.path, next: r.next, applied: r.applied });
    totalHunks += r.applied;
  }
  return { ok: true, files: resolved, totalHunks };
}

/** A one-line human summary of a successful patch. */
export function describePatch(files: readonly ResolvedFile[], totalHunks: number): string {
  const f = files.length;
  return `applied ${totalHunks} hunk${totalHunks === 1 ? "" : "s"} across ${f} file${f === 1 ? "" : "s"}: ${files
    .map((x) => x.path)
    .join(", ")}`;
}

/**
 * Coerce the model's `edits` argument into `PatchFile[]`.
 *
 * Tolerant in the same two ways `parseHunks` is, and for the same reason — models send a JSON
 * string for an array constantly, and a lost patch is a far worse outcome than a lenient parse.
 */
export function parsePatchFiles(raw: unknown): PatchFile[] {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? (() => {
          try {
            const p: unknown = JSON.parse(raw);
            return Array.isArray(p) ? p : [];
          } catch {
            return [];
          }
        })()
      : [];
  const out: PatchFile[] = [];
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const path = typeof rec.path === "string" ? rec.path.trim() : "";
    if (!path) continue;
    const rawHunks = Array.isArray(rec.hunks)
      ? rec.hunks
      : typeof rec.hunks === "string"
        ? (() => {
            try {
              const p: unknown = JSON.parse(rec.hunks as string);
              return Array.isArray(p) ? p : [];
            } catch {
              return [];
            }
          })()
        : [];
    const hunks: EditHunk[] = [];
    let dropped = 0;
    for (const h of rawHunks) {
      if (h && typeof h === "object") {
        const hr = h as Record<string, unknown>;
        if (typeof hr.old === "string" && typeof hr.new === "string") {
          hunks.push({ old: hr.old, new: hr.new });
          continue;
        }
      }
      dropped += 1;
    }
    out.push({ path, hunks, dropped });
  }
  return out;
}

/**
 * The `apply_patch` ToolDef.
 *
 * `destructiveHint` ⇒ the broker always routes it to a human — ONCE, for the whole patch,
 * which is the other half of the point. Six files used to mean six prompts, and a user
 * clicking through six prompts is not reviewing any of them.
 */
export const APPLY_PATCH_TOOL: ToolDef = {
  name: "apply_patch",
  title: "Apply a multi-file patch",
  description:
    "Edit SEVERAL existing files as one atomic change: [{path, hunks:[{old,new}]}]. Every " +
    "hunk in every file is matched first, and NOTHING is written unless all of them match — " +
    "so a partial refactor is impossible. `old` must be an exact, unique, verbatim span of " +
    "that file. Prefer this over repeated propose_edit when a change spans files; use " +
    "write_file for a NEW file. Requires human approval (once, for the whole patch).",
  schema: {
    edits: {
      type: "array",
      required: true,
      description: "one entry per file: {path, hunks:[{old,new}]}",
      items: { type: "object", shape: "{path,hunks}" },
    },
  },
  annotations: { destructiveHint: true },
  toArgv: () => {
    throw new Error("apply_patch is applied locally by the host runtime, not by prometheus.py");
  },
};
