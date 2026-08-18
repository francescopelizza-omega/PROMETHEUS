/**
 * agent/system/host/preview-io.ts — the real filesystem behind `previewMutation`.
 *
 * `agent/mutation-preview.ts` is pure by design: it takes reads as an injected seam so "what
 * would this delete?" is testable without a filesystem. This is the ONE node-backed
 * implementation of that seam, shared by both CLI hosts and the desktop main process — because
 * the alternative is three of them, and the third one always forgets the binary check.
 *
 * Three properties the preview depends on, all decided here rather than at each call site:
 *
 *  - A BINARY file reads as `null`, not as mojibake. Printing the bytes of a PNG into a confirm
 *    prompt is worse than printing nothing: it fills the screen, so the human stops reading,
 *    which is the exact failure the preview exists to prevent.
 *  - A HUGE file reads as `null` too. The preview renderer is bounded, but the READ is not, and
 *    a confirm prompt is not a reason to pull a 400 MB file into memory.
 *  - A directory listing is BOUNDED and depth-first, with symlinks NOT followed. `rm -rf` on a
 *    tree containing a symlink to `$HOME` must not enumerate `$HOME`; the delete itself won't
 *    traverse it, so neither may the preview that claims to describe the delete.
 */
import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { PreviewIo } from "../../mutation-preview.js";

/** Above this, a file is summarised rather than read (bytes). */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** Above this many entries, a directory listing stops walking. */
export const PREVIEW_MAX_ENTRIES = 5000;

/**
 * Is this buffer text?
 *
 * A NUL byte in the first 8 KiB is the same heuristic `git diff` uses, and for the same reason:
 * it is cheap, it never false-positives on UTF-8, and the cost of being wrong is only that a
 * genuinely-text file with an embedded NUL gets summarised instead of shown.
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Walk a directory depth-first, returning paths RELATIVE to the root.
 *
 * Symlinks are recorded as entries but never followed — `lstat` semantics, via `withFileTypes`,
 * so a link to `/` does not turn a preview into a filesystem scan. Unreadable subdirectories
 * are skipped rather than throwing: a preview that dies on one permission error tells the human
 * nothing, and the delete it was describing would have hit the same error anyway.
 */
function walk(root: string, limit: number): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop() as string;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= limit) break;
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (e.isSymbolicLink()) {
        out.push(`${rel} →`); // recorded, deliberately not traversed
      } else if (e.isDirectory()) {
        out.push(`${rel}/`);
        stack.push(full);
      } else {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

/**
 * The node-backed preview seam.
 *
 * Every method swallows its errors and answers with the "cannot show it" value, because a
 * confirm prompt must still appear when the preview fails. A preview that throws would take the
 * approval flow down with it and leave the user unable to approve or reject anything.
 */
export function nodePreviewIo(): PreviewIo {
  return {
    readFile: (p) => {
      try {
        const st = statSync(p);
        if (!st.isFile()) return null;
        if (st.size > PREVIEW_MAX_BYTES) return null;
        const buf = readFileSync(p);
        if (looksBinary(buf)) return null;
        return buf.toString("utf8");
      } catch {
        return null;
      }
    },
    listDir: (p) => {
      try {
        if (!statSync(p).isDirectory()) return null;
      } catch {
        return null;
      }
      return walk(p, PREVIEW_MAX_ENTRIES);
    },
    exists: (p) => {
      try {
        statSync(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}
