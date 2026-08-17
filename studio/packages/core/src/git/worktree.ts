/**
 * git/worktree.ts — thin, dependency-injected git wrappers shared by the CLI's `/worktree`
 * slash (CLI-054) and the desktop app's worktree command/panel (Task #5, desktop parity).
 *
 * Originally lived at apps/cli/src/session/git-helpers.ts, CLI-owned, because "the CLI can't
 * import desktop's Electron-side git-host.ts". Moved into `@prometheus/core` so BOTH hosts call
 * the exact same functions instead of each maintaining its own copy of the trust rules below —
 * apps/cli/src/session/git-helpers.ts is now a thin re-export shim (`export * from
 * "@prometheus/core/git-worktree"`) so every existing CLI import site and test is unaffected.
 *
 * Security invariants (repo-wide, non-negotiable):
 *   - child_process lives ONLY in engine-bridge (C5) — every spawn routes through `execCapture`
 *     (shell-free, sanitized env, hard timeout). The default `GitSpawn` is that seam; tests
 *     inject a fake so vitest never spawns real git.
 *   - Option-injection guard: a user-supplied branch/path that starts with `-` is REJECTED
 *     BEFORE any spawn (else `git worktree add --foo` smuggles a flag). argv is always an array,
 *     never a shell string.
 *   - Never `--force`; never throws — every helper returns a typed result.
 */
import { realpathSync } from "node:fs";

import { type ExecCaptureResult, execCapture } from "@prometheus/engine-bridge";

/** A git invocation's typed outcome (never throws — a spawn error is `ok:false, code:127`). */
export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** The injectable spawn seam: run `git <args>` shell-free and capture. Default = engine-bridge. */
export type GitSpawn = (args: string[]) => Promise<ExecCaptureResult>;

const defaultGitSpawn: GitSpawn = (args) => execCapture("git", args, { timeoutMs: 10_000 });

/** The real git spawn (engine-bridge safe-env seam) — the host injects this into SlashCtx.git. */
export const realGitSpawn: GitSpawn = defaultGitSpawn;

/**
 * Do two paths point at the same location? Resolves symlinks (macOS `/var`→`/private/var`) via
 * realpath; falls back to string equality when a path doesn't exist (or on Windows casing).
 */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** A user token is git-argv-safe iff non-empty and not a flag (no leading `-`). */
export function isSafeToken(token: string): boolean {
  return token.length > 0 && !token.startsWith("-");
}

/** Run git in `cwd` (via `-C`, no shell cwd change). `cwd` is trusted session state, never argv. */
export async function runGit(
  argv: string[],
  cwd: string,
  spawn: GitSpawn = defaultGitSpawn,
): Promise<GitResult> {
  const res = await spawn(["-C", cwd, ...argv]);
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr, code: res.code };
}

/** Is `cwd` inside a git work tree? */
export async function isGitRepo(cwd: string, spawn: GitSpawn = defaultGitSpawn): Promise<boolean> {
  const r = await runGit(["rev-parse", "--is-inside-work-tree"], cwd, spawn);
  return r.ok && r.stdout.trim() === "true";
}

/* ------------------------------ worktree list ------------------------------ */

export interface Worktree {
  /** absolute path of the worktree root. */
  path: string;
  /** the checked-out commit sha (empty for a bare record). */
  head: string;
  /** short branch name (`refs/heads/` stripped), absent when detached/bare. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  /** present (reason string, or `true`) when the worktree is locked. */
  locked?: string | boolean;
  /** present (reason string) when git flags the worktree prunable. */
  prunable?: string;
}

/**
 * Parse `git worktree list --porcelain` — blank-line-delimited records, each with `worktree
 * <path>` + `HEAD <sha>` then EITHER `branch refs/heads/<name>` OR `detached`; the main record
 * may add `bare`; any may add `locked [<reason>]` / `prunable <reason>`. Parses all five kinds.
 */
export function parseWorktreePorcelain(text: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    let path = "";
    let head = "";
    let branch: string | undefined;
    let detached = false;
    let bare = false;
    let locked: string | boolean | undefined;
    let prunable: string | undefined;
    for (const line of lines) {
      const sp = line.indexOf(" ");
      const key = sp === -1 ? line : line.slice(0, sp);
      const val = sp === -1 ? "" : line.slice(sp + 1);
      if (key === "worktree") path = val;
      else if (key === "HEAD") head = val;
      else if (key === "branch") branch = val.replace(/^refs\/heads\//, "");
      else if (key === "detached") detached = true;
      else if (key === "bare") bare = true;
      else if (key === "locked") locked = val || true;
      else if (key === "prunable") prunable = val || "prunable";
    }
    if (!path) continue;
    out.push({
      path,
      head,
      ...(branch ? { branch } : {}),
      detached,
      bare,
      ...(locked !== undefined ? { locked } : {}),
      ...(prunable !== undefined ? { prunable } : {}),
    });
  }
  return out;
}

