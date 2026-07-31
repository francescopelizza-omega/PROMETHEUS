/**
 * auto-continue.test.ts — the run-to-done (yolo) decision core: resumes only when safe + in budget.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AutoContinueInput,
  DEFAULT_AUTO_CONTINUE_BUDGET,
  decideAutoContinue,
  initAutoContinue,
  observeEvent,
} from "./auto-continue.js";
import type { AgentEvent } from "./events.js";

const base = (over: Partial<AutoContinueInput> = {}): AutoContinueInput => ({
  mode: "yolo",
  capped: true,
  state: initAutoContinue(1000),
  budget: DEFAULT_AUTO_CONTINUE_BUDGET,
  nowMs: 1000,
  tokensSpent: 0,
  progressDigest: "round-1",
  ...over,
});

test("yolo + capped + in budget → resume, continues increments", () => {
  const d = decideAutoContinue(base());
  assert.ok(d.resume && d.state.continues === 1 && d.state.lastDigest === "round-1");
});

test("non-run-to-done mode never auto-continues", () => {
  for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"] as const) {
    assert.equal(decideAutoContinue(base({ mode })).resume, false);
  }
});

test("a nemesis gate BLOCK verdict hard-stops the chain", () => {
  let state = initAutoContinue(1000);
  const block: AgentEvent = { kind: "verdict", tool: "engine:install", verdict: "block" };
  state = observeEvent(state, block);
  const d = decideAutoContinue(base({ state }));
  assert.ok(!d.resume && d.reason.includes("BLOCK"));
});

test("a non-block verdict does not stop it", () => {
  let state = initAutoContinue(1000);
  state = observeEvent(state, { kind: "verdict", tool: "x", verdict: "allow" });
  assert.equal(decideAutoContinue(base({ state })).resume, true);
});

test("each budget stops it: continues, walltime, tokens", () => {
  const exhausted = {
    ...initAutoContinue(1000),
    continues: DEFAULT_AUTO_CONTINUE_BUDGET.maxContinues,
  };
  assert.match(
    (decideAutoContinue(base({ state: exhausted })) as { reason: string }).reason,
    /continue budget/,
  );
  const wall = decideAutoContinue(base({ nowMs: 1000 + DEFAULT_AUTO_CONTINUE_BUDGET.maxWallMs }));
  assert.match((wall as { reason: string }).reason, /walltime/);
  const tok = decideAutoContinue(base({ tokensSpent: DEFAULT_AUTO_CONTINUE_BUDGET.maxTokens }));
  assert.match((tok as { reason: string }).reason, /token budget/);
});

test("no-progress guard: same digest twice → halt", () => {
  const first = decideAutoContinue(base({ progressDigest: "same" }));
  assert.ok(first.resume);
  const second = decideAutoContinue(base({ state: first.state, progressDigest: "same" }));
  assert.ok(!second.resume && (second as { reason: string }).reason.includes("no progress"));
});

test("not capped (turn finished naturally) → no resume", () => {
  assert.equal(decideAutoContinue(base({ capped: false })).resume, false);
});
