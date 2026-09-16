/**
 * fleet/meters.test.ts — attribution, and the honesty rules around it.
 *
 * The parsing is easy; what is worth pinning is the DESCENDANT walk (a window's real cost is its
 * children too) and the invariant that "we could not measure this" survives all the way out to
 * the caller instead of being rounded down to a zero that looks like a measurement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePsTable, readCpuPct, resetCpuSampler, sumFleetUsage } from "./meters.js";

const PS = `
  1     0   0.1  12000
501     1   4.0 200000
502   501  10.0 300000
503   502   1.0  50000
900     1  55.0 900000
`;

test("parsePsTable reads the padded four-column ps output", () => {
  const rows = parsePsTable(PS);
  assert.equal(rows.length, 5);
  // `comm` is "" for a four-column table: the probe now asks for five, but the guard still
  // admits the old shape rather than dropping every row of it.
  assert.deepEqual(rows[1], { pid: 501, ppid: 1, pcpu: 4, rssBytes: 200000 * 1024, comm: "" });
});

test("parsePsTable keeps the command column, spaces and all", () => {
  const rows = parsePsTable(
    [
      "  1 0 0.1 12000 /sbin/launchd",
      " 501 1 4.0 200000 /Applications/LM Studio.app/Contents/MacOS/LM Studio",
    ].join("\n"),
  );
  assert.equal(rows[0]?.comm, "/sbin/launchd");
  assert.equal(
    rows[1]?.comm,
    "/Applications/LM Studio.app/Contents/MacOS/LM Studio",
    "an .app path contains spaces — everything after column 4 is the command",
  );
});

test("a SHARED model server the session spawned is NOT billed to that window", () => {
  /**
   * `startModelServer` spawns `ollama serve` with `detached: true`, which makes it a process-group
   * leader but leaves its PPID pointing at the Prometheus that spawned it — so the walk counted
   * it, and the multi-GB `ollama runner` beneath it, as this window's own cost. Both this
   * function's docstring and the line `/fleet` prints to the user say the opposite; the exclusion
   * simply did not exist.
   */
  const ps = [
    "  1     0   0.1  12000 /sbin/launchd",
    "501     1   4.0 200000 /usr/local/bin/prometheus",
    "502   501  10.0 300000 /usr/bin/git",
    // the daemon this session started, and the process that actually holds the weights
    "600   501   2.0 400000 /usr/local/bin/ollama",
    "601   600  30.0 9000000 /opt/homebrew/lib/ollama/llama-server",
  ].join("\n");
  const got = sumFleetUsage(parsePsTable(ps), [501]);
  assert.equal(got.counted, 2, "the session and its git — not the shared runner or its child");
  assert.equal(got.rssBytes, (200000 + 300000) * 1024);
  assert.equal(got.pcpu, 14);
});

test("parsePsTable ignores headers and short lines instead of inventing rows", () => {
  const rows = parsePsTable("  PID  PPID %CPU   RSS\nnot a row\n 7 1 2.5 100\n");
  assert.deepEqual(
    rows.map((r) => r.pid),
    [7],
  );
});

test("a window's cost INCLUDES what it spawned", () => {
  // 501 is the session; 502 is the engine it launched; 503 is a `git` the engine ran. All three
  // are the cost of that window — an attribution that stopped at the session process would
  // report a window running a build as using almost nothing.
  const got = sumFleetUsage(parsePsTable(PS), [501]);
  assert.equal(got.counted, 3);
  assert.equal(got.pcpu, 15);
  assert.equal(got.rssBytes, (200000 + 300000 + 50000) * 1024);
});

test("an unrelated heavy process stays OUT of ours", () => {
  // 900 is the shared model server: it belongs to no window, so it belongs in `other`.
  const got = sumFleetUsage(parsePsTable(PS), [501]);
  assert.ok(got.pcpu < 55, "a shared daemon must not be billed to Prometheus");
});

test("a pid that has already exited contributes nothing and does not throw", () => {
  const got = sumFleetUsage(parsePsTable(PS), [501, 4242]);
  assert.equal(got.counted, 3);
});

test("a cycle in the reported tree terminates", () => {
  // ps snapshots race process death; a reparented row can look like its own ancestor. An
  // infinite walk here would hang the frame, not just the meter.
  const rows = parsePsTable("10 11 1.0 100\n11 10 1.0 100\n");
  const got = sumFleetUsage(rows, [10]);
  assert.equal(got.counted, 2);
});

test("the first CPU read has no baseline and still returns a usable percentage", () => {
  resetCpuSampler();
  const first = readCpuPct();
  assert.ok(first >= 0 && first <= 100, `loadavg fallback out of range: ${first}`);
  const second = readCpuPct();
  assert.ok(second >= 0 && second <= 100, `delta out of range: ${second}`);
});
