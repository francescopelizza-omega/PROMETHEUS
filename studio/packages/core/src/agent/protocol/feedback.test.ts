/**
 * feedback.test.ts — a tool's RESULT must reach the model.
 *
 * The defect this pins: the CLI's tool transport ends every turn with `{kind:"final"}`,
 * including the turns where it just emitted tool calls (`session/agent-runtime.ts`, end of
 * `toolTurn`). The loop's round check read `if (sawFinal || toolMessages.length === 0) break`
 * BEFORE folding the round's tool results into the thread — so on the CLI a tool would run,
 * its output would be thrown away, the model would never see it, and the turn would end.
 *
 * Every visible symptom said the feature worked: the tool really ran, the transcript really
 * showed the result, the answer really arrived. What was missing was the model's second look
 * — which is the entire difference between a tool call and an agent.
 *
 * These tests live under `protocol/` rather than in `agent.test.ts` because they are about
 * the contract between a transport and the loop, which is what this directory exists to
 * define.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelRef } from "../../agents/types.js";
import type { AgentEvent } from "../events.js";
import type { LLMClient, LlmTurn, Thread, ToolOutcome } from "../loop.js";
import { defaultTuning, runAgentTurn } from "../loop.js";
import type { ToolDef } from "../tools.js";
import { PROTOCOL_FEEDBACK_TOOL, protocolFeedbackMessage } from "./feedback.js";

const MODEL: ModelRef = { provider: "local", modelId: "qwen3:8b" };

const READ_FILE: ToolDef = {
  name: "read_file",
  title: "Read file",
  description: "Read a file.",
  schema: { path: { type: "string", required: true } },
  annotations: { readOnlyHint: true },
  toArgv: () => {
    throw new Error("host-local");
  },
};

/** An LLM that plays one scripted round per invocation, then stops. */
function rounds(script: LlmTurn[][]): LLMClient {
  let i = 0;
  return {
    turn: async function* () {
      const turn = script[i];
      i += 1;
      if (!turn) return;
      for (const t of turn) yield t;
    },
  };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function tuning() {
  return {
    ...defaultTuning(MODEL),
    yes: true, // read_file is readOnlyHint, so the broker auto-approves it
    tools: { enabled: true, allow: [], deny: [], extra: [READ_FILE] },
  };
}

const runTool = async (): Promise<ToolOutcome> => ({ ok: true, summary: "export const a = 1;" });

/* ── the defect ──────────────────────────────────────────────────────────────*/

test("a tool result reaches the thread even when the transport also said `final`", async () => {
  // This is the CLI's exact shape: tool_call then an unconditional final.
  const thread: Thread = { messages: [{ role: "user", content: "read a.ts" }] };
  const llm = rounds([
    [{ kind: "tool_call", call: { name: "read_file", args: { path: "a.ts" } } }, { kind: "final" }],
    [{ kind: "text", text: "It exports `a`." }, { kind: "final" }],
  ]);

  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));

  const toolMsg = thread.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "the tool ran but its result never entered the thread");
  assert.match(toolMsg.content, /export const a = 1;/);
});

test("the model is re-invoked after a tool runs — the turn is not single-round", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "read a.ts" }] };
  let invocations = 0;
  const llm: LLMClient = {
    turn: async function* () {
      invocations += 1;
      if (invocations === 1) {
        yield { kind: "tool_call", call: { name: "read_file", args: { path: "a.ts" } } };
        yield { kind: "final" };
        return;
      }
      yield { kind: "text", text: "It exports `a`." };
      yield { kind: "final" };
    },
  };

  const events = await collect(runAgentTurn(thread, tuning(), { llm, runTool }));

  assert.equal(invocations, 2, "the model never got to see what the tool returned");
  const text = events
    .filter((e) => e.kind === "text")
    .map((e) => (e.kind === "text" ? e.text : ""))
    .join("");
  assert.match(text, /It exports/, "no answer was synthesised from the tool result");
});

