/**
 * git-host.test.ts — node:test for the RAW-git panel backend, LIVE (file 07 §6.2).
 *
 * git IS installed in this env, so this runs the REAL `git` binary against a
 * THROWAWAY temp repo (mkdtemp under os.tmpdir): init → config → write → status →
 * stage → commit → diff → branch → log. The assertions pin the REAL git behaviour
 * (the brief's "groundTruth"), not a stub — exactly what the host must reflect.
 *
 * It also unit-tests the pure porcelain parsers (parseStatus/parseLog) against
 * hand-built fixtures so the parsing is covered independently of a live repo.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test git-host.test.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { buildPatch, parseUnifiedDiff } from "../../renderer/ide/state/diff-hunks.js";
import {
  GitHost,
  type GitRunResult,
  type GitRunner,
  type RebaseTodoRow,
  defaultGitRunner,
  parseLog,
  parseRemote,
  parseStatus,
  serializeRebaseTodo,
} from "./git-host.js";

/* ── pure parser unit tests (no repo needed) ────────────────────────────────*/

/** git -z terminates every record with a NUL; the helper mirrors that exactly. */
const Z = (...records: string[]): string => `${records.join("\u0000")}\u0000`;

test("parseStatus groups staged / unstaged / untracked / branch", () => {
  const out = parseStatus(
    Z(
      "## main...origin/main [ahead 1, behind 2]",
      "M  staged.ts",
      " M dirty.ts",
      "?? new.ts",
      "A  added.ts",
    ),
  );
  assert.equal(out.branch, "main");
  assert.equal(out.ahead, 1);
  assert.equal(out.behind, 2);
  assert.deepEqual(out.staged.map((c) => c.path).sort(), ["added.ts", "staged.ts"]);
  assert.deepEqual(
    out.unstaged.map((c) => c.path),
    ["dirty.ts"],
  );
  assert.deepEqual(
    out.untracked.map((c) => c.path),
    ["new.ts"],
  );
});

test("parseStatus detects a rename — the ORIGINAL path is the record that follows", () => {
  // Under -z a rename is two records: the status line naming the NEW path, then the old path
  // alone. There is no " -> " delimiter to split on, and a real filename could contain one.
  const out = parseStatus(Z("## main", "R  new.ts", "old.ts"));
  assert.equal(out.staged[0]?.path, "new.ts");
  assert.equal(out.staged[0]?.origPath, "old.ts");
  assert.equal(out.staged[0]?.staged, "renamed");
});

test("parseStatus keeps paths with spaces and non-ASCII usable as pathspecs", () => {
  /**
   * Captured from real git (`git status --porcelain=v1 -b -z` on a repo holding `café.py`,
   * `src/old name.py` renamed to `src/new name.py`, and an untracked `untracked file.txt`).
   *
   * WITHOUT -z the same repo prints ` M "caf\303\251.py"` and
   * `R  "src/old name.py" -> "src/new name.py"` — C-quoted, octal-escaped, and with the arrow
   * INSIDE the quotes. The parser took `raw.slice(3)` verbatim, so the path it handed back
   * still carried the quotes, and every per-file operation fed that string to git as a
   * pathspec: stage exited 128, diff came back empty, blame returned nothing. Two GitPanel
   * call sites discard the result, so the file simply refused to stage with no error shown.
   * `core.quotepath=false` does not help — git quotes the space case regardless.
   */
  const out = parseStatus(
    Z("## main", " M café.py", "R  src/new name.py", "src/old name.py", "?? untracked file.txt"),
  );
  assert.deepEqual(
    out.unstaged.map((c) => c.path),
    ["café.py"],
    "a non-ASCII path must arrive unquoted and unescaped",
  );
  assert.deepEqual(
    out.untracked.map((c) => c.path),
    ["untracked file.txt"],
    "a path with a space must arrive without surrounding quotes",
  );
  assert.equal(out.staged[0]?.path, "src/new name.py");
  assert.equal(out.staged[0]?.origPath, "src/old name.py");
  for (const c of [...out.staged, ...out.unstaged, ...out.untracked]) {
    assert.ok(
      !c.path.startsWith('"') && !c.path.includes("\\3"),
      `"${c.path}" is still C-quoted — git will reject it as a pathspec`,
    );
  }
});

