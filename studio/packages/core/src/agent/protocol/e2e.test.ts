/**
 * e2e.test.ts — a model that can ONLY write text, driving the real loop to a real answer.
 *
 * This is the claim the whole directory exists to support: point Prometheus at a local model
 * with no native function-calling, and it still reads the codebase, edits it, and reports
 * back. Every other test here checks one component; these check that the components compose
 * into the cycle — preamble in, call out, gate, tool, result back in, next round, answer.
 *
 * The gate tests are the important half. Widening tool access to every model also widens it
 * to every model's mistakes, so the invariants that were true for native calls have to hold
 * identically for text ones: --force is refused however it is smuggled, a destructive tool
 * still stops for a human, and a nemesis BLOCK still aborts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelRef } from "../../agents/types.js";
import type { AgentEvent } from "../events.js";
import type { LLMClient, LlmTurn, Thread, ToolCall, ToolOutcome } from "../loop.js";
import { defaultTuning, runAgentTurn } from "../loop.js";
import type { ToolDef } from "../tools.js";
import { ToolCallScanner } from "./parse.js";
import { renderToolPreamble } from "./preamble.js";

const MODEL: ModelRef = { provider: "local", modelId: "qwen2.5-coder:7b" };

const READ_FILE: ToolDef = {
  name: "read_file",
  title: "Read file",
  description: "Read a UTF-8 text file from the workspace.",
  schema: { path: { type: "string", required: true, description: "the path" } },
  annotations: { readOnlyHint: true },
  toArgv: () => {
    throw new Error("host-local");
  },
};

const WRITE_FILE: ToolDef = {
  name: "write_file",
  title: "Write file",
  description: "Create or overwrite a file.",
  schema: {
    path: { type: "string", required: true },
    content: { type: "string", required: true },
  },
  annotations: { destructiveHint: true },
  toArgv: () => {
    throw new Error("host-local");
  },
};

const TOOLS = [READ_FILE, WRITE_FILE];

/**
 * A model that emits nothing but text, chunked the way an SSE stream would deliver it.
 *
 * The text is run through the SAME `ToolCallScanner` the real transports use, so these tests
 * exercise the production path rather than a convenient shortcut around it.
 */
function textOnlyModel(script: string[], chunk = 7): LLMClient {
  let round = 0;
  return {
    turn: async function* (): AsyncIterable<LlmTurn> {
      const say = script[round];
      round += 1;
      if (say === undefined) return;
      const scanner = new ToolCallScanner();
      const calls: ToolCall[] = [];
      const drain = function* (events: ReturnType<ToolCallScanner["end"]>): Generator<LlmTurn> {
        for (const ev of events) {
          if (ev.kind === "text") {
            if (ev.text) yield { kind: "text", text: ev.text };
          } else if (ev.kind === "call") calls.push({ name: ev.call.name, args: ev.call.args });
        }
      };
      for (let i = 0; i < say.length; i += chunk) {
        yield* drain(scanner.push(say.slice(i, i + chunk)));
      }
      yield* drain(scanner.end());
      for (const call of calls) yield { kind: "tool_call", call };
      if (calls.length === 0) yield { kind: "final" };
    },
  };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function tuning(over: Partial<ReturnType<typeof defaultTuning>> = {}) {
  return {
    ...defaultTuning(MODEL),
    tools: { enabled: true, allow: [], deny: [], extra: TOOLS },
    ...over,
  };
}

function textOf(events: AgentEvent[]): string {
  return events
    .filter((e) => e.kind === "text")
    .map((e) => (e.kind === "text" ? e.text : ""))
    .join("");
}

/* ── the whole cycle ─────────────────────────────────────────────────────────*/

test("a text-only model reads a file, is shown the result, and answers from it", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "what does a.ts export?" }] };
  const llm = textOnlyModel([
    'Let me look.\n<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
    "It exports `answer`, which is 42.",
  ]);
  const seen: string[] = [];
  const runTool = async (tool: ToolDef): Promise<ToolOutcome> => {
    seen.push(tool.name);
    return { ok: true, summary: "export const answer = 42;" };
  };

  const events = await collect(runAgentTurn(thread, tuning({ yes: true }), { llm, runTool }));

  assert.deepEqual(seen, ["read_file"], "the tool did not run");
  const toolMsg = thread.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "the result never reached the model");
  assert.match(toolMsg.content, /export const answer = 42;/);
  assert.match(textOf(events), /It exports `answer`, which is 42\./);
  // The protocol markup must never appear in the transcript the user reads.
  assert.doesNotMatch(textOf(events), /<tool_call>/);
});

test("a multi-step turn chains: read, then edit, then report", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "bump the version" }] };
  const llm = textOnlyModel([
    '<tool_call>{"name":"read_file","arguments":{"path":"v.ts"}}</tool_call>',
    '<tool_call>{"name":"write_file","arguments":{"path":"v.ts","content":"export const v = 2;"}}</tool_call>',
    "Bumped it to 2.",
  ]);
  const ran: string[] = [];
  const runTool = async (tool: ToolDef): Promise<ToolOutcome> => {
    ran.push(tool.name);
    return { ok: true, summary: "ok" };
  };

  const events = await collect(
    runAgentTurn(thread, tuning({ yes: true }), {
      llm,
      runTool,
      confirm: () => true, // write_file is destructive: the human says yes
    }),
  );

  assert.deepEqual(ran, ["read_file", "write_file"]);
  assert.match(textOf(events), /Bumped it to 2\./);
});

