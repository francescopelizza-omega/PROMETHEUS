/**
 * memory-probe.test.ts — the app must ask the KERNEL, like the watchdogs do.
 *
 * The metric matters more than the plumbing here. `vm_stat` free+speculative was the number the
 * old guards used, and on this hardware it sits at 0.9–1.5 GB while the kernel reports ~90%
 * free — 1,925 false positives before it was replaced. These tests pin the replacement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMemAvailable, parseSysctlNumbers, underMemoryPressure } from "./memory-probe.js";

test("sysctl output parses in order: pressure level, then free percent", () => {
  assert.deepEqual(parseSysctlNumbers("1\n86\n"), [1, 86]);
  assert.deepEqual(parseSysctlNumbers("  2 \n\n 14 \n"), [2, 14]);
  assert.deepEqual(parseSysctlNumbers(""), []);
  assert.deepEqual(parseSysctlNumbers("not-a-number\n7"), [7], "junk lines are dropped");
});

test("MemAvailable is read from /proc/meminfo in bytes", () => {
  const meminfo =
    "MemTotal:       65536000 kB\nMemFree:         1024000 kB\nMemAvailable:   32768000 kB\n";
  assert.equal(parseMemAvailable(meminfo), 32768000 * 1024);
  assert.equal(parseMemAvailable("MemTotal: 1 kB"), null);
  assert.equal(parseMemAvailable(""), null);
});

test("pressure follows the kernel, not free bytes", () => {
  const base = { totalBytes: 64e9, headroomBytes: 6e9, source: "kernel" as const };
  // The 2026-09-22 case: loading a 23 GB model drained free+speculative to 44 MB while the
  // kernel still reported 57% free. That is NOT pressure, and calling it pressure is what
  // killed every model within seconds of loading it.
  assert.equal(
    underMemoryPressure({ ...base, availableBytes: 0.57 * 64e9, pressureLevel: 1 }),
    false,
  );
  // The kernel saying "warning" IS pressure, whatever the byte count looks like.
  assert.equal(
    underMemoryPressure({ ...base, availableBytes: 0.57 * 64e9, pressureLevel: 2 }),
    true,
  );
  assert.equal(
    underMemoryPressure({ ...base, availableBytes: 0.5 * 64e9, pressureLevel: 4 }),
    true,
  );
  // …and so is genuinely low free memory, when no pressure level is available.
  assert.equal(underMemoryPressure({ ...base, availableBytes: 0.1 * 64e9 }), true);
  assert.equal(underMemoryPressure({ ...base, availableBytes: 0.5 * 64e9 }), false);
});
