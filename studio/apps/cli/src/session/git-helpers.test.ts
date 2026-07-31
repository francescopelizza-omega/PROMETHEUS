/**
 * git-helpers.test.ts — the CLI's thin git wrappers with a FAKE spawn (no real git in CI).
 * Covers every export + the option-injection guard (a `-`-leading branch/path never reaches spawn).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type GitSpawn,
  addWorktree,
  assertReadOnlyGit,
  clampLogCount,
  diffLineRole,
  gitDiff,
  gitLog,
  gitStatus,
  isDirty,
  isGitRepo,
  isSafeToken,
  listWorktrees,
  parseLog,
  parseStatusV2,
  parseWorktreePorcelain,
  removeWorktree,
  runGit,
  truncateDiff,
} from "./git-helpers.js";

/** A scripted fake spawn: records argv, replies from a matcher list (first match wins). */
function fakeGit(script: Array<[RegExp, { code: number; stdout?: string; stderr?: string }]>): {
  spawn: GitSpawn;
  argv: string[][];
} {
  const argv: string[][] = [];
  const spawn: GitSpawn = async (args) => {
    argv.push(args);
    const joined = args.join(" ");
    for (const [rx, res] of script) {
      if (rx.test(joined))
        return { code: res.code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { spawn, argv };
}

test("isSafeToken rejects flags + empty, accepts normal refs (CLI-054)", () => {
  assert.ok(isSafeToken("feature/x"));
  assert.ok(isSafeToken("main"));
  assert.ok(!isSafeToken("-b"));
  assert.ok(!isSafeToken("--force"));
  assert.ok(!isSafeToken(""));
});

test("runGit runs in cwd via -C and maps code→ok (CLI-054)", async () => {
  const { spawn, argv } = fakeGit([[/status/, { code: 0, stdout: "clean" }]]);
  const r = await runGit(["status"], "/repo", spawn);
  assert.deepEqual(argv[0], ["-C", "/repo", "status"]);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, "clean");
});

test("isGitRepo true only on 'true' stdout + exit 0 (CLI-054)", async () => {
  const yes = fakeGit([[/is-inside-work-tree/, { code: 0, stdout: "true\n" }]]);
  assert.equal(await isGitRepo("/repo", yes.spawn), true);
  const no = fakeGit([[/is-inside-work-tree/, { code: 128, stderr: "fatal" }]]);
  assert.equal(await isGitRepo("/x", no.spawn), false);
});

test("parseWorktreePorcelain parses all five line kinds (CLI-054)", () => {
  const text = [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "bare",
    "",
    "worktree /repo-wt-feat",
    "HEAD def456",
    "branch refs/heads/feature/x",
    "locked needs review",
    "",
    "worktree /repo-detached",
    "HEAD 999",
    "detached",
    "prunable gitdir gone",
    "",
  ].join("\n");
  const wts = parseWorktreePorcelain(text);
  assert.equal(wts.length, 3);
  assert.equal(wts[0]?.branch, "main");
  assert.equal(wts[0]?.bare, true);
  assert.equal(wts[1]?.branch, "feature/x");
  assert.equal(wts[1]?.locked, "needs review");
  assert.equal(wts[2]?.detached, true);
  assert.equal(wts[2]?.prunable, "gitdir gone");
});

test("listWorktrees returns [] on a failed list (CLI-054)", async () => {
  const { spawn } = fakeGit([[/worktree list/, { code: 1, stderr: "not a repo" }]]);
  assert.deepEqual(await listWorktrees("/x", spawn), []);
});

test("isDirty classifies tracked vs untracked (CLI-054)", async () => {
  const dirty = fakeGit([[/status/, { code: 0, stdout: " M a.ts\n?? new.ts\nA  b.ts\n" }]]);
  const d = await isDirty("/repo", dirty.spawn);
  assert.deepEqual(d, { dirty: true, tracked: 2, untracked: 1 });
  const clean = fakeGit([[/status/, { code: 0, stdout: "" }]]);
  assert.deepEqual(await isDirty("/repo", clean.spawn), { dirty: false, tracked: 0, untracked: 0 });
});

test("addWorktree: option-injection — a `-`-leading branch/path never reaches spawn (CLI-054)", async () => {
  const bad = fakeGit([]);
  const r1 = await addWorktree("/repo", "--force", undefined, bad.spawn);
  assert.equal(r1.ok, false);
  const r2 = await addWorktree("/repo", "ok", "-x/evil", bad.spawn);
  assert.equal(r2.ok, false);
  assert.deepEqual(bad.argv, [], "no git spawn on a flag-like branch/path");
});

test("addWorktree: new branch → -b, existing → checkout; already-checked-out is refused (CLI-054)", async () => {
  // NEW branch: rev-parse --verify fails → check-ref-format ok → list empty → add with -b.
  const created = fakeGit([
    [/rev-parse --verify/, { code: 1 }],
    [/check-ref-format/, { code: 0 }],
    [/rev-parse --show-toplevel/, { code: 0, stdout: "/home/me/repo\n" }],
    [/worktree list/, { code: 0, stdout: "" }],
    [/worktree add/, { code: 0 }],
  ]);
  const r = await addWorktree("/home/me/repo", "feature/x", undefined, created.spawn);
  assert.equal(r.ok, true);
  assert.equal(r.path, "/home/me/repo-wt-feature-x"); // sibling, `/`→`-` sanitized
  const addArgv = created.argv.find((a) => a.includes("add"));
  assert.deepEqual(addArgv, [
    "-C",
    "/home/me/repo",
    "worktree",
    "add",
    "-b",
    "feature/x",
    "/home/me/repo-wt-feature-x",
  ]);

  // already checked out elsewhere → clean refusal, no add.
  const dup = fakeGit([
    [/rev-parse --verify/, { code: 0 }],
    [
      /worktree list/,
      { code: 0, stdout: "worktree /repo-wt-feat\nHEAD a\nbranch refs/heads/feat\n" },
    ],
  ]);
  const r2 = await addWorktree("/repo", "feat", undefined, dup.spawn);
  assert.equal(r2.ok, false);
  assert.match(r2.message, /already checked out/);
  assert.ok(!dup.argv.some((a) => a.includes("add")));
});

test("removeWorktree: rejects flag path; otherwise runs `worktree remove` w/o --force (CLI-054)", async () => {
  const bad = fakeGit([]);
  const r1 = await removeWorktree("/repo", "-rf", bad.spawn);
  assert.equal(r1.ok, false);
  assert.deepEqual(bad.argv, []);

  const ok = fakeGit([[/worktree remove/, { code: 0 }]]);
  const r2 = await removeWorktree("/repo", "/repo-wt-feat", ok.spawn);
  assert.equal(r2.ok, true);
  const argv = ok.argv[0] ?? [];
  assert.ok(argv.includes("remove"));
  assert.ok(!argv.includes("--force"), "never --force");
});

/* ── CLI-091: read-only /git pane (status/diff/log) ────────────────────────────── */

const NUL = "\x00";

test("CLI-091 parseStatusV2: staged/unstaged/untracked groups + both-groups + rename alignment", () => {
  // A rename (type 2) whose ORIGINAL path is a separate following NUL field; then an ordinary
  // change staged AND unstaged (MM); a staged-only add; an unstaged-only modify; an untracked.
  const z = [
    "# branch.oid abc123", // header — skipped
    "# branch.head main", // header — skipped
    "2 R. N... 100644 100644 100644 hHhH hIhI R100 new/name.ts", // rename, orig follows
    "old/name.ts", // ← the rename's original path (separate NUL field)
    "1 MM N... 100644 100644 100644 aaa bbb both.ts", // staged + unstaged
    "1 A. N... 000000 100644 100644 000 ccc added.ts", // staged only
    "1 .M N... 100644 100644 100644 ddd eee touched.ts", // unstaged only
    "? untracked.ts", // untracked
    "! ignored.ts", // ignored — skipped
  ].join(NUL);
  const g = parseStatusV2(z);
  // rename: staged (X=R). both.ts: staged+unstaged. added.ts: staged only. touched.ts: unstaged only.
  assert.deepEqual(g.staged.map((e) => e.path).sort(), ["added.ts", "both.ts", "new/name.ts"]);
  assert.deepEqual(g.unstaged.map((e) => e.path).sort(), ["both.ts", "touched.ts"]);
  assert.deepEqual(
    g.untracked.map((e) => e.path),
    ["untracked.ts"],
  );
  // the rename carried its original path (alignment stayed correct — next record not shifted).
  assert.equal(g.staged.find((e) => e.path === "new/name.ts")?.orig, "old/name.ts");
});

test("CLI-091 assertReadOnlyGit: rejects push/commit/checkout/reset + option-injection; allows the 4 templates", () => {
  // mutating verbs — every one throws (the fail-closed read-only gate).
  for (const bad of [
    ["push"],
    ["commit", "-m", "x"],
    ["checkout", "main"],
    ["reset", "--hard"],
    ["diff", "--output=/etc/x"], // option-injection: not the exact allowlisted diff argv
    ["log", "--pretty=format:%h%x00%D%x00%s", "-n", "-1"], // option-shaped count
    ["log", "--pretty=format:%h%x00%D%x00%s", "-n", "10", "--all"], // extra arg
  ]) {
    assert.throws(
      () => assertReadOnlyGit(bad),
      /non-allowlisted/,
      `should reject ${bad.join(" ")}`,
    );
  }
  // the exact read-only templates pass.
  assert.doesNotThrow(() => assertReadOnlyGit(["status", "--porcelain=v2", "-z"]));
  assert.doesNotThrow(() =>
    assertReadOnlyGit(["-c", "diff.external=", "diff", "--no-ext-diff", "--color=never"]),
  );
  assert.doesNotThrow(() =>
    assertReadOnlyGit(["log", "--pretty=format:%h%x00%D%x00%s", "-n", "20"]),
  );
});

test("CLI-091 truncateDiff: caps lines + reports the EXACT omitted count", () => {
  const raw = Array.from({ length: 450 }, (_, i) => `+line ${i}`).join("\n");
  const t = truncateDiff(raw, 400);
  assert.equal(t.shown.length, 400);
  assert.equal(t.omitted, 50); // 450 − 400, the lines actually dropped
  // under the cap → nothing omitted.
  assert.equal(truncateDiff("a\nb\nc", 400).omitted, 0);
  assert.equal(truncateDiff("", 400).shown.length, 0);
});

test("CLI-091 diffLineRole: +++/--- headers META before +/- content; @@ hunk; diff/index META", () => {
  assert.equal(diffLineRole("+++ b/x.ts"), "meta");
  assert.equal(diffLineRole("--- a/x.ts"), "meta");
  assert.equal(diffLineRole("+added"), "add");
  assert.equal(diffLineRole("-removed"), "del");
  assert.equal(diffLineRole("@@ -1,2 +1,3 @@"), "hunk");
  assert.equal(diffLineRole("diff --git a/x b/x"), "meta");
  assert.equal(diffLineRole("index 111..222 100644"), "meta");
  assert.equal(diffLineRole(" unchanged"), "context");
});

test("CLI-091 clampLogCount: integer clamp; non-integer/option-shaped → default", () => {
  assert.equal(clampLogCount(undefined), 20);
  assert.equal(clampLogCount("5"), 5);
  assert.equal(clampLogCount("9999", 20, 200), 200); // clamped to max
  assert.equal(clampLogCount("0"), 1); // min 1
  assert.equal(clampLogCount("-5"), 20); // option-shaped → default (never smuggles -n)
  assert.equal(clampLogCount("abc"), 20);
  assert.equal(clampLogCount("--all"), 20);
});

test("CLI-091 parseLog: NUL-delimited hash + optional refs + subject (incl a `(...)`-leading subject)", () => {
  const entries = parseLog(
    "abc1234\x00HEAD -> main, origin/main\x00first commit\ndef5678\x00\x00second commit\nabc9999\x00\x00(cherry-pick) fix\n",
  );
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    hash: "abc1234",
    refs: "HEAD -> main, origin/main",
    subject: "first commit",
  });
  assert.deepEqual(entries[1], { hash: "def5678", subject: "second commit" });
  // a subject that literally starts with "(...)" is NOT misread as refs (the old heuristic bug).
  assert.deepEqual(entries[2], { hash: "abc9999", subject: "(cherry-pick) fix" });
});

