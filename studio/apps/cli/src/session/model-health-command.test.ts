/**
 * model-health-command.test.ts — `/model-health`'s pure run() body: load the on-disk store for
 * `ctx.home`, render it, and write it out one line at a time. Seeds real data on disk through
 * model-health-store.ts's OWN recordEndpointHealth/saveModelHealth (never faked), so this test
 * exercises the real load path end to end.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { EndpointHealthRecord } from "@prometheus/core";

import { runModelHealthCommand } from "./model-health-command.js";
import { recordEndpointHealth, saveModelHealth } from "./model-health-store.js";

/** A fake SlashCtx-shaped object: captures every write() call, in order. */
function fakeCtx(home: string): { home: string; write: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { home, write: (line) => lines.push(line), lines };
}

function record(overrides: Partial<EndpointHealthRecord> = {}): EndpointHealthRecord {
  return {
    endpointId: "local-ollama",
    model: "llama3",
    locality: "local",
    transport: "native",
    demonstrated: true,
    nativeCalls: 3,
    textCallsWhileNative: 0,
    textSyntaxCalls: 0,
    nativeRejected: false,
    breakerState: "closed",
    breakerFailures: 0,
    breakerOpenedAt: null,
    contextWindow: 8192,
    contextWindowSource: "ollama",
    lastUsedIso: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

test("runModelHealthCommand: an empty store prints the 'nothing used yet' line and does not throw", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-model-health-empty-"));
  try {
    const ctx = fakeCtx(home);
    assert.doesNotThrow(() => runModelHealthCommand(ctx));
    assert.ok(ctx.lines.length >= 2, "expected at least a header line + the empty-store line");
    assert.ok(
      ctx.lines.some((l) => l.includes("no endpoint has been used yet this install")),
      `expected an empty-store message, got:\n${ctx.lines.join("\n")}`,
    );
    // ONE line at a time — nothing joined/multi-line inside a single write() call.
    for (const l of ctx.lines)
      assert.ok(!l.includes("\n"), `write() call carried a newline: ${JSON.stringify(l)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runModelHealthCommand: a seeded endpoint's id and model both appear in the printed table", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-model-health-one-"));
  try {
    recordEndpointHealth(record(), home);
    const ctx = fakeCtx(home);
    runModelHealthCommand(ctx, Date.parse("2026-08-18T00:00:05.000Z"));
    const joined = ctx.lines.join("\n");
    assert.ok(joined.includes("local-ollama"), `expected the endpoint id in the table:\n${joined}`);
    assert.ok(joined.includes("llama3"), `expected the model name in the table:\n${joined}`);
    // still one write() call per line.
    assert.equal(ctx.lines.length, joined.split("\n").length);
    for (const l of ctx.lines) assert.ok(!l.includes("\n"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runModelHealthCommand: multiple endpoints all surface, and nowMs is honored for the breaker column", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-model-health-many-"));
  try {
    const local = record({ endpointId: "local-ollama", model: "llama3" });
    const cloud = record({
      endpointId: "cloud-anthropic",
      model: "claude",
      locality: "cloud",
      contextWindowSource: "declared",
      breakerState: "open",
      breakerFailures: 4,
      breakerOpenedAt: Date.parse("2026-08-18T00:00:00.000Z"),
      lastUsedIso: "2026-08-18T00:00:10.000Z",
    });
    // seed both via saveModelHealth directly (store keyed by endpointId), mirroring what
    // recordEndpointHealth would produce for two separate turns.
    saveModelHealth({ "local-ollama": local, "cloud-anthropic": cloud }, home);

    const ctx = fakeCtx(home);
    // 5s after the breaker opened, well inside the default 30s cool-down.
    runModelHealthCommand(ctx, Date.parse("2026-08-18T00:00:05.000Z"));
    const joined = ctx.lines.join("\n");
    assert.ok(joined.includes("local-ollama") && joined.includes("llama3"));
    assert.ok(joined.includes("cloud-anthropic") && joined.includes("claude"));
    assert.ok(
      joined.includes("failing fast"),
      `expected the open breaker to read as failing fast:\n${joined}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runModelHealthCommand: nowMs is optional (defaults to Date.now()) and still does not throw", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-model-health-default-now-"));
  try {
    recordEndpointHealth(record(), home);
    const ctx = fakeCtx(home);
    assert.doesNotThrow(() => runModelHealthCommand(ctx));
    assert.ok(ctx.lines.join("\n").includes("local-ollama"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
