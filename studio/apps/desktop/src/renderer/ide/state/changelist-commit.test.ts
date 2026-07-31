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
