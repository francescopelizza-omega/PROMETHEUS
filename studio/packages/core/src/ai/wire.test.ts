/**
 * wire.test.ts — the three protocols.
 *
 * Every model request spoke OpenAI `/v1/chat/completions`, so Anthropic and Gemini were not
 * merely unconfigured — they were unreachable, and they failed in a way that read like a bug:
 * a request built for OpenAI hits `/v1/chat/completions` on `api.anthropic.com`, an endpoint
 * that does not exist, and 404s.
 *
 * The tests below are mostly about the DIFFERENCES that a naive port gets wrong, because each
 * one is a 400 rather than a graceful degradation: the system prompt is a top-level field on
 * Anthropic and a `systemInstruction` on Gemini; `max_tokens` is REQUIRED by Anthropic; the
 * assistant role is called `model` on Gemini; and neither authenticates with a bearer token.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_FALLBACK_MAX_TOKENS,
  ANTHROPIC_MAX_OUTPUT,
  ANTHROPIC_WIRE,
  GEMINI_WIRE,
  OPENAI_WIRE,
  type WireMessage,
  anthropicMaxTokensFor,
  selectWire,
} from "./wire.js";

const convo: WireMessage[] = [
  { role: "system", content: "be terse" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
  { role: "user", content: "again" },
];

/* ── selection ─────────────────────────────────────────────────────────────*/

test("the format follows the runtime already derived from the base URL", () => {
  // Not a new `wireFormat` field on the endpoint: that would be a second source of the same
  // fact, and the two would eventually disagree.
  assert.equal(selectWire("anthropic").id, "anthropic");
  assert.equal(selectWire("gemini").id, "gemini");
  assert.equal(selectWire("openai").id, "openai");
  // Everything unrecognised gets OpenAI — what all sixteen registered providers speak.
  assert.equal(selectWire("ollama").id, "openai");
  assert.equal(selectWire("unknown").id, "openai");
});

/* ── URLs ──────────────────────────────────────────────────────────────────*/

test("each format targets its OWN endpoint path", () => {
  assert.equal(
    OPENAI_WIRE.url("https://api.groq.com/openai/v1", "m"),
    "https://api.groq.com/openai/v1/chat/completions",
  );
  // The 404 that made Anthropic unreachable: the OpenAI builder produced this host with
  // `/v1/chat/completions`, which does not exist.
  assert.equal(
    ANTHROPIC_WIRE.url("https://api.anthropic.com", "m"),
    "https://api.anthropic.com/v1/messages",
  );
  assert.equal(
    GEMINI_WIRE.url("https://generativelanguage.googleapis.com", "gemini-2.5-pro"),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
  );
});

test("a base URL that already carries its version segment is not doubled", () => {
  // The engine's `localai endpoints` returns URLs ending in /v1; a naive join yields
  // `/v1/v1/...`, which answers "404 page not found" and kills chat.
  assert.equal(
    OPENAI_WIRE.url("http://localhost:11434/v1/", "m"),
    "http://localhost:11434/v1/chat/completions",
  );
  assert.equal(
    ANTHROPIC_WIRE.url("https://api.anthropic.com/v1", "m"),
    "https://api.anthropic.com/v1/messages",
  );
  assert.match(GEMINI_WIRE.url("https://x/v1beta", "m"), /^https:\/\/x\/v1beta\/models\//);
});

test("a model name with a slash cannot escape the Gemini path", () => {
  assert.match(GEMINI_WIRE.url("https://x", "a/b"), /models\/a%2Fb:streamGenerateContent/);
});

/* ── headers ───────────────────────────────────────────────────────────────*/

test("none of the three authenticate the same way", () => {
  assert.deepEqual(OPENAI_WIRE.headers("k"), { authorization: "Bearer k" });
  // x-api-key, NOT a bearer — and the version header is mandatory on every request.
  assert.deepEqual(ANTHROPIC_WIRE.headers("k"), {
    "x-api-key": "k",
    "anthropic-version": "2023-06-01",
  });
  // A header, not the query string: a URL is logged by proxies and shows up in errors.
  assert.deepEqual(GEMINI_WIRE.headers("k"), { "x-goog-api-key": "k" });
});

test("a keyless (local) endpoint gets no credential header at all", () => {
  assert.deepEqual(OPENAI_WIRE.headers(""), {});
  assert.deepEqual(GEMINI_WIRE.headers(""), {});
  // Anthropic still needs its version header — it is protocol, not auth.
  assert.deepEqual(ANTHROPIC_WIRE.headers(""), { "anthropic-version": "2023-06-01" });
});

/* ── bodies ────────────────────────────────────────────────────────────────*/

test("Anthropic takes the system prompt OUT of the messages", () => {
  // `messages` accepts only user/assistant; a system message left in place is a 400.
  const b = ANTHROPIC_WIRE.body(convo, { model: "claude" });
  assert.equal(b.system, "be terse");
  const msgs = b.messages as { role: string }[];
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user"],
  );
});

