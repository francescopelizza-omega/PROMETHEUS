/**
 * protocol.test.ts — directive parsing (delegate/report/broadcast/spawn), code-fence
 * safety, and backend-ref resolution.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type Directive, parseBackendRef, parseDirectives } from "./protocol.js";

test("delegate to a peer", () => {
  const { result, directives } = parseDirectives(
    "Here is my plan.\n@codex: implement the parser\nDone.",
  );
  assert.deepEqual(directives, [{ kind: "delegate", to: "codex", task: "implement the parser" }]);
  assert.equal(result, "Here is my plan.\nDone.");
});

test("report up via @parent and via >>", () => {
  const a = parseDirectives("@parent: I'm blocked on the schema");
  assert.deepEqual(a.directives, [{ kind: "report", content: "I'm blocked on the schema" }]);
  const b = parseDirectives(">> partial result ready");
  assert.deepEqual(b.directives, [{ kind: "report", content: "partial result ready" }]);
});

test("broadcast to the whole swarm", () => {
  const { directives } = parseDirectives("@all: switching the API to v2");
  assert.deepEqual(directives, [{ kind: "broadcast", content: "switching the API to v2" }]);
});

test("spawn a child-subagent bound to a backend", () => {
  const { directives } = parseDirectives("@spawn tester=gemini: write unit tests for the parser");
  assert.deepEqual(directives, [
    { kind: "spawn", name: "tester", backend: "gemini", task: "write unit tests for the parser" },
  ]);
  // with an explicit kind:model backend
  const b = parseDirectives("@spawn helper=local:qwen2.5: refactor utils");
  assert.equal((b.directives[0] as Directive & { backend: string }).backend, "local:qwen2.5");
});

test("a mention inside a fenced code block is NOT a directive", () => {
  const text = "Example:\n```\n@codex: this is sample code, not a directive\n```\ndone";
  const { directives, result } = parseDirectives(text);
  assert.deepEqual(directives, []);
  assert.ok(result.includes("@codex: this is sample code"));
});

test("a mid-line @ in prose is NOT a directive (line-leading only)", () => {
  const { directives } = parseDirectives("ping me at user@host: now");
  assert.deepEqual(directives, []);
});

test("multiple directives + result text in one output", () => {
  const text = [
    "I'll split this up.",
    "@api: build the endpoint",
    "@ui: build the form",
    "@spawn rev=claude: review both",
    ">> dispatched 3 tasks",
    "Standing by.",
  ].join("\n");
  const { directives, result } = parseDirectives(text);
  assert.equal(directives.length, 4);
  assert.equal(directives.filter((d) => d.kind === "delegate").length, 2);
  assert.equal(directives.filter((d) => d.kind === "spawn").length, 1);
  assert.equal(directives.filter((d) => d.kind === "report").length, 1);
  assert.equal(result, "I'll split this up.\nStanding by.");
});

test("empty directive bodies are ignored (treated as text)", () => {
  const { directives, result } = parseDirectives("@codex:\n>>");
  assert.deepEqual(directives, []);
  assert.ok(result.includes("@codex:"));
});

test("parseBackendRef resolves cli / local / engine / fake", () => {
  assert.deepEqual(parseBackendRef("claude"), { kind: "cli", service: "claude" });
  assert.deepEqual(parseBackendRef("codex"), { kind: "cli", service: "codex" });
  assert.deepEqual(parseBackendRef("local:qwen2.5"), { kind: "local", model: "qwen2.5" });
  assert.deepEqual(parseBackendRef("engine:llama3"), { kind: "engine-chat", model: "llama3" });
  assert.deepEqual(parseBackendRef("cli:gemini"), { kind: "cli", service: "gemini" });
  assert.deepEqual(parseBackendRef("fake"), { kind: "fake" });
  // unknown bare token → local model (safe default)
  assert.deepEqual(parseBackendRef("mistral-7b"), { kind: "local", model: "mistral-7b" });
});
