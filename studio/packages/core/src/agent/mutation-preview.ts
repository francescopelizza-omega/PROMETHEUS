/**
 * agent/mutation-preview.ts — showing the human WHAT WILL CHANGE before they approve it.
 *
 * `propose_edit` and `write_file` already render a line-numbered old→new diff card before the
 * prompt. The other three mutators did not. `confirmPrompt` was taught to DESCRIBE them — it
 * names the absolute paths, says when a recursive delete cannot be undone, names both ends of a
 * move — but a description is not a preview:
 *
 *   - `apply_patch` spans N files by design, and the whole point of the one-prompt-per-patch
 *     rule is that the human reviews the patch ONCE. Reviewing it requires seeing it. "apply a
 *     patch to 6 file(s)" is a count, not a change.
 *   - `delete_file` names the path. It does not say the file is 900 lines of the thing you
 *     spent yesterday writing, and a `recursive` delete does not say WHICH files go with it.
 *   - `move_file` with `overwrite:true` silently destroys whatever is at the destination. The
 *     prompt said "REPLACING the destination"; it never said what the destination *was*.
 *
 * This module turns a pending tool call into a STRUCTURED preview. It deliberately models a
 * delete as a diff to the empty string and a clobbering move as a diff of the DESTINATION, so
 * a host that already knows how to paint an old→new card can paint all three with the renderer
 * it has, instead of growing three bespoke ones.
 *
 * PURE: no node, no fs. The caller injects `abs` (path resolution) and `io` (reads). That is
 * the same seam `confirmPrompt` uses, and it is what makes "what would this delete?" testable
 * without a filesystem.
 */

import { parsePatchFiles, resolvePatch } from "./patch.js";

/**
 * The pending call, structurally.
 *
 * Deliberately NOT `import type { ToolCall } from "./loop.js"` — `loop.ts` is the top of the
 * agent graph and pulls in the broker, the tuning and the transport. A preview is a leaf, and
 * a leaf that imports the root is how a module cycle starts. `ToolCall` satisfies this shape.
 */
export interface PendingCall {
  name: string;
  args?: Record<string, unknown>;
}

/** The reads a preview needs. Every one may fail; failing is a legitimate answer, not an error. */
export interface PreviewIo {
  /** current text, or null when the path is missing, unreadable, or not text. */
  readFile: (absPath: string) => string | null;
  /** entries under a directory (relative to it, depth-first), or null when it is not one. */
  listDir?: (absPath: string) => readonly string[] | null;
  /** does anything exist at this path? */
  exists?: (absPath: string) => boolean;
}

/** One thing that will change, in a form a diff renderer can consume directly. */
export type MutationChange =
  /** a file's content is replaced — `newText` "" means the file goes away entirely. */
  | { kind: "edit"; path: string; oldText: string; newText: string; note?: string }
  /** a whole directory tree is removed; `entries` is a bounded sample of `total`. */
  | {
      kind: "delete-dir";
      path: string;
      entries: readonly string[];
      total: number;
      truncated: boolean;
    }
  /** a rename. `lostText` is the destination's current content when this move destroys it. */
  | {
      kind: "move";
      from: string;
      to: string;
      clobbers: boolean;
      lostText: string | null;
    }
  /** the call cannot be previewed AND will not succeed — say so before the human approves it. */
  | { kind: "blocked"; path: string; message: string };

export interface MutationPreview {
  tool: string;
  /** a one-line summary for the card header. */
  headline: string;
  changes: MutationChange[];
  /**
   * TRUE when the preview proves the call will FAIL (a patch whose hunks no longer match, a
   * delete of nothing). A host should still let the human decide, but it must not present a
   * doomed call as though approving it would do the described thing.
   */
  willFail: boolean;
}

/** How many directory entries to list before summarising the rest. */
export const DELETE_DIR_SAMPLE = 40;

