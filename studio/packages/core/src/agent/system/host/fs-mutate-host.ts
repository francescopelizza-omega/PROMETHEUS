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
import { isPathAllowed, scopedAbsolute } from "./working-set.js";

/** A captured pre-image, for a host that can undo. */
/**
 * Read a file as text ONLY if the bytes round-trip exactly; otherwise `null`.
 *
 * `readFileSync(path, "utf8")` does NOT throw on binary — it substitutes U+FFFD for every
 * invalid sequence — so a `catch` around it never fires for the case it was written for, and the
 * lossy string that comes back looks like a perfectly ordinary file. Two separate call sites in
 * this repo have been bitten by it: `delete_file`'s revert pre-image (a PNG went 264 bytes in,
 * 522 bytes out) and `propose_edit`, which spliced the lossy string and WROTE IT BACK — a 1032
 * byte PNG became 2058 bytes of replacement characters, reported as `ok: true, "edited …"`, and
 * the pre-image kept for `/revert` was the corrupted text, so the damage could not be undone.
 *
 * One helper, so the next tool that reads a file for editing cannot drift away from it again.
 */
export function readTextExact(abs: string): string | null {
  const raw = readFileSync(abs);
  const text = raw.toString("utf8");
  return Buffer.from(text, "utf8").equals(raw) ? text : null;
}

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
  // Same rule as the read guard: expand `~` before resolving, so the scope check judges the
  // path the filesystem would actually see rather than a literal `~` directory under cwd.
  const abs = scopedAbsolute(rawPath, deps.cwd);
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
  let capturable = true;
  try {
    /**
     * ROUND-TRIP the bytes before trusting them as a pre-image.
     *
     * `readFileSync(path, "utf8")` does not throw on binary — it substitutes U+FFFD for every
     * invalid sequence — so the `catch` below never fired for the case its comment described,
     * and `/revert` wrote that lossy string back as if it were the file. Measured on a PNG:
     * 264 bytes in, 522 bytes out, not identical. The user was told the delete had been
     * reverted and got a corrupted file, which is worse than not reverting at all.
     */
    const text = readTextExact(r.abs);
    if (text !== null) preImage = text;
    else capturable = false; // genuinely binary — a string pre-image cannot represent it
  } catch {
    // unreadable: it still deletes, it just cannot be captured for revert.
    capturable = false;
  }
  try {
    rmSync(r.abs);
  } catch (err) {
    return { ok: false, summary: `delete_file: failed: ${errText(err)}` };
  }
  // Only record a pre-image we can actually restore byte-for-byte. Recording a lossy one would
  // put a corrupt file into the checkpoint and make `/revert` report a success it did not do.
  if (capturable) {
    // A delete is by construction an "it existed" case — `rmSync` above would have thrown.
    deps.onPreImage?.({ path: r.abs, preImage, existed: true });
  }
  // Say when it is NOT revertible — the same honesty the directory branch above already applies.
  return {
    ok: true,
    summary: capturable ? `deleted ${r.raw}` : `deleted ${r.raw} (binary — not revertible)`,
  };
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
  // `readTextExact`, not `readFileSync(..., "utf8")`. The raw read is the exact mistake this
  // file's own helper was written to end: it does NOT throw on binary, it returns U+FFFD
  // mush. Both catch blocks here were therefore dead for the case they were written for, and
  // the mush was handed to `onPreImage` with `existed: true` — so `/revert` "succeeded" and
  // wrote the replacement characters over a PNG. `readTextExact` returns null unless the
  // bytes round-trip, and a null pre-image is simply not emitted: revert then does nothing,
  // which is the honest answer for a file that is not byte-restorable as text.
  let destPre: string | null = null;
  if (destExists) {
    try {
      destPre = readTextExact(to.abs);
    } catch {
      destPre = null; // a directory, or unreadable
    }
  }
  let sourcePre: string | null = null;
  try {
    sourcePre = readTextExact(from.abs);
  } catch {
    sourcePre = null; // a directory move
  }
  try {
    mkdirSync(dirname(to.abs), { recursive: true });
    renameSync(from.abs, to.abs);
  } catch (err) {
    return { ok: false, summary: `move_file: failed: ${errText(err)}` };
  }
  // The SOURCE existed and now does not → revert by writing it back, but only if its bytes
  // survived the round-trip.
  if (sourcePre !== null) {
    deps.onPreImage?.({ path: from.abs, preImage: sourcePre, existed: true });
  }
  if (!destExists) {
    // The destination did not exist → revert by DELETING it. No read involved, so this is
    // always safe to claim, binary or not.
    deps.onPreImage?.({ path: to.abs, preImage: "", existed: false });
  } else if (destPre !== null) {
    // The destination was replaced → revert by writing its old bytes back.
    deps.onPreImage?.({ path: to.abs, preImage: destPre, existed: true });
  }
  // else: an overwritten BINARY destination. Nothing is claimed, because nothing can be
  // restored from a lossy read — emitting a pre-image here is what destroyed the file.
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
