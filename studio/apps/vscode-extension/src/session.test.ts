/**
 * session.test.ts — ChatSession's mid-turn cancellation, under plain node:test (no real VS Code
 * needed — the package's own `test:vscode` suite requires downloading a real VS Code build,
 * which this file deliberately avoids so cancellation logic gets fast, real, executed coverage
 * without that dependency).
 *
 * session.ts itself imports no `vscode` API directly, but it imports two constants from
 * `./tool-runner.js`, which imports a VALUE (`normalizeWorkspaceRelPath`) from
 * `./workspace-io.js`, which DOES `import * as vscode from "vscode"` at module scope (see its
 * own header: "the ONE seam between the agent's file tools and the editor's filesystem"). None
 * of that code path is ever CALLED by this test (the fakes below never touch the real tool
 * runner). Run this file via `test/register.mjs` (see its own header), which maps the bare
 * "vscode" specifier to an empty stub — it does not exist as an installed npm package outside
 * the real extension host, so plain Node resolution has nothing to find it with otherwise.
 *
 * Run with:
 *   node --import ./src/test/register.mjs --test src/session.test.ts   (from apps/vscode-extension)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ConfirmResult,
  LLMClient,
  LlmTurn,
  ToolCall,
  ToolOutcome,
} from "@prometheus/core/agent-loop";

const { ChatSession, vscodeTuning } = await import("./session.js");

/** Shaped like extension.spec.ts's own `scriptedLlm` (and the repo's `AgentPane.test.ts` twin):
 *  one script per round, the last entry repeats if the loop asks for more rounds than scripted. */
function scriptedLlm(rounds: LlmTurn[][]): LLMClient {
  let round = 0;
  return {
    async *turn() {
      const script = rounds[Math.min(round, rounds.length - 1)] ?? [{ kind: "final" as const }];
      round++;
      for (const t of script) yield t;
    },
  };
}

const TOOL_CALL: ToolCall = { id: "1", name: "list_dir", args: { path: "." } };
/** A WRITE call, so the authorisation ladder — not just `tuning.yes` — decides it. */
const WRITE_CALL: ToolCall = {
  id: "2",
  name: "write_file",
  args: { path: "src/new.ts", content: "x" },
};
/** The same write, aimed OUTSIDE the folder the user opened. */
const ESCAPING_WRITE: ToolCall = {
  id: "3",
  name: "write_file",
  args: { path: "/etc/passwd", content: "x" },
};

function collector(): {
  sinks: import("./session.js").SessionSinks;
  texts: string[];
  statuses: string[];
  done: boolean;
} {
  const texts: string[] = [];
  const statuses: string[] = [];
  let done = false;
  return {
    texts,
    statuses,
    get done() {
      return done;
    },
    sinks: {
      onText: (t) => texts.push(t),
      onStatus: (t) => statuses.push(t),
      onToolNote: () => {},
      onTurnComplete: () => {
        done = true;
      },
      onError: () => {},
    },
  };
}

function alwaysApprove(): Promise<ConfirmResult> {
  return Promise.resolve({ approved: true });
}

async function okOutcome(): Promise<ToolOutcome> {
  return { ok: true, summary: "ok" };
}

test("cancel(): returns false when no turn is running", () => {
  const session = new ChatSession({
    llm: scriptedLlm([[{ kind: "final" }]]),
    runTool: okOutcome,
    confirm: alwaysApprove,
    tuning: vscodeTuning("test-model"),
  });
  assert.equal(session.cancel(), false);
});

test("cancel(): aborts the in-flight turn before it can produce any text", async () => {
  const session = new ChatSession({
    // Two rounds scripted; cancelling before round 0 even starts must mean round 1's text is
    // never reached (the loop checks `signal.aborted` before EVERY round, per loop.ts's own
    // AgentTurnDeps.signal doc).
    llm: scriptedLlm([
      [{ kind: "tool_call", call: TOOL_CALL }],
      [{ kind: "text", text: "round two" }, { kind: "final" }],
    ]),
    runTool: okOutcome,
    confirm: alwaysApprove,
    tuning: vscodeTuning("test-model"),
  });
  const { sinks, texts, statuses } = collector();

  const turn = session.send("do something", sinks);
  // Cancel synchronously, in the SAME tick send() was called in — send() sets up its
  // AbortController before its first await, so this is guaranteed to land before round 0 starts.
  const cancelled = session.cancel();
  await turn;

  assert.equal(cancelled, true, "cancel() must report it actually stopped something");
  assert.deepEqual(texts, [], "no round's text should have streamed");
  assert.ok(
    statuses.some((s) => s.includes("stopped") && s.includes("cancelled")),
    `expected a 'stopped — cancelled …' status line, got: ${JSON.stringify(statuses)}`,
  );
});