/** Line count matching an editor's (a trailing newline does not add a line). */
function lineCount(text: string): number {
  if (text === "") return 0;
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const n = norm.split("\n").length;
  return norm.endsWith("\n") ? n - 1 : n;
}

/**
 * Split for DISPLAY: a trailing newline does not make a final empty line.
 *
 * `"a\nb\n".split("\n")` is `["a","b",""]`, and rendering that prints a bare `-` under the
 * last real line — which reads as "and one more line you can't see" in exactly the card whose
 * job is to say what is being destroyed.
 */
function displayLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** `n file(s)` / `n line(s)` without the parenthesised plural. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Preview `apply_patch`.
 *
 * Resolution runs the REAL `resolvePatch`, so the card shows exactly the bytes that will land
 * and — when a hunk no longer matches — says the patch will be rejected instead of showing a
 * diff that will never be applied. That is the same discipline `renderEditCard` already
 * applies to `propose_edit`, extended to the multi-file case where it matters more: a patch
 * that fails on file 6 writes nothing at all, and the human should learn that here rather than
 * after approving it.
 */
function previewPatch(
  args: Record<string, unknown>,
  abs: (p: string) => string,
  io: PreviewIo,
): MutationPreview {
  const files = parsePatchFiles(args.edits);
  if (files.length === 0) {
    return {
      tool: "apply_patch",
      headline: "apply_patch: no files in the patch",
      changes: [{ kind: "blocked", path: "", message: "the patch has no files" }],
      willFail: true,
    };
  }
  // resolvePatch reads by the path the model wrote; resolve to absolute at the IO seam so the
  // preview reads the same bytes the runner will.
  const originals = new Map<string, string>();
  const read = (p: string): string | null => {
    const text = io.readFile(abs(p));
    if (text !== null) originals.set(p, text);
    return text;
  };
  const res = resolvePatch(files, read);
  if (!res.ok) {
    return {
      tool: "apply_patch",
      headline: `apply_patch: ${plural(files.length, "file")} — WILL BE REJECTED`,
      changes: [
        {
          kind: "blocked",
          path: abs(res.path),
          // `res.message` already names the hunk ("hunk 0: old text not found — …"), so this
          // adds only the consequence the model-facing message leaves out: apply_patch is
          // ATOMIC, so one bad hunk means not one file changes.
          message: `${res.message} — nothing will be written`,
        },
      ],
      willFail: true,
    };
  }
  const changes: MutationChange[] = res.files.map((f) => ({
    kind: "edit" as const,
    path: abs(f.path),
    oldText: originals.get(f.path) ?? "",
    newText: f.next,
    note: `${plural(f.applied, "hunk")}`,
  }));
  return {
    tool: "apply_patch",
    headline: `apply_patch: ${plural(res.totalHunks, "hunk")} across ${plural(res.files.length, "file")}`,
    changes,
    willFail: false,
  };
}

/**
 * Preview `delete_file`.
 *
 * A file delete is modelled as a diff to the empty string: every line is a removal, which is
 * exactly what a delete is and exactly what the existing card renders well. A recursive
 * directory delete has no such rendering — it is a LIST, bounded, with the total stated so a
 * truncated sample can never read as the whole of what is about to go.
 */
