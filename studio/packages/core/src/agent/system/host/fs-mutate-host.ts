/**
 * agent/system/host/fs-mutate-host.ts — the Tier-W file mutators, in ONE place.
 *
 * `delete_file`, `move_file` and `mkdir` were declared in core (`agent/system/fs-mutate.ts`) and
 * implemented only in `apps/cli`, which is why the desktop agent could read, search, edit and
 * write a file but not remove or rename one: `runSystemTool` returned null for all three and the
 * IPC turned that into "not a system tool". A GUI refactor had to detour through `run_command` —
 * a shell-shaped workaround at a higher permission tier for a structured operation.
 *
 * THE OBVIOUS SHORTCUT IS WRONG. Main already exposes `ide:fs.mkdir` / `rename` / `delete`, and
 * reusing them would have been one line each. But they disagree with the tool contracts in ways
 * that matter: its delete is ALWAYS recursive (discarding `delete_file`'s explicit
 * directory guard, the whole point of which is that a tree delete cannot be reverted), its mkdir
 * is NOT recursive (so a nested path errors where the tool promises success), and its rename
 * neither refuses to clobber nor creates missing parents. Wiring them would have silently
 * changed what three tools mean.
 *
 * PRE-IMAGES. A single-file delete captures its contents through `onPreImage` so a host with a
 * checkpoint store can put it in the same undo machinery as an edit. A recursive DIRECTORY delete
 * captures nothing and SAYS so — there is no honest way to snapshot an arbitrary tree into one
 * pre-image, and pretending otherwise would make `/revert` lie about what it can restore.
 *
 * NODE-ONLY: it is the host half, alongside the other `system/host` modules.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { ToolOutcome } from "../../loop.js";
import { isPathAllowed } from "./working-set.js";

/** A captured pre-image, for a host that can undo. */
export interface FsPreImage {
  path: string;
  /** the bytes before the change — `""` when the path was empty OR did not exist. */
  preImage: string;
  /**
   * Did the path EXIST before the change?
   *
   * `false` means "revert by DELETING this", which is the only correct undo for a path the
   * agent brought into existence. Without it a create reverted to a zero-byte file, and the
   * user's tree filled up with empty files that their build then had to account for. Optional,
   * and an absent value reads as "it existed" — the conservative direction, since rewriting a
   * file that should have been deleted loses nothing while the reverse destroys real work.
   */
  existed?: boolean;
}

export interface FsMutateDeps {
  cwd: string;
  /** the working-set roots a mutation must land inside; empty/absent ⇒ no path guard. */
  roots?: readonly string[];
  /** absolute paths a confirm seam approved for this turn despite being out of scope. */
  approvedOutside?: ReadonlySet<string>;
  /** fired before a destructive change, so a host can snapshot for revert. */
  onPreImage?: (rec: FsPreImage) => void;
}

/** Resolve + guard a mutation target. Fail-closed: an unguarded escape is never permitted. */
function resolveMutatePath(
  tool: string,
  raw: unknown,
  deps: FsMutateDeps,
): { ok: true; abs: string; raw: string } | { ok: false; summary: string } {
  const rawPath = typeof raw === "string" ? raw : "";
  // An option-shaped path is refused rather than resolved: `-rf` as a filename is far more
  // likely to be a model mistake than a real file, and resolving it invites an argv confusion.
  if (!rawPath || rawPath.startsWith("-")) {
    return { ok: false, summary: `${tool}: refusing invalid path: ${rawPath}` };
  }
  const abs = isAbsolute(rawPath) ? rawPath : resolve(deps.cwd, rawPath);
  const roots = deps.roots;
  if (
    roots &&
    roots.length > 0 &&
    !isPathAllowed(abs, [...roots]) &&
    !deps.approvedOutside?.has(abs)
  ) {
    return {
      ok: false,
      summary: `${tool}: path outside the working set (not approved): ${rawPath}`,
    };
  }
  return { ok: true, abs, raw: rawPath };
}