test("CLI-091 gitStatus/gitDiff/gitLog route argv through the read-only allowlist", async () => {
  const st = fakeGit([[/status/, { code: 0, stdout: `1 A. N... 0 0 0 a b added.ts${NUL}` }]]);
  const groups = await gitStatus("/repo", st.spawn);
  assert.deepEqual(
    groups.staged.map((e) => e.path),
    ["added.ts"],
  );
  assert.deepEqual(st.argv[0], ["-C", "/repo", "status", "--porcelain=v2", "-z"]);

  const df = fakeGit([[/diff/, { code: 0, stdout: "+a\n-b\n" }]]);
  const r = await gitDiff("/repo", { staged: true }, df.spawn);
  assert.ok(r.stdout.includes("+a"));
  assert.deepEqual(df.argv[0], [
    "-C",
    "/repo",
    "-c",
    "diff.external=",
    "diff",
    "--cached",
    "--no-ext-diff",
    "--color=never",
  ]);

  const lg = fakeGit([[/log/, { code: 0, stdout: "abc1234\x00\x00hello\n" }]]);
  const entries = await gitLog("/repo", 7, lg.spawn);
  assert.deepEqual(entries, [{ hash: "abc1234", subject: "hello" }]);
  assert.deepEqual(lg.argv[0], ["-C", "/repo", "log", "--pretty=format:%h%x00%D%x00%s", "-n", "7"]);
});
