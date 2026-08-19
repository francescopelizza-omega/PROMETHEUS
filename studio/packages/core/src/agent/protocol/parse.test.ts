/**
 * parse.test.ts — the text tool-call protocol, and the corpus of what models actually emit.
 *
 * Modelled on exec.test.ts's red-team corpus, and for the same reason: the failure mode here
 * is not "the parser crashed", it is "the parser fired a tool the model never asked for" or
 * "the parser silently swallowed the only call in the turn". Both are quiet. Both need a
 * named test each.
 *
 * The two load-bearing groups are DOES NOT FIRE (a call inside an ordinary code fence is an
 * illustration, not an instruction) and STREAMING (a call arrives split across SSE deltas —
 * that is the normal case, not the edge case, because a call is longer than one delta).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ScanEvent,
  ToolCallScanner,
  hasTextToolCall,
  parseToolCalls,
  scanJsonValue,
  scanToolCalls,
} from "./parse.js";

/** The prose half of a scan, concatenated — used to prove text survives byte-identical. */
function textOf(events: ReturnType<typeof scanToolCalls>): string {
  return events
    .filter((e) => e.kind === "text")
    .map((e) => (e.kind === "text" ? e.text : ""))
    .join("");
}

/* ── the taught dialect ──────────────────────────────────────────────────────*/

test("the canonical form parses", () => {
  const calls = parseToolCalls(
    '<tool_call>{"name":"read_file","arguments":{"path":"src/index.ts"}}</tool_call>',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "read_file");
  assert.deepEqual(calls[0]?.args, { path: "src/index.ts" });
  assert.equal(calls[0]?.dialect, "tool_call_tag");
});

test("prose around a call survives as text, and the call is lifted out of it", () => {
  const events = scanToolCalls(
    'Let me look at that file first.\n<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>\nThen I will edit it.',
  );
  assert.deepEqual(
    events.filter((e) => e.kind === "call").map((e) => (e.kind === "call" ? e.call.name : "")),
    ["read_file"],
  );
  assert.equal(textOf(events), "Let me look at that file first.\n\nThen I will edit it.");
});

