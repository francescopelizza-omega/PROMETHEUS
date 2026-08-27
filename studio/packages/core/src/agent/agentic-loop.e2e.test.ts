/**
 * agent/agentic-loop.e2e.test.ts — the one thing that makes this an AGENTIC CLI, tested.
 *
 * Every other test in this repo drives one half of the loop. `loop.test.ts` drives the round
 * machinery against a fake `runTool`; `system-tools.test.ts` drives the real tools against no
 * loop at all. Neither covers the property the whole product rests on:
 *
 *   the model asks for a tool → the REAL dispatcher runs it against a REAL filesystem →
 *   the result lands in the thread → the model READS it on the next round and answers from it.
 *
 * A loop that runs a tool and then hands the model a thread the result never reached still
 * passes both of those suites. It fails here, which is the point: these tests assert the
 * CONSEQUENCE (the second round saw the bytes) rather than the arm (`runTool` was called).
 *
 * The model is scripted rather than real — a test that needs a GPU is a test nobody runs — but
 * everything below it is production code: `runAgentTurn`, `runSystemTool`, the broker, the
 * confirm seam, node's `fs`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A temp repo, cleaned up by the caller. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "prom-e2e-"));
  writeFileSync(join(dir, "answer.txt"), "the magic number is 4711\n", "utf8");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "b.ts"), "export const b = 2;\n", "utf8");
  return dir;
}

/**
 * A model whose script is a FUNCTION OF THE THREAD, not a fixed list.
 *
 * That distinction is the test. A fixed list of turns would emit round 2's answer whether or
 * not round 1's result ever arrived — so the loop could drop every tool result on the floor and
 * the suite would stay green. This one reads the thread it is handed and can only answer
 * correctly if the result is actually in there.
 */
function scriptedModel(
  script: (thread: Thread, round: number) => LlmTurn[],
): LLMClient & { rounds: number; seen: Thread[] } {
  const state = {
    rounds: 0,
    seen: [] as Thread[],
    turn(thread: Thread, _tuning: AgentTuning, _tools: ToolDef[]): AsyncIterable<LlmTurn> {
      // snapshot: the loop mutates `thread.messages` in place between rounds.
      const snapshot: Thread = { messages: thread.messages.map((m) => ({ ...m })) };
      state.seen.push(snapshot);
      const turns = script(snapshot, state.rounds);
      state.rounds++;
      return (async function* () {
        for (const t of turns) yield t;
      })();
    },
  };
  return state;
}

/** The REAL host dispatcher, pointed at a real directory. */
function realRunner(cwd: string) {
  const calls: string[] = [];
  const runTool = async (tool: ToolDef, args: Record<string, unknown>): Promise<ToolOutcome> => {
    calls.push(tool.name);
    const out = await runSystemTool(tool.name, args, { cwd, roots: [cwd] });
    if (out === null) return { ok: false, summary: `no host dispatch for ${tool.name}` };
    return out;
  };
  return { runTool, calls };
}

function tuningFor(overrides: Partial<AgentTuning> = {}): AgentTuning {
  const base = defaultTuning({ provider: "local", name: "test" } as AgentTuning["model"]);
  return {
    ...base,
    /**
     * The host tool set, wired the way a real session wires it.
     *
     * `defaultTuning` exposes only the CATALOG (the prometheus verbs + the in-renderer
     * editors). `read_file`, `list_dir` and `run_command` reach a model exclusively through
     * `policy.extra`, which every host fills from `HOST_DISPATCH_TOOLS`. A test that forgot
     * this would be driving a loop with no reads in it and calling that an agentic turn.
     */
    tools: { enabled: true, allow: [], deny: [], extra: [...HOST_DISPATCH_TOOLS] },
    // `yes` lifts reads past the confirm seam exactly as an ordinary session at the default
    // authorisation level does.
    yes: true,
    maxRounds: 6,
    ...overrides,
  };
}

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const call = (name: string, args: Record<string, unknown>, id = "c1"): ToolCall => ({
  name: name as ToolCall["name"],
  args,
  id,
});