/** `delete_file` — remove a file, or a directory tree only when `recursive` was asked for. */
export function deleteFileTool(args: Record<string, unknown>, deps: FsMutateDeps): ToolOutcome {
  const r = resolveMutatePath("delete_file", args.path, deps);
  if (!r.ok) return { ok: false, summary: r.summary };
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(r.abs);
  } catch {
    return { ok: false, summary: `delete_file: no such path: ${r.raw}` };
  }
  if (stat.isDirectory()) {
    if (args.recursive !== true) {
      return {
        ok: false,
        summary: `delete_file: ${r.raw} is a directory — pass recursive:true to remove it`,
      };
    }
    try {
      rmSync(r.abs, { recursive: true, force: false });
    } catch (err) {
      return { ok: false, summary: `delete_file: failed: ${errText(err)}` };
    }
    // Stated in the summary, not silently: the model and the human both need to know this one
    // is outside the undo machinery.
    return { ok: true, summary: `deleted directory ${r.raw} (not revertible)` };
  }
  let preImage = "";
  try {
    preImage = readFileSync(r.abs, "utf8");
  } catch {
    // A binary or unreadable file still deletes; it just cannot be captured for revert.
    preImage = "";
  }
  try {
    rmSync(r.abs);
  } catch (err) {
    return { ok: false, summary: `delete_file: failed: ${errText(err)}` };
  }
  // A delete is by construction an "it existed" case — `rmSync` above would have thrown.
  deps.onPreImage?.({ path: r.abs, preImage, existed: true });
  return { ok: true, summary: `deleted ${r.raw}` };
}

/** `move_file` — rename/move, refusing to clobber unless the caller asked for it explicitly. */
export function moveFileTool(args: Record<string, unknown>, deps: FsMutateDeps): ToolOutcome {
  const from = resolveMutatePath("move_file", args.from, deps);
  if (!from.ok) return { ok: false, summary: from.summary };
  const to = resolveMutatePath("move_file", args.to, deps);
  if (!to.ok) return { ok: false, summary: to.summary };
  try {
    lstatSync(from.abs);
  } catch {
    return { ok: false, summary: `move_file: no such path: ${from.raw}` };
  }
  let destExists = true;
  try {
    lstatSync(to.abs);
  } catch {
    destExists = false;
  }
  if (destExists && args.overwrite !== true) {
    return {
      ok: false,
      summary: `move_file: ${to.raw} already exists — pass overwrite:true to replace it`,
    };
  }
  /**
   * Capture BOTH ends before the rename — a move has two of them, and this captured neither.
   *
   * `move_file` fired no pre-image at all, so `/revert` silently did nothing for it: the source
   * stayed gone and the destination stayed put. An `overwrite:true` move was worse, because the
   * destination's old contents were destroyed with no record of them anywhere.
   *
   * Read the destination BEFORE the rename, or there is nothing left to read.
   */
  let destPre = "";
  if (destExists) {
    try {
      destPre = readFileSync(to.abs, "utf8");
    } catch {
      // binary or unreadable: the move still happens, it just cannot be undone byte-for-byte.
      destPre = "";
    }
  }
  let sourcePre = "";
  let sourceCapturable = false;
  try {
    sourcePre = readFileSync(from.abs, "utf8");
    sourceCapturable = true;
  } catch {
    // a directory move, or a binary — not byte-restorable, so it is not claimed to be.
    sourceCapturable = false;
  }
  try {
    mkdirSync(dirname(to.abs), { recursive: true });
    renameSync(from.abs, to.abs);
  } catch (err) {
    return { ok: false, summary: `move_file: failed: ${errText(err)}` };
  }
  // The SOURCE existed and now does not → revert by writing it back.
  if (sourceCapturable) deps.onPreImage?.({ path: from.abs, preImage: sourcePre, existed: true });
  // The DESTINATION either did not exist (revert by deleting) or was replaced (revert by
  // writing its old bytes back).
  deps.onPreImage?.({ path: to.abs, preImage: destPre, existed: destExists });
  return { ok: true, summary: `moved ${from.raw} → ${to.raw}` };
}

/** `mkdir` — create a directory chain; already-exists is a success, not an error. */
export function mkdirTool(args: Record<string, unknown>, deps: FsMutateDeps): ToolOutcome {
  const r = resolveMutatePath("mkdir", args.path, deps);
  if (!r.ok) return { ok: false, summary: r.summary };
  try {
    mkdirSync(r.abs, { recursive: true });
  } catch (err) {
    return { ok: false, summary: `mkdir: failed: ${errText(err)}` };
  }
  return { ok: true, summary: `created ${r.raw}` };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Dispatch a Tier-W mutator by name, or null when it is not one. */
export function runFsMutateTool(
  name: string,
  args: Record<string, unknown>,
  deps: FsMutateDeps,
): ToolOutcome | null {
  if (name === "delete_file") return deleteFileTool(args, deps);
  if (name === "move_file") return moveFileTool(args, deps);
  if (name === "mkdir") return mkdirTool(args, deps);
  return null;
}
