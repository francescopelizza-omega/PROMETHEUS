/**
 * ollama-watchdog.test.ts — the spawn wrapper's one pure, deterministic piece.
 *
 * `spawnWatchdogIfNeeded` itself calls `node:child_process`'s `spawn` directly with no injected
 * seam (by design — see the module docstring: "Fire-and-forget", it must never throw on the
 * caller's turn), exactly like this package's `startModelServer` in model-server.ts, which has
 * the same shape and is likewise not unit-tested at the spawn call itself. Actually spawning a
 * real detached `node` process from a test would leave a background watchdog running against
 * whatever this dev machine's real `$PROMETHEUS_HOME` happens to be — precisely the kind of
 * uncontrolled extra process this whole feature exists to prevent, so it is deliberately not
 * exercised here. What IS pure and worth locking down is where the entry script resolves to.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { watchdogEntryPath } from "./ollama-watchdog.js";

test("watchdogEntryPath: resolves next to this module's own compiled output, not cwd-relative", () => {
  const p = watchdogEntryPath();
  assert.ok(p.endsWith("ollama-watchdog-entry.js"), p);
  assert.equal(fileURLToPath(new URL(".", import.meta.url)), p.slice(0, p.lastIndexOf("/") + 1));
});

test("watchdogEntryPath: the file it points at actually exists (dev-register resolves .js -> .ts)", () => {
  // dev-register.mjs (this repo's test-time TS loader) maps the compiled `.js` specifier back to
  // the `.ts` source, so resolving the real path here is a meaningful check that the two files
  // stayed in the same directory, not a tautology against a missing file.
  const tsSibling = watchdogEntryPath().replace(/\.js$/, ".ts");
  assert.ok(existsSync(tsSibling), `expected a sibling source file at ${tsSibling}`);
});
