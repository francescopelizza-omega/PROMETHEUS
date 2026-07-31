/**
 * session/working-set.ts — the per-session working set of extra directories the
 * agent is allowed to read (CLI-004).
 *
 * `/add-dir` grants file access to directories OUTSIDE the session cwd. The scope
 * check is fail-closed and mirrors the desktop path-guarded fs IPC: resolve
 * symlinks + `..` (realpath) BEFORE the prefix test, append `path.sep` so root
 * `/foo/bar` never matches sibling `/foo/bar-evil`, and re-resolve on every access
 * (TOCTOU: a dir may be deleted/swapped/symlinked after it was added). On
 * case-insensitive filesystems (macOS APFS, Windows NTFS) the compare is
 * case-folded so `/Users/Foo` and `/users/foo` collapse — else the guard both
 * false-denies and can be bypassed.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/** Expand a leading `~` or `~/` to the home dir (NOT `~otheruser`). */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
  return p;
}

/** Canonicalize for a case-correct, symlink/`..`-resolved compare (or "" on failure). */
function canonical(p: string): string {
  try {
    const real = realpathSync.native(p);
    return CASE_INSENSITIVE ? real.toLowerCase() : real;
  } catch {
    return "";
  }
}

export interface ResolveResult {
  ok: boolean;
  /** the realpath'd absolute dir (canonical case), present iff ok. */
  resolved?: string;
  error?: string;
}

/** Validate a directory arg: expand `~`, resolve vs cwd, require an existing dir. */
export function resolveDir(arg: string, cwd: string): ResolveResult {
  const raw = expandHome(arg.trim());
  if (!raw) return { ok: false, error: "no path given" };
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  let real: string;
  try {
    real = realpathSync.native(abs);
  } catch {
    return { ok: false, error: `no such path: ${abs}` };
  }
  try {
    if (!statSync(real).isDirectory()) return { ok: false, error: `not a directory: ${real}` };
  } catch {
    return { ok: false, error: `cannot stat: ${real}` };
  }
  return { ok: true, resolved: real };
}

/** An ordered, deduped (by resolved path) working set of extra directories. */
export interface WorkingSet {
  /** the resolved dirs, insertion order. */
  list: () => string[];
  /** add a validated dir (dedup by resolved path); returns the resolve result. */
  add: (arg: string, cwd: string) => ResolveResult;
  /** remove a dir by arg (matched on resolved path); true iff it was present. */
  remove: (arg: string, cwd: string) => boolean;
}

export function createWorkingSet(): WorkingSet {
  const dirs: string[] = [];
  const key = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p);
  return {
    list: () => [...dirs],
    add: (arg, cwd) => {
      const r = resolveDir(arg, cwd);
      if (!r.ok || !r.resolved) return r;
      const resolved = r.resolved;
      if (!dirs.some((d) => key(d) === key(resolved))) dirs.push(resolved);
      return r;
    },
    remove: (arg, cwd) => {
      const r = resolveDir(arg, cwd);
      // match on the resolved path when the dir still exists, else the raw abs arg.
      const target = r.ok && r.resolved ? r.resolved : expandHome(arg.trim());
      const i = dirs.findIndex((d) => key(d) === key(target));
      if (i === -1) return false;
      dirs.splice(i, 1);
      return true;
    },
  };
}

/**
 * Fail-closed scope check: is `candidate` inside ANY of `roots`? Re-resolves both
 * sides every call (never caches the boolean — TOCTOU). Empty roots ⇒ deny.
 */
export function isPathAllowed(candidate: string, roots: string[]): boolean {
  if (roots.length === 0) return false;
  let target = canonical(candidate);
  if (!target) {
    // a not-yet-existing leaf (e.g. a write target) — verify its PARENT instead.
    target = canonical(resolve(candidate, ".."));
  }
  if (!target) return false; // unresolvable ⇒ deny
  for (const root of roots) {
    const r = canonical(root);
    if (!r) continue;
    if (target === r || target.startsWith(r + sep)) return true;
  }
  return false;
}

/** Keys whose string (or string[]) values are filesystem paths a tool would touch. */
const PATH_KEYS = new Set(["path", "file", "dir", "directory", "target"]);
const PATH_ARRAY_KEYS = new Set(["paths", "files"]);

/** Collect the filesystem-path arguments from a validated tool-arg object. */
export function pathArgsOf(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && PATH_KEYS.has(k)) out.push(v);
    else if (Array.isArray(v) && PATH_ARRAY_KEYS.has(k))
      for (const el of v) if (typeof el === "string") out.push(el);
  }
  return out;
}
