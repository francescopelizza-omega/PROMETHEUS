/**
 * stores.test.ts — node:test for the ai-session store's SESSION-TARGETED review
 * actions (APP-015). `proposeChangeSet` takes the OWNING session id because a
 * BACKGROUND tab's agent must land its proposed edits in its own session — the
 * store's other review actions act on the ACTIVE session (DiffReview renders only
 * the active tab). Runs under node (no window → the store boots fresh, unpersisted).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { makeCheckpoint, restorePlan } from "@prometheus/core/agent-checkpoint";

import type { ReviewChangeSet } from "./diff-review-state.js";
import { useAiSessionStore } from "./stores.js";

const CS: ReviewChangeSet = {
  id: "cs-t",
  rationale: "test edits",
  edits: [
    {
      uri: "file:///w/a.ts",
      hunks: [{ id: "h1", originalStart: 0, originalLines: 1, oldLines: ["a"], newLines: ["b"] }],
    },
  ],
};

test("proposeChangeSet(cs, sessionId) lands in the OWNING session, not the active one", () => {
  const owner = useAiSessionStore.getState().newSession();
  const other = useAiSessionStore.getState().newSession(); // now the ACTIVE tab
  assert.equal(useAiSessionStore.getState().activeId, other);

  useAiSessionStore.getState().proposeChangeSet(CS, owner);

  const s = useAiSessionStore.getState();
  assert.equal(s.sessions[owner]?.changeSet?.id, "cs-t");
  // the selection is seeded all-accepted (§7.4 review-then-trim default).
  assert.deepEqual(s.sessions[owner]?.selection, { "file:///w/a.ts": ["h1"] });
  assert.equal(s.sessions[other]?.changeSet, null); // the active tab is untouched
});

test("proposeChangeSet without a session id targets the ACTIVE session", () => {
  const active = useAiSessionStore.getState().newSession();
  useAiSessionStore.getState().proposeChangeSet(CS);
  assert.equal(useAiSessionStore.getState().sessions[active]?.changeSet?.id, "cs-t");
});

test("proposeChangeSet to an unknown/closed session id is a safe no-op", () => {
  const before = useAiSessionStore.getState().sessions;
  useAiSessionStore.getState().proposeChangeSet(CS, "s-gone");
  assert.deepEqual(useAiSessionStore.getState().sessions, before);
});

test("clearChangeSet(sessionId) / setSelection(sel, sessionId) target the OWNING session", () => {
  const st = useAiSessionStore.getState();
  const owner = st.newSession();
  useAiSessionStore.getState().proposeChangeSet(CS, owner);
  const other = useAiSessionStore.getState().newSession(); // now ACTIVE ≠ owner
  useAiSessionStore.getState().proposeChangeSet(CS, other);
  // an async Apply continuation for `owner` resolves after the tab switch:
  useAiSessionStore.getState().setSelection({ "file:///a.py": [] }, owner);
  assert.deepEqual(useAiSessionStore.getState().sessions[owner]?.selection, {
    "file:///a.py": [],
  });
  // the ACTIVE session's review state is untouched by the id-addressed calls.
  const activeSel = useAiSessionStore.getState().sessions[other]?.selection;
  assert.notDeepEqual(activeSel, { "file:///a.py": [] });
  useAiSessionStore.getState().clearChangeSet(owner);
  assert.equal(useAiSessionStore.getState().sessions[owner]?.changeSet, null);
  assert.notEqual(useAiSessionStore.getState().sessions[other]?.changeSet, null);
});

// ---- APP-051 checkpoints + revert ------------------------------------------ //

const cp = (id: string, sid: string, turn: number, files: Record<string, string>) =>
  makeCheckpoint(id, sid, turn, "2026-07-12T00:00:00Z", files);

test("takeCheckpoint records a checkpoint; getCheckpoint returns it", () => {
  const sid = useAiSessionStore.getState().newSession();
  useAiSessionStore.getState().takeCheckpoint(sid, cp("cp1", sid, 0, { "a.ts": "x" }));
  const got = useAiSessionStore.getState().getCheckpoint(sid, "cp1");
  assert.ok(got);
  assert.deepEqual(got?.files, { "a.ts": "x" });
});

test("checkpoints beyond the cap (20) are pruned — oldest evicted", () => {
  const sid = useAiSessionStore.getState().newSession();
  const st = useAiSessionStore.getState();
  for (let i = 0; i < 21; i++) st.takeCheckpoint(sid, cp(`c${i}`, sid, i, { "f.ts": String(i) }));
  assert.equal(st.getCheckpoint(sid, "c0"), undefined, "oldest evicted");
  assert.ok(st.getCheckpoint(sid, "c20"), "newest kept");
});

test("revertToTurn truncates the transcript to before that turn", () => {
  const sid = useAiSessionStore.getState().newSession();
  const st = useAiSessionStore.getState();
  st.pushTurn(sid, { role: "user", content: "one", checkpointId: "cpA" });
  st.pushTurn(sid, { role: "assistant", content: "reply one" });
  st.pushTurn(sid, { role: "user", content: "two", checkpointId: "cpB" });
  st.pushTurn(sid, { role: "assistant", content: "reply two" });
  // revert the SECOND user turn (index 2) → keep the first two turns only.
  st.revertToTurn(sid, 2);
  const turns = useAiSessionStore.getState().sessions[sid]?.turns ?? [];
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((t) => t.content),
    ["one", "reply one"],
  );
});

test("restorePlan classifies write (modified/deleted) + delete (created-since)", () => {
  // snapshot had a.ts + b.ts; the turn modified a.ts, deleted b.ts, and created c.ts.
  const c = cp("cpX", "s", 0, { "a.ts": "OLD_A", "b.ts": "OLD_B" });
  const plan = restorePlan(c, ["a.ts", "c.ts"]); // b.ts is gone now; c.ts is new
  assert.deepEqual(plan.write, { "a.ts": "OLD_A", "b.ts": "OLD_B" }); // re-write both snapshot files
  assert.deepEqual(plan.delete, ["c.ts"]); // undo the creation
});

// ---- APP-052 openSessionTab (resume/fork) ---------------------------------- //

test("openSessionTab creates a tab with restored turns; a matching id overwrites", () => {
  const st = useAiSessionStore.getState();
  const id = st.openSessionTab({
    id: "resume-abc",
    title: "Resumed",
    turns: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ],
  });
  assert.equal(id, "resume-abc");
  let s = useAiSessionStore.getState();
  assert.equal(s.activeId, "resume-abc");
  assert.equal(s.sessions["resume-abc"]?.turns.length, 2);
  // re-open the SAME id → overwrite turns (resume-into-existing), no duplicate tab.
  useAiSessionStore.getState().openSessionTab({ id: "resume-abc", title: "Resumed", turns: [] });
  s = useAiSessionStore.getState();
  assert.equal(s.sessions["resume-abc"]?.turns.length, 0);
  assert.equal(s.order.filter((x) => x === "resume-abc").length, 1);
});

test("openSessionTab rejects an unsafe id and mints a safe one", () => {
  const id = useAiSessionStore.getState().openSessionTab({ id: "../evil", title: "x", turns: [] });
  assert.notEqual(id, "../evil");
  assert.ok(id.length > 0);
});