test("parseLog splits the unit-separated machine format (root commit, no refs)", () => {
  const US = String.fromCharCode(0x1f);
  const line = ["abc123", "", "Ada", "2026-01-01T00:00:00", "", "init"].join(US);
  const rows = parseLog(line);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    hash: "abc123",
    parents: [],
    author: "Ada",
    date: "2026-01-01T00:00:00",
    refs: [],
    subject: "init",
  });
});

test("parseLog: a linear commit carries its single parent hash", () => {
  const US = String.fromCharCode(0x1f);
  const line = ["def456", "abc123", "Ada", "2026-01-02T00:00:00", "", "second"].join(US);
  const rows = parseLog(line);
  assert.deepEqual(rows[0]?.parents, ["abc123"]);
});

test("parseLog: a merge commit carries BOTH parent hashes, space-separated", () => {
  const US = String.fromCharCode(0x1f);
  const line = [
    "merge1",
    "aaa111 bbb222",
    "Ada",
    "2026-01-03T00:00:00",
    "",
    "Merge branch 'x'",
  ].join(US);
  const rows = parseLog(line);
  assert.deepEqual(rows[0]?.parents, ["aaa111", "bbb222"]);
});

test("parseLog: an octopus merge carries 3+ parent hashes in order", () => {
  const US = String.fromCharCode(0x1f);
  const line = ["oct1", "p1 p2 p3", "Ada", "2026-01-04T00:00:00", "", "octopus"].join(US);
  const rows = parseLog(line);
  assert.deepEqual(rows[0]?.parents, ["p1", "p2", "p3"]);
});

test("parseLog: HEAD -> branch decoration splits into separate ref names", () => {
  const US = String.fromCharCode(0x1f);
  const line = [
    "h1",
    "p0",
    "Ada",
    "2026-01-05T00:00:00",
    "HEAD -> main, origin/main",
    "on main",
  ].join(US);
  const rows = parseLog(line);
  assert.deepEqual(rows[0]?.refs, ["HEAD", "main", "origin/main"]);
});

test("parseLog: a tag decoration keeps its 'tag: ' prefix (renderer distinguishes it)", () => {
  const US = String.fromCharCode(0x1f);
  const line = ["h2", "p1", "Ada", "2026-01-06T00:00:00", "tag: v1.0.0", "release"].join(US);
  const rows = parseLog(line);
  assert.deepEqual(rows[0]?.refs, ["tag: v1.0.0"]);
});

test("parseLog: an undecorated commit (most rows) has an empty refs array, never a stray blank entry", () => {
  const US = String.fromCharCode(0x1f);
  const line = ["h3", "p2", "Ada", "2026-01-07T00:00:00", "", "plain"].join(US);
  const rows = parseLog(line);
  assert.deepEqual(rows[0]?.refs, []);
});

/* ── APP-037 commit actions: injected-runner argv + conflict routing ─────────*/

/** A fake runner that records every argv and returns a scripted result. */
function recordingRunner(result: Partial<GitRunResult> = {}): {
  runner: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: GitRunner = async (_cwd, argv) => {
    calls.push(argv);
    return { exitCode: 0, stdout: "", stderr: "", ...result };
  };
  return { runner, calls };
}

test("checkoutCommit runs `checkout -q <hash>` (detached HEAD, advisory suppressed)", async () => {
  const { runner, calls } = recordingRunner();
  const res = await new GitHost({ run: runner }).checkoutCommit("/r", "abc123");
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], ["checkout", "-q", "abc123"]);
});

test("cherryPick runs `cherry-pick <hash>`", async () => {
  const { runner, calls } = recordingRunner();
  const res = await new GitHost({ run: runner }).cherryPick("/r", "HEAD~2");
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], ["cherry-pick", "HEAD~2"]);
});

test("revertCommit runs `revert --no-edit <hash>` (never opens an editor)", async () => {
  const { runner, calls } = recordingRunner();
  await new GitHost({ run: runner }).revertCommit("/r", "abc");
  assert.deepEqual(calls[0], ["revert", "--no-edit", "abc"]);
});

