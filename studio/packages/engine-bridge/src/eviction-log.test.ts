import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { EvictionEvent } from "./eviction-log.js";
import { evictionLogPath, findRecentEviction, readEvictionEvents, recordEvictionEvent } from "./eviction-log.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "prom-home-"));
}

test("evictionLogPath: lives at <home>/state/eviction-events.json", () => {
  assert.equal(evictionLogPath("/home/.prometheus"), "/home/.prometheus/state/eviction-events.json");
});

test("readEvictionEvents: a missing log yields an empty list, never throws", () => {
  const home = tmpHome();
  try {
    assert.deepEqual(readEvictionEvents(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readEvictionEvents: a corrupt file also degrades to an empty list", () => {
  const home = tmpHome();
  try {
    mkdirSync(dirname(evictionLogPath(home)), { recursive: true });
    writeFileSync(evictionLogPath(home), "{ not json at all");
    assert.deepEqual(readEvictionEvents(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readEvictionEvents: a JSON file holding a non-array degrades to an empty list", () => {
  const home = tmpHome();
  try {
    mkdirSync(dirname(evictionLogPath(home)), { recursive: true });
    writeFileSync(evictionLogPath(home), JSON.stringify({ not: "an array" }));
    assert.deepEqual(readEvictionEvents(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readEvictionEvents: malformed entries within an otherwise-valid array are filtered out, not fatal", () => {
  const home = tmpHome();
  try {
    mkdirSync(dirname(evictionLogPath(home)), { recursive: true });
    writeFileSync(
      evictionLogPath(home),
      JSON.stringify([{ garbage: true }, { id: "x", runnerId: "ollama", name: "Ollama", ramPct: 96, ceiling: 95, at: "now", reason: "r" }]),
    );
    const events = readEvictionEvents(home);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, "x");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("recordEvictionEvent then readEvictionEvents round-trips, with a generated id and timestamp", () => {
  const home = tmpHome();
  try {
    const recorded = recordEvictionEvent(
      { runnerId: "ollama", name: "Ollama", pid: 4242, ramPct: 96, ceiling: 95, reason: "RAM at 96% ≥ 95%" },
      home,
      () => 1_700_000_000_000,
    );
    assert.ok(recorded.id.length > 0);
    assert.equal(recorded.at, new Date(1_700_000_000_000).toISOString());
    const events = readEvictionEvents(home);
    assert.deepEqual(events, [recorded]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("recordEvictionEvent: successive calls append, each with a distinct id", () => {
  const home = tmpHome();
  try {
    const first = recordEvictionEvent(
      { runnerId: "ollama", name: "Ollama", ramPct: 96, ceiling: 95, reason: "first" },
      home,
    );
    const second = recordEvictionEvent(
      { runnerId: "ollama", name: "Ollama", ramPct: 97, ceiling: 95, reason: "second" },
      home,
    );
    const events = readEvictionEvents(home);
    assert.equal(events.length, 2);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(events.map((e) => e.reason), ["first", "second"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("recordEvictionEvent: caps at the most recent events, dropping the oldest first", () => {
  const home = tmpHome();
  try {
    for (let i = 0; i < 55; i++) {
      recordEvictionEvent({ runnerId: "ollama", name: "Ollama", ramPct: 96, ceiling: 95, reason: `evt-${i}` }, home);
    }
    const events = readEvictionEvents(home);
    assert.equal(events.length, 50, "capped at MAX_EVENTS");
    assert.equal(events[0]?.reason, "evt-5", "the oldest 5 were dropped");
    assert.equal(events.at(-1)?.reason, "evt-54");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("recordEvictionEvent: releases its own write-lock after every call (no leftover contention)", () => {
  const home = tmpHome();
  try {
    recordEvictionEvent({ runnerId: "ollama", name: "Ollama", ramPct: 96, ceiling: 95, reason: "r" }, home);
    assert.throws(
      () => readFileSync(`${evictionLogPath(home)}.lock`, "utf8"),
      "a held lock left behind would wedge every future write's contention check",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function fakeEvent(overrides: Partial<EvictionEvent> = {}): EvictionEvent {
  return {
    id: "evt-1",
    runnerId: "ollama",
    name: "Ollama",
    ramPct: 97,
    ceiling: 95,
    at: new Date().toISOString(),
    reason: "RAM at 97% ≥ 95%",
    ...overrides,
  };
}

test("findRecentEviction: undefined runnerId never matches anything (no accidental wildcard)", () => {
  assert.equal(
    findRecentEviction(undefined, () => [fakeEvent()]),
    undefined,
  );
});

test("findRecentEviction: a fresh, matching event is found", () => {
  const event = fakeEvent({ at: new Date(Date.now() - 5_000).toISOString() });
  assert.deepEqual(findRecentEviction("ollama", () => [event]), event);
});

test("findRecentEviction: a DIFFERENT runnerId is never matched", () => {
  const event = fakeEvent({ runnerId: "some-recipe-id" });
  assert.equal(findRecentEviction("ollama", () => [event]), undefined);
});

test("findRecentEviction: an event outside the recency window is treated as stale, not a match", () => {
  const stale = fakeEvent({ at: new Date(Date.now() - 10 * 60_000).toISOString() });
  assert.equal(findRecentEviction("ollama", () => [stale]), undefined);
});

test("findRecentEviction: with TWO matching events in the window, returns the MOST RECENT one, not the oldest", () => {
  // events are appended oldest-first (recordEvictionEvent pushes onto the end), so a naive
  // `.find()` over the array would return `older` here — the regression this guards against.
  const older = fakeEvent({ id: "evt-older", pid: 111, at: new Date(Date.now() - 30_000).toISOString() });
  const newer = fakeEvent({ id: "evt-newer", pid: 222, at: new Date(Date.now() - 1_000).toISOString() });
  assert.deepEqual(findRecentEviction("ollama", () => [older, newer]), newer);
});

test("findRecentEviction: a custom recencyMs is honored", () => {
  const event = fakeEvent({ at: new Date(Date.now() - 5_000).toISOString() });
  assert.deepEqual(findRecentEviction("ollama", () => [event], 10_000), event);
  assert.equal(findRecentEviction("ollama", () => [event], 1_000), undefined);
});

test("recordEvictionEvent creates the state directory on a completely fresh home", () => {
  const home = tmpHome();
  try {
    assert.doesNotThrow(() =>
      recordEvictionEvent({ runnerId: "ollama", name: "Ollama", ramPct: 96, ceiling: 95, reason: "r" }, home),
    );
    assert.equal(readEvictionEvents(home).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
