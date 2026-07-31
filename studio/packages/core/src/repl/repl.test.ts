/**
 * repl.test.ts — slash parse + pane cycle + footer + keymap + reducer (§3/§7).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { defaultTuning } from "../agent/loop.js";
import type { ModelRef } from "../agents/types.js";
import { footerLine } from "./footer.js";
import { actionFor } from "./keymap.js";
import { cyclePane } from "./panes.js";
import { TUNING_SLASHES, knownSlash, parseSlash } from "./slash.js";
import { initialReplState, reduce, tuneFromSlash } from "./state.js";

const MODEL: ModelRef = { provider: "anthropic", modelId: "claude-opus" };

test("parseSlash: message vs slash + rest", () => {
  assert.deepEqual(parseSlash("install rust"), { kind: "message", text: "install rust" });
  assert.deepEqual(parseSlash("/scan"), { kind: "slash", name: "scan", rest: "" });
  assert.deepEqual(parseSlash("/model ollama:qwen3:8b"), {
    kind: "slash",
    name: "model",
    rest: "ollama:qwen3:8b",
  });
  assert.equal(knownSlash("gate"), true);
  assert.equal(knownSlash("bogus"), false);
  assert.ok(TUNING_SLASHES.has("model") && TUNING_SLASHES.has("gate"));
});

test("cyclePane: Ctrl+G core cycle wraps", () => {
  assert.equal(cyclePane("transcript"), "catalog");
  assert.equal(cyclePane("repo"), "transcript"); // wrap
  assert.equal(cyclePane("transcript", -1), "repo");
  assert.equal(cyclePane("audit"), "transcript"); // off-cycle → first
});

test("footerLine reflects tuning", () => {
  assert.equal(
    footerLine(defaultTuning(MODEL)),
    "model claude-opus · tools:on · gate:enforce · dry-run:off · verbosity:normal",
  );
});

test("keymap actionFor", () => {
  assert.equal(actionFor("Enter", "input"), "send");
  assert.equal(actionFor("Ctrl+G", "global"), "cycle-panes");
  assert.equal(actionFor("q", "pane"), "back-from-pane");
  assert.equal(actionFor("zzz", "input"), undefined);
});

test("tuneFromSlash: the §3.1 tuning verbs", () => {
  const t = defaultTuning(MODEL);
  assert.deepEqual(tuneFromSlash("gate", "warn", t), { gateMode: "warn" });
  assert.deepEqual(tuneFromSlash("dry-run", "on", t), { dryRun: true });
  assert.deepEqual(tuneFromSlash("verbosity", "debug", t), { verbosity: "debug" });
  assert.deepEqual(tuneFromSlash("yes", "on", t), { yes: true });
  assert.deepEqual(tuneFromSlash("tools", "off", t), { tools: { ...t.tools, enabled: false } });
  assert.deepEqual(tuneFromSlash("model", "ollama:qwen3:8b", t), {
    model: { provider: "ollama", modelId: "qwen3:8b" },
  });
  assert.equal(tuneFromSlash("gate", "bogus", t), null);
  assert.equal(tuneFromSlash("scan", "", t), null); // not a tuning slash
});

test("reduce: message / cycle-pane / tune / clear are pure", () => {
  const s0 = initialReplState(defaultTuning(MODEL), "/w");
  const s1 = reduce(s0, { type: "message", role: "you", text: "hi" });
  assert.equal(s1.transcript.length, 1);
  assert.equal(s0.transcript.length, 0); // immutable
  const s2 = reduce(s1, { type: "cycle-pane" });
  assert.equal(s2.activePane, "catalog");
  const s3 = reduce(s2, { type: "tune", patch: { gateMode: "off" } });
  assert.equal(s3.tuning.gateMode, "off");
  const s4 = reduce(s3, { type: "clear" });
  assert.equal(s4.transcript.length, 0);
});
