/**
 * fleet/heartbeat.test.ts — the presence protocol, and every way a peer can be wrong about
 * another peer.
 *
 * The interesting cases are all failure cases: a crashed instance, a wedged one, a pid the OS
 * handed to somebody else, and a file half-written by a writer we raced.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  DEAD_KEEP_MS,
  type Heartbeat,
  STALE_DEAD_MS,
  STALE_MS,
  clearHeartbeat,
  fleetCounts,
  fleetPids,
  heartbeatPath,
  pidAlive,
  readFleet,
  runDir,
  writeHeartbeat,
} from "./heartbeat.js";

const homes: string[] = [];
function tmpHome(): string {
  const h = mkdtempSync(join(tmpdir(), "prom-fleet-"));
  homes.push(h);
  return h;
}
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const beat = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  pid: 4242,
  id: "sess-1",
  startedAt: new Date(NOW - 60_000).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  cwd: "/work/proj",
  model: "gemma3:27b",
  state: "idle",
  ...over,
});

test("a written heartbeat reads back as a live peer", () => {
  const home = tmpHome();
  assert.ok(writeHeartbeat(beat(), home));
  const peers = readFleet({ home, now: NOW, self: 4242, isAlive: () => true });
  assert.equal(peers.length, 1);
  assert.equal(peers[0]?.state, "idle");
  assert.equal(peers[0]?.self, true);
  assert.equal(peers[0]?.stale, false);
  assert.equal(peers[0]?.model, "gemma3:27b");
});

test("the write is atomic — no .tmp file is left behind for a reader to trip on", () => {
  const home = tmpHome();
  writeHeartbeat(beat(), home);
  assert.deepEqual(readdirSync(runDir(home)), ["4242.json"]);
});

test("a pid that is GONE is dead — this is how a crash reports itself", () => {
  const home = tmpHome();
  writeHeartbeat(beat({ state: "working" }), home);
  const peers = readFleet({ home, now: NOW, isAlive: () => false });
  assert.equal(peers[0]?.state, "dead", "a killed window must not stay `working` forever");
});

test("alive but silent 6–30s keeps its LAST state, flagged stale", () => {
  const home = tmpHome();
  writeHeartbeat(
    beat({ state: "working", updatedAt: new Date(NOW - STALE_MS - 1).toISOString() }),
    home,
  );
  const peers = readFleet({ home, now: NOW, isAlive: () => true });
  // A session blocked eight seconds inside a synchronous `git status` is NOT dead, and calling
  // it dead is the single most damaging thing this bar could get wrong.
  assert.equal(peers[0]?.state, "working");
  assert.equal(peers[0]?.stale, true);
});

test("alive but silent past 30s is dead — the pid-reuse guard", () => {
  const home = tmpHome();
  writeHeartbeat(beat({ updatedAt: new Date(NOW - STALE_DEAD_MS - 1).toISOString() }), home);
  // The OS handed 4242 to something unrelated; it is alive and it is not us. Nothing else can
  // tell the two apart, because a recycled pid does not write our file.
  const peers = readFleet({ home, now: NOW, isAlive: () => true });
  assert.equal(peers[0]?.state, "dead");
});

test("a dead peer is KEPT for a while, then swept", () => {
  const home = tmpHome();
  writeHeartbeat(beat(), home);
  const soon = readFleet({ home, now: NOW + 60_000, isAlive: () => false });
  assert.equal(soon.length, 1, "the `dead` chip has to survive long enough to be read");
  const later = readFleet({ home, now: NOW + DEAD_KEEP_MS + 60_000, isAlive: () => false });
  assert.equal(later.length, 0);
  assert.equal(readdirSync(runDir(home)).length, 0, "…and the file goes with it");
});

test("malformed JSON is skipped, never fatal", () => {
  const home = tmpHome();
  mkdirSync(runDir(home), { recursive: true });
  writeFileSync(join(runDir(home), "99.json"), "{not json");
  writeHeartbeat(beat(), home);
  const peers = readFleet({ home, now: NOW, isAlive: () => true });
  assert.equal(peers.length, 1);
  assert.equal(peers[0]?.pid, 4242);
});

test("a record with an unknown state is rejected rather than rendered", () => {
  const home = tmpHome();
  mkdirSync(runDir(home), { recursive: true });
  // A future build inventing a fifth state must not make this build paint an unlabelled chip.
  writeFileSync(
    join(runDir(home), "77.json"),
    JSON.stringify({ ...beat({ pid: 77 }), state: "brb" }),
  );
  assert.equal(readFleet({ home, now: NOW, isAlive: () => true }).length, 0);
});

test("a missing run/ directory is an empty fleet, not a throw", () => {
  assert.deepEqual(readFleet({ home: join(tmpHome(), "nope"), now: NOW }), []);
});

test("clearHeartbeat removes the row a clean exit would otherwise report as dead", () => {
  const home = tmpHome();
  writeHeartbeat(beat(), home);
  clearHeartbeat(4242, home);
  assert.equal(readFleet({ home, now: NOW, isAlive: () => false }).length, 0);
});

test("counts tally every state and pids exclude the dead", () => {
  const home = tmpHome();
  writeHeartbeat(beat({ pid: 1, state: "working" }), home);
  writeHeartbeat(beat({ pid: 2, state: "idle" }), home);
  writeHeartbeat(beat({ pid: 3, state: "needs-you" }), home);
  writeHeartbeat(beat({ pid: 4, state: "idle" }), home);
  const peers = readFleet({ home, now: NOW, isAlive: (p) => p !== 4 });
  assert.deepEqual(fleetCounts(peers), {
    working: 1,
    idle: 1,
    needsYou: 1,
    dead: 1,
    total: 4,
  });
  // The resource probe must not attribute usage to a pid that no longer exists — and on a
  // machine that recycled it, attributing would count a stranger's CPU as ours.
  assert.deepEqual(fleetPids(peers).sort(), [1, 2, 3]);
});

test("pidAlive says yes for this very process and no for an impossible pid", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0x7fffffff), false);
});

test("heartbeatPath is under <home>/run", () => {
  assert.equal(heartbeatPath(7, "/h"), join("/h", "run", "7.json"));
});

test("an unwritable home returns false rather than throwing", () => {
  // `<file>/run/…` can never be a directory — the mkdir fails, and the session must not care.
  const home = tmpHome();
  const asFile = join(home, "afile");
  writeFileSync(asFile, "x");
  assert.equal(writeHeartbeat(beat(), asFile), false);
});
