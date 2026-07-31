/**
 * browser-view.test.ts — the pure browser tab/URL/onion model (privacy browsing).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BrowserState,
  activeTab,
  browserReducer,
  canGoBack,
  canGoForward,
  initialBrowserState,
  isLoadable,
  isOnion,
  normalizeUrl,
  onionPolicy,
  tabLabel,
} from "./browser-view.js";

// ---- URL handling ---------------------------------------------------------- //

test("normalizeUrl: keeps http(s), prefixes bare hosts, searches everything else", () => {
  assert.equal(normalizeUrl("https://example.com"), "https://example.com");
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("sub.host.io/path"), "https://sub.host.io/path");
  assert.match(normalizeUrl("how to wipe metadata"), /^https:\/\/duckduckgo\.com\/\?q=/);
  // dangerous schemes never navigate — they become a search
  assert.match(normalizeUrl("javascript:alert(1)"), /duckduckgo\.com\/\?q=/);
  assert.match(normalizeUrl("file:///etc/passwd"), /duckduckgo\.com\/\?q=/);
});

test("isLoadable allows only http(s)", () => {
  assert.equal(isLoadable("https://x.com"), true);
  assert.equal(isLoadable("http://x.com"), true);
  assert.equal(isLoadable("file:///x"), false);
  assert.equal(isLoadable("ftp://x"), false);
});

test("isOnion detects .onion hosts (with + without scheme)", () => {
  assert.equal(
    isOnion("https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion"),
    true,
  );
  assert.equal(isOnion("expyuzz4wqqyqhjn.onion/wiki"), true);
  assert.equal(isOnion("https://example.com"), false);
});

test("onionPolicy: .onion requires a tor tab", () => {
  const onion = "https://abc.onion";
  assert.equal(onionPolicy(onion, "default").ok, false);
  assert.equal(onionPolicy(onion, "tor").ok, true);
  assert.equal(onionPolicy("https://example.com", "default").ok, true);
});

// ---- reducer --------------------------------------------------------------- //

test("open/activate/close maintains a sane active tab", () => {
  let s: BrowserState = initialBrowserState();
  s = browserReducer(s, { type: "open", id: "1", url: "example.com" });
  s = browserReducer(s, { type: "open", id: "2", url: "duck.com", engine: "tor" });
  assert.equal(s.activeId, "2");
  assert.equal(activeTab(s)?.engine, "tor");
  assert.equal(s.tabs[0]?.url, "https://example.com");
  s = browserReducer(s, { type: "close", id: "2" });
  assert.equal(s.activeId, "1", "active falls back to a surviving tab");
});

test("navigate pushes history; back/forward walk it; truncates forward branch", () => {
  let s = initialBrowserState();
  s = browserReducer(s, { type: "open", id: "1", url: "a.com" });
  s = browserReducer(s, { type: "navigate", id: "1", url: "b.com" });
  s = browserReducer(s, { type: "navigate", id: "1", url: "c.com" });
  let t = activeTab(s);
  assert.deepEqual(t?.history, ["https://a.com", "https://b.com", "https://c.com"]);
  assert.equal(canGoForward(t as NonNullable<typeof t>), false);
  s = browserReducer(s, { type: "back", id: "1" });
  s = browserReducer(s, { type: "back", id: "1" });
  t = activeTab(s);
  assert.equal(t?.url, "https://a.com");
  assert.equal(canGoBack(t as NonNullable<typeof t>), false);
  assert.equal(canGoForward(t as NonNullable<typeof t>), true);
  // navigating from the middle truncates the forward branch
  s = browserReducer(s, { type: "navigate", id: "1", url: "d.com" });
  t = activeTab(s);
  assert.deepEqual(t?.history, ["https://a.com", "https://d.com"]);
});

test("title/loading + tabLabel", () => {
  let s = initialBrowserState();
  s = browserReducer(s, { type: "open", id: "1", url: "https://example.com/path" });
  assert.equal(tabLabel(activeTab(s) as NonNullable<ReturnType<typeof activeTab>>), "example.com");
  s = browserReducer(s, { type: "title", id: "1", title: "Example Domain" });
  s = browserReducer(s, { type: "loading", id: "1", loading: true });
  assert.equal(activeTab(s)?.title, "Example Domain");
  assert.equal(activeTab(s)?.loading, true);
  assert.equal(
    tabLabel(activeTab(s) as NonNullable<ReturnType<typeof activeTab>>),
    "Example Domain",
  );
});
