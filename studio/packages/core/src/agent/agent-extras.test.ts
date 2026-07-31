/**
 * agent-extras.test.ts — session store, compaction, checkpoint, modes (file 14 §3.1/§3.10/§3.11/E2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CheckpointStore,
  changedPaths,
  makeCheckpoint,
  restorePlan,
  shouldSnapshot,
} from "./checkpoint.js";
import {
  type SessionEvent,
  SessionEventBus,
  compact,
  estimateTokens,
  shouldCompact,
} from "./compact.js";
import {
  AGENT_BUILD,
  AGENT_PLAN,
  SEED_AGENTS,
  agentFileToDef,
  getAgent,
  parseAgentFile,
  parseMention,
  parseModelRef,
} from "./modes.js";
import {
  type Session,
  appendTurn,
  createSession,
  deserializeSession,
  searchSessions,
  serializeSession,
  truncateAfter,
} from "./session-store.js";

// ---- session store (§3.10) ------------------------------------------------- //

test("session: append turns, search, truncate, serialize round-trip", () => {
  let s = createSession("s1", "Refactor auth", "2026-06-19T00:00:00Z", "/home/u/proj");
  s = appendTurn(s, {
    id: "t1",
    prompt: "make it async",
    events: [{ kind: "text", text: "done" }],
    checkpointId: "cp1",
    createdAt: "2026-06-19T00:01:00Z",
  });
  s = appendTurn(s, {
    id: "t2",
    prompt: "add tests",
    events: [{ kind: "text", text: "added" }],
    checkpointId: "cp2",
    createdAt: "2026-06-19T00:02:00Z",
  });
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns[1]?.turnNumber, 2);
  // search by title + content
  assert.equal(searchSessions([s], { text: "refactor" }).length, 1);
  assert.equal(searchSessions([s], { text: "async", includeContent: true }).length, 1);
  assert.equal(searchSessions([s], { workspacePath: "/other" }).length, 0);
  // truncate after turn 1 (revert drops forward history)
  const t = truncateAfter(s, 1, "2026-06-19T00:03:00Z");
  assert.equal(t.turns.length, 1);
  // serialize round-trip
  const back = deserializeSession(serializeSession(s));
  assert.equal(back?.title, "Refactor auth");
  assert.equal(back?.turns.length, 2);
  assert.equal(deserializeSession("garbage{"), null);
});

test("searchSessionStore sorts most-recently-updated first", () => {
  const a = createSession("a", "A", "2026-06-01T00:00:00Z");
  const b = createSession("b", "B", "2026-06-02T00:00:00Z");
  assert.deepEqual(
    searchSessions([a, b], {}).map((s) => s.id),
    ["b", "a"],
  );
});

// ---- compaction (§3.11) ---------------------------------------------------- //

function sess(turnCount: number, textLen = 100): Session {
  let s = createSession("s", "S", "2026-06-19T00:00:00Z");
  for (let i = 0; i < turnCount; i++) {
    s = appendTurn(s, {
      id: `t${i}`,
      prompt: "x".repeat(textLen),
      events: [{ kind: "text", text: "y".repeat(textLen) }],
      createdAt: "2026-06-19T00:00:00Z",
    });
  }
  return s;
}

test("shouldCompact triggers only past the token budget + recent-keep", () => {
  const s = sess(10, 1000); // ~ (1000+1000)/4 = 500 tok/turn × 10 = 5000
  assert.equal(shouldCompact(s.turns, { maxTokens: 100000, keepRecentTurns: 4 }), false);
  assert.equal(shouldCompact(s.turns, { maxTokens: 1000, keepRecentTurns: 4 }), true);
  assert.equal(
    shouldCompact(sess(2).turns, { maxTokens: 1, keepRecentTurns: 4 }),
    false,
    "too few turns",
  );
  assert.ok(estimateTokens(s.turns) > 0);
});

test("compact replaces the older slice with a summary, keeps recent verbatim; fail-soft", async () => {
  const s = sess(6, 50);
  const events: SessionEvent[] = [];
  const bus = new SessionEventBus();
  bus.on((e) => events.push(e));
  const r = await compact(
    "s",
    s.turns,
    { maxTokens: 1, keepRecentTurns: 2 },
    async () => "SUMMARY",
    "2026-06-19T01:00:00Z",
    bus,
  );
  assert.equal(r.compacted, true);
  assert.equal(r.turns.length, 3, "1 summary + 2 recent");
  assert.equal(r.turns[0]?.events[0]?.kind === "text" && r.turns[0]?.events[0]?.text, "SUMMARY");
  assert.ok(events.some((e) => e.kind === "compacted"));
  // fail-soft: summarizer throws → original turns kept
  const failed = await compact(
    "s",
    s.turns,
    { maxTokens: 1, keepRecentTurns: 2 },
    async () => {
      throw new Error("model down");
    },
    "2026-06-19T01:00:00Z",
  );
  assert.equal(failed.compacted, false);
  assert.equal(failed.turns.length, s.turns.length);
  assert.match(failed.error ?? "", /model down/);
});

// ---- checkpoint (E2) ------------------------------------------------------- //

test("checkpoint snapshots eligible files; restorePlan rewrites + deletes new files", () => {
  const cp = makeCheckpoint("cp1", "s", 1, "2026-06-19T00:00:00Z", {
    "src/a.ts": "v1",
    ".env": "SECRET=1", // skipped
    "node_modules/x/i.js": "x", // skipped
  });
  assert.deepEqual(Object.keys(cp.files), ["src/a.ts"]);
  assert.equal(shouldSnapshot(".env", "x"), false);
  assert.equal(shouldSnapshot("src/a.ts", "x"), true);
  // a bash side-effect created src/new.ts after the checkpoint → restore deletes it
  const plan = restorePlan(cp, ["src/a.ts", "src/new.ts"]);
  assert.deepEqual(plan.write, { "src/a.ts": "v1" });
  assert.deepEqual(plan.delete, ["src/new.ts"]);
});

test("changedPaths reports added/modified/deleted vs a checkpoint", () => {
  const cp = makeCheckpoint("cp", "s", 1, "now", { "a.ts": "1", "b.ts": "2" });
  const d = changedPaths(cp, { "a.ts": "1", "b.ts": "CHANGED", "c.ts": "new" });
  assert.deepEqual(d.added, ["c.ts"]);
  assert.deepEqual(d.modified, ["b.ts"]);
  assert.deepEqual(d.deleted, []);
});

test("CheckpointStore records, lists by session, evicts past capacity", () => {
  const store = new CheckpointStore(2);
  store.record(makeCheckpoint("c1", "s1", 1, "n", { "a.ts": "1" }));
  store.record(makeCheckpoint("c2", "s1", 2, "n", { "a.ts": "2" }));
  store.record(makeCheckpoint("c3", "s2", 1, "n", { "a.ts": "3" }));
  assert.equal(store.size, 2, "oldest evicted");
  assert.equal(store.get("c1"), undefined);
  assert.equal(store.list("s1").length, 1);
});

// ---- modes-as-agents (§3.1) ------------------------------------------------ //

test("seed roster: Build is full + auto, Plan is read-first (no auto, no shell)", () => {
  assert.equal(SEED_AGENTS.length, 4);
  assert.equal(getAgent(SEED_AGENTS, "build")?.id, "build");
  assert.equal(AGENT_BUILD.tools[0]?.autoApprove, true);
  assert.equal(AGENT_BUILD.sandbox.shell, true);
  assert.equal(AGENT_PLAN.tools[0]?.autoApprove, false);
  assert.equal(AGENT_PLAN.sandbox.shell, false);
  assert.deepEqual(AGENT_PLAN.sandbox.fsWrite, []);
});

test("parseAgentFile + agentFileToDef build an AgentDef from markdown frontmatter", () => {
  const md =
    "---\nname: Reviewer\ndescription: reviews diffs\nmode: plan\nmodel: anthropic:claude-sonnet-4-6\ntools: [engine:scan, fs:read]\n---\nYou review code.";
  const parsed = parseAgentFile(md);
  assert.equal(parsed.meta.name, "Reviewer");
  assert.deepEqual(parsed.meta.tools, ["engine:scan", "fs:read"]);
  const def = agentFileToDef(parsed, "reviewer");
  assert.equal(def.name, "Reviewer");
  assert.deepEqual(def.model, { provider: "anthropic", modelId: "claude-sonnet-4-6" });
  assert.equal(def.system, "You review code.");
  assert.equal(def.tools[0]?.autoApprove, false, "plan mode → not auto");
  assert.equal(def.sandbox.shell, false);
});

test("parseModelRef + parseMention", () => {
  assert.deepEqual(parseModelRef("openai:gpt-4o"), { provider: "openai", modelId: "gpt-4o" });
  assert.deepEqual(parseModelRef("qwen3"), { provider: "local", modelId: "qwen3" });
  assert.deepEqual(parseMention("@Explore find the bug"), {
    agentId: "explore",
    rest: "find the bug",
  });
  assert.equal(parseMention("no mention here"), null);
});