test("Anthropic ALWAYS sends max_tokens, because omitting it is a 400", () => {
  assert.equal(ANTHROPIC_WIRE.body(convo, { model: "m" }).max_tokens, ANTHROPIC_DEFAULT_MAX_TOKENS);
  assert.equal(ANTHROPIC_WIRE.body(convo, { model: "m", maxTokens: 100 }).max_tokens, 100);
});

test("Gemini renames the assistant role and wraps text in parts", () => {
  const b = GEMINI_WIRE.body(convo, { model: "g" });
  const contents = b.contents as { role: string; parts: { text: string }[] }[];
  assert.deepEqual(
    contents.map((c) => c.role),
    ["user", "model", "user"],
  );
  assert.equal(contents[0]?.parts[0]?.text, "hi");
  assert.deepEqual(b.systemInstruction, { parts: [{ text: "be terse" }] });
});

test("OpenAI's body is unchanged — the default path must not move", () => {
  const b = OPENAI_WIRE.body(convo, { model: "m", includeUsage: true, maxTokens: 50 });
  assert.equal(b.stream, true);
  assert.deepEqual(b.stream_options, { include_usage: true });
  assert.equal(b.max_tokens, 50);
  assert.equal((b.messages as unknown[]).length, 4, "the system message stays in the list");
});

/* ── parsing ───────────────────────────────────────────────────────────────*/

test("each format's TEXT delta is found where that format puts it", () => {
  assert.equal(OPENAI_WIRE.parse('{"choices":[{"delta":{"content":"ab"}}]}').delta, "ab");
  assert.equal(
    ANTHROPIC_WIRE.parse('{"type":"content_block_delta","delta":{"type":"text_delta","text":"ab"}}')
      .delta,
    "ab",
  );
  assert.equal(
    GEMINI_WIRE.parse('{"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}').delta,
    "ab",
  );
});

test("each format's terminal marker is recognised", () => {
  assert.equal(OPENAI_WIRE.parse("[DONE]").done, true);
  assert.equal(ANTHROPIC_WIRE.parse('{"type":"message_stop"}').done, true);
});

test("usage is normalized into ONE shape across all three", () => {
  const oa = OPENAI_WIRE.parse(
    '{"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}',
  ).usage;
  assert.deepEqual(oa, { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 4 });

  // Anthropic reports input on message_start and output on message_delta — two frames.
  const start = ANTHROPIC_WIRE.parse(
    '{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":6}}}',
  ).usage;
  assert.equal(start?.inputTokens, 10);
  assert.equal(start?.cacheRead, 6);
  const end = ANTHROPIC_WIRE.parse('{"type":"message_delta","usage":{"output_tokens":7}}').usage;
  assert.equal(end?.outputTokens, 7);

  const gm = GEMINI_WIRE.parse(
    '{"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":3,"totalTokenCount":12}}',
  ).usage;
  assert.deepEqual(gm, { inputTokens: 9, outputTokens: 3, totalTokens: 12 });
});

