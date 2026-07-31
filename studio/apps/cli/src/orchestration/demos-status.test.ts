/**
 * demos-status.test.ts — the CLI-074 live participant board: the pure reducer, the LiveBoard
 * (the first real MessageBus.subscribe caller), and renderBoard. No live subprocess.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { orchestration as orch } from "@prometheus/core";

import { type Board, LiveBoard, initBoard, reduceBoard } from "./demos-status-board.js";
import { renderBoard } from "./demos-view.js";

type Message = orch.Message;
const msg = (over: Partial<Message>): Message => ({
  id: "m",
  from: "a",
  to: "b",
  kind: "msg",
  content: "c",
  ts: 0,
  ...over,
});

test("reduceBoard CLI-074: a bus sequence folds idle→busy→idle (injected clock)", () => {
  let b = initBoard(["lead", "api"]);
  assert.equal(b.lead.state, "idle");
  // a task from lead to api → lead is working, api has incoming work.
  b = reduceBoard(
    b,
    { kind: "bus", msg: msg({ from: "lead", to: "api", kind: "task", content: "do X" }) },
    1,
  );
  assert.equal(b.lead.state, "busy");
  assert.equal(b.api.state, "busy");
  assert.equal(b.lead.lastMessage, "do X");
  assert.equal(b.lead.lastActivityAt, 1); // the injected clock, not wall-time
  // api delivers a result → it is free again (idle).
  b = reduceBoard(
    b,
    { kind: "bus", msg: msg({ from: "api", to: "lead", kind: "result", content: "done" }) },
    2,
  );
  assert.equal(b.api.state, "idle");
});

test("reduceBoard CLI-074: a liveness snapshot marks a missing pane dead (terminal)", () => {
  let b = initBoard(["lead", "api", "ui"]);
  b = reduceBoard(b, { kind: "liveness", live: ["lead", "api"], roster: ["lead", "api", "ui"] }, 5);
  assert.equal(b.ui.state, "dead"); // not in `live` → dead
  assert.equal(b.lead.state, "idle");
  // dead is terminal — a later bus message must NOT resurrect it (CLI-075 relies on this shape).
  b = reduceBoard(b, { kind: "bus", msg: msg({ from: "ui", to: "lead", kind: "msg" }) }, 6);
  assert.equal(b.ui.state, "dead");
});

test("LiveBoard CLI-074: attach() is a real MessageBus.subscribe caller; dispose unsubscribes", () => {
  const bus = new orch.MessageBus();
  const board = new LiveBoard(["lead", "api"]);
  const dispose = board.attach(bus);
  bus.post({ from: "lead", to: "api", kind: "task", content: "work" });
  assert.equal(board.snapshot().api.state, "busy");
  assert.equal(board.snapshot().lead.state, "busy");
  // idempotent: a second attach does not double-subscribe.
  board.attach(bus);
  dispose();
  bus.post({ from: "api", to: "lead", kind: "result", content: "done" });
  assert.equal(
    board.snapshot().api.state,
    "busy",
    "a post after dispose does not update the board",
  );
});

test("LiveBoard CLI-074: applyLiveness folds a tmux liveness snapshot", () => {
  const board = new LiveBoard(["lead", "api"]);
  board.applyLiveness(["lead"]); // api's pane is gone
  assert.equal(board.snapshot().api.state, "dead");
  assert.equal(board.snapshot().lead.state, "idle");
});

test("renderBoard CLI-074: one line per agent with state + note, no ANSI at caps none", () => {
  const b: Board = {
    lead: { state: "busy", lastActivityAt: 1, lastMessage: "building the parser" },
    api: { state: "dead", lastActivityAt: 2 },
  };
  const out = renderBoard(b, ["lead", "api"], "none");
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0] as string, /lead.*busy.*building the parser/);
  assert.match(lines[1] as string, /api.*dead/);
  assert.ok(!/\x1b\[/.test(out), "no ANSI when caps=none");
});