test("reset builds `reset --<mode> <hash>` for every mode", async () => {
  for (const mode of ["soft", "mixed", "hard"] as const) {
    const { runner, calls } = recordingRunner();
    await new GitHost({ run: runner }).reset("/r", "abc", mode);
    assert.deepEqual(calls[0], ["reset", `--${mode}`, "abc"]);
  }
});

test("reset rejects an out-of-union mode at runtime — git is NEVER invoked", async () => {
  const { runner, calls } = recordingRunner();
  // a malformed IPC value must not smuggle `--hard` past the closed union.
  const res = await new GitHost({ run: runner }).reset(
    "/r",
    "abc",
    "hard; rm -rf /" as unknown as "hard",
  );
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0);
});

test("cherryPick surfaces a CONFLICT (exit≠0 + CONFLICT text) as conflicted, not a hard error", async () => {
  const runner: GitRunner = async () => ({
    exitCode: 1,
    stdout: "CONFLICT (content): Merge conflict in a.txt\n",
    stderr: "error: could not apply abc123... subject\n",
  });
  const res = await new GitHost({ run: runner }).cherryPick("/r", "abc123");
  assert.equal(res.ok, false);
  assert.equal(res.conflicted, true);
  assert.match(res.error ?? "", /could not apply/);
});

test("revertCommit on a dirty tree is a HARD failure, not a conflict route", async () => {
  const runner: GitRunner = async () => ({
    exitCode: 128,
    stdout: "",
    stderr: "error: your local changes would be overwritten by revert.\n",
  });
  const res = await new GitHost({ run: runner }).revertCommit("/r", "abc");
  assert.equal(res.ok, false);
  assert.notEqual(res.conflicted, true);
  assert.match(res.error ?? "", /would be overwritten/);
});

