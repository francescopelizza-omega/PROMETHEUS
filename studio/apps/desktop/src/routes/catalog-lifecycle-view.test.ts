/**
 * catalog-lifecycle-view.test.ts — verb→request mapping + progress filtering (APP-007).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  LOG_LINE_CAP,
  appendLifecycleLog,
  lifecycleRequest,
  lifecycleRunId,
  lifecycleStreams,
  lifecycleSurfaceFor,
  parseVersions,
} from "./catalog-lifecycle-view.js";

test("lifecycleSurfaceFor: the three lifecycle kinds map, plugins get NO menu", () => {
  assert.equal(lifecycleSurfaceFor("app"), "apps");
  assert.equal(lifecycleSurfaceFor("worldsim"), "worldsim");
  assert.equal(lifecycleSurfaceFor("model-tool"), "models");
  assert.equal(lifecycleSurfaceFor("plugin"), null);
  assert.equal(lifecycleSurfaceFor(""), null);
});

test("lifecycleRequest: exact wire shape ({surface, action, tool} + optionals)", () => {
  assert.deepEqual(lifecycleRequest("apps", "restart", "comfy"), {
    surface: "apps",
    action: "restart",
    tool: "comfy",
  });
  assert.deepEqual(
    lifecycleRequest("models", "rollback", "ollama", { version: "0.5.1", runId: "r1" }),
    {
      surface: "models",
      action: "rollback",
      tool: "ollama",
      version: "0.5.1",
      runId: "r1",
    },
  );
});

test("lifecycleRunId: always satisfies main's RUN_ID regex, even for slashed tools", () => {
  const id = lifecycleRunId("owner/repo,extra tool", 3);
  assert.match(id, /^[A-Za-z0-9._:-]+$/);
  assert.ok(id.length <= 128);
  assert.equal(lifecycleRunId("comfy", 1), "lifecycle:comfy:1");
  assert.match(lifecycleRunId("", 2), /^[A-Za-z0-9._:-]+$/); // empty tool still valid
});

test("appendLifecycleLog: strict runId filter keeps foreign ops out of the pane", () => {
  const lines = appendLifecycleLog([], { runId: "mine", message: "hello" }, "mine");
  assert.deepEqual(lines, ["hello"]);
  assert.deepEqual(appendLifecycleLog(lines, { runId: "other", message: "noise" }, "mine"), lines);
  assert.deepEqual(appendLifecycleLog(lines, { message: "no-run-id" }, "mine"), lines);
  assert.deepEqual(appendLifecycleLog(lines, { runId: "mine", message: "x" }, null), lines);
});

test("appendLifecycleLog: multi-line payloads split; cap keeps the newest lines", () => {
  const multi = appendLifecycleLog([], { runId: "r", message: "a\nb\n\nc" }, "r");
  assert.deepEqual(multi, ["a", "b", "c"]);
  const many = Array.from({ length: LOG_LINE_CAP + 10 }, (_, i) => `l${i}`);
  const capped = appendLifecycleLog(many, { runId: "r", message: "tail" }, "r");
  assert.equal(capped.length, LOG_LINE_CAP);
  assert.equal(capped[capped.length - 1], "tail");
});

test("parseVersions: string arrays, {version} rows, junk → []", () => {
  assert.deepEqual(parseVersions({ versions: ["1.2.0", "1.1.0"] }), ["1.2.0", "1.1.0"]);
  assert.deepEqual(parseVersions({ rows: [{ version: "2.0" }, { other: true }] }), ["2.0"]);
  assert.deepEqual(parseVersions({ versions: "not-a-list" } as never), []);
  assert.deepEqual(parseVersions(undefined), []);
  assert.deepEqual(parseVersions({}), []);
});

test("lifecycleStreams: mutating runs stream, reads do not", () => {
  assert.equal(lifecycleStreams("update"), true);
  assert.equal(lifecycleStreams("rollback"), true);
  assert.equal(lifecycleStreams("restart"), true);
  assert.equal(lifecycleStreams("versions"), false);
  assert.equal(lifecycleStreams("logs"), false);
  assert.equal(lifecycleStreams("status"), false);
});

test("lifecycleRunId: the prefix names the KIND of run and is sanitised like the tool", () => {
  // §9: install / uninstall streams share the log pane, so their run ids must be
  // distinguishable — and the prefix goes through the same RUN_ID regex as the tool.
  assert.equal(lifecycleRunId("comfy", 1, "install"), "install:comfy:1");
  assert.equal(lifecycleRunId("comfy", 2, "uninstall"), "uninstall:comfy:2");
  // the default keeps every pre-existing caller (and the assertion above) unchanged.
  assert.equal(lifecycleRunId("comfy", 1), "lifecycle:comfy:1");
  // a hostile prefix cannot break main's zod regex.
  assert.match(lifecycleRunId("t", 1, "a/b c,d"), /^[A-Za-z0-9._:-]+$/);
  assert.equal(lifecycleRunId("t", 1, ""), "run:t:1");
});
