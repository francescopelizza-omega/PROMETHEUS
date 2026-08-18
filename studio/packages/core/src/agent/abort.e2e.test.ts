/**
 * agent/abort.e2e.test.ts — ESC actually stops things.
 *
 * Both CLI hosts have minted a per-turn `AbortController` since CLI-002 and both trip it on the
 * interrupt key. It reached exactly ONE consumer: the SSE stream. So the observable behaviour of
 * pressing ESC was that the tokens stopped arriving and the agent kept working — another round,
 * another model call, more tools, and a `run_command` child that ran to completion after the
 * turn the user had cancelled was over.
 *
 * These tests assert the three consequences, not the wiring:
 *   1. a cancel between rounds means NO further model call,
 *   2. a cancel inside a round means the REST of that round's tool calls do not run,
 *   3. a cancel during a `run_command` KILLS THE CHILD (a real process, really killed).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type AgentTuning,
  type LLMClient,
  type LlmTurn,
  type Thread,
  type ToolCall,
  type ToolOutcome,
  defaultTuning,
  runAgentTurn,
} from "./loop.js";
import { HOST_DISPATCH_TOOLS } from "./system/host-dispatch.js";
import { runSystemTool } from "./system/host/system-tools.js";
import type { ToolDef } from "./tools.js";

function tuningFor(overrides: Partial<AgentTuning> = {}): AgentTuning {
  return {
    ...defaultTuning({ provider: "local", name: "test" } as AgentTuning["model"]),
    tools: { enabled: true, allow: [], deny: [], extra: [...HOST_DISPATCH_TOOLS] },
    yes: true,
    maxRounds: 8,
    ...overrides,
  };
}

const call = (name: string, args: Record<string, unknown>, id: string): ToolCall => ({
  name: name as ToolCall["name"],
  args,
  id,
});

async function drain(it: AsyncIterable<unknown>): Promise<{ kind: string; reason?: string }[]> {
  const out: { kind: string; reason?: string }[] = [];
  for await (const e of it) out.push(e as { kind: string; reason?: string });
  return out;
}

test("a cancel BETWEEN rounds stops the loop — the model is not called again", async () => {
  const ac = new AbortController();
  let modelCalls = 0;
  const llm: LLMClient = {
    turn(): AsyncIterable<LlmTurn> {
      modelCalls++;
      return (async function* () {
        yield { kind: "tool_call", call: call("list_dir", { path: "." }, `c${modelCalls}`) };
      })();
    },
  };
  let toolRuns = 0;
  const runTool = async (): Promise<ToolOutcome> => {
    toolRuns++;
    // the human presses ESC while the first tool is running
    ac.abort();
    return { ok: true, summary: "ok" };
  };

  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  const events = await drain(
    runAgentTurn(thread, tuningFor(), { llm, runTool, signal: ac.signal }),
  );

  // Round 1 ran (the abort landed during its tool). Round 2 must never have started.
  assert.equal(modelCalls, 1, "the model was called again after the turn was cancelled");
  assert.equal(toolRuns, 1);
  // and the user is TOLD why it stopped
  assert.ok(
    events.some((e) => e.kind === "blocked" && /cancelled/i.test(e.reason ?? "")),
    "the cancel was silent — no blocked event explains why the agent stopped",
  );
  // a cancel is not a pause: offering /continue would resume what was cancelled
  assert.ok(!events.some((e) => e.kind === "capped"), "a cancelled turn must not report capped");
});

test("a cancel MID-ROUND stops the remaining tool calls in that same round", async () => {
  const ac = new AbortController();
  const ran: string[] = [];
  const llm: LLMClient = {
    turn(): AsyncIterable<LlmTurn> {
      return (async function* () {
        // one round, three calls — the user cancels after the first
        yield { kind: "tool_call", call: call("list_dir", { path: "a" }, "1") };
        yield { kind: "tool_call", call: call("list_dir", { path: "b" }, "2") };
        yield { kind: "tool_call", call: call("list_dir", { path: "c" }, "3") };
      })();
    },
  };
  const runTool = async (_t: ToolDef, args: Record<string, unknown>): Promise<ToolOutcome> => {
    ran.push(String(args.path));
    ac.abort();
    return { ok: true, summary: "ok" };
  };

  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  await drain(runAgentTurn(thread, tuningFor(), { llm, runTool, signal: ac.signal }));

  assert.deepEqual(
    ran,
    ["a"],
    "the rest of the round ran after the user cancelled — ESC refused one call, not the batch",
  );
});

test("an ALREADY-aborted signal runs nothing at all", async () => {
  const ac = new AbortController();
  ac.abort();
  let modelCalls = 0;
  const llm: LLMClient = {
    turn(): AsyncIterable<LlmTurn> {
      modelCalls++;
      return (async function* () {
        yield { kind: "final", text: "hi" };
      })();
    },
  };
  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  await drain(
    runAgentTurn(thread, tuningFor(), {
      llm,
      runTool: async () => ({ ok: true, summary: "" }),
      signal: ac.signal,
    }),
  );
  assert.equal(modelCalls, 0, "a turn cancelled before it began still called the model");
});

test("no signal ⇒ nothing changes: the loop runs to completion as before", async () => {
  let modelCalls = 0;
  const llm: LLMClient = {
    turn(): AsyncIterable<LlmTurn> {
      modelCalls++;
      return (async function* () {
        if (modelCalls === 1) {
          yield { kind: "tool_call", call: call("list_dir", { path: "." }, "1") };
        } else {
          yield { kind: "final", text: "done" };
        }
      })();
    },
  };
  const thread: Thread = { messages: [{ role: "user", content: "go" }] };
  const events = await drain(
    runAgentTurn(thread, tuningFor(), {
      llm,
      runTool: async () => ({ ok: true, summary: "ok" }),
    }),
  );
  assert.equal(modelCalls, 2);
  assert.ok(!events.some((e) => e.kind === "blocked"));
});

test("a cancel KILLS a running run_command child — measured against the uncancelled baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prom-abort-"));
  try {
    // BASELINE: how long the command really takes when nobody cancels it. Asserting an
    // absolute number would pass on a machine where the command was refused outright and never
    // ran at all — which is exactly how the first version of this test fooled me. The
    // comparison is the evidence.
    const t0 = Date.now();
    const baseline = await runSystemTool(
      "run_command",
      { command: "sleep 3", timeoutSeconds: 30 },
      { cwd: dir, roots: [dir] },
    );
    const baselineMs = Date.now() - t0;
    assert.ok(baseline?.ok, `the baseline command did not run: ${baseline?.summary}`);
    assert.ok(baselineMs > 2500, `the baseline finished in ${baselineMs}ms — it never slept`);

    // CANCELLED: the same command, interrupted a quarter of a second in.
    const ac = new AbortController();
    const t1 = Date.now();
    const promise = runSystemTool(
      "run_command",
      { command: "sleep 3", timeoutSeconds: 30 },
      { cwd: dir, roots: [dir], signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 250);
    const out = await promise;
    const cancelledMs = Date.now() - t1;

    assert.ok(
      cancelledMs < baselineMs / 2,
      `cancelled run took ${cancelledMs}ms vs a ${baselineMs}ms baseline — the abort never reached the child`,
    );
    assert.ok(out !== null);
    // …and the model is TOLD it was cancelled, rather than being handed `exit 0`.
    assert.equal(out.ok, false, "a cancelled command reported success");
    assert.match(out.summary, /CANCELLED/);
    assert.equal((out.data as { exitCode: number }).exitCode, 130);
    assert.equal((out.data as { aborted: boolean }).aborted, true);
    assert.equal(
      (out.data as { timedOut: boolean }).timedOut,
      false,
      "a cancel is not a timeout — they are different facts and lead to different next moves",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancelled `a && b` never runs b — the chain stops where the user stopped it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prom-chain-"));
  const victim = join(dir, "IMPORTANT.txt");
  try {
    writeFileSync(victim, "do not delete me\n", "utf8");
    const out = await runSystemTool(
      "run_command",
      { command: `sleep 3 && rm ${victim}`, timeoutSeconds: 30 },
      { cwd: dir, roots: [dir], signal: AbortSignal.timeout(250) },
    );
    assert.equal(out?.ok, false);
    // Give the second half every chance to fire late.
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(
      existsSync(victim),
      true,
      "cancelling during the first half of the chain still ran the destructive second half",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