test("APP-037 LIVE: checkout detaches HEAD; cherry-pick/revert/reset move HEAD for real", async () => {
  const r = await mkdtemp(join(tmpdir(), "prom-git-commit-actions-"));
  try {
    const g = new GitHost();
    const raw = async (argv: string[]): Promise<void> => {
      const res = await defaultGitRunner(r, argv);
      if (res.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${res.stderr}`);
    };
    await raw(["init", "-b", "main"]);
    await raw(["config", "user.email", "t@prometheus.local"]);
    await raw(["config", "user.name", "T"]);
    await raw(["config", "commit.gpgsign", "false"]);

    await writeFile(join(r, "a.txt"), "one\n", "utf-8");
    await g.stage(r, ["a.txt"]);
    await g.commit(r, "c1");
    const c1 = (await g.log(r, 5))[0]!.hash;
    await writeFile(join(r, "a.txt"), "two\n", "utf-8");
    await g.stage(r, ["a.txt"]);
    await g.commit(r, "c2");

    // checkoutCommit(c1) → DETACHED HEAD.
    assert.equal((await g.checkoutCommit(r, c1)).ok, true);
    const head = await defaultGitRunner(r, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.equal(head.stdout.trim(), "HEAD");
    await raw(["checkout", "main"]);

    // revertCommit(HEAD=c2) → a NEW inverse commit; a.txt back to "one".
    assert.equal((await g.revertCommit(r, "HEAD")).ok, true);
    assert.equal(await readFile(join(r, "a.txt"), "utf-8"), "one\n");
    assert.equal((await g.log(r, 5)).length, 3); // c1, c2, revert

    // reset --hard c1 → HEAD back at c1, worktree "one", history trimmed.
    assert.equal((await g.reset(r, c1, "hard")).ok, true);
    assert.equal((await g.log(r, 5))[0]?.hash, c1);
    assert.equal(await readFile(join(r, "a.txt"), "utf-8"), "one\n");

    // cherry-pick a side commit ONTO main.
    await raw(["checkout", "-b", "side"]);
    await writeFile(join(r, "b.txt"), "b\n", "utf-8");
    await g.stage(r, ["b.txt"]);
    await g.commit(r, "add b");
    const sideHash = (await g.log(r, 1))[0]!.hash;
    await raw(["checkout", "main"]);
    assert.equal((await g.cherryPick(r, sideHash)).ok, true);
    assert.equal(await readFile(join(r, "b.txt"), "utf-8"), "b\n");
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});

test("APP-039 LIVE: conflictVersions returns base/ours/theirs + working for a real conflict", async () => {
  const r = await mkdtemp(join(tmpdir(), "prom-git-conflict-"));
  try {
    const g = new GitHost();
    const raw = (argv: string[]): Promise<{ exitCode: number }> => defaultGitRunner(r, argv);
    await raw(["init", "-b", "main"]);
    await raw(["config", "user.email", "t@prometheus.local"]);
    await raw(["config", "user.name", "T"]);
    await raw(["config", "commit.gpgsign", "false"]);
    await raw(["config", "merge.conflictStyle", "diff3"]); // populate the :1: base pane
    await writeFile(join(r, "f.txt"), "base line\n", "utf-8");
    await g.stage(r, ["f.txt"]);
    await g.commit(r, "base");
    await raw(["checkout", "-b", "feature"]);
    await writeFile(join(r, "f.txt"), "theirs line\n", "utf-8");
    await g.stage(r, ["f.txt"]);
    await g.commit(r, "theirs");
    await raw(["checkout", "main"]);
    await writeFile(join(r, "f.txt"), "ours line\n", "utf-8");
    await g.stage(r, ["f.txt"]);
    await g.commit(r, "ours");
    await raw(["merge", "feature"]); // exits 1 with a conflict — must NOT throw

    const cv = await g.conflictVersions(r, "f.txt");
    assert.equal(cv.ok, true);
    assert.equal(cv.binary, false);
    assert.equal(cv.base.trim(), "base line");
    assert.equal(cv.ours.trim(), "ours line"); // :2: = HEAD (main)
    assert.equal(cv.theirs.trim(), "theirs line"); // :3: = MERGE_HEAD (feature)
    assert.match(cv.working, /<{7}/);
    assert.match(cv.working, />{7}/);

    // a non-conflicted / missing file → empty panes, still ok:true
    const none = await g.conflictVersions(r, "missing.txt");
    assert.equal(none.ok, true);
    assert.equal(none.working, "");
    assert.equal(none.ours, "");
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});

/* ── LIVE git against a real temp repo ──────────────────────────────────────*/

let repo: string;
const git = new GitHost();

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "prom-git-host-"));
  // a hermetic repo: deterministic identity, no global config bleed.
  await runRaw(repo, ["init", "-b", "main"]);
  await runRaw(repo, ["config", "user.email", "test@prometheus.local"]);
  await runRaw(repo, ["config", "user.name", "Prometheus Test"]);
  await runRaw(repo, ["config", "commit.gpgsign", "false"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

/** A tiny raw git helper through the host's REAL default runner (real git). */
async function runRaw(cwd: string, argv: string[]): Promise<void> {
  const res = await defaultGitRunner(cwd, argv);
  if (res.exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${res.stderr}`);
}

test("GitHost.isRepo is true inside the repo, false outside", async () => {
  assert.equal(await git.isRepo(repo), true);
  assert.equal(await git.isRepo(tmpdir()), false);
});

test("GitHost LIVE: write → status(untracked) → stage → status(staged) → commit → log", async () => {
  // 1) a brand-new file is UNTRACKED.
  await writeFile(join(repo, "hello.py"), "print('hi')\n", "utf-8");
  let st = await git.status(repo);
  assert.equal(st.ok, true);
  assert.equal(st.branch, "main");
  assert.deepEqual(
    st.untracked.map((c) => c.path),
    ["hello.py"],
  );
  assert.equal(st.staged.length, 0);

  // 2) STAGE it → it moves to staged (added).
  const staged = await git.stage(repo, ["hello.py"]);
  assert.equal(staged.ok, true);
  st = await git.status(repo);
  assert.deepEqual(
    st.staged.map((c) => c.path),
    ["hello.py"],
  );
  assert.equal(st.staged[0]?.staged, "added");
  assert.equal(st.untracked.length, 0);

  // 3) COMMIT it → the tree is clean afterwards.
  const committed = await git.commit(repo, "add hello.py");
  assert.equal(committed.ok, true);
  st = await git.status(repo);
  assert.equal(st.staged.length, 0);
  assert.equal(st.unstaged.length, 0);
  assert.equal(st.untracked.length, 0);

  // 4) LOG shows the commit, newest-first.
  const log = await git.log(repo, 10);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.subject, "add hello.py");
  assert.equal(log[0]?.author, "Prometheus Test");
  assert.match(log[0]!.hash, /^[0-9a-f]{40}$/);
  assert.deepEqual(log[0]?.parents, []); // the repo's first commit is a root commit
});

test("GitHost LIVE: modify a tracked file → unified diff shows the change", async () => {
  // modify the committed file.
  await writeFile(join(repo, "hello.py"), "print('hello, world')\n", "utf-8");
  const st = await git.status(repo);
  assert.deepEqual(
    st.unstaged.map((c) => c.path),
    ["hello.py"],
  );
  assert.equal(st.unstaged[0]?.unstaged, "modified");

  // the WORKING-TREE unified diff shows the +/- lines.
  const diff = await git.diff(repo, "hello.py", false);
  assert.match(diff, /^diff --git a\/hello\.py b\/hello\.py/m);
  assert.match(diff, /-print\('hi'\)/);
  assert.match(diff, /\+print\('hello, world'\)/);

  // STAGED diff (--cached) is empty until we stage.
  const stagedDiffBefore = await git.diff(repo, "hello.py", true);
  assert.equal(stagedDiffBefore.trim(), "");
  await git.stage(repo, ["hello.py"]);
  const stagedDiffAfter = await git.diff(repo, "hello.py", true);
  assert.match(stagedDiffAfter, /\+print\('hello, world'\)/);
});

test("GitHost LIVE: branch create + switch, listBranches, currentBranch", async () => {
  const made = await git.branch(repo, "feature/x", { create: true });
  assert.equal(made.ok, true);
  assert.equal(await git.currentBranch(repo), "feature/x");
  const branches = await git.listBranches(repo);
  assert.ok(branches.includes("main"));
  assert.ok(branches.includes("feature/x"));
  // switch back to main.
  await git.branch(repo, "main");
  assert.equal(await git.currentBranch(repo), "main");
});

test("GitHost LIVE: stash round-trips a dirty working tree", async () => {
  await writeFile(join(repo, "scratch.txt"), "wip\n", "utf-8");
  await git.stage(repo, ["scratch.txt"]);
  const stashed = await git.stash(repo, "wip");
  assert.equal(stashed.ok, true);
  // after stash the staged change is gone.
  let st = await git.status(repo);
  assert.equal(st.staged.length, 0);
  // pop restores it.
  const popped = await git.stashPop(repo);
  assert.equal(popped.ok, true);
  st = await git.status(repo);
  assert.ok([...st.staged, ...st.unstaged, ...st.untracked].some((c) => c.path === "scratch.txt"));
});

test("GitHost: a failed git op returns ok:false with stderr (not a throw)", async () => {
  // commit with nothing staged (after a clean state) → non-zero, surfaced as ok:false.
  await runRaw(repo, ["restore", "--staged", "."]).catch(() => {});
  await runRaw(repo, ["stash", "clear"]).catch(() => {});
  // reset to a clean tree so there is nothing to commit.
  await runRaw(repo, ["checkout", "--", "."]).catch(() => {});
  await runRaw(repo, ["clean", "-fd"]).catch(() => {});
  const res = await git.commit(repo, "nothing to commit here");
  assert.equal(res.ok, false);
  assert.equal(typeof res.error, "string");
});

/* ── interactive rebase (APP-082): pure serializer + LIVE rebase behaviour ───*/

test("serializeRebaseTodo: one line per row; subject newline-stripped; drop has no subject", () => {
  const text = serializeRebaseTodo([
    { sha: "aaa", subject: "first", action: "pick" },
    { sha: "bbb", subject: "second\nwith newline", action: "squash", message: "m" },
    { sha: "ccc", subject: "", action: "drop" },
  ]);
  assert.equal(text, "pick aaa first\nsquash bbb second with newline\ndrop ccc\n");
});

/** Fresh hermetic repo with an initial base commit; returns the base sha + a commit helper. */
async function newRebaseRepo(): Promise<{
  dir: string;
  git: GitHost;
  base: string;
  commit: (file: string, content: string, msg: string) => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "prom-git-rebase-"));
  const raw = async (argv: string[]): Promise<void> => {
    const res = await defaultGitRunner(dir, argv);
    if (res.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${res.stderr}`);
  };
  await raw(["init", "-b", "main"]);
  await raw(["config", "user.email", "t@prometheus.local"]);
  await raw(["config", "user.name", "T"]);
  await raw(["config", "commit.gpgsign", "false"]);
  const git = new GitHost();
  const commit = async (file: string, content: string, msg: string): Promise<void> => {
    await writeFile(join(dir, file), content, "utf-8");
    await git.stage(dir, [file]);
    const r = await git.commit(dir, msg);
    if (!r.ok) throw new Error(`commit ${msg}: ${r.error}`);
  };
  await commit("base.txt", "base\n", "c0");
  const base = (await git.log(dir, 1))[0]!.hash;
  return { dir, git, base, commit };
}

/** The subjects of `base..HEAD`, oldest-first. */
async function subjectsAbove(dir: string, base: string): Promise<string[]> {
  const r = await defaultGitRunner(dir, [
    "log",
    "--reverse",
    "--pretty=format:%s",
    `${base}..HEAD`,
  ]);
  return r.stdout.split("\n").filter(Boolean);
}

test("APP-082 LIVE: rebaseTodo lists base..HEAD oldest-first as pick rows", async () => {
  const { dir, git, base, commit } = await newRebaseRepo();
  try {
    await commit("a.txt", "a\n", "c1");
    await commit("b.txt", "b\n", "c2");
    const todo = await git.rebaseTodo(dir, base);
    assert.equal(todo.ok, true);
    assert.deepEqual(
      todo.rows.map((r) => [r.subject, r.action]),
      [
        ["c1", "pick"],
        ["c2", "pick"],
      ],
    );
    assert.match(todo.base, /^[0-9a-f]{40}$/);
    // an unresolvable base is a clean error, not a throw
    const bad = await git.rebaseTodo(dir, "nope/does/not/exist");
    assert.equal(bad.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("APP-082 LIVE: squash folds a commit into its predecessor", async () => {
  const { dir, git, base, commit } = await newRebaseRepo();
  try {
    await commit("a.txt", "a\n", "c1");
    await commit("b.txt", "b\n", "c2");
    await commit("c.txt", "c\n", "c3");
    const todo = (await git.rebaseTodo(dir, base)).rows.map((r) => ({ ...r }) as RebaseTodoRow);
    todo[1]!.action = "squash";
    todo[1]!.message = "c1 and c2 combined";
    const run = await git.rebaseRun(dir, base, todo);
    assert.equal(run.ok, true, run.error);
    // c2 folded into c1 → two commits above base (combined + c3)
    assert.deepEqual(await subjectsAbove(dir, base), ["c1 and c2 combined", "c3"]);
    // all three files survive the squash (only history collapsed, not content)
    for (const f of ["a.txt", "b.txt", "c.txt"]) {
      assert.ok(await readFile(join(dir, f), "utf-8"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("APP-082 LIVE: reword changes a commit's message", async () => {
  const { dir, git, base, commit } = await newRebaseRepo();
  try {
    await commit("a.txt", "a\n", "c1");
    await commit("b.txt", "b\n", "c2");
    const todo = (await git.rebaseTodo(dir, base)).rows.map((r) => ({ ...r }) as RebaseTodoRow);
    todo[0]!.action = "reword";
    todo[0]!.message = "c1 reworded";
    const run = await git.rebaseRun(dir, base, todo);
    assert.equal(run.ok, true, run.error);
    assert.deepEqual(await subjectsAbove(dir, base), ["c1 reworded", "c2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("APP-082 LIVE: reorder produces commits in the new order", async () => {
  const { dir, git, base, commit } = await newRebaseRepo();
  try {
    // distinct files → a reorder applies without conflict
    await commit("a.txt", "a\n", "c1");
    await commit("b.txt", "b\n", "c2");
    await commit("c.txt", "c\n", "c3");
    const rows = (await git.rebaseTodo(dir, base)).rows.map((r) => ({ ...r }) as RebaseTodoRow);
    const reordered = [rows[0]!, rows[2]!, rows[1]!]; // c1, c3, c2
    const run = await git.rebaseRun(dir, base, reordered);
    assert.equal(run.ok, true, run.error);
    assert.deepEqual(await subjectsAbove(dir, base), ["c1", "c3", "c2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("APP-082 LIVE: drop removes a commit and its content", async () => {
  const { dir, git, base, commit } = await newRebaseRepo();
  try {
    await commit("a.txt", "a\n", "c1");
    await commit("b.txt", "b\n", "c2");
    await commit("c.txt", "c\n", "c3");
    const todo = (await git.rebaseTodo(dir, base)).rows.map((r) => ({ ...r }) as RebaseTodoRow);
    todo[1]!.action = "drop"; // drop c2
    const run = await git.rebaseRun(dir, base, todo);
    assert.equal(run.ok, true, run.error);
    assert.deepEqual(await subjectsAbove(dir, base), ["c1", "c3"]);
    await assert.rejects(readFile(join(dir, "b.txt"), "utf-8")); // b.txt is gone
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("APP-082 LIVE: abort mid-conflict restores the original HEAD exactly", async () => {
  const { dir, git, base, commit } = await newRebaseRepo();
  try {
    // c1 and c2 modify the SAME line → reordering them forces a conflict
    await commit("f.txt", "one\n", "c1");
    await commit("f.txt", "two\n", "c2");
    const before = (await git.log(dir, 1))[0]!.hash;
    const rows = (await git.rebaseTodo(dir, base)).rows.map((r) => ({ ...r }) as RebaseTodoRow);
    const reordered = [rows[1]!, rows[0]!]; // c2 then c1 → conflict on f.txt
    const run = await git.rebaseRun(dir, base, reordered);
    assert.equal(run.ok, false);
    assert.equal(run.conflicted, true);
    // rebaseState reports in-progress + the pre-rebase tip
    const state = await git.rebaseState(dir);
    assert.equal(state.inProgress, true);
    assert.ok(state.conflicted.includes("f.txt"));
    assert.equal(state.origHead, before);
    // abort restores the original branch tip EXACTLY
    const abort = await git.rebaseAbort(dir);
    assert.equal(abort.ok, true, abort.error);
    assert.equal((await git.rebaseState(dir)).inProgress, false);
    assert.equal((await git.log(dir, 1))[0]!.hash, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── inline blame + commit show (APP-083): LIVE against a real repo ───────────*/

test("APP-083 LIVE: blame carries the FULL sha + author-time epoch", async () => {
  const { dir, git } = await newRebaseRepo();
  try {
    const entries = await git.blame(dir, "base.txt");
    assert.ok(entries.length >= 1);
    const e = entries[0]!;
    assert.match(e.hash, /^[0-9a-f]{40}$/); // full sha (inline shows a short prefix)
    assert.ok(e.epoch > 0); // author-time epoch drives the relative date
    assert.equal(e.author, "T");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("APP-083 LIVE: show returns commit metadata (no diff); bogus sha → ok:false", async () => {
  const { dir, git, base } = await newRebaseRepo();
  try {
    const d = await git.show(dir, base);
    assert.equal(d.ok, true);
    assert.match(d.sha, /^[0-9a-f]{40}$/);
    assert.equal(d.author, "T");
    assert.equal(d.email, "t@prometheus.local");
    assert.equal(d.summary, "c0");
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}T/); // strict ISO-8601 (%aI)
    const bad = await git.show(dir, "deadbeefdeadbeef");
    assert.equal(bad.ok, false);
    assert.equal(typeof bad.error, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── per-hunk staging (APP-084): applyPatch over stdin, LIVE ─────────────────*/

test("APP-084 LIVE: applyPatch stages ONE of two hunks; reverse restores the index", async () => {
  const { dir, git, commit } = await newRebaseRepo();
  try {
    // a file whose two edits are far enough apart to form SEPARATE hunks (3-ctx default)
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    await commit("multi.txt", `${lines.join("\n")}\n`, "seed multi");
    const edited = [...lines];
    edited[1] = "line2-CHANGED";
    edited[14] = "line15-CHANGED";
    await writeFile(join(dir, "multi.txt"), `${edited.join("\n")}\n`, "utf-8");

    const diffText = await git.diff(dir, "multi.txt");
    const parsed = parseUnifiedDiff(diffText);
    assert.equal(parsed.hunks.length, 2, "two separated edits → two hunks");

    // stage ONLY the first hunk (the line2 change) into the index
    const patch = buildPatch(parsed.header, [parsed.hunks[0]!]);
    const applied = await git.applyPatch(dir, patch, { cached: true });
    assert.equal(applied.ok, true, applied.error);

    const cached = await git.diff(dir, "multi.txt", true); // git diff --cached
    assert.match(cached, /line2-CHANGED/);
    assert.ok(!cached.includes("line15-CHANGED"), "the second hunk stayed unstaged");

    // reverse-apply the SAME staged hunk → the index is clean again
    const stagedDiff = await git.diff(dir, "multi.txt", true);
    const rev = buildPatch(parseUnifiedDiff(stagedDiff).header, parseUnifiedDiff(stagedDiff).hunks);
    const unstaged = await git.applyPatch(dir, rev, { cached: true, reverse: true });
    assert.equal(unstaged.ok, true, unstaged.error);
    assert.equal((await git.diff(dir, "multi.txt", true)).trim(), ""); // index clean

    // a bad patch is a clean ok:false (not a throw)
    const bad = await git.applyPatch(dir, "not a patch\n", { cached: true });
    assert.equal(bad.ok, false);
    assert.equal(typeof bad.error, "string");
    // an empty patch is a no-op success
    assert.equal((await git.applyPatch(dir, "", { cached: true })).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── PR review: remote parsing (APP-085) — PURE ──────────────────────────────*/

test("parseRemote: https + ssh GitHub forms → github", () => {
  for (const url of [
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com:22/owner/repo.git",
  ]) {
    const r = parseRemote(url);
    assert.ok(r, url);
    assert.equal(r.provider, "github");
    assert.equal(r.host, "github.com");
    assert.equal(r.owner, "owner");
    assert.equal(r.repo, "repo");
    assert.equal(r.slug, "owner/repo");
  }
});

test("parseRemote: GitLab, incl. a subgroup path (>1 slash)", () => {
  const plain = parseRemote("https://gitlab.com/group/repo.git");
  assert.equal(plain?.provider, "gitlab");
  assert.equal(plain?.slug, "group/repo");
  const sub = parseRemote("git@gitlab.com:group/subgroup/repo.git");
  assert.ok(sub);
  assert.equal(sub.provider, "gitlab");
  assert.equal(sub.owner, "group/subgroup"); // namespace above the repo
  assert.equal(sub.repo, "repo");
  assert.equal(sub.slug, "group/subgroup/repo"); // full project path (id source)
});

test("parseRemote: unknown host / malformed → undefined (feature hidden, never guessed)", () => {
  assert.equal(parseRemote("https://bitbucket.org/o/r.git"), undefined);
  assert.equal(parseRemote("git@example.com:o/r.git"), undefined);
  assert.equal(parseRemote("https://github.com/onlyowner"), undefined); // needs owner/repo
  assert.equal(parseRemote(""), undefined);
  assert.equal(parseRemote("not a url"), undefined);
});

test("remoteUrl runs `remote get-url -- <name>` (option-injection-guarded)", async () => {
  const calls: string[][] = [];
  const runner: GitRunner = async (_cwd, argv) => {
    calls.push(argv);
    return { exitCode: 0, stdout: "git@github.com:o/r.git\n", stderr: "" };
  };
  const url = await new GitHost({ run: runner }).remoteUrl("/r", "origin");
  assert.equal(url, "git@github.com:o/r.git");
  assert.deepEqual(calls[0], ["remote", "get-url", "--", "origin"]);
});
