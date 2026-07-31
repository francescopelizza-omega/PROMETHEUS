/**
 * idle-classifier.test.ts — per-vendor idle/busy/dead pane detection + capture digest.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { captureDigest, classifyPane } from "./idle-classifier.js";

const sig = (over: Partial<Parameters<typeof classifyPane>[1]> = {}) => ({
  inMode: "0",
  capture: "",
  ...over,
});

test("copy/scroll mode → busy (send-keys swallowed)", () => {
  assert.equal(classifyPane("claude", sig({ inMode: "1", capture: "❯ " })), "busy");
});

test("the pane_dead flag → dead (a shell foreground is NOT dead — tmux wraps the agent)", () => {
  assert.equal(classifyPane("claude", sig({ dead: true, capture: "% " })), "dead");
  // a shell-ish foreground while the agent is alive is NOT dead
  assert.equal(classifyPane("claude", sig({ capture: "did it\n❯ " })), "idle");
});

test("claude: prompt marker at the last line → idle; spinner → busy", () => {
  assert.equal(classifyPane("claude", sig({ capture: "did the thing\n❯ " })), "idle");
  assert.equal(classifyPane("claude", sig({ capture: "Thinking… (Esc to interrupt)" })), "busy");
});

test("codex / gemini ready + busy signatures", () => {
  assert.equal(classifyPane("codex", sig({ capture: "ok\n▌ " })), "idle");
  assert.equal(classifyPane("codex", sig({ capture: "Working… generating" })), "busy");
  assert.equal(classifyPane("gemini", sig({ capture: "answer\n> " })), "idle");
  assert.equal(classifyPane("gemini", sig({ capture: "Loading ⠋" })), "busy");
});

test("a prompt marker NOT on the last line (mid-stream) → busy", () => {
  // "> " appears but tokens are still streaming after it
  assert.equal(
    classifyPane("gemini", sig({ capture: "> here is more\nstreaming output" })),
    "busy",
  );
});

test("unknown vendor falls back to a generic shell-ish prompt", () => {
  assert.equal(classifyPane("mystery", sig({ capture: "out\n$ " })), "idle");
  assert.equal(classifyPane("mystery", sig({ capture: "still working on it" })), "busy");
});

test("captureDigest changes when the tail changes, stable when frozen", () => {
  const a = captureDigest("line1\nline2\n❯ ");
  const b = captureDigest("line1\nline2\n❯ ");
  const c = captureDigest("line1\nline2\nline3\n❯ ");
  assert.equal(a, b); // frozen → same
  assert.notEqual(a, c); // changed → different
});
