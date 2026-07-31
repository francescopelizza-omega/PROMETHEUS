/**
 * update-policy.test.ts — channel mapping + never-auto-install + staged rollout (§5).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_DOWNLOAD,
  AUTO_INSTALL,
  channelForTag,
  isPrerelease,
  stagedRolloutAllows,
} from "./update-policy.js";

test("channelForTag: stable / beta / alpha by tag shape", () => {
  assert.equal(channelForTag("v1.2.3"), "latest");
  assert.equal(channelForTag("1.2.3"), "latest");
  assert.equal(channelForTag("v1.2.3-beta.4"), "beta");
  assert.equal(channelForTag("v1.2.3-alpha.1"), "alpha");
  assert.equal(isPrerelease("v1.2.3"), false);
  assert.equal(isPrerelease("v1.2.3-beta.1"), true);
});

test("never auto-download / auto-install (the §5 invariant)", () => {
  assert.equal(AUTO_DOWNLOAD, false);
  assert.equal(AUTO_INSTALL, false);
});

test("stagedRolloutAllows: percentage gate", () => {
  assert.equal(stagedRolloutAllows(undefined, 50), true); // no staging → everyone
  assert.equal(stagedRolloutAllows(100, 99), true);
  assert.equal(stagedRolloutAllows(0, 0), false);
  assert.equal(stagedRolloutAllows(10, 5), true); // bucket 5 < 10%
  assert.equal(stagedRolloutAllows(10, 20), false); // bucket 20 ≥ 10%
});
