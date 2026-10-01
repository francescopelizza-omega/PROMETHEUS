// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/git-host.ts — the git panel backend (file 07 §6.2).
 *
 * Backed by the RAW `git` child process — NEVER a libgit2 reimplementation of
 * porcelain (file 07 §6.2 is explicit). git runs IN THE MAIN PROCESS (C5: the
 * renderer never spawns a child); the GitPanel drives it over the `git:*` IPC
 * channel. Surfaces: status / diff (unified) / stage / unstage / commit / branch /
 * stash / log.
 *
 * This is NOT a python3/nemesis spawner, so C5's "engine-bridge is the only JS
 * python3/nemesis spawner" does not apply — git is a different, benign binary and
 * (unlike pyright/debugpy/node-pty) git IS installed here, so this host runs REAL
 * git LIVE (the tests init a temp repo and assert real behaviour). The spawn is
 * still INJECTABLE so a hermetic test could stub it, but the default + the live
 * tests use real `git`.
 *
 * SAFETY: argv is built by the host, shell:false, so a branch/message string can
 * never inject a flag/command (a leading `-` argument is separated by `--` where a
 * pathspec/refspec is expected). PUSH is a network action surfaced plainly (not
 * gated); the REMOTE a `git clone` came from is gated by file 06 at clone time —
 * NOT here (file 07 §6.2).
 *
 * Node built-ins only: node:child_process + node:fs/promises (the merge editor reads
 * the working-tree copy) + node:path.
 */

import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  spawn as nodeSpawn,
} from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/* ------------------------------------------------------------------------- *
 * The injected git runner (real git by default)
 * ------------------------------------------------------------------------- */

/** The result of one `git` invocation. */
export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `git <argv...>` in `cwd` and capture stdout/stderr/exit. INJECTABLE so a
 * test can stub it; the default spawns the real `git` (shell:false). Never throws
 * for a non-zero git exit (a dirty/failed command is a RESULT the panel renders) —
 * it only rejects when the binary itself cannot be launched. `env` overlays extra
 * variables onto the inherited environment (APP-082 rebase points GIT_SEQUENCE_EDITOR
 * / GIT_EDITOR at scripted, non-interactive wrappers — never a spawned editor).
 */
export type GitRunner = (
  cwd: string,
  argv: string[],
  env?: Record<string, string>,
  stdin?: string,
) => Promise<GitRunResult>;

const GIT_TIMEOUT_MS = 60_000;

/** The default runner: the real `git` binary (or $GIT_BIN). `stdin`, when supplied, is
 *  piped to the child (APP-084 `git apply -` reads the patch over stdin — NEVER argv/shell). */