function previewDelete(
  args: Record<string, unknown>,
  abs: (p: string) => string,
  io: PreviewIo,
): MutationPreview {
  const raw = typeof args.path === "string" ? args.path : "";
  const path = abs(raw);
  if (!raw) {
    return {
      tool: "delete_file",
      headline: "delete_file: no path",
      changes: [{ kind: "blocked", path: "", message: "delete_file was called without a path" }],
      willFail: true,
    };
  }
  if (args.recursive) {
    const entries = io.listDir?.(path) ?? null;
    if (entries === null) {
      // recursive was asked for but the path is not a directory — the runner refuses this, so
      // the preview must not imply a tree is about to be removed.
      const text = io.readFile(path);
      if (text === null && io.exists?.(path) === false) {
        return {
          tool: "delete_file",
          headline: `delete_file: nothing at ${path}`,
          changes: [{ kind: "blocked", path, message: "no such path — the delete will fail" }],
          willFail: true,
        };
      }
      return {
        tool: "delete_file",
        headline: `delete ${path}`,
        changes: [{ kind: "edit", path, oldText: text ?? "", newText: "", note: "delete" }],
        willFail: false,
      };
    }
    const shown = entries.slice(0, DELETE_DIR_SAMPLE);
    return {
      tool: "delete_file",
      headline: `DELETE the directory ${path} — ${plural(entries.length, "entry", "entries")}, CANNOT BE UNDONE`,
      changes: [
        {
          kind: "delete-dir",
          path,
          entries: shown,
          total: entries.length,
          truncated: entries.length > shown.length,
        },
      ],
      willFail: false,
    };
  }
  const text = io.readFile(path);
  if (text === null) {
    if (io.exists?.(path) === false) {
      return {
        tool: "delete_file",
        headline: `delete_file: nothing at ${path}`,
        changes: [{ kind: "blocked", path, message: "no such path — the delete will fail" }],
        willFail: true,
      };
    }
    // exists but unreadable (binary, permissions) — still a real delete, just not diffable.
    return {
      tool: "delete_file",
      headline: `delete ${path} (contents not previewable)`,
      changes: [{ kind: "edit", path, oldText: "", newText: "", note: "not text" }],
      willFail: false,
    };
  }
  return {
    tool: "delete_file",
    headline: `delete ${path} — ${plural(lineCount(text), "line")}, ${plural(text.length, "byte")}`,
    changes: [{ kind: "edit", path, oldText: text, newText: "", note: "delete" }],
    willFail: false,
  };
}

/**
 * Preview `move_file`.
 *
 * The interesting case is the only one the old prompt got wrong: `overwrite:true` onto an
 * existing destination. That is a DELETE of the destination wearing a move's clothes, so the
 * preview carries the destination's current text and the host can show what is being thrown
 * away. Without `overwrite` an existing destination means the runner will refuse, which is
 * worth saying before the human approves rather than after.
 */
function previewMove(
  args: Record<string, unknown>,
  abs: (p: string) => string,
  io: PreviewIo,
): MutationPreview {
  const rawFrom = typeof args.from === "string" ? args.from : "";
  const rawTo = typeof args.to === "string" ? args.to : "";
  if (!rawFrom || !rawTo) {
    return {
      tool: "move_file",
      headline: "move_file: missing from/to",
      changes: [
        {
          kind: "blocked",
          path: abs(rawFrom || rawTo),
          message: "move_file needs both from and to",
        },
      ],
      willFail: true,
    };
  }
  const from = abs(rawFrom);
  const to = abs(rawTo);
  const sourceMissing = io.exists?.(from) === false;
  if (sourceMissing) {
    return {
      tool: "move_file",
      headline: `move_file: nothing at ${from}`,
      changes: [{ kind: "blocked", path: from, message: "no such path — the move will fail" }],
      willFail: true,
    };
  }
  const destText = io.readFile(to);
  const destExists = destText !== null || io.exists?.(to) === true;
  if (destExists && !args.overwrite) {
    return {
      tool: "move_file",
      headline: `move_file: ${to} already exists`,
      changes: [
        {
          kind: "blocked",
          path: to,
          message: "the destination exists and `overwrite` was not set — the move will fail",
        },
      ],
      willFail: true,
    };
  }
  const clobbers = destExists && Boolean(args.overwrite);
  return {
    tool: "move_file",
    headline: clobbers
      ? `move ${from} → ${to} — REPLACING ${plural(lineCount(destText ?? ""), "line")} at the destination`
      : `move ${from} → ${to}`,
    changes: [{ kind: "move", from, to, clobbers, lostText: clobbers ? destText : null }],
    willFail: false,
  };
}

