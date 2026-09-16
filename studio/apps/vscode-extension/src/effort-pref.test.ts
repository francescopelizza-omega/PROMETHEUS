/**
 * effort-pref.test.ts — which thinking-effort tier the extension runs at.
 *
 * The absence this pins: `vscodeTuning` never set `tuning.effort`, so `llm.ts`'s fully-wired
 * `resolveEffort` call always saw `undefined` and this surface sent no reasoning knob to any
 * model, ever.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveEffortTier } from "./effort-pref.js";

/**
 * The one call the resolver makes. `inspect` is load-bearing: `get` would always return a value
 * (a package.json default), so a user who never touched the setting would be indistinguishable
 * from one who pinned it, and the shared tier could never win.
 */
function cfg(pinned?: {
  globalValue?: string;
  workspaceValue?: string;
  workspaceFolderValue?: string;
}): never {
  return {
    get: () => pinned?.globalValue,
    inspect: () => ({ ...(pinned ?? {}) }),
  } as never;
}

test("an explicitly pinned setting wins, most-local scope first", () => {
  assert.equal(
    resolveEffortTier(cfg({ globalValue: "max" }), () => "low"),
    "max",
  );
  assert.equal(
    resolveEffortTier(cfg({ globalValue: "max", workspaceValue: "medium" }), () => "low"),
    "medium",
  );
  assert.equal(
    resolveEffortTier(
      cfg({ globalValue: "max", workspaceValue: "medium", workspaceFolderValue: "off" }),
      () => "low",
    ),
    "off",
    "a per-folder pin is the reason to keep the setting: a repo you want cheaper",
  );
});

test("with no pin, the SHARED tier applies — /think follows you into the editor", () => {
  assert.equal(
    resolveEffortTier(cfg(), () => "xhigh"),
    "xhigh",
  );
  assert.equal(
    resolveEffortTier(cfg(), () => "ultra"),
    "ultra",
  );
});

test("with no pin and nothing saved, the knob is left ALONE rather than invented", () => {
  // Not a hard-coded "medium": sending a reasoning knob on the strength of a default this file
  // made up would be a claim about the user's intent that nobody made.
  assert.equal(
    resolveEffortTier(cfg(), () => null),
    undefined,
  );
});

test("a setting that is not a ladder rung is ignored, not forwarded", () => {
  assert.equal(
    resolveEffortTier(cfg({ globalValue: "MAX" }), () => null),
    undefined,
  );
  assert.equal(
    resolveEffortTier(cfg({ globalValue: "hyper" }), () => "high"),
    "high",
  );
});
