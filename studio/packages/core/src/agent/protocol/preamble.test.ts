/**
 * preamble.test.ts — the tool preamble and its budget ladder.
 *
 * The assertions that carry weight: the REAL catalog fits the default budget (a synthetic
 * three-tool fixture would prove nothing about ~38 tools), the ladder degrades in the stated
 * order rather than truncating mid-line, and a drop is always ADMITTED in the prompt text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PROMETHEUS_TOOLS } from "../../mcp/server/tools.js";
import { PROPOSE_EDIT_TOOL, WRITE_FILE_TOOL } from "../edit.js";
import { SYSTEM_TOOLS } from "../system/tools.js";
import type { ToolDef } from "../tools.js";
import { WEB_FETCH_TOOL } from "../web.js";
import {
  ACT_DONT_DESCRIBE,
  PREAMBLE_MAX_TOKENS,
  PREAMBLE_MIN_TOKENS,
  PREAMBLE_WINDOW_SHARE,
  TEXT_CALL_PROTOCOL,
  preambleBudget,
  renderField,
  renderSignature,
  renderToolPreamble,
  shortDescription,
  withToolPreamble,
} from "./preamble.js";

/** The whole exposed surface, as `exposedTools` would produce it for the CLI. */
const FULL: readonly ToolDef[] = [
  ...PROMETHEUS_TOOLS,
  ...SYSTEM_TOOLS,
  PROPOSE_EDIT_TOOL,
  WRITE_FILE_TOOL,
  WEB_FETCH_TOOL,
];

/* ── field and signature rendering ───────────────────────────────────────────*/

test("required is starred, optional is questioned", () => {
  assert.equal(renderField("path", { type: "string", required: true }), "path*: string");
  assert.equal(renderField("depth", { type: "number" }), "depth?: number");
});

test("an enum renders its VALUES — the whole point of it being an enum", () => {
  assert.equal(
    renderField("component", { type: "enum", enum: ["hooks", "mcp"], required: true }),
    'component*: "hooks"|"mcp"',
  );
});

test("a default is shown, including the falsy ones", () => {
  assert.equal(
    renderField("dryRun", { type: "boolean", default: false }),
    "dryRun?: boolean=false",
  );
  assert.equal(renderField("n", { type: "number", default: 0 }), "n?: number=0");
});

test("a no-argument tool renders as empty parentheses, not a bare name", () => {
  const tool = FULL.find((t) => t.name === "prometheus_scan");
  assert.ok(tool);
  assert.equal(renderSignature(tool), "prometheus_scan()");
});

test("required-only drops the optional arguments", () => {
  const readFile = FULL.find((t) => t.name === "read_file");
  assert.ok(readFile);
  const full = renderSignature(readFile);
  const req = renderSignature(readFile, true);
  assert.ok(full.length >= req.length);
  assert.equal(req.includes("?"), false, "an optional argument survived required-only");
});

test("a description is cut at a sentence, never mid-word", () => {
  const tool: ToolDef = {
    name: "t",
    title: "T",
    description: "Does the thing. And then a second sentence that should not appear.",
    schema: {},
    annotations: {},
    toArgv: () => [],
  };
  assert.equal(shortDescription(tool), "Does the thing.");
  const long = { ...tool, description: `${"word ".repeat(60)}end.` };
  const cut = shortDescription(long, 40);
  assert.ok(cut.length <= 40, `got ${cut.length} chars`);
  assert.ok(cut.endsWith("…"));
});

/* ── the budget ladder ───────────────────────────────────────────────────────*/

test("the REAL catalog fits the default budget", () => {
  // The number that decides whether this feature is affordable on an 8k local model.
  const r = renderToolPreamble(FULL, { mode: "text" });
  assert.ok(r.approxTokens <= 700, `preamble was ${r.approxTokens} tokens`);
  assert.deepEqual(r.omitted, [], "the real catalog had to drop tools at the default budget");
});