/**
 * The preview for ONE pending tool call, or null when the tool has nothing to preview.
 *
 * Null is not a failure — `run_command` and the read tools have no file-level "before" to show,
 * and `propose_edit`/`write_file` already have their own card. Returning null keeps this from
 * becoming a second, competing renderer for the two tools that were never broken.
 */
export function previewMutation(
  call: PendingCall,
  abs: (p: string) => string,
  io: PreviewIo,
): MutationPreview | null {
  const args = call.args ?? {};
  if (call.name === "apply_patch") return previewPatch(args, abs, io);
  if (call.name === "delete_file") return previewDelete(args, abs, io);
  if (call.name === "move_file") return previewMove(args, abs, io);
  return null;
}

/**
 * Every absolute path a previewed call will TOUCH.
 *
 * The working-set escape check in `confirmPrompt` reads the model's arguments; this reads the
 * resolved preview, which is the set that actually gets written. They agree today, and this
 * exists so a future tool whose real targets are computed (a patch, a glob) cannot drift out of
 * the scope check by adding an argument shape nobody updated.
 */
export function previewPaths(preview: MutationPreview): string[] {
  const out: string[] = [];
  for (const ch of preview.changes) {
    if (ch.kind === "move") {
      out.push(ch.from, ch.to);
    } else {
      out.push(ch.path);
    }
  }
  return out.filter(Boolean);
}

/**
 * A PLAIN-TEXT rendering of a preview — the fallback for a host with no diff painter.
 *
 * The TUI has `renderDiffCard` and should use it (the structure above is shaped for exactly
 * that). The readline host does not, and "no card at all" is how this defect started, so the
 * unstyled path renders here rather than being left to each host to forget again.
 */
export function renderMutationPreview(
  preview: MutationPreview,
  opts: { maxLines?: number } = {},
): string[] {
  const maxLines = opts.maxLines ?? 60;
  const out: string[] = [preview.headline];
  let budget = maxLines;
  for (const ch of preview.changes) {
    if (budget <= 0) {
      out.push("  … (preview truncated)");
      break;
    }
    if (ch.kind === "blocked") {
      out.push(`  ⎿ ${ch.path ? `${ch.path}: ` : ""}${ch.message}`);
      budget--;
      continue;
    }
    if (ch.kind === "delete-dir") {
      out.push(`  ${ch.path}/`);
      for (const e of ch.entries) {
        if (budget-- <= 0) break;
        out.push(`    − ${e}`);
      }
      if (ch.truncated) out.push(`    … and ${ch.total - ch.entries.length} more`);
      continue;
    }
    if (ch.kind === "move") {
      out.push(`  ${ch.from}`);
      out.push(`  → ${ch.to}`);
      budget -= 2;
      if (ch.clobbers && ch.lostText !== null) {
        out.push("  ⚠ this REPLACES the destination; its current contents are lost:");
        for (const l of displayLines(ch.lostText).slice(0, Math.max(0, Math.min(budget, 10)))) {
          if (budget-- <= 0) break;
          out.push(`    − ${l}`);
        }
      }
      continue;
    }
    // an `edit` — including a delete, which is an edit to nothing.
    const oldLines = displayLines(ch.oldText);
    const newLines = displayLines(ch.newText);
    out.push(`  ${ch.path}${ch.note ? ` (${ch.note})` : ""}`);
    budget--;
    if (ch.newText === "") {
      for (const l of oldLines.slice(0, Math.max(0, Math.min(budget, 20)))) {
        if (budget-- <= 0) break;
        out.push(`    − ${l}`);
      }
      if (oldLines.length > 20) out.push(`    … and ${oldLines.length - 20} more lines removed`);
      continue;
    }
    // a real edit — the host's diff painter does better; this is the "+N/−M" fallback.
    out.push(`    ~ ${oldLines.length} → ${newLines.length} lines`);
    budget--;
  }
  return out;
}