test("cancel(): a tool-less cancellation never renders as '⛔ undefined blocked'", async () => {
  const session = new ChatSession({
    llm: scriptedLlm([[{ kind: "text", text: "hi" }, { kind: "final" }]]),
    runTool: okOutcome,
    confirm: alwaysApprove,
    tuning: vscodeTuning("test-model"),
  });
  const toolNotes: string[] = [];
  const sinks: import("./session.js").SessionSinks = {
    onText: () => {},
    onToolNote: (n) => toolNotes.push(n),
    onTurnComplete: () => {},
    onError: () => {},
  };
  const turn = session.send("hi", sinks);
  session.cancel();
  await turn;
  assert.ok(
    !toolNotes.some((n) => n.includes("undefined")),
    `a tool-less blocked event must never render as '⛔ undefined blocked', got: ${JSON.stringify(toolNotes)}`,
  );
});

test("cancel(): a no-op after the turn already completed (the controller is cleared)", async () => {
  const session = new ChatSession({
    llm: scriptedLlm([[{ kind: "text", text: "done" }, { kind: "final" }]]),
    runTool: okOutcome,
    confirm: alwaysApprove,
    tuning: vscodeTuning("test-model"),
  });
  const c = collector();
  await session.send("hi", c.sinks);
  assert.ok(c.done, "the turn should have completed normally");
  assert.equal(session.cancel(), false, "nothing left running to cancel");
});

test("cancel(): a fresh turn after a cancelled one runs normally (the controller is per-turn)", async () => {
  const session = new ChatSession({
    llm: scriptedLlm([[{ kind: "text", text: "second turn's answer" }, { kind: "final" }]]),
    runTool: okOutcome,
    confirm: alwaysApprove,
    tuning: vscodeTuning("test-model"),
  });

  // First turn: cancel it immediately.
  const first = collector();
  const firstTurn = session.send("first", first.sinks);
  session.cancel();
  await firstTurn;

  // Second turn: let it run to completion uninterrupted.
  const second = collector();
  await session.send("second", second.sinks);
  assert.deepEqual(second.texts, ["second turn's answer"]);
  assert.ok(second.done);
});

test("stopAndWaitIdle(): a no-op that resolves immediately when nothing is running", async () => {
  const session = new ChatSession({
    llm: scriptedLlm([[{ kind: "final" }]]),
    runTool: okOutcome,
    confirm: alwaysApprove,
    tuning: vscodeTuning("test-model"),
  });
  assert.equal(session.busy, false);
  await session.stopAndWaitIdle(); // must not hang or throw
});

test("reset(): while idle, clears the thread back to just the fresh system message", async () => {
  const session = new ChatSession({
    llm: scriptedLlm([[{ kind: "text", text: "hi" }, { kind: "final" }]]),
    runTool: okOutcome,
    confirm: alwaysApprove,
    tuning: vscodeTuning("test-model"),
  });
  await session.send("hi", collector().sinks);
  assert.ok(session.thread.messages.length > 1, "the turn must have added messages");

  await session.reset();
  assert.deepEqual(
    session.thread.messages.map((m) => m.role),
    ["system"],
  );
});

test("reset(): cancels and WAITS OUT an in-flight turn before clearing — the interrupted turn's own round-end fold can never reappear in the thread afterward", async () => {
  // Round 0 forces a second round (a tool_call); round 1's model response is gated on a
  // manually-controlled promise, standing in for a slow model reply that is genuinely already
  // in flight — not merely scheduled — at the moment reset() is called.
  let releaseRound1: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseRound1 = resolve;
  });
  let round = 0;
  const llm: LLMClient = {
    async *turn() {
      const thisRound = round++;
      if (thisRound === 0) {
        yield { kind: "tool_call", call: TOOL_CALL };
        return;
      }
      await gate;
      yield { kind: "text", text: "round 1 — must NEVER land after a reset" };
      yield { kind: "final" };
    },
  };
  const session = new ChatSession({
    llm,
    runTool: okOutcome,
    confirm: alwaysApprove,
    tuning: vscodeTuning("test-model"),
  });

  const turn = session.send("do something", collector().sinks);
  // Give round 0 (the tool_call) real ticks to process and the loop to advance into round 1's
  // llm.turn() call, which then blocks on `gate` — i.e. genuinely in flight.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const resetDone = session.reset();
  // Release round 1 WHILE reset() is still awaiting the turn — under the old, unguarded
  // `reset()` this ordering is exactly what let the interrupted turn's own fold push its
  // trailing content back onto the array reset had already cleared.
  releaseRound1();
  await resetDone;
  await turn;

  assert.deepEqual(
    session.thread.messages.map((m) => m.role),
    ["system"],
    "the thread must contain ONLY the fresh system message — no leftover content from the interrupted turn's own round-end fold",
  );
});