export async function listWorktrees(
  cwd: string,
  spawn: GitSpawn = defaultGitSpawn,
): Promise<Worktree[]> {
  const r = await runGit(["worktree", "list", "--porcelain"], cwd, spawn);
  return r.ok ? parseWorktreePorcelain(r.stdout) : [];
}

/* ------------------------------ dirty check ------------------------------ */

export interface DirtyStatus {
  dirty: boolean;
  /** tracked-modified/staged files (block a clean `git worktree remove`). */
  tracked: number;
  /** untracked `??` files (removable only with --force, which we never use). */
  untracked: number;
}

/** Classify a worktree's cleanliness from `git status --porcelain` (v1, stable format). */
export async function isDirty(
  worktreePath: string,
  spawn: GitSpawn = defaultGitSpawn,
): Promise<DirtyStatus> {
  const r = await runGit(["status", "--porcelain"], worktreePath, spawn);
  if (!r.ok) return { dirty: false, tracked: 0, untracked: 0 };
  let tracked = 0;
  let untracked = 0;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (line.startsWith("??")) untracked++;
    else tracked++;
  }
  return { dirty: tracked > 0 || untracked > 0, tracked, untracked };
}

/* ------------------------------ add / remove ------------------------------ */

export interface AddWorktreeResult {
  ok: boolean;
  /** the resolved worktree path (present on success). */
  path?: string;
  /** a human-readable message (error reason or success note). */
  message: string;
}

/** Sanitize a branch name into a filesystem-safe sibling dir segment (`feature/x` → `feature-x`). */
function branchToDirSegment(branch: string): string {
  return branch.replace(/\//g, "-");
}

/**
 * Create a worktree for `branch` (new or existing). Default path = `<repo-parent>/<repo>-wt-
 * <branch>` sibling. Rejects a flag-like branch/path BEFORE any spawn; validates a NEW branch name
 * with `git check-ref-format`; pre-checks (via listWorktrees) that the branch isn't already
 * checked out elsewhere — surfacing a clean message instead of git's raw `fatal:`.
 */
export async function addWorktree(
  cwd: string,
  branch: string,
  explicitPath?: string,
  spawn: GitSpawn = defaultGitSpawn,
): Promise<AddWorktreeResult> {
  if (!isSafeToken(branch)) return { ok: false, message: `unsafe branch name: "${branch}"` };
  if (explicitPath !== undefined && !isSafeToken(explicitPath)) {
    return { ok: false, message: `unsafe path: "${explicitPath}"` };
  }

  // does the branch already exist locally? (existing ⇒ checkout it; new ⇒ `-b`).
  const exists = (await runGit(["rev-parse", "--verify", `refs/heads/${branch}`], cwd, spawn)).ok;
  if (!exists) {
    // validate a NEW branch name (check-ref-format --normalize; exit 0 = valid).
    const fmt = await runGit(
      ["check-ref-format", "--normalize", `refs/heads/${branch}`],
      cwd,
      spawn,
    );
    if (!fmt.ok) return { ok: false, message: `invalid branch name: "${branch}"` };
  }

  // pre-check: is the branch already checked out in another worktree?
  const existing = (await listWorktrees(cwd, spawn)).find((w) => w.branch === branch);
  if (existing) {
    return { ok: false, message: `branch "${branch}" already checked out at ${existing.path}` };
  }

  // derive the sibling path when none given: <repo-parent>/<repo>-wt-<sanitized-branch>.
  let path = explicitPath;
  if (!path) {
    const top = (await runGit(["rev-parse", "--show-toplevel"], cwd, spawn)).stdout.trim();
    const repo = top.split("/").filter(Boolean).at(-1) ?? "repo";
    const parent = top.slice(0, Math.max(0, top.length - repo.length - 1)) || ".";
    path = `${parent}/${repo}-wt-${branchToDirSegment(branch)}`;
  }

  // argv ordering: `git worktree add [-b <new>] <path> [<existing-branch>]`. Options FIRST; we
  // already rejected flag-like path/branch, so no `--` (older gits reject it before the path).
  const argv = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path];
  const r = await runGit(argv, cwd, spawn);
  if (!r.ok)
    return { ok: false, message: r.stderr.trim() || `git worktree add failed (${r.code})` };
  return { ok: true, path, message: `created worktree at ${path}` };
}

/**
 * Remove a worktree by path. NEVER `--force`: git refuses a dirty/locked worktree and we surface
 * that honestly. Callers must have already checked `isDirty` + confirmed. Rejects a flag-like path.
 */