test("a malformed or irrelevant frame yields nothing, never a throw", () => {
  // A stream is a hostile input: half a frame, a keepalive comment, an unknown event type.
  for (const fmt of [OPENAI_WIRE, ANTHROPIC_WIRE, GEMINI_WIRE]) {
    assert.deepEqual(fmt.parse("{not json"), {});
    assert.deepEqual(fmt.parse(""), {});
    assert.deepEqual(fmt.parse('{"type":"ping"}'), {});
  }
});

/* ── tool calling, in three dialects ───────────────────────────────────────*/

test("all three formats carry tools natively", () => {
  // This used to be true/false/false, and `false` did not degrade Anthropic and Gemini
  // politely — it routed the two best models available to this CLI through the text protocol
  // written for small local models that cannot function-call at all.
  assert.equal(OPENAI_WIRE.supportsTools, true);
  assert.equal(ANTHROPIC_WIRE.supportsTools, true);
  assert.equal(GEMINI_WIRE.supportsTools, true);
});

const TOOL = {
  name: "read_file",
  description: "read a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "path" } },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

const CHAT = [{ role: "user", content: "hi" }] as const;

test("each format declares a tool in ITS OWN dialect, not OpenAI's", () => {
  const o = OPENAI_WIRE.body(CHAT, { model: "m", tools: [TOOL] }) as Record<string, any>;
  assert.equal(o.tools[0].type, "function");
  assert.equal(o.tools[0].function.name, "read_file");
  assert.equal(o.tool_choice, "auto");

  // Anthropic: no `{type:"function"}` envelope, and the schema key is `input_schema`.
  const a = ANTHROPIC_WIRE.body(CHAT, { model: "m", tools: [TOOL] }) as Record<string, any>;
  assert.equal(a.tools[0].name, "read_file");
  assert.ok(a.tools[0].input_schema, "Anthropic takes input_schema, not parameters");
  assert.equal(a.tools[0].parameters, undefined);
  assert.deepEqual(a.tool_choice, { type: "auto" });

  // Gemini: ONE tools entry holding every declaration.
  const g = GEMINI_WIRE.body(CHAT, { model: "m", tools: [TOOL] }) as Record<string, any>;
  assert.equal(g.tools.length, 1);
  assert.equal(g.tools[0].functionDeclarations[0].name, "read_file");
  assert.deepEqual(g.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
});

test("Gemini's schema is rebuilt, because unknown keys are a 400 there", () => {
  // `type` is a protobuf enum ("STRING", not "string"), and `additionalProperties` — which
  // this repo's schemas carry — is rejected outright rather than ignored.
  const g = GEMINI_WIRE.body(CHAT, { model: "m", tools: [TOOL] }) as Record<string, any>;
  const p = g.tools[0].functionDeclarations[0].parameters;
  assert.equal(p.type, "OBJECT");
  assert.equal(p.properties.path.type, "STRING");
  assert.equal("additionalProperties" in p, false);
  assert.deepEqual(p.required, ["path"]);
});

test("a no-argument tool omits Gemini's `parameters` entirely", () => {
  // An OBJECT schema with an empty `properties` map is rejected; half this repo's catalog
  // (prometheus_scan, git_status, system_info) takes no arguments.
  const g = GEMINI_WIRE.body(CHAT, {
    model: "m",
    tools: [
      { name: "git_status", description: "d", parameters: { type: "object", properties: {} } },
    ],
  }) as Record<string, any>;
  assert.equal("parameters" in g.tools[0].functionDeclarations[0], false);
});

test("NO tool fields go on the wire when nothing is exposed", () => {
  // `tools: []` is not the same as absent: Anthropic rejects the empty array, and it is the
  // shape every turn takes whenever the policy exposes nothing.
  for (const [name, w] of [
    ["openai", OPENAI_WIRE],
    ["anthropic", ANTHROPIC_WIRE],
    ["gemini", GEMINI_WIRE],
  ] as const) {
    const empty = w.body(CHAT, { model: "m", tools: [] }) as Record<string, unknown>;
    const none = w.body(CHAT, { model: "m" }) as Record<string, unknown>;
    assert.equal("tools" in empty, false, `${name} sent an empty tools array`);
    assert.equal("tools" in none, false, `${name} invented a tools field`);
  }
});

/* ── the round trip: a call goes out, a result comes back ──────────────────*/

const ROUND_TRIP = [
  { role: "user", content: "read it" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_1", name: "read_file", argsJson: '{"path":"a.ts"}' }],
  },
  { role: "tool", content: "file body", toolCallId: "call_1", toolName: "read_file" },
] as const;

test("OpenAI pairs a result to its call by tool_call_id", () => {
  const o = OPENAI_WIRE.body(ROUND_TRIP, { model: "m" }) as Record<string, any>;
  assert.equal(o.messages[1].tool_calls[0].id, "call_1");
  assert.equal(o.messages[1].tool_calls[0].function.arguments, '{"path":"a.ts"}');
  assert.equal(o.messages[2].role, "tool");
  assert.equal(o.messages[2].tool_call_id, "call_1");
});

test("Anthropic turns the call into a tool_use BLOCK and the result into a user turn", () => {
  // There is no `tool` role in this format at all; the result rides the next user turn.
  const a = ANTHROPIC_WIRE.body(ROUND_TRIP, { model: "m" }) as Record<string, any>;
  assert.deepEqual(
    a.messages.map((m: any) => m.role),
    ["user", "assistant", "user"],
  );
  const use = a.messages[1].content.find((b: any) => b.type === "tool_use");
  assert.equal(use.id, "call_1");
  // `input` is an OBJECT here, not the JSON text OpenAI takes.
  assert.deepEqual(use.input, { path: "a.ts" });
  const res = a.messages[2].content[0];
  assert.equal(res.type, "tool_result");
  assert.equal(res.tool_use_id, "call_1");
});

test("Gemini pairs by NAME, because it issues no call ids", () => {
  const g = GEMINI_WIRE.body(ROUND_TRIP, { model: "m" }) as Record<string, any>;
  const call = g.contents[1].parts.find((p: any) => p.functionCall);
  assert.deepEqual(call.functionCall, { name: "read_file", args: { path: "a.ts" } });
  const res = g.contents[2].parts[0];
  assert.equal(res.functionResponse.name, "read_file");
});

test("a system prompt already MARKED for caching survives — it used to become [object Object]", () => {
  // `ai/prompt-cache.ts` marks the stable prefix by replacing the system message's `content`
  // string with a block array. Joining those with `\n\n` produced the literal string
  // "[object Object]" — and the marking triggers at 4096 characters, which an agentic system
  // prompt with a tool preamble always exceeds. So EVERY Claude turn shipped that literal as
  // its whole system prompt: no instructions, no tools, no identity, and a 200 response.
  const marked = [
    {
      role: "system",
      content: [{ type: "text", text: "you are prometheus", cache_control: { type: "ephemeral" } }],
    },
    { role: "user", content: "hi" },
  ] as unknown as Parameters<typeof ANTHROPIC_WIRE.body>[0];
  const a = ANTHROPIC_WIRE.body(marked, { model: "m" }) as Record<string, any>;
  assert.ok(Array.isArray(a.system), "the marked form must stay block-shaped");
  assert.equal(a.system[0].text, "you are prometheus");
  // …and the breakpoint must survive, or caching is requested nowhere despite the report
  // pricing the savings.
  assert.deepEqual(a.system[0].cache_control, { type: "ephemeral" });
});

test("an UNMARKED system prompt is still the cheap string form", () => {
  const a = ANTHROPIC_WIRE.body(
    [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "hi" },
    ],
    { model: "m" },
  ) as Record<string, any>;
  assert.equal(a.system, "a\n\nb");
});

test("a text-only thread is still rendered as a plain string, not blocks", () => {
  // The cheap rendering has to survive, or every ordinary chat body changes shape.
  const a = ANTHROPIC_WIRE.body(CHAT, { model: "m" }) as Record<string, any>;
  assert.equal(typeof a.messages[0].content, "string");
});

/* ── decoding a streamed call ──────────────────────────────────────────────*/

test("OpenAI's argument FRAGMENTS are keyed by index so parallel calls stay apart", () => {
  const open = OPENAI_WIRE.parse(
    JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file" } }] } },
      ],
    }),
  );
  assert.deepEqual(open.toolCall, { index: 0, id: "c1", name: "read_file" });
  const frag = OPENAI_WIRE.parse(
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }],
    }),
  );
  assert.deepEqual(frag.toolCall, { index: 0, argsFragment: '{"pa' });
});