/* ── the authorisation ladder actually reaches this surface ──────────────────── */

/**
 * Regression: the whole 0-7 ladder used to collapse to `tuning.yes = authLevel >= 1`.
 *
 * `prometheus.authLevel` advertised "0-7, the SAME ladder as the prometheus CLI and the desktop
 * app", `resolveAuthLevel` resolved and clamped a 0-7 value faithfully — and then every level
 * from 1 to 7 behaved identically, because the loop reads only the boolean and nothing else in
 * this host consulted the number. A user who set 7 after reading that description still got a
 * modal for every edit.
 */
function writeSession(authLevel: number, call: ToolCall) {
  let asked = 0;
  const session = new ChatSession({
    llm: scriptedLlm([[{ kind: "tool_call", call }], [{ kind: "final" }]]),
    runTool: okOutcome,
    confirm: async () => {
      asked += 1;
      return { approved: true };
    },
    tuning: vscodeTuning("test-model", authLevel),
    authLevel,
    // the real predicate is `normalizeWorkspaceRelPath(p) !== null`; this is its rule
    insideWorkingSet: (p) => !p.startsWith("/") && !p.includes(".."),
  });
  return { session, asked: () => asked };
}

test("a write INSIDE the workspace stops prompting once the level says so", async () => {
  const low = writeSession(1, WRITE_CALL);
  const c1 = collector();
  await low.session.send("go", c1.sinks);
  assert.equal(low.asked(), 1, "level 1 covers read-only tools only — a write still asks");

  const high = writeSession(5, WRITE_CALL);
  const c2 = collector();
  await high.session.send("go", c2.sinks);
  assert.equal(high.asked(), 0, "at an auto level an in-scope write runs unprompted");
});

test("a write OUTSIDE the workspace still asks, at every level below the global opt-in", async () => {
  // `scopedWriteDecision`'s rule, and the reason bare `authDecision` is not enough: "level >= 2
  // auto-approves edits" means the files the human is working on, not an arbitrary-write
  // primitive over anything on disk.
  for (const level of [2, 3, 4, 5]) {
    const s2 = writeSession(level, ESCAPING_WRITE);
    const c = collector();
    await s2.session.send("go", c.sinks);
    assert.equal(s2.asked(), 1, `level ${level} must still ask for a write outside the folder`);
  }
});

test("no authLevel at all ⇒ nothing is auto-approved beyond what tuning.yes covers", async () => {
  // An embedder that passes no level must get today's behaviour, never an accidental grant.
  let asked = 0;
  const session = new ChatSession({
    llm: scriptedLlm([[{ kind: "tool_call", call: WRITE_CALL }], [{ kind: "final" }]]),
    runTool: okOutcome,
    confirm: async () => {
      asked += 1;
      return { approved: true };
    },
    tuning: vscodeTuning("test-model", 7),
  });
  const c = collector();
  await session.send("go", c.sinks);
  assert.equal(asked, 1, "the number is what grants, not the tuning bit");
});

test("a DESTRUCTIVE tool asks below the global opt-in, and only stops asking at 6-7", async () => {
  /**
   * The ladder's own rule, shared verbatim with the CLI and the desktop: `destructive` is the
   * LAST of the six categories, so it is unlocked only by levels 6 ("trusted") and 7 ("run all"),
   * which are an explicit global opt-in. Nemesis still hard-stops danger at every level.
   *
   * Pinned as a test because this is the one place honouring the ladder made this surface LESS
   * prompt-happy than it used to be, and that has to be a deliberate, stated behaviour rather
   * than a side effect nobody notices.
   */
  const del = (id: string): ToolCall => ({ id, name: "delete_file", args: { path: "src/x.ts" } });
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const s2 = writeSession(level, del(`d${level}`));
    const c = collector();
    await s2.session.send("go", c.sinks);
    assert.equal(s2.asked(), 1, `level ${level} must ask before deleting`);
  }
  for (const level of [6, 7]) {
    const s2 = writeSession(level, del(`d${level}`));
    const c = collector();
    await s2.session.send("go", c.sinks);
    assert.equal(s2.asked(), 0, `level ${level} is an explicit global opt-in`);
  }
});