export async function removeWorktree(
  cwd: string,
  path: string,
  spawn: GitSpawn = defaultGitSpawn,
): Promise<GitResult> {
  if (!isSafeToken(path)) {
    return { ok: false, stdout: "", stderr: `unsafe path: "${path}"`, code: 1 };
  }
  return runGit(["worktree", "remove", path], cwd, spawn);
}

/* ==========================================================================
 * Read-only inspection surface for the `/git` pane (CLI-091).
 *
 * HARD read-only invariant: every spawn's argv (BEFORE the trusted `-C <cwd>` prefix runGit adds)
 * must be one of the FROZEN templates in GIT_ALLOWED. `assertReadOnlyGit` throws otherwise, so a
 * mutating verb (push/commit/checkout/reset) or an option-injection (`--output=…`) can never reach
 * a spawn. User input selects only the verb + a numeric log count (`/^\d+$/`, clamped) — never argv.
 * ======================================================================== */

/**
 * The ONLY git argv arrays the read-only pane may run (identity-matched, not prefix). The `log`
 * template ends at `-n`; the single trailing integer count is validated separately as `/^\d+$/`.
 * `-c diff.external=` neutralizes a config-level external diff even beyond `--no-ext-diff`.
 */
const GIT_ALLOWED: readonly (readonly string[])[] = [
  ["status", "--porcelain=v2", "-z"],
  ["-c", "diff.external=", "diff", "--no-ext-diff", "--color=never"],
  ["-c", "diff.external=", "diff", "--cached", "--no-ext-diff", "--color=never"],
  // NUL-delimited hash/refs/subject (git interprets `%x00` → NUL) so a subject that starts with
  // `(...)` can never be misread as ref decorations (the `--oneline` heuristic could).
  ["log", "--pretty=format:%h%x00%D%x00%s", "-n"],
];

/** Does `argv` match `tpl`? The `-n`-terminated log template additionally requires exactly ONE more
 *  arg that is a bare integer (so `-n` can't smuggle an option-shaped value like `-1` or `--x`). */
function argvMatches(tpl: readonly string[], argv: readonly string[]): boolean {
  if (tpl[tpl.length - 1] === "-n") {
    if (argv.length !== tpl.length + 1) return false;
    for (let i = 0; i < tpl.length; i++) if (argv[i] !== tpl[i]) return false;
    return /^\d+$/.test(argv[tpl.length] ?? "");
  }
  return argv.length === tpl.length && tpl.every((t, i) => t === argv[i]);
}

/** Throw unless `argv` is an allowlisted read-only git invocation (the fail-closed read-only gate). */
export function assertReadOnlyGit(argv: readonly string[]): void {
  if (!GIT_ALLOWED.some((tpl) => argvMatches(tpl, argv))) {
    throw new Error(`refused non-allowlisted git argv: ${JSON.stringify(argv)}`);
  }
}

/* ------------------------------ status (porcelain v2 -z) ------------------------------ */

/** One changed path from `git status --porcelain=v2 -z`. `x`/`y` are the staged/unstaged codes. */
export interface StatusEntry {
  path: string;
  x: string;
  y: string;
  /** rename/copy ORIGINAL path (type-`2` records only). */
  orig?: string;
}

export interface StatusGroups {
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: StatusEntry[];
}

/** The substring of `record` after its `spaceIndex`-th space (0 → whole string). "" if too few. */
function fieldAfterSpaces(record: string, spaceIndex: number): string {
  let idx = 0;
  for (let n = 0; n < spaceIndex; n++) {
    const sp = record.indexOf(" ", idx);
    if (sp === -1) return "";
    idx = sp + 1;
  }
  return record.slice(idx);
}

/**
 * Parse `git status --porcelain=v2 -z` (CLI-091). Split STRICTLY on NUL (paths may contain
 * newlines/spaces). Record types: `1` ordinary, `2` rename/copy (its original path is a SEPARATE
 * following NUL field — consumed here so alignment never shifts), `u` unmerged, `?` untracked,
 * `!` ignored (skipped), `#` branch header (skipped). `X`/`Y` = staged/unstaged: `X≠'.'` ⇒ staged
 * group, `Y≠'.'` ⇒ unstaged group (a file can be in both); unmerged (`u`) → unstaged (conflict).
 */