test("Anthropic opens a call on content_block_start and fills it with input_json_delta", () => {
  const open = ANTHROPIC_WIRE.parse(
    JSON.stringify({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "read_file" },
    }),
  );
  assert.deepEqual(open.toolCall, { index: 1, id: "toolu_1", name: "read_file" });
  const frag = ANTHROPIC_WIRE.parse(
    JSON.stringify({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path"' },
    }),
  );
  assert.deepEqual(frag.toolCall, { index: 1, argsFragment: '{"path"' });
  // …and the fragment must NOT be mistaken for prose, or raw JSON prints at the user.
  assert.equal(frag.delta, undefined);
});

test("a text content_block_start is not mistaken for a call", () => {
  const ev = ANTHROPIC_WIRE.parse(
    JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
  );
  assert.deepEqual(ev, {});
});

test("Gemini delivers a call WHOLE, and gets a synthetic id", () => {
  // Every other pairing in the loop is by id; Gemini issues none, so the name serves as one —
  // which is also exactly what functionResponse pairs on.
  const ev = GEMINI_WIRE.parse(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } } }] } },
      ],
    }),
  );
  assert.equal(ev.toolCall?.name, "read_file");
  assert.equal(ev.toolCall?.id, "read_file");
  assert.equal(ev.toolCall?.argsFragment, '{"path":"a.ts"}');
});