test("several calls in ONE reply all run, and all their results come back", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "read both" }] };
  const llm = textOnlyModel([
    '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>\n' +
      '<tool_call>{"name":"read_file","arguments":{"path":"b.ts"}}</tool_call>',
    "Both read.",
  ]);
  const paths: unknown[] = [];
  const runTool = async (_t: ToolDef, args: Record<string, unknown>): Promise<ToolOutcome> => {
    paths.push(args.path);
    return { ok: true, summary: `contents of ${String(args.path)}` };
  };

  await collect(runAgentTurn(thread, tuning({ yes: true }), { llm, runTool }));

  assert.deepEqual(paths, ["a.ts", "b.ts"]);
  const results = thread.messages.filter((m) => m.role === "tool");
  assert.equal(results.length, 2, "one of the two results was lost");
});

test("the round cap still bounds a text-protocol model that never stops calling", async () => {
  // A small model that has learned "emit a tool call" and not "stop" must not spin forever.
  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  let turns = 0;
  const llm: LLMClient = {
    turn: async function* () {
      turns += 1;
      yield {
        kind: "tool_call",
        call: { name: "read_file", args: { path: `f${turns}.ts` } },
      };
    },
  };
  const events = await collect(
    runAgentTurn(thread, tuning({ yes: true, maxRounds: 3 }), {
      llm,
      runTool: async () => ({ ok: true, summary: "x" }),
    }),
  );
  assert.equal(turns, 3);
  assert.ok(
    events.some((e) => e.kind === "capped"),
    "the cap was hit but the host was never told it could /continue",
  );
});

/* ── the gates hold identically for text calls ───────────────────────────────*/

test("--force is refused however a TEXT call smuggles it", async () => {
  // The §4 invariant: only a human may type the confirmation. Widening tool access to every
  // model widens it to every model that has read a README suggesting --force.
  for (const args of [
    '{"path":"a.ts","force":true}',
    '{"path":"a.ts","force":"true"}',
    '{"argv":["install","--force"]}',
    '{"argv":["install","--force=1"]}',
  ]) {
    const thread: Thread = { messages: [{ role: "user", content: "go" }] };
    const llm = textOnlyModel([
      `<tool_call>{"name":"read_file","arguments":${args}}</tool_call>`,
      "ok",
    ]);
    let ran = false;
    const events = await collect(
      runAgentTurn(thread, tuning({ yes: true }), {
        llm,
        runTool: async () => {
          ran = true;
          return { ok: true, summary: "x" };
        },
      }),
    );
    assert.equal(ran, false, `a forced call RAN via ${args}`);
    const blocked = events.find((e) => e.kind === "blocked");
    assert.ok(blocked, `no block event for ${args}`);
    assert.match(blocked.kind === "blocked" ? blocked.reason : "", /force/);
  }
});

test("a destructive tool still stops for a human, even under `yes`", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "overwrite it" }] };
  const llm = textOnlyModel([
    '<tool_call>{"name":"write_file","arguments":{"path":"a.ts","content":"x"}}</tool_call>',
    "ok",
  ]);
  let ran = false;
  let asked = false;
  await collect(
    runAgentTurn(thread, tuning({ yes: true }), {
      llm,
      runTool: async () => {
        ran = true;
        return { ok: true, summary: "x" };
      },
      confirm: () => {
        asked = true;
        return false;
      },
    }),
  );
  assert.equal(asked, true, "a destructive text call skipped the confirmation");
  assert.equal(ran, false);
});

test("a declined call comes back as a result the model can re-plan on", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "overwrite it" }] };
  const llm = textOnlyModel([
    '<tool_call>{"name":"write_file","arguments":{"path":"a.ts","content":"x"}}</tool_call>',
    "Understood — I will not overwrite it.",
  ]);
  const events = await collect(
    runAgentTurn(thread, tuning({ yes: true }), {
      llm,
      runTool: async () => ({ ok: true, summary: "x" }),
      confirm: () => ({ approved: false, reason: "that file is generated" }),
    }),
  );
  const toolMsg = thread.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /that file is generated/);
  assert.match(textOf(events), /I will not overwrite it/);
});

test("a nemesis BLOCK aborts a text call and tells the model why", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  const llm = textOnlyModel([
    '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
    "ok",
  ]);
  const events = await collect(
    runAgentTurn(thread, tuning({ yes: true }), {
      llm,
      runTool: async () => ({ ok: false, summary: "", verdict: { verdict: "block" } }),
    }),
  );
  assert.ok(events.some((e) => e.kind === "blocked"));
  const toolMsg = thread.messages.find((m) => m.role === "tool");
  assert.match(toolMsg?.content ?? "", /nemesis gate BLOCK/);
});

test("a tool the policy DENIES is refused even when the model names it perfectly", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  const llm = textOnlyModel([
    '<tool_call>{"name":"write_file","arguments":{"path":"a.ts","content":"x"}}</tool_call>',
    "ok",
  ]);
  let ran = false;
  const events = await collect(
    runAgentTurn(
      thread,
      tuning({
        yes: true,
        tools: { enabled: true, allow: [], deny: ["write_file"], extra: TOOLS },
      }),
      {
        llm,
        runTool: async () => {
          ran = true;
          return { ok: true, summary: "x" };
        },
        confirm: () => true,
      },
    ),
  );
  assert.equal(ran, false);
  assert.ok(events.some((e) => e.kind === "blocked"));
});

/* ── the preamble is what makes the model able to do any of this ─────────────*/

test("the preamble names the tools the loop will actually accept", async () => {
  // A preamble advertising a tool the policy denies teaches the model to keep proposing it.
  const policy = { enabled: true, allow: [], deny: ["write_file"], extra: TOOLS };
  const { exposedTools } = await import("../tools.js");
  const exposed = exposedTools(policy);
  const { text } = renderToolPreamble(exposed, { mode: "text" });
  assert.match(text, /read_file/);
  assert.doesNotMatch(text, /write_file/);
});