test("the ladder degrades in order as the budget tightens", () => {
  const seen = [1000, 400, 260, 150].map(
    (maxTokens) => renderToolPreamble(FULL, { mode: "text", maxTokens }).detail,
  );
  // Not asserting exact stage-per-budget (that would pin the catalog's byte count); asserting
  // it never degrades BACKWARDS as the budget shrinks.
  const ORDER = ["full", "signatures", "required-only", "names"];
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(
      ORDER.indexOf(seen[i] as string) >= ORDER.indexOf(seen[i - 1] as string),
      `budget shrank but detail improved: ${seen.join(" → ")}`,
    );
  }
});

test("every stage stays within its budget, or admits what it dropped", () => {
  for (const maxTokens of [800, 500, 300, 200, 120, 60, 30]) {
    const r = renderToolPreamble(FULL, { mode: "text", maxTokens });
    if (r.omitted.length > 0) {
      assert.match(
        r.text,
        /more tools? exist but did not fit/,
        `dropped ${r.omitted.length} tools silently at ${maxTokens}`,
      );
    } else {
      assert.ok(
        r.approxTokens <= maxTokens,
        `no drop but over budget: ${r.approxTokens} > ${maxTokens}`,
      );
    }
  }
});

test("the highest-value tools are the LAST to be dropped", () => {
  const r = renderToolPreamble(FULL, { mode: "text", maxTokens: 30 });
  assert.ok(r.omitted.length > 0, "nothing was dropped at an absurd budget");
  for (const keep of ["read_file", "list_dir", "grep", "propose_edit"]) {
    assert.equal(r.omitted.includes(keep), false, `${keep} was dropped before the registry verbs`);
    assert.match(r.text, new RegExp(keep));
  }
});

test("a drop never leaves the agent with nothing to call", () => {
  const r = renderToolPreamble(FULL, { mode: "text", maxTokens: 1 });
  assert.ok(r.text.includes("read_file"));
  assert.ok(r.omitted.length > 0);
});

/* ── modes ───────────────────────────────────────────────────────────────────*/