/* ── strict role alternation ───────────────────────────────────────────────*/

/** The normal shape of an agentic turn: the tool result lands between two user turns. */
const AGENT_TURN = [
  { role: "system", content: "sys" },
  { role: "user", content: "do the thing" },
  { role: "assistant", content: "calling a tool" },
  { role: "tool", content: "[tool_result] ok" },
  { role: "user", content: "and now?" },
] as const;

test("Anthropic and Gemini get STRICTLY alternating roles, because both reject repeats", () => {
  // This is the shape that broke every agentic loop on these two providers. `tool` has no
  // role of its own in either format, so flattening it to `user` put two user turns back to
  // back and the second round of every tool loop took a 400. A one-shot chat never produces
  // that shape, which is why it looked fine.
  const a = ANTHROPIC_WIRE.body(AGENT_TURN, { model: "m" }) as { messages: { role: string }[] };
  const g = GEMINI_WIRE.body(AGENT_TURN, { model: "m" }) as { contents: { role: string }[] };
  assert.deepEqual(
    a.messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  assert.deepEqual(
    g.contents.map((m) => m.role),
    ["user", "model", "user"],
  );
});

test("merging keeps the tool result IN FRONT of the model — it is never dropped", () => {
  // Dropping the repeated turn would satisfy alternation and reintroduce the exact invisible
  // failure `flattenToolRoles` exists to prevent: the transcript shows a result the model
  // never saw, and the agent calls the same tool again.
  const a = ANTHROPIC_WIRE.body(AGENT_TURN, { model: "m" }) as {
    messages: { role: string; content: string }[];
  };
  const merged = a.messages[2]?.content ?? "";
  assert.match(merged, /\[tool_result\] ok/);
  assert.match(merged, /and now\?/);
});

test("a thread that OPENS on the assistant is folded, not sent", () => {
  // A restored session can start here, and Anthropic requires the first message to be `user`.
  const a = ANTHROPIC_WIRE.body(
    [
      { role: "assistant", content: "restored" },
      { role: "user", content: "carry on" },
    ],
    { model: "m" },
  ) as { messages: { role: string; content: string }[] };
  assert.deepEqual(
    a.messages.map((m) => m.role),
    ["user"],
  );
  assert.match(a.messages[0]?.content ?? "", /restored/);
  assert.match(a.messages[0]?.content ?? "", /carry on/);
});

test("OpenAI is NOT coerced — it accepts the roles as given", () => {
  // The alternation rule is Anthropic's and Gemini's, not a universal one. Rewriting the
  // OpenAI body would lose the `tool` role that format genuinely understands.
  const o = OPENAI_WIRE.body(AGENT_TURN, { model: "m" }) as { messages: { role: string }[] };
  assert.deepEqual(
    o.messages.map((m) => m.role),
    ["system", "user", "assistant", "tool", "user"],
  );
});

/* ── a failure that arrives AFTER the 200 ──────────────────────────────────*/

test("a mid-stream provider error is reported, not parsed to silence", () => {
  // The status is already 200 by the time these arrive, so retry never sees them and neither
  // does the error path: the turn just ended with an empty answer, which reads as the model
  // refusing to speak.
  const a = ANTHROPIC_WIRE.parse(
    '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  );
  assert.match(a.error ?? "", /overloaded_error/);
  assert.match(a.error ?? "", /Overloaded/);

  const o = OPENAI_WIRE.parse('{"error":{"message":"context length exceeded"}}');
  assert.match(o.error ?? "", /context length exceeded/);

  const g = GEMINI_WIRE.parse('{"error":{"code":429,"message":"quota"}}');
  assert.match(g.error ?? "", /quota/);
});

test("Gemini's two NON-error failures are reported too", () => {
  // Neither is an `error` object, and both are 200s with no text.
  const blocked = GEMINI_WIRE.parse('{"promptFeedback":{"blockReason":"SAFETY"}}');
  assert.match(blocked.error ?? "", /blocked/);
  assert.match(blocked.error ?? "", /SAFETY/);

  const cut = GEMINI_WIRE.parse(
    '{"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"partial"}]}}]}',
  );
  assert.match(cut.error ?? "", /MAX_TOKENS/);
  // …and the text it DID produce is still delivered — a truncated answer beats none.
  assert.equal(cut.delta, "partial");
});

test("an ORDINARY Gemini finish is not mistaken for a failure", () => {
  const ok = GEMINI_WIRE.parse(
    '{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"done"}]}}]}',
  );
  assert.equal(ok.error, undefined);
  assert.equal(ok.delta, "done");
});

test("an error with no message still produces a reportable sentence", () => {
  // An error that cannot be described must still be REPORTED — `undefined` here would restore
  // exactly the silence this fixes.
  const a = ANTHROPIC_WIRE.parse('{"type":"error","error":{}}');
  assert.ok((a.error ?? "").length > 0);
});

test("EVERY tool call in a frame is parsed, not just the first", () => {
  /**
   * `WireEvent.toolCall` is a single object and both parsers took exactly one entry per frame —
   * OpenAI read `tool_calls[0]`, Gemini took the first `functionCall` part. A server that batches
   * a turn's parallel calls into ONE frame therefore lost all but the first: the agent ran 1 of N
   * requested actions, and because the thread sent back also held only the survivor, the model
   * could not tell the rest had vanished — it just re-asked, burning rounds.
   *
   * Gemini is where this actually bites: it delivers parallel function calls as several
   * `functionCall` parts inside one candidate. The OpenAI branch was a latent gap.
   */
  const openai = OPENAI_WIRE.parse(
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "a", function: { name: "read_file", arguments: '{"p":1}' } },
              { index: 1, id: "b", function: { name: "grep", arguments: '{"q":2}' } },
            ],
          },
        },
      ],
    }),
  );
  assert.equal(openai.toolCalls?.length, 2, "the second parallel call was dropped");
  assert.equal(openai.toolCalls?.[1]?.name, "grep");
  assert.equal(openai.toolCall?.name, "read_file", "the single-call field must still be the first");
  assert.equal(openai.toolCalls?.[1]?.index, 1, "the provider's own index must be preserved");

  const gemini = GEMINI_WIRE.parse(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: "read_file", args: { p: 1 } } },
              { functionCall: { name: "grep", args: { q: 2 } } },
            ],
          },
        },
      ],
    }),
  );
  assert.equal(gemini.toolCalls?.length, 2, "Gemini's second parallel call was dropped");
  assert.deepEqual(
    gemini.toolCalls?.map((c) => c.name),
    ["read_file", "grep"],
  );
  // distinct indices, or the hosts' accumulator Map merges them into one unparseable call
  assert.notEqual(gemini.toolCalls?.[0]?.index, gemini.toolCalls?.[1]?.index);

  // a frame with ONE call is unchanged in both shapes
  const one = OPENAI_WIRE.parse(
    JSON.stringify({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: "a", function: { name: "x", arguments: "{}" } }] },
        },
      ],
    }),
  );
  assert.equal(one.toolCalls?.length, 1);
  assert.equal(one.toolCall?.name, "x");
});

