/**
 * compact.test.ts — the auto-compaction TRIGGER.
 *
 * This module had no test file at all, which is how its estimate came to ignore the single
 * largest thing in an agentic session. `estimateTurnTokens` summed the prompt and the model's
 * prose and counted every `tool_result` as zero — so a session that had read ten large files
 * registered as nearly empty, `shouldCompact` stayed false, and the transcript sailed past the
 * context window until the provider rejected it mid-task.
 *
 * The trigger was therefore blind exactly where the agent does its work, and accurate only in
 * the chat-shaped case that was never going to overflow in the first place.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionTurn } from "../domain/session.js";
import { carryForward } from "./carry-forward.js";
import { estimateTurnTokens, shouldCompact } from "./compact.js";

const turn = (over: Partial<SessionTurn> & { id: string }): SessionTurn =>
  ({
    turnNumber: 1,
    prompt: "",
    createdAt: "t0",
    events: [],
    ...over,
  }) as unknown as SessionTurn;

test("tool output counts toward the compaction trigger — it used to weigh zero", () => {
  const withTools = turn({
    id: "t1",
    prompt: "read the file",
    events: [
      { kind: "tool_use", call: { name: "read_file", args: { path: "a.ts" } } },
      {
        kind: "tool_result",
        call: { name: "read_file", args: {} },
        ok: true,
        summary: "x".repeat(40_000),
      },
      { kind: "text", text: "done" },
    ],
  } as never);
  const proseOnly = turn({
    id: "t2",
    prompt: "read the file",
    events: [{ kind: "text", text: "done" }],
  } as never);

  assert.ok(
    estimateTurnTokens(withTools) > 9_000,
    "40k characters of tool output must not estimate as ~nothing",
  );
  assert.ok(estimateTurnTokens(withTools) > estimateTurnTokens(proseOnly) * 100);
});

test("a tool-heavy session actually TRIPS the trigger", () => {
  // The consequence, not the arithmetic: this is the session shape that used to sail past the
  // window without ever compacting.
  const heavy = Array.from({ length: 6 }, (_, i) =>
    turn({
      id: `t${i}`,
      turnNumber: i + 1,
      prompt: "read it",
      events: [
        {
          kind: "tool_result",
          call: { name: "read_file", args: {} },
          ok: true,
          summary: "y".repeat(20_000),
        },
      ],
    } as never),
  );
  assert.equal(shouldCompact(heavy, { maxTokens: 8_000, keepRecentTurns: 2 }), true);
});

test("a short chat-shaped session still does NOT compact", () => {
  // The trigger must not become hair-first: compacting a two-turn conversation would throw
  // away context for nothing.
  const light = [
    turn({ id: "a", prompt: "hi", events: [{ kind: "text", text: "hello" }] as never }),
    turn({ id: "b", prompt: "thanks", events: [{ kind: "text", text: "welcome" }] as never }),
  ];
  assert.equal(shouldCompact(light, { maxTokens: 8_000, keepRecentTurns: 2 }), false);
});

test("reasoning counts too, because it is billed and it is in the window", () => {
  const thinking = turn({
    id: "r",
    prompt: "",
    events: [{ kind: "reasoning", text: "z".repeat(8_000) }] as never,
  });
  assert.ok(estimateTurnTokens(thinking) > 1_500);
});

test("carryForward returns the CONVERSATION only — system messages are not 'dropped'", () => {
  /**
   * The caller re-adds system messages separately (`withPreamble`), so `carryForward` strips
   * them. Comparing raw lengths therefore counted every system message as trimmed: on the first
   * turn of a session, with a 100k budget and nothing actually dropped, the CLI printed
   * "3 older message(s) dropped from this turn" — every single round. A warning that fires when
   * nothing happened trains the user to ignore the one that matters.
   */
  const body = [
    { role: "system", content: "You are Prometheus." },
    { role: "system", content: "steering" },
    { role: "system", content: "repo map" },
    { role: "user", content: "hi" },
  ];
  const trimmed = carryForward(body as never, { budgetTokens: 100_000 });
  assert.equal(trimmed.length, 1, "only the conversation comes back");
  assert.ok(
    trimmed.every((m) => (m as { role: string }).role !== "system"),
    "system messages are the caller's to re-add",
  );
  // the honest count compares against the NON-system messages
  const carried = body.filter((m) => m.role !== "system");
  assert.equal(carried.length - trimmed.length, 0, "nothing was actually dropped here");
});