test("native mode does not pay a SECOND time for what `tools[]` already carries", () => {
  // The native transport sends name + FULL description + JSON Schema for every tool. A
  // preamble that repeats the signatures and a truncated copy of the descriptions is a
  // duplicate advertisement, charged on every request of every round of every turn.
  const native = renderToolPreamble(FULL, { mode: "native", contextWindow: 262_144 });
  const text = renderToolPreamble(FULL, { mode: "text", contextWindow: 262_144 });
  assert.ok(
    native.text.length * 3 < text.text.length,
    `native preamble is ${native.text.length} chars vs text ${text.text.length} — still duplicating`,
  );
  // The names stay: the priority ORDER is the one thing `tools[]` cannot express.
  assert.match(native.text, /read_file/);
  // …but the signatures do not.
  assert.equal(/read_file\(/.test(native.text), false, "signatures are duplicated from tools[]");
  // And the model is told WHERE the arguments are, or a bare list reads as "takes no args".
  assert.match(native.text, /tool schemas you already have/);
});

test("text mode teaches the call syntax; native mode does not", () => {
  const text = renderToolPreamble(FULL, { mode: "text" });
  const native = renderToolPreamble(FULL, { mode: "native" });
  assert.ok(text.text.includes("<tool_call>"), "the text protocol was not taught");
  assert.equal(
    native.text.includes("<tool_call>"),
    false,
    "native mode taught a syntax the endpoint already renders",
  );
  assert.ok(native.approxTokens < text.approxTokens);
});

test("both modes always carry the act-don't-describe rule", () => {
  // It survives every degrade stage because it is the rule that decides whether the turn
  // does anything at all.
  for (const mode of ["text", "native"] as const) {
    for (const maxTokens of [700, 100, 10]) {
      assert.ok(
        renderToolPreamble(FULL, { mode, maxTokens }).text.includes(ACT_DONT_DESCRIBE),
        `lost the rule at ${mode}/${maxTokens}`,
      );
    }
  }
});

test("the taught syntax is exactly what the parser reads back", async () => {
  // A preamble that teaches a shape the scanner cannot read is the worst possible bug here:
  // the model complies perfectly and nothing happens.
  const { parseToolCalls } = await import("./parse.js");
  const example = TEXT_CALL_PROTOCOL.split("\n").find((l) => l.startsWith("<tool_call>"));
  assert.ok(example, "the protocol no longer shows an example call");
  const concrete = example.replace("TOOL", "git_status").replace("{...}", "{}");
  assert.deepEqual(
    parseToolCalls(concrete).map((c) => c.name),
    ["git_status"],
  );
});

/* ── composition ─────────────────────────────────────────────────────────────*/

test("the host's own prompt comes first and is never trimmed", () => {
  // It carries the persona and any user-typed `/system` override; a preamble that displaced
  // it would silently undo a setting the user made.
  const host = "You are Prometheus. Always scan before installing.";
  const { prompt } = withToolPreamble(host, FULL, { mode: "text" });
  assert.ok(prompt.startsWith(host));
  assert.ok(prompt.includes("<tool_call>"));
});

test("an empty host prompt does not leave leading blank lines", () => {
  const { prompt } = withToolPreamble("   ", FULL, { mode: "native" });
  assert.equal(prompt, prompt.trimStart());
});

test("with no tools exposed the preamble still renders without crashing", () => {
  const r = renderToolPreamble([], { mode: "text" });
  assert.ok(r.text.includes(ACT_DONT_DESCRIBE));
  assert.deepEqual(r.omitted, []);
});

/* ── the budget is a share of the model's window, not a constant ────────────*/

/**
 * The budget was a flat 700 tokens — 8% of an 8192 window, sized for the smallest model in the
 * fleet and then applied to every model regardless. With the shipped 45-tool catalogue that
 * forces the ladder down to `signatures`, so NO tool description reaches the model: not "prefer
 * this over repeated propose_edit when a change spans files", not "send the WHOLE list every
 * time". Those lines are how a model decides WHICH tool to reach for, and they were being spent
 * away on a 262144-token model to save a fraction of a percent of its context.
 */

test("a bigger window buys more DETAIL, which is the whole point", () => {
  const small = renderToolPreamble(FULL, { mode: "text", contextWindow: 8192 });
  const big = renderToolPreamble(FULL, { mode: "text", contextWindow: 262144 });
  assert.ok(
    big.approxTokens >= small.approxTokens,
    "a larger window produced no more detail than a tiny one",
  );
});

test("the budget scales with the window, clamped at both ends", () => {
  assert.equal(preambleBudget(8192), PREAMBLE_MIN_TOKENS, "8% of 8192 is under the floor");
  assert.equal(preambleBudget(100_000), 8000 > PREAMBLE_MAX_TOKENS ? PREAMBLE_MAX_TOKENS : 8000);
  assert.equal(preambleBudget(262_144), PREAMBLE_MAX_TOKENS, "a huge window is still capped");
  assert.equal(preambleBudget(32_768), Math.floor(32_768 * PREAMBLE_WINDOW_SHARE));
});

test("an unknown window keeps the OLD budget exactly — no silent behaviour change", () => {
  // A caller that does not know the window must behave as it did before this existed.
  for (const w of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      preambleBudget(w as number | undefined),
      700,
      `changed behaviour for ${String(w)}`,
    );
  }
  const unset = renderToolPreamble(FULL, { mode: "text" });
  const legacy = renderToolPreamble(FULL, { mode: "text", maxTokens: 700 });
  assert.equal(unset.text, legacy.text);
});

test("an explicit maxTokens still wins over the window", () => {
  // A caller with its own reason keeps its override.
  const r = renderToolPreamble(FULL, { mode: "text", contextWindow: 262_144, maxTokens: 120 });
  assert.equal(r.detail, "names");
});

test("a tiny window still degrades — the floor is not a licence to overflow", () => {
  const r = renderToolPreamble(FULL, { mode: "text", contextWindow: 2048 });
  assert.ok(r.approxTokens <= PREAMBLE_MIN_TOKENS);
});