/* ══ output is NOT capped (2026-09-25) ═══════════════════════════════════════
 * A cap on how much the model may SAY is the one cap this product cannot have: it ends the
 * answer mid-sentence and reads as the model failing. These tests exist so the 4096 default
 * cannot come back by accident.
 */

test("OpenAI, Gemini and ollama carry NO output cap at all", () => {
  const convo: WireMessage[] = [{ role: "user", content: "hi" }];
  const openai = OPENAI_WIRE.body(convo, { model: "gpt-x" }) as Record<string, unknown>;
  assert.equal(openai.max_tokens, undefined, "OpenAI must not cap the answer");
  // ollama is driven through the same OpenAI /v1 shim, so this covers it too.
  const gemini = selectWire("gemini").body(convo, { model: "gemini-x" }) as Record<string, unknown>;
  assert.equal(gemini.generationConfig, undefined, "Gemini must not cap the answer");
});

test("Anthropic's required max_tokens is the MODEL's ceiling, never a flat 4096", () => {
  const convo: WireMessage[] = [{ role: "user", content: "hi" }];
  const of = (model: string): number =>
    (ANTHROPIC_WIRE.body(convo, { model }) as { max_tokens: number }).max_tokens;
  // The shipped default was 4096 on models that serve sixteen times that.
  assert.equal(of("claude-sonnet-4-5"), 64_000);
  assert.equal(of("claude-haiku-4-5"), 64_000);
  assert.equal(of("claude-opus-4-1"), 32_000);
  // Older models keep their real, smaller ceilings — sending more is a 400, not a favour.
  assert.equal(of("claude-3-5-sonnet-20241022"), 8_192);
  assert.equal(of("claude-3-opus-20240229"), 4_096);
  for (const id of ["claude-sonnet-4-5", "claude-3-5-sonnet-20241022"]) {
    assert.ok(of(id) > 0 && Number.isInteger(of(id)), id);
  }
});