test("`final` with NO tool call still ends the turn immediately", async () => {
  // The other half of the contract: a plain text answer must not cost a second round.
  const thread: Thread = { messages: [{ role: "user", content: "hello" }] };
  let invocations = 0;
  const llm: LLMClient = {
    turn: async function* () {
      invocations += 1;
      yield { kind: "text", text: "hi" };
      yield { kind: "final" };
    },
  };
  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));
  assert.equal(invocations, 1, "a text-only turn was re-invoked");
  // The terminal answer IS folded now. The old assertion ("would be duplicated") was correct
  // while the thread was only the multi-round loop's scratch buffer and each host appended
  // `res.reply` to its own history. The thread is the CROSS-TURN memory now, so leaving the
  // answer out meant the agent remembered every file it read and nothing it had said.
  assert.deepEqual(
    thread.messages.filter((m) => m.role === "assistant").map((m) => m.content),
    ["hi"],
    "the terminal answer must reach the thread — it is what the next turn reads",
  );
});

test("a BLOCKED call still ends the round with a result the model can re-plan on", async () => {
  // A block produces no ToolOutcome but DOES produce a tool message; the model must get it,
  // or it will re-propose the identical blocked call on every subsequent turn.
  const thread: Thread = { messages: [{ role: "user", content: "delete everything" }] };
  const llm = rounds([
    [{ kind: "tool_call", call: { name: "not_a_tool", args: {} } }, { kind: "final" }],
    [{ kind: "text", text: "I cannot do that." }, { kind: "final" }],
  ]);
  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));
  const toolMsg = thread.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "a blocked call left no trace for the model to re-plan on");
  assert.match(toolMsg.content, /not exposed/);
});

test("the assistant's pre-tool narration is kept with the tool result", async () => {
  // "Let me read that file first." is the context that makes the tool result interpretable.
  const thread: Thread = { messages: [{ role: "user", content: "read a.ts" }] };
  const llm = rounds([
    [
      { kind: "text", text: "Let me read that file first." },
      { kind: "tool_call", call: { name: "read_file", args: { path: "a.ts" } } },
      { kind: "final" },
    ],
    [{ kind: "final", text: "done" }],
  ]);
  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));
  const assistant = thread.messages.find((m) => m.role === "assistant");
  assert.ok(assistant);
  assert.match(assistant.content, /Let me read that file first\./);
});

/* ── the model must remember what it ASKED for ───────────────────────────────*/

test("a call made with no prose still leaves an assistant message in the thread", async () => {
  // Models that speak purely in tool calls are the norm, not the exception. Folding only the
  // prose left no assistant message at all, so the next round read as: user asks a question,
  // then a `[tool_result]` appears from nowhere. A live gemma4:12b answered that by calling
  // the same tool again, or stopping with an empty answer, in three runs out of four.
  const thread: Thread = { messages: [{ role: "user", content: "read a.ts" }] };
  const llm = rounds([
    [{ kind: "tool_call", call: { name: "read_file", args: { path: "a.ts" } } }],
    [{ kind: "text", text: "It exports `a`." }, { kind: "final" }],
  ]);
  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));

  const assistant = thread.messages.find((m) => m.role === "assistant");
  assert.ok(assistant, "the model was given no record of its own tool call");
  assert.match(assistant.content, /read_file/);
  assert.match(assistant.content, /a\.ts/);
});

test("the record is the same syntax the model itself emits", async () => {
  // So the transcript reads back as its own output rather than as a paraphrase of it.
  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  const llm = rounds([
    [{ kind: "tool_call", call: { name: "read_file", args: { path: "a.ts" } } }],
    [{ kind: "final" }],
  ]);
  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));
  assert.equal(
    thread.messages.find((m) => m.role === "assistant")?.content,
    '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
  );
});

test("prose and the call are BOTH kept, prose first", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  const llm = rounds([
    [
      { kind: "text", text: "Let me look.\n" },
      { kind: "tool_call", call: { name: "read_file", args: { path: "a.ts" } } },
    ],
    [{ kind: "final" }],
  ]);
  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));
  const assistant = thread.messages.find((m) => m.role === "assistant");
  assert.match(assistant?.content ?? "", /^Let me look\.\n<tool_call>/);
});

