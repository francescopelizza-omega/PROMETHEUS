/**
 * relay-protocol.test.ts — prom-msg frame parse + topology-aware target resolution.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatForDelivery, parseFrame, resolveFrame } from "./relay-protocol.js";

const ctx = {
  orchestrator: "lead",
  parentOf: (n: string) => (n === "lead" ? undefined : n === "dbtest" ? "api" : "lead"),
};

test("parseFrame validates JSON + required fields", () => {
  assert.deepEqual(parseFrame('{"from":"api","to":"ui","content":"hi"}'), {
    from: "api",
    to: "ui",
    content: "hi",
  });
  assert.equal(parseFrame("not json"), null);
  assert.equal(parseFrame('{"from":"","to":"ui","content":"x"}'), null); // empty from
  assert.equal(parseFrame('{"from":"a","content":"x"}'), null); // missing to
  // content with quotes/newlines/$() survives (it was JSON-encoded by prom-msg)
  const f = parseFrame(JSON.stringify({ from: "a", to: "b", content: 'x "q" $(boom)\nline2' }));
  assert.equal(f?.content, 'x "q" $(boom)\nline2');
});

test("resolveFrame: a teammate name → a direct msg", () => {
  const r = resolveFrame({ from: "api", to: "ui", content: "need schema" }, ctx);
  assert.deepEqual(r, { from: "api", to: "ui", kind: "msg", content: "need schema" });
});

test("resolveFrame: parent/up/orchestrator → msg to the sender's parent", () => {
  assert.equal(resolveFrame({ from: "api", to: "parent", content: "x" }, ctx).to, "lead");
  assert.equal(resolveFrame({ from: "dbtest", to: "up", content: "x" }, ctx).to, "api"); // dbtest's parent
});

test("resolveFrame: broadcast aliases → broadcast", () => {
  assert.equal(resolveFrame({ from: "api", to: "all", content: "x" }, ctx).to, "broadcast");
  assert.equal(resolveFrame({ from: "api", to: "everyone", content: "x" }, ctx).to, "broadcast");
});

test("resolveFrame: done → a result; orchestrator's done → to user", () => {
  assert.deepEqual(resolveFrame({ from: "api", to: "done", content: "built" }, ctx), {
    from: "api",
    to: "lead",
    kind: "result",
    content: "built",
  });
  // the orchestrator finishing the whole run → addressed to user
  assert.equal(resolveFrame({ from: "lead", to: "done", content: "shipped" }, ctx).to, "user");
});

test("resolveFrame: a 'Q:' content becomes a question", () => {
  assert.equal(
    resolveFrame({ from: "ui", to: "api", content: "Q: which port?" }, ctx).kind,
    "question",
  );
});

test("formatForDelivery prefixes the sender (so replies are addressable)", () => {
  assert.equal(formatForDelivery("api", "done with x"), "[from api] done with x");
  assert.equal(formatForDelivery("lead", "heads up", true), "[from lead] (broadcast) heads up");
});