test("two rounds: the model reads a REAL file and answers from bytes it did not have in round 1", async () => {
  const dir = fixture();
  try {
    const { runTool, calls } = realRunner(dir);
    /** what round 2 was actually able to see — captured, not assumed. */
    let roundTwoSawTheBytes = false;
    const llm = scriptedModel((thread, round) => {
      if (round === 0) {
        // Round 1: the model has NOT seen the file. It cannot know the number.
        const priorText = thread.messages.map((m) => m.content).join("\n");
        assert.ok(
          !priorText.includes("4711"),
          "round 1 must not already contain the answer — the fixture would be testing nothing",
        );
        return [{ kind: "tool_call", call: call("read_file", { path: "answer.txt" }) }];
      }
      // Round 2: the ONLY way to answer is from the tool result the loop folded in.
      const toolMsgs = thread.messages.filter((m) => m.role === "tool");
      roundTwoSawTheBytes = toolMsgs.some((m) => m.content.includes("4711"));
      const number = /(\d{4})/.exec(toolMsgs.map((m) => m.content).join(""))?.[1] ?? "NOTHING";
      return [{ kind: "final", text: `the number is ${number}` }];
    });

    const thread: Thread = {
      messages: [{ role: "user", content: "what is the magic number in answer.txt?" }],
    };
    const events = (await drain(runAgentTurn(thread, tuningFor(), { llm, runTool }))) as {
      kind: string;
      text?: string;
    }[];

    // the arm: the real dispatcher ran the real tool
    assert.deepEqual(calls, ["read_file"]);
    // the CONSEQUENCE: round 2's thread carried the bytes read off disk
    assert.equal(roundTwoSawTheBytes, true, "round 2 never saw the tool result");
    assert.equal(llm.rounds, 2, "the loop did not run a second round");
    // and the answer the user gets is derived from them
    const finalText = events
      .filter((e) => e.kind === "text" || e.kind === "final")
      .map((e) => e.text ?? "")
      .join("");
    assert.match(finalText, /4711/);
    // the terminal answer is folded into the thread, so `/resume` and compaction can see it
    const assistant = thread.messages.filter((m) => m.role === "assistant");
    assert.ok(
      assistant.some((m) => m.content.includes("4711")),
      "the final answer was not folded into the thread",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("three rounds: each round's result is visible to the NEXT one, cumulatively", async () => {
  const dir = fixture();
  try {
    const { runTool, calls } = realRunner(dir);
    /** how many distinct tool results each round could see. */
    const visible: number[] = [];
    const llm = scriptedModel((thread, round) => {
      visible.push(thread.messages.filter((m) => m.role === "tool").length);
      if (round === 0)
        return [{ kind: "tool_call", call: call("read_file", { path: "a.ts" }, "1") }];
      if (round === 1) {
        return [{ kind: "tool_call", call: call("read_file", { path: "sub/b.ts" }, "2") }];
      }
      const joined = thread.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content)
        .join("\n");
      return [
        {
          kind: "final",
          text: `a=${/const a = (\d)/.exec(joined)?.[1] ?? "?"} b=${/const b = (\d)/.exec(joined)?.[1] ?? "?"}`,
        },
      ];
    });

    const thread: Thread = { messages: [{ role: "user", content: "read both files" }] };
    const events = (await drain(runAgentTurn(thread, tuningFor(), { llm, runTool }))) as {
      kind: string;
      text?: string;
    }[];

    assert.deepEqual(calls, ["read_file", "read_file"]);
    // round 1 saw 0 results, round 2 saw 1, round 3 saw 2 — results ACCUMULATE.
    assert.deepEqual(visible, [0, 1, 2]);
    const finalText = events
      .filter((e) => e.kind === "text" || e.kind === "final")
      .map((e) => e.text ?? "")
      .join("");
    assert.match(finalText, /a=1 b=2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool FAILURE reaches the next round as a result the model can recover from", async () => {
  const dir = fixture();
  try {
    const { runTool, calls } = realRunner(dir);
    let sawFailure = false;
    const llm = scriptedModel((thread, round) => {
      if (round === 0) {
        return [{ kind: "tool_call", call: call("read_file", { path: "does-not-exist.txt" }) }];
      }
      const toolText = thread.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content)
        .join("\n");
      sawFailure = /"ok":\s*false|not found|no such|ENOENT|cannot/i.test(toolText);
      if (round === 1) {
        // recover: read the file that DOES exist
        return [{ kind: "tool_call", call: call("read_file", { path: "answer.txt" }, "c2") }];
      }
      return [{ kind: "final", text: toolText.includes("4711") ? "recovered: 4711" : "stuck" }];
    });

    const thread: Thread = { messages: [{ role: "user", content: "read the answer" }] };
    const events = (await drain(runAgentTurn(thread, tuningFor(), { llm, runTool }))) as {
      kind: string;
      text?: string;
    }[];

    assert.deepEqual(calls, ["read_file", "read_file"]);
    assert.equal(sawFailure, true, "the failure never reached the model — it cannot re-plan");
    const finalText = events
      .filter((e) => e.kind === "text" || e.kind === "final")
      .map((e) => e.text ?? "")
      .join("");
    assert.match(finalText, /recovered: 4711/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a WRITE through the real dispatcher lands on disk and its effect is readable next round", async () => {
  const dir = fixture();
  try {
    const { runTool, calls } = realRunner(dir);
    const target = join(dir, "made.txt");
    let roundThreeSawTheWrittenBytes = false;
    const llm = scriptedModel((thread, round) => {
      if (round === 0) {
        return [
          {
            kind: "tool_call",
            call: call("run_command", { command: `printf 'written-by-the-agent\\n' > made.txt` }),
          },
        ];
      }
      if (round === 1) {
        return [{ kind: "tool_call", call: call("read_file", { path: "made.txt" }, "c2") }];
      }
      const toolText = thread.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content)
        .join("\n");
      roundThreeSawTheWrittenBytes = toolText.includes("written-by-the-agent");
      return [{ kind: "final", text: "done" }];
    });

    const thread: Thread = { messages: [{ role: "user", content: "make a file then read it" }] };
    /**
     * An explicitly APPROVING human.
     *
     * `yes: true` lifts reads past the confirm seam; it does not lift `run_command`, which is
     * `destructiveHint` and therefore always reaches a human. Omitting `confirm` here made the
     * command silently denied and the write never happened — which is the safety stack working,
     * and is covered by the deny test below. This test is about what happens AFTER a human says
     * yes, so it says yes.
     */
    const approvals: string[] = [];
    await drain(
      runAgentTurn(thread, tuningFor({ yes: true, gateMode: "off" }), {
        llm,
        runTool,
        confirm: (c) => {
          approvals.push(c.name);
          return true;
        },
      }),
    );
    // the seam was consulted for the mutation and NOT for the read (`yes` already covered it)
    assert.deepEqual(approvals, ["run_command"]);

    // The full chain, asserted end to end: the agent's command MUTATED THE DISK, and the
    // mutation came back to it as readable bytes on a later round. Anything softer than this
    // (an `if (exists)` guard) is a test that passes when the whole thing is broken.
    assert.deepEqual(calls, ["run_command", "read_file"]);
    assert.match(readFileSync(target, "utf8"), /written-by-the-agent/);
    assert.equal(
      roundThreeSawTheWrittenBytes,
      true,
      "the file was written but its contents never reached the model",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a DENIED call still produces a result the model can read — it is not silence", async () => {
  const dir = fixture();
  try {
    const { runTool, calls } = realRunner(dir);
    let sawDenial = false;
    const llm = scriptedModel((thread, round) => {
      if (round === 0) return [{ kind: "tool_call", call: call("read_file", { path: "a.ts" }) }];
      const toolText = thread.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content)
        .join("\n");
      sawDenial = /denied|not permitted|rejected|no reason/i.test(toolText);
      return [{ kind: "final", text: "understood" }];
    });

    const thread: Thread = { messages: [{ role: "user", content: "read a.ts" }] };
    await drain(
      runAgentTurn(thread, tuningFor({ yes: false }), {
        llm,
        runTool,
        confirm: () => ({ approved: false, reason: "the user said no" }),
      }),
    );

    // the tool never ran…
    assert.deepEqual(calls, []);
    // …and the model was TOLD so, on the next round, in the thread.
    assert.equal(sawDenial, true, "a denial reached the model as silence, not as a result");
    assert.equal(llm.rounds, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/dry-run on: a mutating tool is NOT executed — the real file survives the real dispatcher", async () => {
  // regression: `withDryRun` only INJECTED `dryRun:true` into the tool args, and no filesystem
  // tool declared the field, so it was ignored. With dry-run on, `delete_file` still deleted the
  // file and `mkdir` still created the directory — measured against this same real dispatcher.
  const dir = fixture();
  try {
    const { runTool, calls } = realRunner(dir);
    const victim = join(dir, "answer.txt");
    const llm = scriptedModel((_thread, round) =>
      round === 0
        ? [{ kind: "tool_call", call: call("delete_file", { path: victim }) }]
        : [{ kind: "final", text: "done" }],
    );
    const thread: Thread = { messages: [{ role: "user", content: "delete it" }] };
    await drain(
      runAgentTurn(thread, tuningFor({ dryRun: true }), { llm, runTool, confirm: () => true }),
    );

    assert.equal(readFileSync(victim, "utf8"), "the magic number is 4711\n");
    assert.deepEqual(calls, [], "the dispatcher must never be reached under dry-run");
    const toolMsgs = thread.messages.filter((m) => m.role === "tool");
    assert.ok(
      toolMsgs.some((m) => m.content.includes("dry-run")),
      `the model must be told it was a dry run, got: ${toolMsgs.map((m) => m.content).join(" | ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/dry-run on: READS still run — a preview the agent cannot look around in is useless", async () => {
  const dir = fixture();
  try {
    const { runTool, calls } = realRunner(dir);
    let sawBytes = false;
    const llm = scriptedModel((thread, round) => {
      if (round === 0)
        return [{ kind: "tool_call", call: call("read_file", { path: "answer.txt" }) }];
      sawBytes = thread.messages.some((m) => m.role === "tool" && m.content.includes("4711"));
      return [{ kind: "final", text: "ok" }];
    });
    const thread: Thread = { messages: [{ role: "user", content: "read it" }] };
    await drain(runAgentTurn(thread, tuningFor({ dryRun: true }), { llm, runTool }));
    assert.deepEqual(calls, ["read_file"]);
    assert.ok(sawBytes, "a read must still reach the model under dry-run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run OFF: the same mutation really happens — the guard does not disarm the tool", async () => {
  const dir = fixture();
  try {
    const { runTool, calls } = realRunner(dir);
    const victim = join(dir, "answer.txt");
    const llm = scriptedModel((_thread, round) =>
      round === 0
        ? [{ kind: "tool_call", call: call("delete_file", { path: victim }) }]
        : [{ kind: "final", text: "done" }],
    );
    const thread: Thread = { messages: [{ role: "user", content: "delete it" }] };
    await drain(
      runAgentTurn(thread, tuningFor({ dryRun: false }), { llm, runTool, confirm: () => true }),
    );
    assert.deepEqual(calls, ["delete_file"]);
    assert.throws(() => readFileSync(victim, "utf8"), "the real delete must still remove the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
