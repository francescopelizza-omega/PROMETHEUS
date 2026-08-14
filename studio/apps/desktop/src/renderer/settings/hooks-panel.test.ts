/**
 * hooks-panel.test.ts — Settings ▸ Lifecycle Hooks: pure draft/validation helpers.
 *
 * The load-bearing property this file checks: `validateHookDraft`'s reasons and
 * `isHookDraftValid`'s decision can never disagree with core's own `isHookSpec` — a UI that
 * accepted a row the loader would go on to drop would be a silent-data-loss bug.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isHookSpec } from "@prometheus/core/agent-hooks";

import {
  EMPTY_HOOK_DRAFT,
  type HookDraft,
  draftToHookSpec,
  hookSpecToDraft,
  isHookDraftValid,
  matcherLabel,
  removeHook,
  upsertHook,
  validateHookDraft,
} from "./hooks-panel.js";

test("draftToHookSpec: trims command, drops an empty/whitespace matcher, keeps a real one", () => {
  assert.deepEqual(draftToHookSpec({ event: "PreToolUse", matcher: "", command: " ./guard.sh " }), {
    event: "PreToolUse",
    command: "./guard.sh",
  });
  assert.deepEqual(draftToHookSpec({ event: "PreToolUse", matcher: "   ", command: "cmd" }), {
    event: "PreToolUse",
    command: "cmd",
  });
  assert.deepEqual(
    draftToHookSpec({ event: "PostToolUse", matcher: " write_file ", command: "cmd" }),
    { event: "PostToolUse", matcher: "write_file", command: "cmd" },
  );
});

test("hookSpecToDraft round-trips through draftToHookSpec for a matcher-bearing spec", () => {
  const spec = { event: "PreToolUse" as const, matcher: "write_file", command: "./guard.sh" };
  assert.deepEqual(draftToHookSpec(hookSpecToDraft(spec)), spec);
});

test("hookSpecToDraft: an absent matcher becomes an empty-string draft field", () => {
  const spec = { event: "SessionStart" as const, command: "echo hi" };
  const draft = hookSpecToDraft(spec);
  assert.equal(draft.matcher, "");
  assert.deepEqual(draftToHookSpec(draft), spec);
});

test("validateHookDraft: the empty draft is rejected for a missing command only (event defaults valid)", () => {
  const errors = validateHookDraft(EMPTY_HOOK_DRAFT);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /Command is required/);
});

test("validateHookDraft: an unknown event is rejected with the allowed list named", () => {
  const errors = validateHookDraft({ event: "OnFileSave", matcher: "", command: "echo hi" });
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /Event must be one of/);
  assert.match(errors[0] ?? "", /PreToolUse/);
});

test("validateHookDraft: a fully valid draft has no errors", () => {
  assert.deepEqual(
    validateHookDraft({ event: "PreToolUse", matcher: "write_file", command: "./guard.sh" }),
    [],
  );
  // matcher is optional — omitting it (or leaving it blank) is still valid.
  assert.deepEqual(
    validateHookDraft({ event: "SessionStart", matcher: "", command: "echo hi" }),
    [],
  );
});

test("isHookDraftValid agrees with validateHookDraft's verdict across a spread of drafts", () => {
  const drafts: HookDraft[] = [
    EMPTY_HOOK_DRAFT,
    { event: "PreToolUse", matcher: "*", command: "./guard.sh" },
    { event: "PostToolUse", matcher: "", command: "" },
    { event: "SessionStart", matcher: "", command: "echo hi" },
    { event: "NotARealEvent", matcher: "", command: "echo hi" },
    { event: "PreToolUse", matcher: "write_*", command: "   " }, // whitespace-only command
  ];
  for (const draft of drafts) {
    const noErrors = validateHookDraft(draft).length === 0;
    assert.equal(isHookDraftValid(draft), noErrors, JSON.stringify(draft));
  }
});

test("isHookDraftValid: zero drift — agrees with core's OWN isHookSpec on the built spec", () => {
  const drafts: HookDraft[] = [
    { event: "PreToolUse", matcher: "write_file", command: "./guard.sh" },
    { event: "PostToolUse", matcher: "", command: "" },
    { event: "SessionStart", matcher: "  ", command: "echo hi" },
    { event: "BadEvent", matcher: "", command: "echo hi" },
  ];
  for (const draft of drafts) {
    assert.equal(
      isHookDraftValid(draft),
      isHookSpec(draftToHookSpec(draft)),
      JSON.stringify(draft),
    );
  }
});

test("matcherLabel: absent/empty/'*' all read as 'every tool'; anything else is shown verbatim", () => {
  assert.equal(matcherLabel({ event: "PreToolUse", command: "x" }), "every tool");
  assert.equal(matcherLabel({ event: "PreToolUse", matcher: "", command: "x" }), "every tool");
  assert.equal(matcherLabel({ event: "PreToolUse", matcher: "*", command: "x" }), "every tool");
  assert.equal(
    matcherLabel({ event: "PreToolUse", matcher: "write_file", command: "x" }),
    "write_file",
  );
});

test("upsertHook: appends when index is omitted/out of range, replaces in place otherwise", () => {
  const a = { event: "PreToolUse" as const, command: "a" };
  const b = { event: "PostToolUse" as const, command: "b" };
  const c = { event: "SessionStart" as const, command: "c" };
  assert.deepEqual(upsertHook([a], b), [a, b]);
  assert.deepEqual(upsertHook([a, b], c, 1), [a, c]);
  assert.deepEqual(upsertHook([a], c, 99), [a, c]); // out of range ⇒ append
  // immutable: the input array is untouched.
  const rows = [a];
  upsertHook(rows, b);
  assert.deepEqual(rows, [a]);
});

test("removeHook: drops the row at index, pure/immutable", () => {
  const a = { event: "PreToolUse" as const, command: "a" };
  const b = { event: "PostToolUse" as const, command: "b" };
  assert.deepEqual(removeHook([a, b], 0), [b]);
  const rows = [a, b];
  removeHook(rows, 0);
  assert.deepEqual(rows, [a, b]); // original untouched
});
