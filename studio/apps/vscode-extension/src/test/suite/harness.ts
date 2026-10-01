// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * harness.ts — a ~40-line test harness for the VS Code extension host.
 *
 * WHY NOT mocha (the usual choice) OR node:test (the repo's choice elsewhere):
 *
 *   - The suite runs INSIDE VS Code's extension host, launched by `@vscode/test-electron` with
 *     `--extensionTestsPath`. That contract is one module exporting `run(): Promise<void>` which
 *     rejects on failure. Nothing about it needs a framework.
 *   - `node:test` (which `scripts/run-tests.mjs` uses for the other 4900 cases) drives its own
 *     process-level runner and reporter; hosting it inside Electron's already-running loop to
 *     get a pass/fail back is more machinery than the thing it would be testing.
 *   - mocha would be a dependency, a bundling problem (it reaches for dynamic requires esbuild
 *     cannot see) and a second reporting format in the repo.
 *
 * So: register with `test()`, run with `runAll()`, report TAP-ish lines to stdout — which is
 * what `@vscode/test-electron` pipes back to the terminal — and reject if anything failed.
 */

type TestFn = () => void | Promise<void>;

interface Registered {
  name: string;
  fn: TestFn;
}

const registry: Registered[] = [];

export function test(name: string, fn: TestFn): void {
  registry.push({ name, fn });
}

export async function runAll(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  console.log(`1..${registry.length}`);
  for (const [i, t] of registry.entries()) {
    const started = Date.now();
    try {
      await t.fn();
      passed++;
      console.log(`ok ${i + 1} - ${t.name} (${Date.now() - started}ms)`);
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      failures.push(`${t.name}\n${indent(msg)}`);
      console.log(`not ok ${i + 1} - ${t.name} (${Date.now() - started}ms)`);
      console.log(indent(msg));
    }
  }
  console.log(`# pass ${passed}`);
  console.log(`# fail ${failures.length}`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} test(s) failed:\n\n${failures.join("\n\n")}`);
  }
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/* ── assertions (node:assert is available, but these give better messages here) ──*/

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

export function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${message}\n  expected to contain: ${needle}\n  actual: ${haystack}`);
  }
}

/** Poll until `cond` holds or the budget runs out. The extension host is full of async settling. */
export async function waitFor(
  cond: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${message}`);
}
