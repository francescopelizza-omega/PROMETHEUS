/**
 * effort-ipc.test.ts — the app and the terminal share ONE saved thinking-effort tier.
 *
 * Mirrors auth-level-ipc.test.ts. `effort-ipc.ts` does a real top-level
 * `import { ipcMain } from "electron"`, so this suite substitutes a fake via node:test's
 * `mock.module()` (wired into scripts/run-tests.mjs) and calls the handlers directly.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import type { EffortPrefResult } from "../shared/ipc-contract.js";
import { IPC } from "../shared/ipc-contract.js";

type Handler = (event: unknown, arg: unknown) => unknown;

function makeFakeIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handle(channel: string, fn: Handler): void {
      if (handlers.has(channel)) throw new Error(`second handler for '${channel}'`);
      handlers.set(channel, fn);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    handledChannels(): Set<string> {
      return new Set(handlers.keys());
    },
    invoke(channel: string, arg?: unknown): unknown {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler registered for '${channel}'`);
      return fn(undefined, arg);
    },
  };
}

const fakeIpcMain = makeFakeIpcMain();
mock.module("electron", { exports: { ipcMain: fakeIpcMain } });
const { registerEffortIpcHandlers } = await import("./effort-ipc.js");

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("effort:get reports 'never chosen' as null, not as a default", async () => {
  const home = tmp("prom-effortipc-fresh-");
  const dispose = registerEffortIpcHandlers({ home });
  try {
    const res = (await fakeIpcMain.invoke(IPC.effortGet)) as EffortPrefResult;
    assert.equal(res.ok, true);
    assert.equal(res.tier, null);
    assert.ok(res.path?.endsWith(join(".prometheus", "config", "effort.json")));
  } finally {
    dispose();
  }
});

test("a tier set in the TERMINAL is what the app opens with, and vice-versa", async () => {
  const home = tmp("prom-effortipc-shared-");
  const { cliProfiles } = await import("@prometheus/core");
  cliProfiles.saveEffort("xhigh", home); // as if `/think xhigh` had been typed in the terminal
  const dispose = registerEffortIpcHandlers({ home });
  try {
    assert.equal(((await fakeIpcMain.invoke(IPC.effortGet)) as EffortPrefResult).tier, "xhigh");

    // …and the reverse direction: the app writes the same file the CLI reads
    const set = (await fakeIpcMain.invoke(IPC.effortSet, { tier: "ultra" })) as EffortPrefResult;
    assert.equal(set.ok, true);
    assert.equal(set.tier, "ultra");
    assert.equal(cliProfiles.readSavedEffort(home), "ultra");
    assert.equal(
      JSON.parse(readFileSync(join(home, ".prometheus", "config", "effort.json"), "utf8")).tier,
      "ultra",
    );
  } finally {
    dispose();
  }
});

test("an UNMIGRATED install is still read, from the legacy config root", async () => {
  const home = tmp("prom-effortipc-legacy-");
  mkdirSync(join(home, ".config", "prometheus-studio"), { recursive: true });
  writeFileSync(join(home, ".config", "prometheus-studio", "effort.json"), '{"tier":"max"}');
  const dispose = registerEffortIpcHandlers({ home });
  try {
    assert.equal(((await fakeIpcMain.invoke(IPC.effortGet)) as EffortPrefResult).tier, "max");
  } finally {
    dispose();
  }
});

test("anything that is not a ladder rung is refused, and nothing is written", async () => {
  const home = tmp("prom-effortipc-bad-");
  const dispose = registerEffortIpcHandlers({ home });
  try {
    for (const bad of [{ tier: "MAX" }, { tier: "hyper" }, { tier: 7 }, {}, null]) {
      const res = (await fakeIpcMain.invoke(IPC.effortSet, bad)) as EffortPrefResult;
      assert.equal(res.ok, false, `accepted ${JSON.stringify(bad)}`);
    }
    assert.equal(((await fakeIpcMain.invoke(IPC.effortGet)) as EffortPrefResult).tier, null);
  } finally {
    dispose();
  }
});

test("dispose removes both channels, so a window teardown leaves no handler behind", async () => {
  const home = tmp("prom-effortipc-dispose-");
  const dispose = registerEffortIpcHandlers({ home });
  assert.equal(fakeIpcMain.handledChannels().has(IPC.effortGet), true);
  dispose();
  assert.equal(fakeIpcMain.handledChannels().has(IPC.effortGet), false);
  assert.equal(fakeIpcMain.handledChannels().has(IPC.effortSet), false);
  registerEffortIpcHandlers({ home })(); // re-registering must not throw
});