test("the 128K generation gets 128K — the first fix was family-wide, the ceilings are per-generation", () => {
  const convo: WireMessage[] = [{ role: "user", content: "hi" }];
  const of = (model: string): number =>
    (ANTHROPIC_WIRE.body(convo, { model }) as { max_tokens: number }).max_tokens;
  // Every one of these was under-capped by the 2026-09-25 table: the rows were written per
  // FAMILY and the published ceilings move per GENERATION. `claude-opus-4-8` is the default
  // Opus in this repo's own catalog and was being cut off at a quarter of its budget.
  assert.equal(of("claude-opus-4-8"), 128_000);
  assert.equal(of("claude-opus-4-7"), 128_000);
  assert.equal(of("claude-opus-4-6"), 128_000);
  assert.equal(of("claude-opus-5"), 128_000);
  assert.equal(of("claude-sonnet-5"), 128_000);
  assert.equal(of("claude-sonnet-4-6"), 128_000);
  assert.equal(of("claude-fable-5"), 128_000);
  assert.equal(of("claude-fable-5-1"), 128_000);
  assert.equal(of("claude-mythos-5"), 128_000);

  // ORDER IS LOAD-BEARING: `.find()` takes the first match, so the specific generations must
  // precede the family catch-alls. These two prove the catch-alls still work — 32,000 really is
  // correct for legacy Opus 4, and removing that row to "fix" 4-8 would have broken them.
  assert.equal(of("claude-opus-4"), 32_000);
  assert.equal(of("claude-opus-4-1"), 32_000);

  // haiku-5 is undocumented; the row exists only so splitting opus/sonnet out to 128K does not
  // drop it through to the 8,192 fallback. Preserving behaviour, not asserting a published fact.
  assert.equal(of("claude-haiku-5"), 64_000);
});