export const defaultGitRunner: GitRunner = (cwd, argv, env, stdin) =>
  new Promise<GitRunResult>((resolve, reject) => {
    const bin = (typeof process !== "undefined" && process.env.GIT_BIN) || "git";
    const options: SpawnOptions = {
      cwd,
      shell: false,
      // pipe stdin only when there is input to feed (git apply -); else ignore it.
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // never block on an interactive credential prompt — a push/pull/fetch with no
      // configured helper FAILS FAST (with a clear error) instead of hanging the IPC.
      // caller `env` overlays LAST (the rebase editor wrappers), never dropping the prompt guard.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(env ?? {}) },
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = nodeSpawn(bin, argv, options) as ChildProcessWithoutNullStreams;
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (stdin !== undefined) {
      // LF-strict body (git apply normalizes internally); write then close so git sees EOF.
      try {
        child.stdin?.write(stdin);
        child.stdin?.end();
      } catch {
        /* the child may have already exited (bad argv) — the close handler reports it */
      }
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      reject(new Error(`git ${argv[0] ?? ""} timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });

/* ------------------------------------------------------------------------- *
 * Renderer-facing result shapes (plain data)
 * ------------------------------------------------------------------------- */

/** A working-tree change kind (a coarsening of git's XY porcelain codes). */
export type GitChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

/** One changed path, with its staged/unstated split (from `git status --porcelain=v1`). */
export interface GitChange {
  path: string;
  /** the staged (index) change kind, if any. */
  staged?: GitChangeKind;
  /** the unstaged (worktree) change kind, if any. */
  unstaged?: GitChangeKind;
  /** the rename source path, when this is a rename. */
  origPath?: string;
}

/** The grouped status the GitPanel renders. */
export interface GitStatus {
  ok: boolean;
  branch?: string;
  /** ahead/behind the upstream, when known. */
  ahead?: number;
  behind?: number;
  staged: GitChange[];
  unstaged: GitChange[];
  untracked: GitChange[];
  conflicted: GitChange[];
  error?: string;
}

/** A parsed commit log row (`git log` machine format). */
export interface GitLogEntry {
  hash: string;
  /** parent commit hashes, in order (0 for a root commit, 2+ for a merge). */
  parents: string[];
  author: string;
  date: string;
  /** ref decorations on this commit (branch/tag names, "HEAD" stripped of the arrow). */
  refs: string[];
  subject: string;
}

/** One `git stash list` entry (index 0 = most recent). */
export interface GitStashEntry {
  index: number;
  ref: string;
  message: string;
}

/** A parsed git remote resolved to a known forge (APP-085). Unknown hosts → undefined. */
export interface ParsedRemote {
  provider: "github" | "gitlab";
  /** the forge host (github.com / gitlab.com). */
  host: string;
  /** the namespace above the repo — for a GitLab subgroup this holds "group/subgroup". */
  owner: string;
  /** the repository name (last path segment, `.git` stripped). */
  repo: string;
  /** the full "owner/.../repo" path — the GitLab project-id source; "owner/repo" on GitHub. */
  slug: string;
}

const KNOWN_FORGES: Record<string, "github" | "gitlab"> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
};

/**
 * PURE parse of a git remote URL → a known forge, or undefined (feature stays hidden,
 * never guessed). Handles https/ssh URL forms and scp-syntax (`git@host:owner/repo.git`),
 * a real `ssh://…:22/…` port, GitLab subgroups (path with >1 slash), and a single
 * trailing `.git`. Only github.com / gitlab.com are recognized — every other host → undefined.
 */
export function parseRemote(url: string): ParsedRemote | undefined {
  const raw = (url ?? "").trim();
  if (!raw) return undefined;
  let host: string;
  let path: string;
  if (/^(?:https?|ssh|git):\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return undefined;
    }
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } else {
    // scp syntax: [user@]host:owner/repo(.git) — the ':' is a path separator, not a port.
    const m = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
    if (!m || !m[1] || !m[2]) return undefined;
    host = m[1].toLowerCase();
    path = m[2];
  }
  const provider = KNOWN_FORGES[host];
  if (!provider) return undefined;
  const slug = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const segments = slug.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const repo = segments[segments.length - 1]!;
  const owner = segments.slice(0, -1).join("/");
  return { provider, host, owner, repo, slug: segments.join("/") };
}

/** One line's blame (`git blame --porcelain`), 1-based line. */
export interface GitBlameEntry {
  line: number;
  /** the FULL 40-char commit sha (inline blame shows a short prefix, hover the full). */
  hash: string;
  author: string;
  date: string;
  summary: string;
  /** author-time as a Unix epoch (seconds) — the source for a relative "3d ago" label. */
  epoch: number;
}

/** One commit's metadata for the blame click-through (`git show --no-patch`, APP-083). */
export interface GitCommitDetail {
  ok: boolean;
  sha: string;
  author: string;
  email: string;
  /** strict ISO-8601 author date (`%aI`). */
  date: string;
  summary: string;
  body: string;
  error?: string;
}

/** A plain git op result (commit/stage/branch/stash). */
export interface GitOpResult {
  ok: boolean;
  message?: string;
  error?: string;
  /** a cherry-pick/revert that exited non-zero because it left CONFLICTS to resolve
   *  (not a hard failure) — the panel routes the user to the conflicted-files UI. */
  conflicted?: boolean;
}

/** The three `git reset` modes; `hard` is the only worktree-destroying one. */
export type GitResetMode = "soft" | "mixed" | "hard";

/** The three merge-index stages + working copy of a conflicted file (APP-039). */
export interface GitConflictVersions {
  ok: boolean;
  /** `:1:` merge base — empty for an add/add conflict (no common ancestor). */
  base: string;
  /** `:2:` ours (HEAD). */
  ours: string;
  /** `:3:` theirs (MERGE_HEAD). */
  theirs: string;
  /** the working-tree file (still carrying the conflict markers). */
  working: string;
  /** a NUL byte in any version → a 3-way TEXT merge is meaningless (fall back). */
  binary: boolean;
  error?: string;
}

/* ------------------------------------------------------------------------- *
 * Porcelain parsing (pure, the riskiest bit — exercised live)
 * ------------------------------------------------------------------------- */

/** Map a single porcelain status char to a change kind. */
function kindFromCode(code: string): GitChangeKind | undefined {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "added"; // copy → treat as add for the panel
    case "U":
      return "conflicted";
    case "?":
      return "untracked";
    default:
      return undefined;
  }
}

/**
 * Parse `git status --porcelain=v1 -b` output into the grouped GitStatus (pure).
 * The first `## ` line carries the branch + ahead/behind; each subsequent line is
 * `XY <path>` (X=index, Y=worktree; `??`=untracked; `R <old> -> <new>`=rename).
 */
export function parseStatus(stdout: string): Omit<GitStatus, "ok" | "error"> {
  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  const untracked: GitChange[] = [];
  const conflicted: GitChange[] = [];
  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;

  /**
   * NUL-separated records (`-z`), not lines.
   *
   * Without `-z`, git C-QUOTES any path holding a space (always), a non-ASCII byte, a quote, a
   * backslash or a control char — ` M "caf\303\251.py"`, `R  "src/old name.py" -> "src/new
   * name.py"`. The old parser took `raw.slice(3)` verbatim, so the path it produced carried the
   * surrounding quotes and octal escapes, and every per-file operation fed that back as a
   * pathspec: `git add -- '"src/my file.py"'` exits 128, `git diff --` returns empty, blame
   * returns nothing. `core.quotepath=false` does NOT rescue the space case — only `-z` does.
   * Core's own git layer already used `-z` for exactly this reason; this host was the copy that
   * missed it.
   *
   * With `-z` the pathnames are emitted raw, and a rename/copy is TWO records: `R  <new path>`
   * followed by the original path on its own. `records` is walked by index so that pairing can
   * be consumed explicitly. The final record is always empty (records are terminated, not
   * separated).
   */
  const records = stdout.split("\u0000");
  for (let i = 0; i < records.length; i += 1) {
    const raw = records[i] ?? "";
    if (!raw) continue;
    if (raw.startsWith("## ")) {
      const info = raw.slice(3);
      // forms: "main...origin/main [ahead 1, behind 2]" | "main" |
      //        "No commits yet on main" (a fresh repo before its first commit).
      const noCommits = info.match(/No commits yet on (\S+)/);
      if (noCommits) {
        branch = noCommits[1];
      } else {
        const head = info.split(" ")[0] ?? "";
        branch = head.includes("...") ? head.slice(0, head.indexOf("...")) : head;
      }
      const am = info.match(/ahead (\d+)/);
      const bm = info.match(/behind (\d+)/);
      if (am) ahead = Number(am[1]);
      if (bm) behind = Number(bm[1]);
      continue;
    }
    const x = raw[0] ?? " ";
    const y = raw[1] ?? " ";
    const path = raw.slice(3);
    // A rename/copy on either side puts the ORIGINAL path in the very next record. Consume it
    // here rather than splitting on " -> ", which is not a delimiter under -z and which a path
    // could legitimately contain.
    let origPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const next = records[i + 1];
      if (next) {
        origPath = next;
        i += 1;
      }
    }

    if (x === "?" && y === "?") {
      untracked.push({ path, unstaged: "untracked" });
      continue;
    }
    if (x === "U" || y === "U" || (x === "D" && y === "D") || (x === "A" && y === "A")) {
      conflicted.push({ path, staged: "conflicted", unstaged: "conflicted" });
      continue;
    }
    const xk = kindFromCode(x);
    const yk = kindFromCode(y);
    if (xk) staged.push({ path, staged: xk, ...(origPath ? { origPath } : {}) });
    if (yk) unstaged.push({ path, unstaged: yk, ...(origPath ? { origPath } : {}) });
  }
  return { staged, unstaged, untracked, conflicted, branch, ahead, behind };
}

/** The ASCII Unit Separator git emits between log fields (`%x1f`). */
const US = String.fromCharCode(0x1f);

/**
 * Parse `git log --pretty=format:%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s` (unit-separator)
 * rows. `%P` is space-separated parent hashes (empty for a root commit); `%D` is
 * comma-separated ref decorations (empty for most rows) — strip a leading "HEAD -> "
 * arrow so "HEAD" and the branch it points at both appear as plain ref names.
 */
export function parseLog(stdout: string): GitLogEntry[] {
  const out: GitLogEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [hash, parentField, author, date, refField, subject] = line.split(US);
    const parents = (parentField ?? "").split(" ").filter(Boolean);
    const refs = (refField ?? "")
      .replace("HEAD -> ", "HEAD, ")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    out.push({
      hash: hash ?? "",
      parents,
      author: author ?? "",
      date: date ?? "",
      refs,
      subject: subject ?? "",
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Interactive rebase (APP-082) — scripted todo, NEVER a spawned editor
 * ------------------------------------------------------------------------- */

/** The rebase todo actions the host accepts (the IPC validator whitelists the same set). */
export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";

/** One editable todo row for `git rebase -i`. `message` is used only for reword/squash. */
export interface RebaseTodoRow {
  sha: string;
  subject: string;
  action: RebaseAction;
  /** the reword/squash message; defaults to `subject` when omitted (never empty). */
  message?: string;
}

/** The commits of `base..HEAD` as an editable todo (oldest-first), or an error. */
export interface RebaseTodoResult {
  ok: boolean;
  /** `base` resolved to a concrete commit sha (the argv `git rebase -i` receives). */
  base: string;
  rows: RebaseTodoRow[];
  error?: string;
}

/** Whether a rebase is mid-flight (incl. across an app restart) + its conflict state. */
export interface RebaseState {
  inProgress: boolean;
  /** unmerged paths blocking `--continue` (empty when not conflicted). */
  conflicted: string[];
  /** the pre-rebase tip (`rebase-merge/orig-head` or ORIG_HEAD) — Abort restores it. */
  origHead?: string;
  /** the commit the rebase is replaying onto. */
  onto?: string;
  /** 1-based current step / total steps, when git records them. */
  step?: number;
  total?: number;
  error?: string;
}

/**
 * Serialize todo rows to the git-rebase-todo text (PURE). One `<action> <sha> <subject>`
 * line per row; the subject is cosmetic (git ignores everything after the sha) but is
 * newline-stripped so a crafted subject can never inject a second todo command. Rows are
 * emitted verbatim in order — the CALLER supplies them oldest-first (rebase order).
 */
export function serializeRebaseTodo(rows: readonly RebaseTodoRow[]): string {
  const lines = rows.map((r) => {
    const subject = r.subject.replace(/[\r\n]+/g, " ").trim();
    return `${r.action} ${r.sha}${subject ? ` ${subject}` : ""}`;
  });
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------------- *
 * The host
 * ------------------------------------------------------------------------- */

export interface GitHostOptions {
  /** the git runner (default: real `git`). Injectable for hermetic tests. */
  run?: GitRunner;
}

/** The git panel host — RAW git porcelain over the injected runner (real by default). */
export class GitHost {
  private readonly run: GitRunner;

  constructor(opts: GitHostOptions = {}) {
    this.run = opts.run ?? defaultGitRunner;
  }

  /** Is `root` inside a git work tree? (`git rev-parse --is-inside-work-tree`). */
  async isRepo(root: string): Promise<boolean> {
    try {
      const r = await this.run(root, ["rev-parse", "--is-inside-work-tree"]);
      return r.exitCode === 0 && r.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /**
   * Grouped working-tree status (`git status --porcelain=v1 -b -z`, file 07 §6.2).
   *
   * `-z` is load-bearing, not a micro-optimisation: without it git C-quotes any path containing a
   * space or a non-ASCII byte, and the quoted string then fails as a pathspec for every per-file
   * stage / unstage / diff / blame. See `parseStatus`.
   */
  async status(root: string): Promise<GitStatus> {
    try {
      const r = await this.run(root, ["status", "--porcelain=v1", "-b", "-z"]);
      if (r.exitCode !== 0) {
        return {
          ok: false,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicted: [],
          error: r.stderr.trim(),
        };
      }
      const parsed = parseStatus(r.stdout);
      return { ok: true, ...parsed };
    } catch (e) {
      return {
        ok: false,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Unified diff for a file (file 07 §6.2). `staged` → `git diff --cached <file>`
   * (index vs HEAD); else `git diff <file>` (worktree vs index). `--` separates the
   * pathspec so a leading-dash filename can't be read as a flag.
   */
  async diff(root: string, file: string, staged = false): Promise<string> {
    const argv = staged ? ["diff", "--cached", "--", file] : ["diff", "--", file];
    try {
      const r = await this.run(root, argv);
      // git diff exits 0 with output (or empty); a non-zero is surfaced as the body.
      return r.stdout || (r.exitCode !== 0 ? r.stderr : "");
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Per-line blame (`git blame --porcelain -- <file>`), parsed to one entry per line.
   *  The path rides after `--`, so it can't be treated as a flag (injection-safe). */
  async blame(root: string, file: string): Promise<GitBlameEntry[]> {
    try {
      const r = await this.run(root, ["blame", "--porcelain", "--", file]);
      if (r.exitCode !== 0) return [];
      const commits = new Map<string, { author: string; time: number; summary: string }>();
      const entries: GitBlameEntry[] = [];
      let cur: string | null = null;
      let finalLine = 0;
      for (const ln of r.stdout.split("\n")) {
        const m = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(ln);
        if (m?.[1]) {
          cur = m[1];
          finalLine = Number(m[2]);
          if (!commits.has(cur)) commits.set(cur, { author: "", time: 0, summary: "" });
          continue;
        }
        if (!cur) continue;
        const meta = commits.get(cur);
        if (!meta) continue;
        if (ln.startsWith("author ")) meta.author = ln.slice(7);
        else if (ln.startsWith("author-time ")) meta.time = Number(ln.slice(12)) || 0;
        else if (ln.startsWith("summary ")) meta.summary = ln.slice(8);
        else if (ln.startsWith("\t")) {
          entries.push({
            line: finalLine,
            hash: cur, // full 40-char sha; the inline annotation shows a short prefix
            author: meta.author,
            date: meta.time ? new Date(meta.time * 1000).toISOString().slice(0, 10) : "",
            summary: meta.summary,
            epoch: meta.time,
          });
        }
      }
      entries.sort((a, b) => a.line - b.line);
      return entries;
    } catch {
      return [];
    }
  }

  /** Abort an in-progress merge or rebase (`git merge --abort`, else `rebase --abort`). */
  async abortMerge(root: string): Promise<GitOpResult> {
    try {
      const m = await this.run(root, ["merge", "--abort"]);
      if (m.exitCode === 0) return { ok: true, message: "merge aborted" };
      const rb = await this.run(root, ["rebase", "--abort"]);
      if (rb.exitCode === 0) return { ok: true, message: "rebase aborted" };
      return { ok: false, error: (rb.stderr || m.stderr || "nothing to abort").trim() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Resolve one conflicted file to a side (`git checkout --ours|--theirs -- <file>`).
   *  `side` is a validated enum + the path rides after `--` (injection-safe). */
  async checkoutSide(root: string, file: string, side: "ours" | "theirs"): Promise<GitOpResult> {
    return this.runOp(root, ["checkout", `--${side}`, "--", file]);
  }

  /** Checkout a commit-ish into a DETACHED HEAD (`git checkout -q <hash>`). `-q`
   *  suppresses the "detached HEAD" advisory git prints on stderr at exit 0, so a
   *  successful checkout never reads as an error. The hash/ref is validated (no
   *  leading `-`) at the IPC boundary, so it can never inject a flag. */
  async checkoutCommit(root: string, hash: string): Promise<GitOpResult> {
    return this.runOp(root, ["checkout", "-q", hash]);
  }

  /** Cherry-pick a commit onto the current branch (`git cherry-pick <hash>`). A
   *  conflict exits non-zero and leaves `.git/CHERRY_PICK_HEAD` + unmerged paths;
   *  that outcome is reported as `{ ok:false, conflicted:true }` so the panel
   *  routes to the conflicted-files section rather than reporting a hard failure. */
  async cherryPick(root: string, hash: string): Promise<GitOpResult> {
    return this.runSequencerOp(root, ["cherry-pick", hash]);
  }

  /** Revert a commit as a new inverse commit, no editor (`git revert --no-edit
   *  <hash>`). Conflicts route like cherry-pick; a dirty index/worktree fails with
   *  git's own "local changes would be overwritten" stderr surfaced verbatim. */
  async revertCommit(root: string, hash: string): Promise<GitOpResult> {
    return this.runSequencerOp(root, ["revert", "--no-edit", hash]);
  }

  /** Move HEAD to a commit (`git reset --<mode> <hash>`). `mode` is a CLOSED union
   *  RE-CHECKED at runtime so a malformed IPC value can never inject `--hard`; only
   *  `--hard` discards index+worktree (the caller gates it behind a typed confirm). */
  async reset(root: string, hash: string, mode: GitResetMode): Promise<GitOpResult> {
    if (mode !== "soft" && mode !== "mixed" && mode !== "hard") {
      return { ok: false, error: `invalid reset mode "${String(mode)}"` };
    }
    return this.runOp(root, ["reset", `--${mode}`, hash]);
  }

  /** Read the three conflict versions of a file (APP-039): index stages `:1:`/`:2:`/
   *  `:3:` (base/ours/theirs) + the working tree. A MISSING stage (add/add has no
   *  base; delete/modify misses ours or theirs) exits non-zero → an empty pane, still
   *  ok:true. A NUL byte in any blob flags binary (a 3-way TEXT merge is meaningless).
   *  `file` is validated repo-relative at the IPC boundary (no leading '-'/'..'). */
  async conflictVersions(root: string, file: string): Promise<GitConflictVersions> {
    const showStage = async (n: 1 | 2 | 3): Promise<string> => {
      try {
        const r = await this.run(root, ["show", `:${n}:${file}`]);
        return r.exitCode === 0 ? r.stdout : ""; // missing stage → empty pane
      } catch {
        return "";
      }
    };
    try {
      const [base, ours, theirs] = await Promise.all([showStage(1), showStage(2), showStage(3)]);
      let working = "";
      try {
        working = await readFile(join(root, file), "utf8");
      } catch {
        working = ""; // deleted in the worktree → empty working pane
      }
      const binary = [base, ours, theirs, working].some((s) => s.includes("\u0000"));
      return { ok: true, base, ours, theirs, working, binary };
    } catch (e) {
      return {
        ok: false,
        base: "",
        ours: "",
        theirs: "",
        working: "",
        binary: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Stage paths (`git add -- <files>`). Empty list → stage all (`git add -A`). */
  async stage(root: string, files: string[]): Promise<GitOpResult> {
    const argv = files.length === 0 ? ["add", "-A"] : ["add", "--", ...files];
    return this.runOp(root, argv);
  }

  /** Unstage paths (`git restore --staged -- <files>`). Empty → unstage all. */
  async unstage(root: string, files: string[]): Promise<GitOpResult> {
    const argv =
      files.length === 0 ? ["restore", "--staged", "."] : ["restore", "--staged", "--", ...files];
    return this.runOp(root, argv);
  }

  /**
   * Apply a caller-built patch to the INDEX for per-hunk / per-line staging (APP-084):
   * `git apply --cached [-R] -`, with the patch piped over STDIN (never argv/shell). A
   * `reverse` apply of a STAGED-diff hunk unstages exactly that hunk. Normal `git diff`
   * output carries 3 context lines, so `--unidiff-zero` is deliberately NOT used (it
   * disables the context safety check and only fits `-U0` patches). Empty patch → no-op ok.
   */
  async applyPatch(
    root: string,
    patch: string,
    opts: { cached?: boolean; reverse?: boolean } = {},
  ): Promise<GitOpResult> {
    if (!patch.trim()) return { ok: true, message: "empty patch (nothing to apply)" };
    const argv = [
      "apply",
      ...(opts.cached ? ["--cached"] : []),
      ...(opts.reverse ? ["-R"] : []),
      "-",
    ];
    try {
      const r = await this.run(root, argv, undefined, patch);
      if (r.exitCode === 0) return { ok: true, message: "patch applied" };
      return {
        ok: false,
        error: (r.stderr || r.stdout).trim() || `git apply exited ${r.exitCode}`,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Commit staged changes (`git commit -m <message>` [+ `--amend`]). */
  async commit(
    root: string,
    message: string,
    opts: { amend?: boolean } = {},
  ): Promise<GitOpResult> {
    if (!message.trim() && !opts.amend) return { ok: false, error: "empty commit message" };
    const argv = ["commit", "-m", message, ...(opts.amend ? ["--amend"] : [])];
    return this.runOp(root, argv);
  }

  /** The current branch name (`git rev-parse --abbrev-ref HEAD`). */
  async currentBranch(root: string): Promise<string | undefined> {
    try {
      const r = await this.run(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return r.exitCode === 0 ? r.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The current HEAD sha (`git rev-parse HEAD`), or undefined when there is none.
   *
   * Undefined covers every "nothing to key trust on" case — not a repository, a fresh repo with
   * no commits, git missing — which the run gate treats as "scan it".
   */
  async headSha(root: string): Promise<string | undefined> {
    try {
      const r = await this.run(root, ["rev-parse", "HEAD"]);
      const sha = r.stdout.trim();
      return r.exitCode === 0 && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : undefined;
    } catch {
      return undefined;
    }
  }

  /** The configured URL of a remote (`git remote get-url -- <name>`, APP-085). `--`
   *  blocks a `-`-leading remote name; the URL is then run through PURE parseRemote by
   *  the caller (never string-concatenated into an API URL). */
  async remoteUrl(root: string, name = "origin"): Promise<string | undefined> {
    try {
      const r = await this.run(root, ["remote", "get-url", "--", name]);
      const url = r.stdout.trim();
      return r.exitCode === 0 && url ? url : undefined;
    } catch {
      return undefined;
    }
  }

  /** Switch / create a branch. `create` → `git switch -c <name>`; else `git switch <name>`. */
  async branch(root: string, name: string, opts: { create?: boolean } = {}): Promise<GitOpResult> {
    const argv = opts.create ? ["switch", "-c", name] : ["switch", name];
    return this.runOp(root, argv);
  }

  /** List branches (`git branch --format=%(refname:short)`). */
  async listBranches(root: string): Promise<string[]> {
    try {
      const r = await this.run(root, ["branch", "--format=%(refname:short)"]);
      if (r.exitCode !== 0) return [];
      return r.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Stash the working tree (`git stash push` [-m message]). */
  async stash(root: string, message?: string): Promise<GitOpResult> {
    const argv = message ? ["stash", "push", "-m", message] : ["stash", "push"];
    return this.runOp(root, argv);
  }

  /** List stash entries (`git stash list`), newest-first (index 0 = most recent). */
  async stashList(root: string): Promise<GitStashEntry[]> {
    try {
      const r = await this.run(root, ["stash", "list", "--format=%gd%x1f%s"]);
      if (r.exitCode !== 0) return [];
      return r.stdout
        .split("\n")
        .map((ln) => ln.trim())
        .filter(Boolean)
        .map((ln, i) => {
          const [ref, message] = ln.split("\x1f");
          return { index: i, ref: ref ?? `stash@{${i}}`, message: message ?? "" };
        });
    } catch {
      return [];
    }
  }

  /** Pop a stash (`git stash pop [stash@{index}]`; latest when index omitted). The
   *  index is a validated non-negative integer, so the ref is injection-safe. */
  async stashPop(root: string, index?: number): Promise<GitOpResult> {
    const ref = index === undefined ? [] : [`stash@{${index}}`];
    return this.runOp(root, ["stash", "pop", ...ref]);
  }

  /** Apply a stash without removing it (`git stash apply [stash@{index}]`). */
  async stashApply(root: string, index?: number): Promise<GitOpResult> {
    const ref = index === undefined ? [] : [`stash@{${index}}`];
    return this.runOp(root, ["stash", "apply", ...ref]);
  }

  /** Drop a stash (`git stash drop [stash@{index}]`). */
  async stashDrop(root: string, index?: number): Promise<GitOpResult> {
    const ref = index === undefined ? [] : [`stash@{${index}}`];
    return this.runOp(root, ["stash", "drop", ...ref]);
  }

  /** Push the current branch to its configured upstream (`git push`). */
  async push(root: string): Promise<GitOpResult> {
    return this.runOp(root, ["push"]);
  }

  /** Pull with rebase to avoid an implicit merge commit (`git pull --rebase`). */
  async pull(root: string): Promise<GitOpResult> {
    return this.runOp(root, ["pull", "--rebase"]);
  }

  /** Fetch all remotes + prune deleted refs (`git fetch --all --prune`). */
  async fetch(root: string): Promise<GitOpResult> {
    return this.runOp(root, ["fetch", "--all", "--prune"]);
  }

  /** Commit log, newest-first (`git log -n <limit>`, machine format). */
  async log(root: string, limit = 50): Promise<GitLogEntry[]> {
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 50;
    try {
      const r = await this.run(root, [
        "log",
        `-n${n}`,
        "--pretty=format:%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s",
        "--date=iso-strict",
      ]);
      if (r.exitCode !== 0) return [];
      return parseLog(r.stdout);
    } catch {
      return [];
    }
  }

  /**
   * One commit's metadata for the blame click-through (APP-083). `--no-patch` (=`-s`)
   * suppresses the diff — metadata only; `--` terminates so a leading-dash sha can't be
   * read as a flag (the sha is also validated at the IPC boundary). NUL-delimited fields
   * (author names carry spaces) split cleanly in JS.
   */
  async show(root: string, sha: string): Promise<GitCommitDetail> {
    const empty: GitCommitDetail = {
      ok: false,
      sha: "",
      author: "",
      email: "",
      date: "",
      summary: "",
      body: "",
    };
    try {
      const r = await this.run(root, [
        "show",
        "--no-patch",
        "--no-color",
        "--format=%H%x00%an%x00%ae%x00%aI%x00%s%x00%b",
        sha,
        "--",
      ]);
      if (r.exitCode !== 0) {
        return { ...empty, error: (r.stderr || "git show failed").trim() };
      }
      const [h, an, ae, adate, s, b] = r.stdout.split("\x00");
      return {
        ok: true,
        sha: (h ?? sha).trim(),
        author: an ?? "",
        email: ae ?? "",
        date: (adate ?? "").trim(),
        summary: s ?? "",
        body: (b ?? "").replace(/\n+$/, ""),
      };
    } catch (e) {
      return { ...empty, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /* ── interactive rebase (APP-082) ─────────────────────────────────────────
   * Non-interactive by construction: `git rebase -i` is driven by scripted
   * GIT_SEQUENCE_EDITOR / GIT_EDITOR wrappers (written 0o700 into a mkdtemp dir,
   * deleted in finally) that COPY precomputed todo/message files over the paths
   * git hands them — no editor UI, no shell interpolation of user data (the todo
   * and messages ride in files pointed at by env vars, never in argv). */

  /** Resolve a ref (sha / `HEAD~3` / branch) to a concrete commit sha, or null. */
  private async resolveRef(root: string, ref: string): Promise<string | null> {
    try {
      const r = await this.run(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      const sha = r.stdout.trim();
      return r.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /** Absolute path of a `.git`-relative entry (`--git-path`), worktree/submodule-safe. */
  private async gitPathAbs(root: string, rel: string): Promise<string> {
    try {
      const r = await this.run(root, ["rev-parse", "--git-path", rel]);
      const p = r.exitCode === 0 ? r.stdout.trim() : rel;
      return isAbsolute(p) ? p : join(root, p);
    } catch {
      return join(root, ".git", rel);
    }
  }

  private async gitPathExists(root: string, rel: string): Promise<boolean> {
    try {
      await stat(await this.gitPathAbs(root, rel));
      return true;
    } catch {
      return false;
    }
  }

  private async readGitFile(root: string, rel: string): Promise<string | undefined> {
    try {
      return (await readFile(await this.gitPathAbs(root, rel), "utf8")).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The commits of `base..HEAD` as an editable todo, OLDEST-first (the order
   * `git rebase -i` applies them — `git log` is newest-first, so `--reverse`).
   * `base` is resolved to a concrete sha first (a `HEAD~3`/branch base is fine).
   */
  async rebaseTodo(root: string, base: string): Promise<RebaseTodoResult> {
    const baseSha = await this.resolveRef(root, base);
    if (!baseSha) return { ok: false, base, rows: [], error: `cannot resolve base ref: ${base}` };
    try {
      const r = await this.run(root, [
        "log",
        "--reverse",
        "--pretty=format:%H%x1f%s",
        `${baseSha}..HEAD`,
      ]);
      if (r.exitCode !== 0) {
        return { ok: false, base: baseSha, rows: [], error: (r.stderr || "git log failed").trim() };
      }
      const rows: RebaseTodoRow[] = [];
      for (const line of r.stdout.split("\n")) {
        if (!line) continue;
        const [sha, subject] = line.split(US);
        if (sha) rows.push({ sha, subject: subject ?? "", action: "pick" });
      }
      return { ok: true, base: baseSha, rows };
    } catch (e) {
      return {
        ok: false,
        base: baseSha,
        rows: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Run `git rebase -i <base>` applying `todo` non-interactively (APP-082). The
   * caller-built todo drives a scripted GIT_SEQUENCE_EDITOR; reword/squash messages
   * drive a scripted GIT_EDITOR (one message file per reword/squash, consumed in
   * todo order). A conflict is reported `conflicted:true` (the panel shows the
   * Continue/Abort banner), not a hard failure.
   */
  async rebaseRun(
    root: string,
    base: string,
    todo: readonly RebaseTodoRow[],
  ): Promise<GitOpResult> {
    const kept = todo.filter((r) => r.action !== "drop");
    if (kept.length === 0) return { ok: false, error: "rebase todo has no commits to apply" };
    if (kept[0] && (kept[0].action === "squash" || kept[0].action === "fixup")) {
      return { ok: false, error: `the first commit cannot be "${kept[0].action}"` };
    }
    const baseSha = await this.resolveRef(root, base);
    if (!baseSha) return { ok: false, error: `cannot resolve base ref: ${base}` };

    const dir = await mkdtemp(join(tmpdir(), "prom-rebase-"));
    try {
      // 1) the precomputed todo + the sequence-editor wrapper that installs it.
      const todoSrc = join(dir, "todo");
      await writeFile(todoSrc, serializeRebaseTodo(todo), { mode: 0o600 });
      const seqEditor = join(dir, "seq-editor.sh");
      await writeFile(seqEditor, '#!/bin/sh\ncat "$PROM_REBASE_TODO" > "$1"\n', { mode: 0o700 });

      const env: Record<string, string> = {
        GIT_SEQUENCE_EDITOR: seqEditor,
        PROM_REBASE_TODO: todoSrc,
        // pick/fixup/drop never open an editor; `true` is the safety net (never blocks).
        GIT_EDITOR: "true",
      };

      // 2) reword/squash message wrapper. CRITICAL: git opens GIT_EDITOR ONCE per `reword`
      // row AND ONCE per maximal consecutive squash/fixup RUN (a run with ≥1 squash; a run of
      // plain fixups is silent) — NOT once per row. Emitting one file per row desynced the
      // counter so a reword after a squash run grabbed the wrong commit's message (corruption).
      // Walk the applied sequence (`kept`, drops removed) and emit exactly one message file per
      // editor invocation, in order.
      const msgOf = (r: RebaseTodoRow): string => (r.message?.trim() ? r.message : r.subject);
      const invocations: string[] = [];
      for (let k = 0; k < kept.length; ) {
        const r = kept[k]!;
        if (r.action === "reword") {
          invocations.push(msgOf(r));
          k++;
        } else if (r.action === "squash" || r.action === "fixup") {
          // consume the whole consecutive squash/fixup run → at most ONE invocation, keyed to
          // the LAST squash's message (the final combined message); an all-fixup run is silent.
          let end = k;
          let lastSquash: RebaseTodoRow | null = null;
          while (
            end < kept.length &&
            (kept[end]!.action === "squash" || kept[end]!.action === "fixup")
          ) {
            if (kept[end]!.action === "squash") lastSquash = kept[end]!;
            end++;
          }
          if (lastSquash) invocations.push(msgOf(lastSquash));
          k = end;
        } else {
          k++;
        }
      }
      if (invocations.length > 0) {
        const msgDir = join(dir, "msg");
        await mkdir(msgDir);
        for (let i = 0; i < invocations.length; i++) {
          await writeFile(join(msgDir, String(i)), `${invocations[i]}\n`, { mode: 0o600 });
        }
        const counter = join(dir, "counter");
        await writeFile(counter, "0", { mode: 0o600 });
        const msgEditor = join(dir, "msg-editor.sh");
        await writeFile(
          msgEditor,
          '#!/bin/sh\nn=$(cat "$PROM_REBASE_COUNTER")\ncp "$PROM_REBASE_MSGDIR/$n" "$1"\necho $((n + 1)) > "$PROM_REBASE_COUNTER"\n',
          { mode: 0o700 },
        );
        env.GIT_EDITOR = msgEditor;
        env.PROM_REBASE_MSGDIR = msgDir;
        env.PROM_REBASE_COUNTER = counter;
      }

      const r = await this.run(root, ["rebase", "-i", baseSha], env);
      if (r.exitCode === 0) {
        return { ok: true, message: (r.stdout || r.stderr).trim() || "rebase complete" };
      }
      const conflicted = /CONFLICT|could not apply|needs merge|Resolve all conflicts/i.test(
        `${r.stdout}\n${r.stderr}`,
      );
      const error = (r.stderr || r.stdout).trim() || `git exited ${r.exitCode}`;
      return conflicted ? { ok: false, conflicted: true, error } : { ok: false, error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Is a rebase in progress (incl. after an app restart)? + its conflict/step state. */
  async rebaseState(root: string): Promise<RebaseState> {
    try {
      const [inMerge, inApply] = await Promise.all([
        this.gitPathExists(root, "rebase-merge"),
        this.gitPathExists(root, "rebase-apply"),
      ]);
      if (!inMerge && !inApply) return { inProgress: false, conflicted: [] };
      let conflicted: string[] = [];
      try {
        const u = await this.run(root, ["diff", "--name-only", "--diff-filter=U"]);
        if (u.exitCode === 0) {
          conflicted = u.stdout
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      } catch {
        /* best-effort: an empty conflict list still shows the banner */
      }
      const origHead =
        (await this.readGitFile(root, "rebase-merge/orig-head")) ??
        (await this.readGitFile(root, "ORIG_HEAD"));
      const onto = await this.readGitFile(root, "rebase-merge/onto");
      const stepStr = await this.readGitFile(root, "rebase-merge/msgnum");
      const totalStr = await this.readGitFile(root, "rebase-merge/end");
      const state: RebaseState = { inProgress: true, conflicted };
      if (origHead) state.origHead = origHead;
      if (onto) state.onto = onto;
      if (stepStr && /^\d+$/.test(stepStr)) state.step = Number(stepStr);
      if (totalStr && /^\d+$/.test(totalStr)) state.total = Number(totalStr);
      return state;
    } catch (e) {
      return {
        inProgress: false,
        conflicted: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Continue a conflict-paused rebase (`git rebase --continue`). GIT_EDITOR=true so a
   *  pending reword/squash after the conflict accepts the in-progress message (never blocks). */
  async rebaseContinue(root: string): Promise<GitOpResult> {
    try {
      const r = await this.run(root, ["rebase", "--continue"], { GIT_EDITOR: "true" });
      if (r.exitCode === 0) {
        return { ok: true, message: (r.stdout || r.stderr).trim() || "rebase continued" };
      }
      const conflicted = /CONFLICT|could not apply|needs merge|Resolve all conflicts/i.test(
        `${r.stdout}\n${r.stderr}`,
      );
      const error = (r.stderr || r.stdout).trim() || `git exited ${r.exitCode}`;
      return conflicted ? { ok: false, conflicted: true, error } : { ok: false, error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Abort an in-progress rebase (`git rebase --abort`), restoring the pre-rebase tip. */
  async rebaseAbort(root: string): Promise<GitOpResult> {
    return this.runOp(root, ["rebase", "--abort"]);
  }

  /** Run a state-changing git op and normalise to a GitOpResult. */
  private async runOp(
    root: string,
    argv: string[],
    env?: Record<string, string>,
  ): Promise<GitOpResult> {
    try {
      const r = await this.run(root, argv, env);
      if (r.exitCode === 0)
        return { ok: true, message: (r.stdout || r.stderr).trim() || undefined };
      return { ok: false, error: (r.stderr || r.stdout).trim() || `git exited ${r.exitCode}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Run a sequencer op (cherry-pick/revert) distinguishing a CONFLICT (exit≠0 but
   *  the op left unmerged paths to resolve) from a hard failure (bad ref, dirty
   *  tree). A conflict carries `conflicted:true` for the panel's routing. */
  private async runSequencerOp(root: string, argv: string[]): Promise<GitOpResult> {
    try {
      const r = await this.run(root, argv);
      if (r.exitCode === 0)
        return { ok: true, message: (r.stdout || r.stderr).trim() || undefined };
      const conflicted = /CONFLICT|could not apply|after resolving the conflicts/i.test(
        `${r.stdout}\n${r.stderr}`,
      );
      const error = (r.stderr || r.stdout).trim() || `git exited ${r.exitCode}`;
      return conflicted ? { ok: false, conflicted: true, error } : { ok: false, error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
