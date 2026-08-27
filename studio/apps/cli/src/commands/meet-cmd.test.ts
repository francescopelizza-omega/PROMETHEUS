/**
 * commands/meet-cmd.test.ts — `prometheus meet` over a REAL temp directory (never the real cwd
 * / real filesystem beyond that one throwaway tree — this command reads a whole directory tree,
 * so unlike most stores here there is no "home" to accidentally default to, but there is very
 * much a real cwd/`process.cwd()` that must never be the thing under test either).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runMeetCommand } from "./meet-cmd.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `prom-meet-cmd-${prefix}-`));
}

test("runMeetCommand: detects a stack and renders a friendly overview", () => {
  const cwd = tempDir("node-project");
  try {
    writeFileSync(join(cwd, "package.json"), "{}");
    writeFileSync(join(cwd, "README.md"), "# Hello");
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "index.ts"), "export function main() {}");

    const res = runMeetCommand(cwd);
    assert.equal(res.exitCode, 0);
    assert.match(res.text ?? "", /Node\.js \/ JavaScript/);
    assert.match(res.text ?? "", /README\.md/);
    assert.equal(res.json?.ok, true);
    assert.ok(Array.isArray(res.json?.detectedStacks));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runMeetCommand: an empty directory renders cleanly, no stack guessed", () => {
  const cwd = tempDir("empty");
  try {
    const res = runMeetCommand(cwd);
    assert.equal(res.exitCode, 0);
    assert.match(res.text ?? "", /^0 files/);
    assert.deepEqual(res.json?.detectedStacks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runMeetCommand: a nonexistent directory is a clean error, never a thrown exception", () => {
  const res = runMeetCommand(join(tmpdir(), "prom-meet-cmd-does-not-exist-at-all"));
  assert.equal(res.exitCode, 1);
  assert.equal(res.json?.ok, false);
  assert.match(res.text ?? "", /error:/);
});
