/**
 * terminal-session.test.ts — node:test for the PURE multi-session terminal reducer (#7).
 *
 * Pins add/activate, close-with-neighbor-activation (next, else previous, else null),
 * rename, and idempotent add. Pure — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activateSession,
  addSession,
  closePane,
  closeSession,
  deserializeLayout,
  focusPane,
  initialLayout,
  initialTerminalState,
  paneActivateSession,
  paneAddSession,
  paneCloseSession,
  paneRenameSession,
  renameSession,
  serializeLayout,
  splitPane,
} from "./terminal-session.js";

const mk = (id: string) => ({ id, title: id, cwd: "/w" });

test("add appends + activates; duplicate id is ignored", () => {
  let s = initialTerminalState();
  s = addSession(s, mk("a"));
  s = addSession(s, mk("b"));
  assert.deepEqual(
    s.sessions.map((x) => x.id),
    ["a", "b"],
  );
  assert.equal(s.activeId, "b");
  const before = s;
  s = addSession(s, mk("a")); // duplicate
  assert.equal(s, before); // unchanged reference
});

test("closing the active tab activates the NEXT neighbor", () => {
  let s = initialTerminalState();
  for (const id of ["a", "b", "c"]) s = addSession(s, mk(id));
  s = activateSession(s, "b");
  s = closeSession(s, "b");
  assert.deepEqual(
    s.sessions.map((x) => x.id),
    ["a", "c"],
  );
  assert.equal(s.activeId, "c"); // the tab that took b's index
});

test("closing the LAST active tab falls back to the previous", () => {
  let s = initialTerminalState();
  for (const id of ["a", "b"]) s = addSession(s, mk(id)); // active = b (last)
  s = closeSession(s, "b");
  assert.equal(s.activeId, "a");
});

test("closing the only tab leaves activeId null", () => {
  let s = addSession(initialTerminalState(), mk("a"));
  s = closeSession(s, "a");
  assert.deepEqual(s.sessions, []);
  assert.equal(s.activeId, null);
});

test("closing a NON-active tab keeps the active one", () => {
  let s = initialTerminalState();
  for (const id of ["a", "b", "c"]) s = addSession(s, mk(id)); // active = c
  s = closeSession(s, "a");
  assert.equal(s.activeId, "c");
});

test("rename updates the title, ignores blank + unknown", () => {
  let s = addSession(initialTerminalState(), mk("a"));
  s = renameSession(s, "a", "  build  ");
  assert.equal(s.sessions[0]?.title, "build");
  assert.equal(renameSession(s, "a", "   "), s); // blank ignored
  assert.equal(renameSession(s, "zzz", "x"), s); // unknown ignored
});

// ---- split panes (APP-049) -------------------------------------------------- //

test("one-pane layout reproduces the flat reducer's add/close semantics", () => {
  let L = initialLayout("p1");
  L = paneAddSession(L, "p1", mk("a"));
  L = paneAddSession(L, "p1", mk("b"));
  L = paneAddSession(L, "p1", mk("c"));
  L = paneActivateSession(L, "p1", "b");
  L = paneCloseSession(L, "p1", "b"); // active → NEXT neighbor (c)
  const pane = L.panes[0]!;
  assert.deepEqual(
    pane.sessions.map((x) => x.id),
    ["a", "c"],
  );
  assert.equal(pane.activeId, "c");
});

test("splitPane adds a focused empty pane; closePane focuses a neighbor; last never closes", () => {
  let L = initialLayout("p1");
  L = paneAddSession(L, "p1", mk("a"));
  L = splitPane(L, "p2", "row");
  assert.equal(L.panes.length, 2);
  assert.equal(L.focusedPaneId, "p2");
  assert.equal(L.direction, "row");
  L = paneAddSession(L, "p2", mk("b"));
  L = closePane(L, "p2");
  assert.equal(L.panes.length, 1);
  assert.equal(L.focusedPaneId, "p1");
  const before = L;
  assert.equal(closePane(L, "p1"), before); // last pane never closes
});

test("closing a pane's LAST tab closes the pane when other panes remain", () => {
  let L = initialLayout("p1");
  L = paneAddSession(L, "p1", mk("a"));
  L = splitPane(L, "p2", "column");
  L = paneAddSession(L, "p2", mk("b"));
  L = paneCloseSession(L, "p2", "b"); // p2's only tab → pane closes
  assert.equal(L.panes.length, 1);
  assert.equal(L.panes[0]!.id, "p1");
  // last pane's last tab does NOT close the pane (→ empty "+ to open" pane)
  L = paneCloseSession(L, "p1", "a");
  assert.equal(L.panes.length, 1);
  assert.equal(L.panes[0]!.activeId, null);
});

test("focusPane switches focus; unknown id is a no-op", () => {
  let L = splitPane(initialLayout("p1"), "p2", "row");
  L = focusPane(L, "p1");
  assert.equal(L.focusedPaneId, "p1");
  assert.equal(focusPane(L, "zzz"), L);
});

test("serialize→deserialize round-trips titles/cwd/direction with FRESH ids", () => {
  let L = initialLayout("p1");
  L = paneAddSession(L, "p1", { id: "a", title: "build", cwd: "/w" });
  L = splitPane(L, "p2", "column");
  L = paneAddSession(L, "p2", { id: "b", title: "logs", cwd: "/w/logs", launch: "SECRET" });
  const blob = serializeLayout(L);
  // secrets never persisted
  assert.ok(!JSON.stringify(blob).includes("SECRET"));
  let seq = 0;
  const restored = deserializeLayout(blob, () => `n${++seq}`, "/w");
  assert.equal(restored.direction, "column");
  assert.equal(restored.panes.length, 2);
  assert.equal(restored.panes[0]!.sessions[0]!.title, "build");
  assert.equal(restored.panes[1]!.sessions[0]!.title, "logs");
  assert.equal(restored.panes[1]!.sessions[0]!.cwd, "/w/logs");
  // fresh ids (never the persisted-away "a"/"b")
  assert.ok(restored.panes[0]!.sessions[0]!.id.startsWith("n"));
  assert.equal(restored.panes[1]!.sessions[0]!.launch, undefined);
});

test("deserialize fails soft to a single pane on bad JSON / wrong version", () => {
  const bad = deserializeLayout("{not json", () => "x", "/w");
  assert.equal(bad.panes.length, 1);
  assert.equal(paneRenameSession(bad, bad.focusedPaneId, "nope", "x"), bad); // no sessions yet
  const wrongVer = deserializeLayout({ version: 99, panes: [] }, () => "y", "/w");
  assert.equal(wrongVer.panes.length, 1);
});
