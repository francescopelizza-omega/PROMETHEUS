/**
 * auth-level-ipc.test.ts — the app and the terminal share ONE saved autonomy level.
 *
 * This is the half of the unification that lives in main. The renderer's half (seeding from the
 * local mirror, hydrating from this channel, and NOT persisting a mode-derived level) is covered
 * in `renderer/stores/authorisation-*.test.ts`.
 *
 * `auth-level-ipc.ts` does a real top-level `import { ipcMain } from "electron"`, so this suite
 * uses node:test's `mock.module()` — wired into scripts/run-tests.mjs — to substitute a fake and
 * then calls the registered handler directly. `mock.module("electron", …)` may only be called
 * once per process, so the mock, the import and the registration all happen once at file scope.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import type { AuthLevelResult } from "../shared/ipc-contract.js";
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
    invoke(channel: string, arg?: unknown): unknown {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler registered for '${channel}'`);
      return fn(undefined, arg);
    },
  };
}

const fakeIpcMain = makeFakeIpcMain();
mock.module("electron", { exports: { ipcMain: fakeIpcMain } });
const { registerAuthLevelIpcHandlers } = await import("./auth-level-ipc.js");

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("authLevel:get reports 'never set' as null, not as the default", async () => {
  const home = tmp("prom-authipc-fresh-");
  const dispose = registerAuthLevelIpcHandlers({ home });
  try {
    const res = (await fakeIpcMain.invoke(IPC.authLevelGet)) as AuthLevelResult;
    assert.equal(res.ok, true);
    assert.equal(
      res.level,
      null,
      "never-chosen and chosen-to-be-1 are different facts; only the first may be overwritten",
    );
    assert.ok(res.path?.endsWith(join(".prometheus", "config", "authorisation.json")));
  } finally {
    dispose();
  }
});

test("authLevel:set writes the SAME file the CLI reads, and get reads it back", async () => {
  const home = tmp("prom-authipc-rt-");
  const dispose = registerAuthLevelIpcHandlers({ home });
  try {
    const set = (await fakeIpcMain.invoke(IPC.authLevelSet, { level: 6 })) as AuthLevelResult;
    assert.equal(set.ok, true);
    assert.equal(set.level, 6);

    // the file itself — this is the whole point of the channel: the GUI kept its level in
    // renderer localStorage, so a level set here was invisible to `prometheus` on the terminal
    const onDisk = JSON.parse(
      readFileSync(join(home, ".prometheus", "config", "authorisation.json"), "utf8"),
    );
    assert.equal(onDisk.level, 6);

    const got = (await fakeIpcMain.invoke(IPC.authLevelGet)) as AuthLevelResult;
    assert.equal(got.level, 6);

    // and the CLI's own reader sees exactly the same value
    const { cliProfiles } = await import("@prometheus/core");
    assert.equal(cliProfiles.readSavedAuthLevel(home), 6);
  } finally {
    dispose();
  }
});

test("a level set by the CLI is what the app opens with", async () => {
  const home = tmp("prom-authipc-fromcli-");
  const { cliProfiles } = await import("@prometheus/core");
  cliProfiles.saveAuthLevel(4, home); // as if `/authorisation 4` had been typed in the terminal
  const dispose = registerAuthLevelIpcHandlers({ home });
  try {
    const res = (await fakeIpcMain.invoke(IPC.authLevelGet)) as AuthLevelResult;
    assert.equal(res.level, 4, "the app must adopt the terminal's posture");
  } finally {
    dispose();
  }
});

test("an UNMIGRATED install is still read, from the legacy config root", async () => {
  const home = tmp("prom-authipc-legacy-");
  mkdirSync(join(home, ".config", "prometheus-studio"), { recursive: true });
  writeFileSync(join(home, ".config", "prometheus-studio", "authorisation.json"), '{"level":7}');
  const dispose = registerAuthLevelIpcHandlers({ home });
  try {
    const res = (await fakeIpcMain.invoke(IPC.authLevelGet)) as AuthLevelResult;
    assert.equal(res.level, 7, "the root move must not read as a lost setting");
  } finally {
    dispose();
  }
});

test("a non-numeric level is refused, and nothing is written", async () => {
  const home = tmp("prom-authipc-bad-");
  const dispose = registerAuthLevelIpcHandlers({ home });
  try {
    for (const bad of [{ level: "6" }, { level: Number.NaN }, {}, null]) {
      const res = (await fakeIpcMain.invoke(IPC.authLevelSet, bad)) as AuthLevelResult;
      assert.equal(res.ok, false, `accepted ${JSON.stringify(bad)}`);
    }
    const got = (await fakeIpcMain.invoke(IPC.authLevelGet)) as AuthLevelResult;
    assert.equal(got.level, null, "a refused write must leave the store untouched");
  } finally {
    dispose();
  }
});

test("dispose removes both channels, so a window teardown leaves no handler behind", async () => {
  const home = tmp("prom-authipc-dispose-");
  const dispose = registerAuthLevelIpcHandlers({ home });
  assert.equal(fakeIpcMain.handledChannels().has(IPC.authLevelGet), true);
  dispose();
  assert.equal(fakeIpcMain.handledChannels().has(IPC.authLevelGet), false);
  assert.equal(fakeIpcMain.handledChannels().has(IPC.authLevelSet), false);
  // re-registering must not throw ("a second handler for …") — the app does this on relaunch
  registerAuthLevelIpcHandlers({ home })();
});
