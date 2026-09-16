/**
 * ticker.test.ts — ACTIVE EVICTION polling only (the fleet ticker itself had no test file before
 * this feature; full coverage of the heartbeat/meter machinery is a separate, pre-existing gap
 * outside this feature's scope). `home` points at a fresh temp dir per test so the ticker's own
 * heartbeat write doesn't touch a real `$PROMETHEUS_HOME`; `readEvictionEventsFn` is injected so
 * these tests never depend on a real eviction-log file either.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EvictionEvent } from "@prometheus/engine-bridge";

import { startFleetTicker } from "./ticker.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "prom-home-"));
}

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

test("startFleetTicker: eviction-log entries already present at startup are NOT announced (old news)", async () => {
  const home = tmpHome();
  try {
    const seen: EvictionEvent[] = [];
    const ticker = startFleetTicker({
      home,
      id: "s1",
      cwd: () => "/tmp",
      model: () => "m",
      onEviction: (e) => seen.push(e),
      readEvictionEventsFn: () => [fakeEvent({ id: "already-there" })],
    });
    await ticker.refresh();
    assert.deepEqual(seen, []);
    ticker.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("startFleetTicker: a NEW eviction-log entry appearing after startup is announced exactly once", async () => {
  const home = tmpHome();
  try {
    const seen: EvictionEvent[] = [];
    let events: EvictionEvent[] = [];
    const ticker = startFleetTicker({
      home,
      id: "s1",
      cwd: () => "/tmp",
      model: () => "m",
      onEviction: (e) => seen.push(e),
      readEvictionEventsFn: () => events,
    });
    await ticker.refresh(); // seeds on an empty log — nothing to announce yet
    assert.deepEqual(seen, []);

    events = [fakeEvent({ id: "evt-new" })];
    await ticker.refresh(); // this cycle sees the new entry
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.id, "evt-new");

    await ticker.refresh(); // no NEW entry since — must not re-announce the same one
    assert.equal(seen.length, 1);
    ticker.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("startFleetTicker: several new entries between ticks are all announced, in order", async () => {
  const home = tmpHome();
  try {
    const seen: EvictionEvent[] = [];
    let events: EvictionEvent[] = [];
    const ticker = startFleetTicker({
      home,
      id: "s1",
      cwd: () => "/tmp",
      model: () => "m",
      onEviction: (e) => seen.push(e),
      readEvictionEventsFn: () => events,
    });
    await ticker.refresh();
    events = [fakeEvent({ id: "e1" }), fakeEvent({ id: "e2" })];
    await ticker.refresh();
    assert.deepEqual(
      seen.map((e) => e.id),
      ["e1", "e2"],
    );
    ticker.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("startFleetTicker: works fine with no onEviction callback at all (default no-op)", async () => {
  const home = tmpHome();
  try {
    const ticker = startFleetTicker({
      home,
      id: "s1",
      cwd: () => "/tmp",
      model: () => "m",
      readEvictionEventsFn: () => [fakeEvent()],
    });
    await assert.doesNotReject(() => ticker.refresh());
    ticker.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
