/**
 * route-tabs.test.ts — the segment latch that makes the handoff_3 §1 merge navigable.
 *
 * The latch exists because there is no URL router: a caller that navigates to Workspace and
 * then asks for the Repos segment is racing the mount. Every test here pins one half of that
 * ordering problem — latch-then-mount, and notify-while-mounted.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  isRouteTab,
  onRouteTab,
  requestRouteTab,
  resetRouteTabs,
  takeRouteTab,
} from "./route-tabs.js";

beforeEach(() => resetRouteTabs());

test("a request LATCHES for a route that has not mounted yet", () => {
  requestRouteTab("workspace", "docs");
  assert.equal(takeRouteTab("workspace"), "docs");
});

test("takeRouteTab CLEARS — a segment is a one-shot handoff, not a sticky preference", () => {
  requestRouteTab("workspace", "environments");
  assert.equal(takeRouteTab("workspace"), "environments");
  // Navigating away and back must land on the route's own default, not re-apply a redirect
  // that happened three navigations ago.
  assert.equal(takeRouteTab("workspace"), null);
});

test("a request NOTIFIES a route that is already mounted", () => {
  const seen: string[] = [];
  const off = onRouteTab("catalog", (t) => seen.push(t));
  requestRouteTab("catalog", "skills");
  requestRouteTab("catalog", "extensions");
  off();
  requestRouteTab("catalog", "plugins");
  assert.deepEqual(seen, ["skills", "extensions"]);
});

test("the two routes' latches never collide", () => {
  requestRouteTab("workspace", "repos");
  requestRouteTab("catalog", "skills");
  assert.equal(takeRouteTab("catalog"), "skills");
  assert.equal(takeRouteTab("workspace"), "repos");
});

test("an unknown tab is IGNORED, not latched", () => {
  // A typo'd redirect must leave the route on its default. Latching junk would wedge the
  // route on a segment that has no content to show.
  requestRouteTab("workspace", "plugins"); // a Catalog segment, not a Workspace one
  requestRouteTab("catalog", "repos"); // and the reverse
  requestRouteTab("workspace", "nonsense");
  assert.equal(takeRouteTab("workspace"), null);
  assert.equal(takeRouteTab("catalog"), null);
});

test("isRouteTab is scoped per route", () => {
  assert.ok(isRouteTab("catalog", "plugins"));
  assert.ok(isRouteTab("catalog", "extensions"));
  assert.ok(isRouteTab("catalog", "skills"));
  assert.ok(!isRouteTab("catalog", "repos"));
  assert.ok(isRouteTab("workspace", "repos"));
  assert.ok(isRouteTab("workspace", "environments"));
  assert.ok(isRouteTab("workspace", "docs"));
  assert.ok(!isRouteTab("workspace", "skills"));
});

test("unsubscribing one listener leaves the others intact", () => {
  const a: string[] = [];
  const b: string[] = [];
  const offA = onRouteTab("workspace", (t) => a.push(t));
  onRouteTab("workspace", (t) => b.push(t));
  offA();
  requestRouteTab("workspace", "docs");
  assert.deepEqual(a, []);
  assert.deepEqual(b, ["docs"]);
});