test("a missing closing tag is tolerated — the JSON tells us where the call ends", () => {
  // Models drop the closer constantly. Requiring it would mean losing the call entirely.
  const calls = parseToolCalls('<tool_call>{"name":"git_status","arguments":{}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "git_status");
});

test("a no-argument tool needs no arguments key at all", () => {
  // A third of the catalog takes none; demanding `arguments` would break every one of them.
  assert.deepEqual(parseToolCalls('<tool_call>{"name":"git_status"}</tool_call>')[0]?.args, {});
});

test("several calls in one turn all come through, in order", () => {
  const calls = parseToolCalls(
    '<tool_call>{"name":"list_dir","arguments":{"path":"src"}}</tool_call>' +
      'and then\n<tool_call>{"name":"read_file","arguments":{"path":"src/a.ts"}}</tool_call>',
  );
  assert.deepEqual(
    calls.map((c) => c.name),
    ["list_dir", "read_file"],
  );
});

/* ── the tolerated dialects ──────────────────────────────────────────────────*/

test("Mistral's [TOOL_CALLS] array is read, including its multi-call form", () => {
  const calls = parseToolCalls(
    '[TOOL_CALLS] [{"name":"git_status","arguments":{}},{"name":"read_file","arguments":{"path":"x"}}]',
  );
  assert.deepEqual(
    calls.map((c) => c.name),
    ["git_status", "read_file"],
  );
  assert.equal(calls[0]?.dialect, "mistral");
});

test("Llama's python_tag and `parameters` key are read", () => {
  const calls = parseToolCalls('<|python_tag|>{"name":"which","parameters":{"program":"node"}}');
  assert.equal(calls[0]?.name, "which");
  assert.deepEqual(calls[0]?.args, { program: "node" });
});

test("the `<function=NAME>` form takes its name from the tag", () => {
  const calls = parseToolCalls('<function=read_file>{"path":"a.ts"}</function>');
  assert.equal(calls[0]?.name, "read_file");
  assert.deepEqual(calls[0]?.args, { path: "a.ts" });
});

test("a ```tool_call fence is a call, not a code block", () => {
  const calls = parseToolCalls('```tool_call\n{"name":"git_diff","arguments":{}}\n```');
  assert.equal(calls[0]?.name, "git_diff");
  assert.equal(calls[0]?.dialect, "tool_call_fence");
});

test("`arguments` as a JSON STRING is parsed — OpenAI's own shape, echoed by fine-tunes", () => {
  const calls = parseToolCalls(
    '<tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}</tool_call>',
  );
  assert.deepEqual(calls[0]?.args, { path: "a.ts" });
});

test("alternate name keys are accepted", () => {
  for (const key of ["name", "tool", "tool_name"]) {
    const calls = parseToolCalls(`<tool_call>{"${key}":"git_status"}</tool_call>`);
    assert.equal(calls[0]?.name, "git_status", `the "${key}" key was not read`);
  }
});

/* ── DOES NOT FIRE ───────────────────────────────────────────────────────────*/

test("a call inside an ORDINARY code fence does NOT fire", () => {
  // "Show me how I'd read that file" must print an example, not read the file. This is the
  // single most important test in the file.
  const src =
    "You would write:\n```\n" +
    '<tool_call>{"name":"run_command","arguments":{"command":"rm -rf /"}}</tool_call>\n' +
    "```\nand that is all.";
  const events = scanToolCalls(src);
  assert.equal(
    events.some((e) => e.kind === "call"),
    false,
    "a call inside an illustrative fence fired",
  );
  assert.equal(textOf(events), src, "the illustration was mangled");
});

test("a language-tagged fence also suppresses", () => {
  const src = '```markdown\n<tool_call>{"name":"git_status"}</tool_call>\n```';
  assert.equal(hasTextToolCall(src), false);
  assert.equal(textOf(scanToolCalls(src)), src);
});

test("a call AFTER a closed fence fires normally", () => {
  // The suppression must be scoped to the fence, not latch for the rest of the turn.
  const events = scanToolCalls(
    '```py\nprint("hi")\n```\n<tool_call>{"name":"git_status"}</tool_call>',
  );
  assert.deepEqual(
    events.filter((e) => e.kind === "call").map((e) => (e.kind === "call" ? e.call.name : "")),
    ["git_status"],
  );
});

test("plain prose that merely mentions the tag is left alone", () => {
  const src = "Use the <tool_call> tag when you want to act.";
  const events = scanToolCalls(src);
  assert.equal(
    events.some((e) => e.kind === "call"),
    false,
  );
  assert.equal(textOf(events), src);
});

test("a code fence containing a stray ``` inside a string still balances", () => {
  // A `}` or a fence inside a JSON string argument must not end the scan early — this is why
  // the parser walks balanced JSON rather than searching for the closing marker.
  const calls = parseToolCalls(
    '<tool_call>{"name":"write_file","arguments":{"path":"a.md","content":"```\\nx}\\n```"}}</tool_call>',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args.content, "```\nx}\n```");
});

/* ── malformed ───────────────────────────────────────────────────────────────*/

test("broken JSON is reported malformed — never guessed at, never silently dropped", () => {
  const events = scanToolCalls(
    '<tool_call>{"name":"read_file","arguments":{path:a.ts}}</tool_call>',
  );
  const bad = events.find((e) => e.kind === "malformed");
  assert.ok(bad, "a broken call vanished instead of being reported");
  assert.match(bad.kind === "malformed" ? bad.error.reason : "", /not valid JSON/);
});

test("a payload with no name is malformed, not a call on an empty name", () => {
  const events = scanToolCalls('<tool_call>{"arguments":{"path":"a"}}</tool_call>');
  assert.equal(
    events.some((e) => e.kind === "call"),
    false,
  );
  assert.ok(events.some((e) => e.kind === "malformed"));
});

test("a truncated call at end of stream is malformed, not flushed as prose", () => {
  // The model ran out of budget mid-call. Emitting the fragment as text would put a partial
  // tool call in the transcript and teach the next round that it succeeded.
  const events = scanToolCalls('working on it <tool_call>{"name":"read_file","argum');
  assert.equal(textOf(events), "working on it ");
  const bad = events.find((e) => e.kind === "malformed");
  assert.ok(bad);
  assert.match(bad.kind === "malformed" ? bad.error.reason : "", /cut off/);
});

test("an UNKNOWN tool name still parses as a call — the loop is what refuses it", () => {
  // Swallowing it here would leave the model with no feedback and it would repeat itself.
  // The loop already answers an unexposed tool with a `blocked` event the model can re-plan on.
  const calls = parseToolCalls(
    '<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>',
  );
  assert.equal(calls[0]?.name, "delete_everything");
});

test("args that are an array or a scalar are malformed, not coerced", () => {
  for (const bad of ['"hello"', "[1,2]", "42"]) {
    const events = scanToolCalls(`<tool_call>{"name":"read_file","arguments":${bad}}</tool_call>`);
    assert.equal(
      events.some((e) => e.kind === "call"),
      false,
      `arguments ${bad} was accepted`,
    );
  }
});

/* ── streaming ───────────────────────────────────────────────────────────────*/

/** Feed `src` one character at a time — the worst case a real SSE stream can produce. */
function streamByChar(src: string): ReturnType<typeof scanToolCalls> {
  const scanner = new ToolCallScanner();
  const out: ReturnType<typeof scanToolCalls> = [];
  for (const ch of src) out.push(...scanner.push(ch));
  out.push(...scanner.end());
  return out;
}

test("a call split across every possible boundary still parses exactly once", () => {
  const src =
    'Reading.\n<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>\nDone.';
  const events = streamByChar(src);
  const calls = events.filter((e) => e.kind === "call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind === "call" ? calls[0].call.name : "", "read_file");
  assert.equal(textOf(events), "Reading.\n\nDone.");
});

test("the leading bytes of a call are never emitted as prose", () => {
  // The bug this prevents: the user watches `<tool_ca` appear in the transcript, then it
  // disappears when the rest arrives. Held-back bytes must never be shown at all.
  const scanner = new ToolCallScanner();
  const shown = scanner
    .push("ok <tool_ca")
    .filter((e) => e.kind === "text")
    .map((e) => (e.kind === "text" ? e.text : ""))
    .join("");
  assert.equal(shown, "ok ");
});

test("chunk-by-chunk and one-shot agree on every corpus entry", () => {
  const CORPUS = [
    '<tool_call>{"name":"git_status"}</tool_call>',
    'a<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>b',
    '[TOOL_CALLS] [{"name":"which","arguments":{"program":"go"}}]',
    '```\n<tool_call>{"name":"x"}</tool_call>\n```',
    "no calls here at all",
    '```tool_call\n{"name":"git_diff","arguments":{}}\n```',
    '<function=grep>{"pattern":"TODO"}</function>',
    "trailing fence ```",
  ];
  for (const src of CORPUS) {
    const oneShot = scanToolCalls(src);
    const streamed = streamByChar(src);
    assert.deepEqual(
      streamed.filter((e) => e.kind === "call"),
      oneShot.filter((e) => e.kind === "call"),
      `calls differed when streamed: ${src}`,
    );
    assert.equal(textOf(streamed), textOf(oneShot), `text differed when streamed: ${src}`);
  }
});

test("text is preserved byte-for-byte when there are no calls", () => {
  for (const src of ["plain", "back``tick", "a ``` b ``` c", "<not_a_tool>", "[TOOL", "<|py"]) {
    assert.equal(textOf(scanToolCalls(src)), src, `mangled: ${JSON.stringify(src)}`);
    assert.equal(textOf(streamByChar(src)), src, `mangled when streamed: ${JSON.stringify(src)}`);
  }
});

/* ── the JSON scanner itself ─────────────────────────────────────────────────*/

test("balanced scanning ignores braces inside strings and escaped quotes", () => {
  const s = '{"a":"}{\\"","b":{"c":1}}  trailing';
  const r = scanJsonValue(s, 0);
  assert.ok(r.ok);
  assert.equal(s.slice(0, r.ok ? r.end : 0), '{"a":"}{\\"","b":{"c":1}}');
});

test("an unfinished value is `incomplete`, a non-value is `invalid`", () => {
  assert.deepEqual(scanJsonValue('{"a":', 0), { ok: false, why: "incomplete" });
  assert.deepEqual(scanJsonValue("hello", 0), { ok: false, why: "invalid" });
  assert.deepEqual(scanJsonValue("   ", 0), { ok: false, why: "incomplete" });
});

/* ── the XML attribute form (found by a real model, not by imagination) ──────*/

test("gemma's `<tool_call name=… arguments={…}/>` form parses", () => {
  // The exact bytes a real gemma4:12b produced when asked to read a file. Note the UNQUOTED
  // JSON attribute value, which is not valid XML and is what it emits anyway.
  const calls = parseToolCalls('<tool_call name="list_dir" arguments={"path": "."}/>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "list_dir");
  assert.deepEqual(calls[0]?.args, { path: "." });
  assert.equal(calls[0]?.dialect, "tool_call_attrs");
});

test("the attribute form accepts a QUOTED json value too", () => {
  for (const attr of [
    `arguments='{"path":"a.ts"}'`,
    'arguments="{\\"path\\":\\"a.ts\\"}"',
    'arguments={"path":"a.ts"}',
  ]) {
    const calls = parseToolCalls(`<tool_call name="read_file" ${attr}/>`);
    assert.deepEqual(calls[0]?.args, { path: "a.ts" }, `failed on ${attr}`);
  }
});

test("a non-self-closed attribute tag with a closer still parses once", () => {
  const calls = parseToolCalls('<tool_call name="git_status" arguments={}></tool_call>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "git_status");
});

test("an attribute tag with no arguments is a no-argument call", () => {
  assert.deepEqual(parseToolCalls('<tool_call name="git_status"/>')[0]?.args, {});
});

test("`<function name=… arguments=…/>` parses the same way", () => {
  const calls = parseToolCalls('<function name="which" arguments={"name":"node"}/>');
  assert.equal(calls[0]?.name, "which");
  assert.deepEqual(calls[0]?.args, { name: "node" });
});

test("the plain `<tool_call>` form still wins over the attribute form", () => {
  // `<tool_call` prefixes `<tool_call>`, so marker order is load-bearing here.
  const calls = parseToolCalls('<tool_call>{"name":"git_status"}</tool_call>');
  assert.equal(calls[0]?.dialect, "tool_call_tag");
  assert.equal(calls[0]?.name, "git_status");
});

test("prose mentioning `<tool_calls>` is not mistaken for an attribute call", () => {
  const src = "The <tool_calls> field holds them.";
  assert.equal(hasTextToolCall(src), false);
  assert.equal(textOf(scanToolCalls(src)), src);
});

test("an attribute call inside an ordinary fence stays inert", () => {
  const src = '```\n<tool_call name="run_command" arguments={"command":"rm -rf /"}/>\n```';
  assert.equal(hasTextToolCall(src), false);
  assert.equal(textOf(scanToolCalls(src)), src);
});

test("the attribute form survives being streamed one character at a time", () => {
  const src = 'Looking.\n<tool_call name="read_file" arguments={"path":"a.ts"}/>\nDone.';
  const events = streamByChar(src);
  const calls = events.filter((e) => e.kind === "call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind === "call" ? calls[0].call.name : "", "read_file");
  assert.equal(textOf(events), "Looking.\n\nDone.");
});

test("a truncated attribute call is malformed, not flushed as prose", () => {
  const events = scanToolCalls('<tool_call name="read_file" arguments={"pa');
  assert.equal(
    events.some((e) => e.kind === "call"),
    false,
  );
  assert.ok(events.some((e) => e.kind === "malformed"));
});

/* ── the NUMBERED tag (also found by gemma4:12b, not by imagination) ─────────*/

test("gemma's numbered `<tool_call1>` tag parses", () => {
  // Verbatim from a live gemma4:12b. A literal `<tool_call>` match rejects this as prose and
  // the only call in the turn is lost.
  const calls = parseToolCalls('<tool_call1>{"name":"list_dir", "arguments":{}}</tool_call1>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "list_dir");
  assert.deepEqual(calls[0]?.args, {});
});

test("the numbered closer is consumed, not left in the transcript", () => {
  const events = scanToolCalls('a<tool_call2>{"name":"git_status"}</tool_call2>b');
  assert.equal(textOf(events), "ab");
});

test("several numbered calls in one reply all parse", () => {
  const calls = parseToolCalls(
    '<tool_call1>{"name":"list_dir","arguments":{"path":"."}}</tool_call1>\n' +
      '<tool_call2>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call2>',
  );
  assert.deepEqual(
    calls.map((c) => c.name),
    ["list_dir", "read_file"],
  );
});

test("a numbered tag survives being streamed one character at a time", () => {
  const src = 'ok\n<tool_call1>{"name":"git_status","arguments":{}}</tool_call1>\ndone';
  const events = streamByChar(src);
  assert.equal(events.filter((e) => e.kind === "call").length, 1);
  assert.equal(textOf(events), "ok\n\ndone");
});

test("a numbered ATTRIBUTE tag parses too", () => {
  const calls = parseToolCalls('<tool_call1 name="read_file" arguments={"path":"a.ts"}/>');
  assert.equal(calls[0]?.name, "read_file");
  assert.deepEqual(calls[0]?.args, { path: "a.ts" });
});

test("a numbered call inside an ordinary fence is still inert", () => {
  const src =
    '```\n<tool_call1>{"name":"run_command","arguments":{"command":"rm -rf /"}}</tool_call1>\n```';
  assert.equal(hasTextToolCall(src), false);
  assert.equal(textOf(scanToolCalls(src)), src);
});

/* ── orphan closers ──────────────────────────────────────────────────────────*/

test("a stray `</tool_call>` with no opener is swallowed, not shown to the user", () => {
  // The live gemma4 run opened a turn with exactly this, and it read as `</tool_call>The
  // numeric value of answer is 42.` in the transcript.
  assert.equal(textOf(scanToolCalls("</tool_call>The answer is 42.")), "The answer is 42.");
  assert.equal(textOf(scanToolCalls("done</tool_call1>")), "done");
  assert.equal(textOf(scanToolCalls("a</function>b")), "ab");
});

test("an orphan closer is swallowed when streamed one character at a time", () => {
  assert.equal(textOf(streamByChar("</tool_call>The answer is 42.")), "The answer is 42.");
});

test("an orphan closer inside a code fence is PRESERVED — it is an illustration there", () => {
  const src = "```\n</tool_call>\n```";
  assert.equal(textOf(scanToolCalls(src)), src);
});

test("`</tool_calls>` in prose is left alone", () => {
  const src = "The </tool_calls> spelling is wrong.";
  assert.equal(textOf(scanToolCalls(src)), src);
});

test("a normal call's own closer is still consumed exactly once", () => {
  const events = scanToolCalls('x<tool_call>{"name":"git_status"}</tool_call>y');
  assert.equal(events.filter((e) => e.kind === "call").length, 1);
  assert.equal(textOf(events), "xy");
});

test("a stray extra brace before the tag close is tolerated", () => {
  // Verbatim from a live gemma4:12b asked to edit a file. One `}` too many, and everything
  // else perfectly readable — rejecting it lost the only call in the turn.
  const calls = parseToolCalls('<tool_call name="read_file" arguments={"path": "answer.ts"}}>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "read_file");
  assert.deepEqual(calls[0]?.args, { path: "answer.ts" });
});

test("stray punctuation tolerance does NOT swallow a real attribute", () => {
  const calls = parseToolCalls('<tool_call name="write_file", arguments={"path":"a.ts"}/>');
  assert.deepEqual(calls[0]?.args, { path: "a.ts" });
  assert.equal(calls[0]?.name, "write_file");
});

test("tolerance is bounded — genuine garbage is still rejected", () => {
  // Skipping unknown input is how a parser starts inventing calls.
  const src = '<tool_call name="read_file" !!!bogus!!! />';
  assert.equal(hasTextToolCall(src), false);
});

test("the stray-brace form survives streaming", () => {
  const src = '<tool_call name="read_file" arguments={"path": "answer.ts"}}>';
  assert.equal(streamByChar(src).filter((e) => e.kind === "call").length, 1);
});

/* ── inline code spans (single/double backtick) ──────────────────────────────*/

test("a call inside a SINGLE-backtick inline code span does NOT fire", () => {
  // The natural way to show the syntax in one sentence — and, before this test, a real way
  // to sneak an unconfirmed call past the reader: only ``` fences were tracked.
  const src = 'Like this: `<tool_call>{"name":"ls"}</tool_call>` — try it.';
  const events = scanToolCalls(src);
  assert.equal(
    events.some((e) => e.kind === "call"),
    false,
    "a call inside single-backtick inline code fired",
  );
  assert.equal(textOf(events), src);
});

test("a call inside a DOUBLE-backtick inline code span does NOT fire", () => {
  const src = 'Like this: ``<tool_call>{"name":"ls"}</tool_call>`` — try it.';
  assert.equal(hasTextToolCall(src), false);
  assert.equal(textOf(scanToolCalls(src)), src);
});

test("inline code span suppression survives streaming one character at a time", () => {
  const src = 'Like this: `<tool_call>{"name":"ls"}</tool_call>` — try it.';
  const events = streamByChar(src);
  assert.equal(
    events.some((e) => e.kind === "call"),
    false,
  );
  assert.equal(textOf(events), src);
});

test("a call AFTER a closed inline code span fires normally", () => {
  const events = scanToolCalls(
    'Example: `<tool_call>{"name":"ls"}</tool_call>` and now for real: ' +
      '<tool_call>{"name":"git_status"}</tool_call>',
  );
  assert.deepEqual(
    events.filter((e) => e.kind === "call").map((e) => (e.kind === "call" ? e.call.name : "")),
    ["git_status"],
  );
});

test("a lone backtick used as a plain apostrophe-like mark doesn't wreck the rest of the text", () => {
  // No real closing backtick ever arrives — the span just runs to the end of the message.
  // The content must still come through byte-for-byte; it just never un-suppresses.
  const src = "It`s fine, no tool call follows.";
  assert.equal(textOf(scanToolCalls(src)), src);
});

/* ── orphan closers are recorded, not merely dropped ─────────────────────────*/

test("a swallowed orphan closer is reported as a malformed event, not silently discarded", () => {
  const events = scanToolCalls("</tool_call>The answer is 42.");
  assert.equal(textOf(events), "The answer is 42.");
  const malformed = events.filter((e) => e.kind === "malformed");
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0]?.kind === "malformed" ? malformed[0].error.raw : "", "</tool_call>");
});

/* ── streaming performance: a large body must not be rescanned from scratch ──*/

test("a large call body streamed in small chunks parses correctly and fast (no O(n²) rescans)", () => {
  const content = "x".repeat(300_000);
  const src = `<tool_call>{"name":"write_file","arguments":{"path":"a.txt","content":"${content}"}}</tool_call>`;
  const scanner = new ToolCallScanner();
  const events: ScanEvent[] = [];
  const started = process.hrtime.bigint();
  for (let i = 0; i < src.length; i += 64) {
    events.push(...scanner.push(src.slice(i, i + 64)));
  }
  events.push(...scanner.end());
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

  const calls = events.filter((e) => e.kind === "call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind === "call" ? calls[0].call.name : "", "write_file");
  assert.equal(
    calls[0]?.kind === "call" ? (calls[0].call.args.content as string).length : -1,
    300_000,
  );
  assert.ok(
    elapsedMs < 2000,
    `streaming a 300KB call body in 64-byte chunks took ${elapsedMs}ms — the scanner is rescanning from scratch again`,
  );
});
