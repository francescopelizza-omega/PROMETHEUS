/**
 * context-window-pref.test.ts — the extension stopped ASSERTING a context window.
 *
 * This surface shipped a hardcoded 8192 in three places (the package.json contribution and two
 * independent `?? 8192` reads). That is the number CLAUDE.md §2.8 records as "the bug, not the
 * guard": this repo's own prompt — system text plus ~46 tool schemas — measures ~7.2k tokens, so
 * a thinking model had ~900 left, spent them reasoning, and was cut off mid-thought. The turn
 * produced no answer at all.
 *
 * Under-stating a window is not the harmless direction. Every budget that scales with it shrinks:
 * the tool preamble drops descriptions, compaction fires on a conversation with ample room, and
 * the reply reserve leaves nothing to answer in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AiEndpoint } from "@prometheus/core";

import { configuredContextWindow, refineContextWindow } from "./extension.js";

/** Just enough of vscode's config surface for these two functions. */
const cfg = (v: unknown) =>
  ({ get: (k: string) => (k === "contextWindow" ? v : undefined) }) as never;

const endpoint = (over: Partial<AiEndpoint> = {}): AiEndpoint =>
  ({
    id: "vscode:qwen",
    model: "qwen3.6:latest",
    baseUrl: "http://localhost:11434/v1",
    locality: "local",
    contextWindow: 8192,
    supportsTools: true,
    ...over,
  }) as AiEndpoint;

test("0, absent and nonsense all mean 'ask the server'", () => {
  // The shipped default is now 0. It must not be read as a one-token window.
  assert.equal(configuredContextWindow(cfg(0)), undefined);
  assert.equal(configuredContextWindow(cfg(undefined)), undefined);
  assert.equal(configuredContextWindow(cfg(-1)), undefined);
  assert.equal(configuredContextWindow(cfg(Number.NaN)), undefined);
  assert.equal(configuredContextWindow(cfg("32768")), undefined, "a string is not a number here");
});

test("a positive setting is an explicit override and is kept", () => {
  assert.equal(configuredContextWindow(cfg(32768)), 32768);
  assert.equal(configuredContextWindow(cfg(4096.7)), 4096, "floored, not rounded up");
});

test("the probe REPLACES the floor with what the server actually serves", async () => {
  const e = endpoint();
  await refineContextWindow(e, async () => ({ contextWindow: 262144, source: "ollama" }) as never);
  assert.equal(e.contextWindow, 262144, "32x the old hardcoded default, on a real local model");
});

test("a fail-soft probe is NOT mistaken for a measurement", async () => {
  // `probeContextWindow` returns the floor with `source: "default"` rather than throwing when
  // nothing answered. Treating that as an answer would overwrite a user's setting with a guess.
  const e = endpoint({ contextWindow: 32768 });
  await refineContextWindow(e, async () => ({ contextWindow: 8192, source: "default" }) as never);
  assert.equal(e.contextWindow, 32768, "the configured value stands");
});

test("the window only ever GROWS — a deliberate smaller setting is not overridden", async () => {
  const e = endpoint({ contextWindow: 200000 });
  await refineContextWindow(e, async () => ({ contextWindow: 8192, source: "ollama" }) as never);
  assert.equal(e.contextWindow, 200000);
});

test("a throwing probe costs nothing", async () => {
  const e = endpoint();
  await refineContextWindow(e, async () => {
    throw new Error("runner is down");
  });
  assert.equal(e.contextWindow, 8192, "the floor stands, and no error escapes");
});

test("the probe is asked about the MODEL, not the endpoint id", async () => {
  let askedModel = "";
  const e = endpoint({ id: "vscode:qwen", model: "qwen3.6:latest" });
  await refineContextWindow(e, async (_base: string, model: string) => {
    askedModel = model;
    return { contextWindow: 262144, source: "ollama" } as never;
  });
  // `/api/show` keys on the model tag; sending "vscode:qwen" would 404 and silently yield the floor.
  assert.equal(askedModel, "qwen3.6:latest");
});
