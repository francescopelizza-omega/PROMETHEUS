import assert from "node:assert/strict";
import { dirname, join } from "node:path";
/**
 * spectacular.test.ts — argv builders + facade round-trips for the SPECTACULAR
 * commands added to prometheus.py: describe / tutorial / methods / harden /
 * models config+browse / chat (agentic-local + terminal preview).
 *
 * Builders are pure (asserted directly). Facade methods round-trip the `command`
 * literal through the fake engine (which echoes the first positional as command).
 */
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Commands } from "./commands.js";
import { PrometheusEngine } from "./engine.js";
import { isCommand } from "./types/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = join(HERE, "__fixtures__", "fake-engine.mjs");
const fakeEng = (): PrometheusEngine =>
  new PrometheusEngine({ pythonBin: process.execPath, prometheusPy: FAKE_ENGINE });

// --- argv builders (pure) -------------------------------------------------- //

test("Commands.describe/tutorial/methods build [verb, id]", () => {
  assert.deepEqual(Commands.describe("crewai"), ["describe", "crewai"]);
  assert.deepEqual(Commands.tutorial("firecrawl"), ["tutorial", "firecrawl"]);
  assert.deepEqual(Commands.methods("ultralytics"), ["methods", "ultralytics"]);
});

test("Commands.harden / modelsConfig / modelsBrowse", () => {
  assert.deepEqual(Commands.harden(), ["harden"]);
  assert.deepEqual(Commands.modelsConfig(), ["models", "config", "--show"]);
  assert.deepEqual(Commands.modelsConfig("/tmp/m"), ["models", "config", "--set-root", "/tmp/m"]);
  assert.deepEqual(Commands.modelsBrowse(), ["models", "browse"]);
});

test("Commands.chatLocal includes runner + prompt when present", () => {
  // the prompt rides behind a `--` end-of-options separator (option-injection guard)
  assert.deepEqual(Commands.chatLocal("qwen3", "hi", "ollama"), [
    "chat",
    "--local",
    "qwen3",
    "--runner",
    "ollama",
    "--",
    "hi",
  ]);
  assert.deepEqual(Commands.chatLocal("qwen3"), ["chat", "--local", "qwen3"]);
});

test("Commands.chatPreview assembles flags, never --open, tmux variants", () => {
  assert.deepEqual(Commands.chatPreview("claude", { model: "opus", bypass: true, prompt: "go" }), [
    "chat",
    "--cli",
    "claude",
    "--model",
    "opus",
    "--bypass",
    "--",
    "go",
  ]);
  assert.deepEqual(Commands.chatPreview("codex", { tmux: "work" }), [
    "chat",
    "--cli",
    "codex",
    "--tmux",
    "work",
  ]);
  assert.deepEqual(Commands.chatPreview("gemini", { tmux: true }), [
    "chat",
    "--cli",
    "gemini",
    "--tmux",
  ]);
  assert.ok(!Commands.chatPreview("claude", {}).includes("--open")); // preview never launches
});

// --- facade round-trips through the fake engine ---------------------------- //

test("describe() round-trips a 'describe' envelope", async () => {
  const env = await fakeEng().describe("crewai");
  assert.equal(env.command, "describe");
  assert.ok(isCommand(env, "describe"));
});

test("tutorial() + methods() route to their commands", async () => {
  assert.equal((await fakeEng().tutorial("firecrawl")).command, "tutorial");
  assert.equal((await fakeEng().methods("ultralytics")).command, "methods");
});

test("harden() round-trips a 'harden' envelope", async () => {
  const env = await fakeEng().harden();
  assert.equal(env.command, "harden");
  assert.ok(isCommand(env, "harden"));
});

test("chatPreview() + chatLocal() route through the 'chat' command", async () => {
  assert.equal((await fakeEng().chatPreview("claude", { model: "opus" })).command, "chat");
  assert.equal((await fakeEng().chatLocal("qwen3", "hi")).command, "chat");
});

test("modelsConfig() + modelsBrowse() route through 'models'", async () => {
  assert.equal((await fakeEng().modelsConfig()).command, "models");
  assert.equal((await fakeEng().modelsBrowse()).command, "models");
});