test("INVARIANT: every Claude model this repo SHIPS has its own row, never the fallback", async () => {
  /*
   * The rule that stops this table rotting again.
   *
   * `claude-fable-5` matched no row and silently took `ANTHROPIC_FALLBACK_MAX_TOKENS` (8,192)
   * against a real 128,000 — a 15.6x under-cap on a model listed in this repo's own catalog.
   * The fallback's reasoning ("an unknown model is most likely a NEW one or an OLD one, so
   * refusing to guess high keeps it working") is sound for an id arriving from a user's config
   * and wrong for one we ship: there, a missing row is a bug, not caution.
   *
   * Reading the real config rather than a fixture is the point — a model added to the catalog
   * without a row here must fail THIS test.
   */
  const cfg = (await import("./providers/providers.config.json", { with: { type: "json" } })) as {
    default: unknown;
  };
  const raw = cfg.default as Record<string, unknown>;
  const providers = (Array.isArray(raw) ? raw : (raw.providers ?? [])) as {
    id?: string;
    models?: { id?: string }[];
  }[];
  const shipped = providers
    .flatMap((p) => p.models ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.startsWith("claude-"));

  assert.ok(
    shipped.length > 0,
    "the catalog must list some Claude models for this to mean anything",
  );
  for (const id of shipped) {
    const matched = ANTHROPIC_MAX_OUTPUT.some((r) => r.re.test(id.toLowerCase()));
    assert.ok(
      matched,
      `${id} is in providers.config.json but matches no ANTHROPIC_MAX_OUTPUT row, so it would ` +
        `silently take the ${ANTHROPIC_FALLBACK_MAX_TOKENS}-token fallback. Add its row.`,
    );
  }
});

test("an unrecognised Claude model gets a conservative ceiling, not a guess", () => {
  const convo: WireMessage[] = [{ role: "user", content: "hi" }];
  const body = ANTHROPIC_WIRE.body(convo, { model: "claude-something-new" }) as {
    max_tokens: number;
  };
  assert.equal(body.max_tokens, ANTHROPIC_FALLBACK_MAX_TOKENS);
  assert.equal(anthropicMaxTokensFor("CLAUDE-SONNET-4-5"), 64_000, "id match is case-insensitive");
});

test("an explicit caller ceiling still wins — this is a default, not an override", () => {
  const convo: WireMessage[] = [{ role: "user", content: "hi" }];
  const body = ANTHROPIC_WIRE.body(convo, { model: "claude-sonnet-4-5", maxTokens: 1000 }) as {
    max_tokens: number;
  };
  assert.equal(body.max_tokens, 1000);
});
