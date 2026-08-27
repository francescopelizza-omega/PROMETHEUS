/**
 * changelist-commit.test.ts — the commit-one-changelist staging choreography (APP-038).
 *
 * Asserts the EXACT git call sequence (reset index → stage the list → commit →
 * restore the other lists' staged files) and the transactional rollback (restore the
 * ORIGINAL staged set on failure), against a fake git api that records every call.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type ChangelistGitApi, commitChangelistFiles } from "./changelist-commit.js";

type Call = [string, string[] | string];

function recordingApi(script: { stageOk?: boolean; commitOk?: boolean } = {}): {
  api: ChangelistGitApi;
  calls: Call[];
} {
  const calls: Call[] = [];
  const api: ChangelistGitApi = {
    gitUnstage: async (_r, files) => {
      calls.push(["unstage", files]);
      return { ok: true };
    },
    gitStage: async (_r, files) => {
      calls.push(["stage", files]);
      return script.stageOk === false ? { ok: false, error: "stage boom" } : { ok: true };
    },
    gitCommit: async (_r, msg) => {
      calls.push(["commit", msg]);
      return script.commitOk === false ? { ok: false, error: "commit boom" } : { ok: true };
    },
  };
  return { api, calls };
}

test("commit-one-list stages EXACTLY the list files, commits, restores the others", async () => {
  const { api, calls } = recordingApi();
  const res = await commitChangelistFiles(api, {
    root: "/r",
    message: "feat: A",
    targets: ["a.ts", "b.ts"],
    originalStaged: ["a.ts", "z.ts"],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [
    ["unstage", []],
    ["stage", ["a.ts", "b.ts"]],
    ["commit", "feat: A"],
    ["stage", ["z.ts"]], // only the OTHER previously-staged file is restored
  ]);
});

test("commit-one-list restores the ORIGINAL staged set on commit failure", async () => {
  const { api, calls } = recordingApi({ commitOk: false });
  const res = await commitChangelistFiles(api, {
    root: "/r",
    message: "x",
    targets: ["a.ts"],
    originalStaged: ["a.ts", "z.ts"],
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /commit boom/);
  assert.deepEqual(calls, [
    ["unstage", []],
    ["stage", ["a.ts"]],
    ["commit", "x"],
    ["unstage", []], // rollback: clear
    ["stage", ["a.ts", "z.ts"]], // rollback: restore the ORIGINAL set
  ]);
});

test("commit-one-list refuses an empty message / empty list without touching git", async () => {
  const { api, calls } = recordingApi();
  assert.equal(
    (
      await commitChangelistFiles(api, {
        root: "/r",
        message: "  ",
        targets: ["a.ts"],
        originalStaged: [],
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await commitChangelistFiles(api, {
        root: "/r",
        message: "x",
        targets: [],
        originalStaged: [],
      })
    ).ok,
    false,
  );
  assert.equal(calls.length, 0);
});

test("commit-one-list with no OTHER staged files skips the restore stage", async () => {
  const { api, calls } = recordingApi();
  await commitChangelistFiles(api, {
    root: "/r",
    message: "x",
    targets: ["a.ts"],
    originalStaged: ["a.ts"],
  });
  assert.deepEqual(calls, [
    ["unstage", []],
    ["stage", ["a.ts"]],
    ["commit", "x"],
  ]);
});

test("committing one list PRESERVES another file's partial staging, instead of flattening it", async () => {
  /**
   * The choreography cleared the whole index (`git restore --staged .`) and later re-staged the
   * other lists' files with `git add -- <paths>`, which stages the CURRENT WORKTREE content —
   * not the index content that was there before. So a file the user had partially staged with
   * the panel's own per-hunk stager was silently promoted to fully staged, and the hunks they
   * had deliberately left out went into the NEXT commit. Both the module header and the inline
   * comment claimed the original staged set was restored "exactly"; only path membership was.
   */
  const calls: string[] = [];
  const PATCH = "diff --git a/keep.ts b/keep.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const res = await commitChangelistFiles(
    {
      gitUnstage: async (_r, files) => {
        calls.push(`unstage:${files.length === 0 ? "ALL" : files.join(",")}`);
        return { ok: true };
      },
      gitStage: async (_r, files) => {
        calls.push(`stage:${files.join(",")}`);
        return { ok: true };
      },
      gitCommit: async () => {
        calls.push("commit");
        return { ok: true };
      },
      gitDiff: async (_r, file, staged) => {
        calls.push(`diff:${file}:${staged ? "cached" : "worktree"}`);
        return { ok: true, diff: PATCH };
      },
      gitApplyPatch: async (_r, patch) => {
        calls.push(`apply:${patch === PATCH ? "exact" : "OTHER"}`);
        return { ok: true };
      },
    },
    { root: "/repo", message: "msg", targets: ["ship.ts"], originalStaged: ["ship.ts", "keep.ts"] },
  );

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.flattened, undefined, "nothing should have been flattened");
  // the staged CONTENT of the untouched file is captured before the reset and replayed after
  assert.ok(calls.includes("diff:keep.ts:cached"), `never captured the index content: ${calls}`);
  assert.ok(calls.includes("apply:exact"), `never replayed the index content: ${calls}`);
  assert.ok(
    !calls.includes("stage:keep.ts"),
    `keep.ts was re-staged by PATH, which flattens partial staging: ${calls}`,
  );
});

test("a file whose staged content cannot be replayed is REPORTED, not silently flattened", async () => {
  // Binary files have no textual patch to replay. Falling back to `git add` is the old behaviour
  // and is acceptable — doing it without telling anyone is not.
  const res = await commitChangelistFiles(
    {
      gitUnstage: async () => ({ ok: true }),
      gitStage: async () => ({ ok: true }),
      gitCommit: async () => ({ ok: true }),
      gitDiff: async () => ({ ok: true, diff: "Binary files a/logo.png and b/logo.png differ\n" }),
      gitApplyPatch: async () => ({ ok: true }),
    },
    { root: "/repo", message: "m", targets: ["a.ts"], originalStaged: ["a.ts", "logo.png"] },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.flattened, ["logo.png"]);
});

test("with no diff/apply seam the choreography still works, and says what it could not preserve", async () => {
  const res = await commitChangelistFiles(
    {
      gitUnstage: async () => ({ ok: true }),
      gitStage: async () => ({ ok: true }),
      gitCommit: async () => ({ ok: true }),
    },
    { root: "/repo", message: "m", targets: ["a.ts"], originalStaged: ["a.ts", "b.ts"] },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.flattened, ["b.ts"]);
});
