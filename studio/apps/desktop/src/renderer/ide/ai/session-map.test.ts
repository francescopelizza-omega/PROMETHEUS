/**
 * session-map.test.ts — node:test for the live↔core session mapper (APP-052).
 * Pure — no react/window. Pins the bidirectional round-trip + fs-safe id validation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deserializeSession,
  searchSessions,
  serializeSession,
  truncateAfter,
} from "@prometheus/core/agent-session";

import type { AiTurn } from "../state/stores.js";
import { isSafeSessionId, liveToSession, sessionToLive } from "./session-map.js";

const META = {
  id: "sess-1",
  title: "My chat",
  workspacePath: "/w",
  createdAt: "2026-07-12T00:00:00Z",
  updatedAt: "2026-07-12T01:00:00Z",
};

const LIVE: AiTurn[] = [
  { role: "user", content: "hi", checkpointId: "cp1" },
  { role: "assistant", content: "hello" },
  { role: "user", content: "make a plan" },
  { role: "assistant", content: "🔧 read a.ts" },
  { role: "assistant", content: "here is the plan" },
];

test("liveToSession groups a flat transcript into SessionTurns (one per user prompt)", () => {
  const s = liveToSession(META, LIVE);
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns[0]!.prompt, "hi");
  assert.equal(s.turns[0]!.checkpointId, "cp1");
  assert.equal(s.turns[0]!.turnNumber, 1);
  assert.deepEqual(
    s.turns[1]!.events.map((e) => (e.kind === "text" ? e.text : "")),
    ["🔧 read a.ts", "here is the plan"],
  );
});

test("sessionToLive ∘ liveToSession round-trips the flat transcript", () => {
  const s = liveToSession(META, LIVE);
  assert.deepEqual(sessionToLive(s), LIVE);
});

test("JSONL round-trip through serialize/deserialize preserves turns", () => {
  const s = liveToSession(META, LIVE);
  const back = deserializeSession(serializeSession(s));
  assert.ok(back);
  assert.deepEqual(sessionToLive(back as NonNullable<typeof back>), LIVE);
});

test("deserializeSession skips a truncated last line (crash-mid-write)", () => {
  const s = liveToSession(META, LIVE);
  const jsonl = serializeSession(s);
  const corrupt = `${jsonl}\n{"_t":"turn","id":"x","turnNum`; // partial trailing line
  const back = deserializeSession(corrupt);
  assert.ok(back);
  assert.equal(back!.turns.length, 2); // the partial line dropped, not thrown
});

test("truncateAfter fork keeps turns 1..N; the original is unchanged", () => {
  const s = liveToSession(META, LIVE);
  const forked = truncateAfter(s, 1, META.updatedAt); // keep only the first SessionTurn
  assert.equal(forked.turns.length, 1);
  assert.equal(s.turns.length, 2, "original untouched (pure copy)");
  assert.deepEqual(sessionToLive(forked), [
    { role: "user", content: "hi", checkpointId: "cp1" },
    { role: "assistant", content: "hello" },
  ]);
});

test("searchSessions filters by title (newest-first)", () => {
  const older = liveToSession(
    { ...META, id: "a", title: "alpha", updatedAt: "2026-07-11T00:00:00Z" },
    [],
  );
  const newer = liveToSession(
    { ...META, id: "b", title: "beta", updatedAt: "2026-07-12T00:00:00Z" },
    [],
  );
  const out = searchSessions([older, newer], {});
  assert.deepEqual(
    out.map((s) => s.id),
    ["b", "a"],
  );
  assert.deepEqual(
    searchSessions([older, newer], { text: "alph" }).map((s) => s.id),
    ["a"],
  );
});

test("isSafeSessionId rejects path-escaping / reserved / control ids", () => {
  assert.equal(isSafeSessionId("sess-1"), true);
  assert.equal(isSafeSessionId(crypto.randomUUID()), true);
  assert.equal(isSafeSessionId("../etc/passwd"), false);
  assert.equal(isSafeSessionId("a/b"), false);
  assert.equal(isSafeSessionId("a\\b"), false);
  assert.equal(isSafeSessionId("CON"), false);
  assert.equal(isSafeSessionId("nul.jsonl"), false);
  assert.equal(isSafeSessionId(""), false);
});