export function parseStatusV2(z: string): StatusGroups {
  const toks = z.split("\x00").filter((t) => t.length > 0);
  const staged: StatusEntry[] = [];
  const unstaged: StatusEntry[] = [];
  const untracked: StatusEntry[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] ?? "";
    const type = t[0];
    if (type === "#" || type === "!") continue; // branch header / ignored
    if (type === "?") {
      untracked.push({ path: t.slice(2), x: "?", y: "?" });
      continue;
    }
    if (type === "1" || type === "2" || type === "u") {
      const x = t[2] ?? ".";
      const y = t[3] ?? ".";
      let orig: string | undefined;
      let path: string;
      if (type === "2") {
        path = fieldAfterSpaces(t, 9); // extra <Xscore> field before the path
        orig = toks[++i]; // the original path is the NEXT NUL field — consume it
      } else if (type === "1") {
        path = fieldAfterSpaces(t, 8);
      } else {
        path = fieldAfterSpaces(t, 10); // `u` carries 3 stages + 3 hashes before the path
      }
      const entry: StatusEntry = { path, x, y, ...(orig ? { orig } : {}) };
      if (type === "u") {
        unstaged.push(entry); // a conflict is unresolved in the work tree
        continue;
      }
      if (x !== ".") staged.push(entry);
      if (y !== ".") unstaged.push(entry);
    }
  }
  return { staged, unstaged, untracked };
}

/** Read-only `git status` → grouped entries (empty groups on a non-repo / spawn failure). */
export async function gitStatus(
  cwd: string,
  spawn: GitSpawn = defaultGitSpawn,
): Promise<StatusGroups> {
  const argv = ["status", "--porcelain=v2", "-z"];
  assertReadOnlyGit(argv);
  const r = await runGit(argv, cwd, spawn);
  return r.ok ? parseStatusV2(r.stdout) : { staged: [], unstaged: [], untracked: [] };
}

/* ------------------------------ diff ------------------------------ */

/** The per-line diff role → the render layer maps it to a color (no raw ANSI here). */
export type DiffRole = "add" | "del" | "hunk" | "meta" | "context";

/** Classify one `--color=never` diff line for coloring. File headers (`+++`/`---`) are META, checked
 *  BEFORE the `+`/`-` add/del test so they don't read as content. */
export function diffLineRole(line: string): DiffRole {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("similarity ") ||
    line.startsWith("rename ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file")
  ) {
    return "meta";
  }
  return "context";
}

export interface DiffTruncation {
  /** the shown diff lines (≤ cap), uncolored. */
  shown: string[];
  /** how many lines were dropped past the cap (0 ⇒ nothing truncated). */
  omitted: number;
}

/** Cut a raw diff to `cap` lines, reporting the EXACT omitted count (the lines actually dropped). */
export function truncateDiff(raw: string, cap = 400): DiffTruncation {
  const body = raw.replace(/\r?\n$/, "");
  const all = body.length === 0 ? [] : body.split(/\r?\n/);
  return { shown: all.slice(0, cap), omitted: Math.max(0, all.length - cap) };
}

/** Read-only `git diff` (or `--cached`) with the external-diff neutralized; raw text (uncolored). */
export async function gitDiff(
  cwd: string,
  opts: { staged?: boolean } = {},
  spawn: GitSpawn = defaultGitSpawn,
): Promise<GitResult> {
  const argv = opts.staged
    ? ["-c", "diff.external=", "diff", "--cached", "--no-ext-diff", "--color=never"]
    : ["-c", "diff.external=", "diff", "--no-ext-diff", "--color=never"];
  assertReadOnlyGit(argv);
  return runGit(argv, cwd, spawn);
}

/* ------------------------------ log ------------------------------ */

export interface LogEntry {
  hash: string;
  /** decorate refs (`HEAD -> master, origin/master`), absent when the commit has none. */
  refs?: string;
  subject: string;
}

/** Parse the NUL-delimited `git log --pretty=format:%h%x00%D%x00%s` output: one commit per line,
 *  three NUL-separated fields (hash, refs, subject) — refs empty ⇒ omitted. Unambiguous by design. */
export function parseLog(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length === 0) continue;
    const [hash, refs, subject] = raw.split("\x00");
    if (!hash) continue;
    out.push({ hash, subject: subject ?? "", ...(refs ? { refs } : {}) });
  }
  return out;
}

/** Validate + clamp a user log count: non-integer/option-shaped ⇒ default (never smuggles `-n`). */
export function clampLogCount(raw: string | undefined, def = 20, max = 200): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return def;
  return Math.min(Math.max(1, Number(raw)), max);
}

/** Read-only `git log --pretty=format:%h%x00%D%x00%s -n <count>` → parsed entries ([] on failure). */
export async function gitLog(
  cwd: string,
  count: number,
  spawn: GitSpawn = defaultGitSpawn,
): Promise<LogEntry[]> {
  const argv = ["log", "--pretty=format:%h%x00%D%x00%s", "-n", String(count)];
  assertReadOnlyGit(argv);
  const r = await runGit(argv, cwd, spawn);
  return r.ok ? parseLog(r.stdout) : [];
}
