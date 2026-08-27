/**
 * budget-ipc.test.ts — node:test coverage for registerBudgetIpcHandlers(): `budget:status`
 * relays the live `DesktopBudgetGate.status()` snapshot, and a null gate (not yet armed) reports
 * the same safe "no cap configured" snapshot rather than throwing.
 *
 * budget-ipc.ts does a REAL top-level `import { ipcMain } from "electron"`, so this suite uses
 * node:test's `mock.module()` (wired into scripts/run-tests.mjs) to substitute a fake exposing
 * just `ipcMain`, then calls the registered handler DIRECTLY (bypassing real IPC transport).
 *
 * `mock.module("electron", ...)` may only be called ONCE per process, so — mirroring
 * model-health-ipc.test.ts — the mock + the ONE resulting module import + registration happen
 * ONCE at file scope. `resetBudgetGate()` is called between tests (a plain function call, not a
 * re-mock) to swap the process-wide gate singleton without re-registering the IPC handler.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import type { BudgetStatusResult } from "../shared/ipc-contract.js";
import { IPC } from "../shared/ipc-contract.js";

type Handler = (event: unknown, arg: unknown) => unknown;

function makeFakeIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handle(channel: string, fn: Handler): void {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handlers.set(channel, fn);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    handledChannels(): Set<string> {
      return new Set(handlers.keys());
    },
    invoke(channel: string, arg: unknown): unknown {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler registered for '${channel}'`);
      return fn(undefined, arg);
    },
  };
}

const fakeIpcMain = makeFakeIpcMain();
mock.module("electron", { exports: { ipcMain: fakeIpcMain } });
const { registerBudgetIpcHandlers } = await import("./budget-ipc.js");
const budgetGateModule = await import("./budget-gate.js");

const dispose = registerBudgetIpcHandlers();

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "prom-budget-ipc-"));
  dirs.push(d);
  return d;
}

test("budget:status: no gate armed yet reports a safe 'no cap configured' snapshot", async () => {
  budgetGateModule.resetBudgetGate();
  const res = (await fakeIpcMain.invoke(IPC.budgetStatus, {})) as BudgetStatusResult;
  assert.equal(res.ok, true);
  assert.equal(res.capped, false);
  assert.deepEqual(res.config, {});
  assert.equal(res.sessionSpentUsd, 0);
  assert.equal(res.dailySpentUsd, 0);
  assert.deepEqual(res.unpriced, []);
});

test("budget:status: relays the live gate's real snapshot", async () => {
  budgetGateModule.resetBudgetGate();
  const home = tmp();
  const pricing = { "gpt-x": { inputUsdPerMTok: 10, outputUsdPerMTok: 10, match: "gpt-x" } };
  // initBudgetGate arms the SAME process-wide singleton getBudgetGate() (and therefore the IPC
  // handler) reads — mirrors how main/index.ts arms it at real app startup.
  // No fixed nowIso here on purpose: initBudgetGate's startedMs defaults to the REAL Date.now()
  // at the moment it's called, so a record timestamped to some other fixed instant could land
  // BEFORE startedMs and be filtered out of the "session" window — real time only moves forward,
  // so leaving record()/status() to their own real-"now" defaults keeps this deterministic.
  budgetGateModule.initBudgetGate(home, pricing);
  budgetGateModule.setBudgetSettings({ "budget.sessionUsd": 5 });
  budgetGateModule.getBudgetGate()?.record({
    locality: "cloud",
    model: "gpt-x",
    promptTokens: 100_000,
    completionTokens: 100_000, // $2.00
  });

  const res = (await fakeIpcMain.invoke(IPC.budgetStatus, {})) as BudgetStatusResult;
  assert.equal(res.ok, true);
  assert.equal(res.capped, true);
  assert.deepEqual(res.config, { sessionUsd: 5 });
  assert.equal(res.sessionSpentUsd, 2);
});

test("registerBudgetIpcHandlers: a full dispose lets re-registration succeed (window-reload safety)", () => {
  assert.deepEqual([...fakeIpcMain.handledChannels()], [IPC.budgetStatus]);
  dispose();
  assert.equal(fakeIpcMain.handledChannels().size, 0);
  assert.doesNotThrow(() => {
    registerBudgetIpcHandlers();
  }, "re-registering after a full dispose must not throw double-registration");
  assert.deepEqual([...fakeIpcMain.handledChannels()], [IPC.budgetStatus]);
});

after(() => {
  budgetGateModule.resetBudgetGate();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
