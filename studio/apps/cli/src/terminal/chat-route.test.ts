/**
 * terminal/chat-route.test.ts — the parse→TerminalChatOpts adapter (P5/P6 wiring).
 *
 * Deterministic, no engine/pty/tmux: a fake EngineClient returns a canned
 * ChatTerminalEnvelope; the launch seams are never reached for a preview. Covers
 * the launch DETECTION (isTerminalChatLaunch), the flag→opts mapping, the
 * preview-only override (the in-session path), and the never-force deny.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatTerminalEnvelope, EngineClient } from "@prometheus/engine-bridge";

import { parseArgs } from "../parse.js";
import { isTerminalChatLaunch, routeTerminalChat } from "./chat-route.js";

function fakeEnvelope(over: Partial<ChatTerminalEnvelope> = {}): ChatTerminalEnvelope {
  return {
    command: "chat",
    ok: true,
    mode: "terminal",
    cli: "claude",
    label: "Claude Code",
    argv: ["claude", "--print"],
    env: {},
    notes: ["note: a heads-up"],
    bypass: false,
    tmux: null,
    interactive: true,
    model: null,
    cwd: "/work",
    ...over,
  } as ChatTerminalEnvelope;
}

/** A client whose runPrometheus returns the canned envelope (no real engine). */
function fakeClient(env: ChatTerminalEnvelope): EngineClient {
  return {
    runPrometheus: async () => env as never,
  } as unknown as EngineClient;
}

test("isTerminalChatLaunch: only chat --cli X with --open/--tmux is a launch", () => {
  assert.equal(isTerminalChatLaunch(parseArgs(["chat", "--cli", "claude", "--open"])), true);
  assert.equal(isTerminalChatLaunch(parseArgs(["chat", "--cli", "claude", "--tmux"])), true);
  // preview (no launch switch) is NOT a launch — it routes through the registry.
  assert.equal(isTerminalChatLaunch(parseArgs(["chat", "--cli", "claude"])), false);
  // bare chat / local chat / other verbs are not launches.
  assert.equal(isTerminalChatLaunch(parseArgs(["chat"])), false);
  assert.equal(isTerminalChatLaunch(parseArgs(["chat", "--local", "qwen", "--open"])), false);
  assert.equal(isTerminalChatLaunch(parseArgs(["scan", "--open"])), false);
});

test("routeTerminalChat: previewOnly returns the preview without spawning", async () => {
  const env = fakeEnvelope();
  const parsed = parseArgs(["chat", "--cli", "claude", "--open"]);
  const out = await routeTerminalChat(parsed, {
    client: fakeClient(env),
    json: false,
    previewOnly: true,
  });
  // a preview is a CommandOutcome (exit 0); it never spawned a terminal.
  assert.equal(out.exitCode, 0);
  assert.ok(typeof out.text === "string" && out.text.length > 0);
});

test("routeTerminalChat: a bypass launch with NO confirm is denied (never-force)", async () => {
  const env = fakeEnvelope({ bypass: true });
  const parsed = parseArgs(["chat", "--cli", "claude", "--open", "--bypass"]);
  const out = await routeTerminalChat(parsed, {
    client: fakeClient(env),
    json: false,
    // no confirm wired → the handoff must DENY the bypass launch (fail-closed).
  });
  assert.equal(out.exitCode, 2);
});
