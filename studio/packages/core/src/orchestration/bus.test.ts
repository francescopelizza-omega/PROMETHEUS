/**
 * bus.test.ts — addressing, mailbox drain, broadcast, correlation, persistence, subscribe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MessageBus, parseBusJsonl } from "./bus.js";

const det = () =>
  new MessageBus({
    now: () => 1000,
    genId: (() => {
      let n = 0;
      return () => `m${n++}`;
    })(),
  });

test("post fills id + ts deterministically", () => {
  const bus = det();
  const m = bus.post({ from: "lead", to: "api", kind: "task", content: "build it" });
  assert.equal(m.id, "m0");
  assert.equal(m.ts, 1000);
  assert.equal(bus.all().length, 1);
});

test("drainFor delivers addressed + broadcast, never the sender's own, and advances the cursor", () => {
  const bus = det();
  bus.post({ from: "lead", to: "api", kind: "task", content: "t1" });
  bus.post({ from: "lead", to: "ui", kind: "task", content: "t2" });
  bus.post({ from: "lead", to: "broadcast", kind: "msg", content: "hello all" });
  bus.post({ from: "api", to: "api", kind: "log", content: "self note" }); // own → not delivered

  const apiFirst = bus.drainFor("api");
  assert.deepEqual(
    apiFirst.map((m) => m.content),
    ["t1", "hello all"],
  );
  // second drain → nothing new
  assert.deepEqual(bus.drainFor("api"), []);
  // a new message after the cursor is delivered
  bus.post({ from: "ui", to: "api", kind: "msg", content: "peer ping" });
  assert.deepEqual(
    bus.drainFor("api").map((m) => m.content),
    ["peer ping"],
  );
});

test("peer-to-peer: api can message ui directly", () => {
  const bus = det();
  bus.post({ from: "api", to: "ui", kind: "msg", content: "need the schema" });
  assert.deepEqual(
    bus.drainFor("ui").map((m) => m.content),
    ["need the schema"],
  );
  assert.deepEqual(bus.drainFor("lead"), []); // orchestrator not addressed
});

test("forTask correlates results to their task", () => {
  const bus = det();
  const task = bus.post({ from: "lead", to: "api", kind: "task", content: "do x", taskId: "T1" });
  bus.post({
    from: "api",
    to: "lead",
    kind: "result",
    content: "did x",
    taskId: "T1",
    parentId: task.id,
  });
  const corr = bus.forTask("T1");
  assert.equal(corr.length, 2);
  assert.equal(corr[1]?.kind, "result");
});

test("subscribe streams every posted message; unsubscribe stops it", () => {
  const bus = det();
  const seen: string[] = [];
  const off = bus.subscribe((m) => seen.push(m.content));
  bus.post({ from: "a", to: "b", kind: "msg", content: "one" });
  off();
  bus.post({ from: "a", to: "b", kind: "msg", content: "two" });
  assert.deepEqual(seen, ["one"]);
});

test("serialize → deserialize round-trips the log", () => {
  const bus = det();
  bus.post({ from: "lead", to: "api", kind: "task", content: "t" });
  bus.post({ from: "api", to: "lead", kind: "result", content: "r", taskId: "T1" });
  const jsonl = bus.serialize();
  assert.equal(jsonl.split("\n").length, 2);
  const restored = MessageBus.deserialize(jsonl);
  assert.equal(restored.all().length, 2);
  assert.equal(restored.all()[1]?.content, "r");
});

test("parseBusJsonl CLI-073: well-formed → Message[]; empty trailing line OK", () => {
  const bus = det();
  bus.post({ from: "lead", to: "api", kind: "task", content: "do X" });
  bus.post({ from: "api", to: "lead", kind: "result", content: "did X", taskId: "T1" });
  // serialize() has no trailing newline; add one to prove the empty final segment is fine.
  const msgs = parseBusJsonl(`${bus.serialize()}\n`);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]?.kind, "task");
  assert.equal(msgs[1]?.content, "did X");
});

test("parseBusJsonl CLI-073: a corrupt MIDDLE line fails closed naming the line", () => {
  const good = JSON.stringify({ id: "m0", from: "a", to: "b", kind: "log", content: "x", ts: 1 });
  const jsonl = `${good}\n{ this is not json\n${good}`;
  assert.throws(() => parseBusJsonl(jsonl), /line 2/);
});

test("parseBusJsonl CLI-073: a truncated final line (partial object) fails closed", () => {
  const good = JSON.stringify({ id: "m0", from: "a", to: "b", kind: "task", content: "x", ts: 1 });
  // a crash mid-write leaves the last line an incomplete object with no trailing newline.
  const jsonl = `${good}\n{"id":"m1","from":"a","to":"b","kind":"res`;
  assert.throws(() => parseBusJsonl(jsonl), /line 2.*not valid JSON/);
});

test("parseBusJsonl CLI-073: valid JSON but wrong shape is rejected (not a bus message)", () => {
  assert.throws(() => parseBusJsonl('{"hello":"world"}'), /not a bus message/);
  // an unknown kind is also rejected.
  assert.throws(
    () => parseBusJsonl('{"id":"m","from":"a","to":"b","kind":"bogus","content":"c","ts":1}'),
    /not a bus message/,
  );
});