test("a REFUSED call is recorded too — otherwise the model re-proposes it forever", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  const llm = rounds([
    [{ kind: "tool_call", call: { name: "not_a_tool", args: {} } }],
    [{ kind: "final" }],
  ]);
  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));
  assert.match(thread.messages.find((m) => m.role === "assistant")?.content ?? "", /not_a_tool/);
});

test("several calls in one round are all recorded, in order", async () => {
  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  const llm = rounds([
    [
      { kind: "tool_call", call: { name: "read_file", args: { path: "a.ts" } } },
      { kind: "tool_call", call: { name: "read_file", args: { path: "b.ts" } } },
    ],
    [{ kind: "final" }],
  ]);
  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));
  const content = thread.messages.find((m) => m.role === "assistant")?.content ?? "";
  assert.ok(content.indexOf("a.ts") < content.indexOf("b.ts"));
  assert.equal(content.split("<tool_call>").length - 1, 2);
});

/* ── protocol feedback reaches the model INTACT ──────────────────────────────*/

test("an unreadable call is answered with the REASON, not `tool is not exposed`", async () => {
  // The first version of this rode the loop's unexposed-tool branch, which replaced the
  // diagnosis with a message about a tool that was never called — so the model learned
  // nothing about what it had actually got wrong, and repeated it.
  const thread: Thread = { messages: [{ role: "user", content: "read a.ts" }] };
  const llm = rounds([
    [
      {
        kind: "tool_call",
        call: {
          name: PROTOCOL_FEEDBACK_TOOL,
          args: { reason: "the call is not valid JSON", wrote: '<tool_call>{"name":' },
        },
      },
    ],
    [{ kind: "final", text: "sorry" }],
  ]);
  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));

  const msg = thread.messages.find((m) => m.role === "tool")?.content ?? "";
  assert.match(msg, /the call is not valid JSON/, "the diagnosis never reached the model");
  assert.doesNotMatch(msg, /is not exposed/, "still masquerading as an unknown tool");
  assert.match(msg, /you wrote: <tool_call>\{"name":/);
  // The correction has to restate the shape that needs to change.
  assert.match(msg, /Re-send it exactly as/);
});

test("the echo of a huge malformed payload is capped", async () => {
  // A truncated 8KB write_file would otherwise bury the correction inside the thing being
  // corrected.
  const msg = protocolFeedbackMessage({ reason: "cut off", wrote: "x".repeat(5000) });
  assert.ok(msg.length < 500, `feedback was ${msg.length} chars`);
  assert.match(msg, /…/);
});

test("feedback with no reason still says something actionable", () => {
  const msg = protocolFeedbackMessage({});
  assert.match(msg, /could not be read as a tool call/);
  assert.match(msg, /Re-send it exactly as/);
  assert.doesNotMatch(msg, /you wrote:/);
});

test("the reserved name is never a callable tool", async () => {
  // It must not appear in any catalog or preamble — it is the transport talking, not a tool.
  const { exposedToolNames } = await import("../tools.js");
  const names = exposedToolNames({ enabled: true, allow: [], deny: [], extra: [READ_FILE] });
  assert.equal(names.has(PROTOCOL_FEEDBACK_TOOL), false);
  const { renderToolPreamble } = await import("./preamble.js");
  assert.doesNotMatch(
    renderToolPreamble([READ_FILE], { mode: "text" }).text,
    new RegExp(PROTOCOL_FEEDBACK_TOOL),
  );
});

test("a REAL unknown tool still gets the unexposed message", async () => {
  // The new branch must not swallow the ordinary case.
  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  const llm = rounds([
    [{ kind: "tool_call", call: { name: "delete_everything", args: {} } }],
    [{ kind: "final" }],
  ]);
  await collect(runAgentTurn(thread, tuning(), { llm, runTool }));
  assert.match(thread.messages.find((m) => m.role === "tool")?.content ?? "", /is not exposed/);
});
