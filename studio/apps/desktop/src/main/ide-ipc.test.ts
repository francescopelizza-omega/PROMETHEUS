/**
 * ide-ipc.test.ts — node:test coverage for registerIdeIpcHandlers()'s disposer
 * completeness (Task #10).
 *
 * BUG: `registerIdeIpcHandlers()` registers every `ide:*`/`agent:*` channel via
 * `ipcMain.handle(...)`, then returns a disposer that `ipcMain.removeHandler()`s a
 * hand-kept array of those SAME channels — so a window reload (which calls
 * registerIdeIpcHandlers() → dispose() → registerIdeIpcHandlers() again) can safely
 * re-register. An audit found 25 handled channels (agentSystemTool, ideGitShow, the
 * three ideWorktree* verbs, the five rebase verbs, the five PR-review verbs,
 * ideSetWorkingSet/ideApproveOutside, ideCoverageRun/Import, ideGitApplyPatch, and
 * the three agent:* grant/engine channels) had NEVER been added to that array —
 * Electron's `ipcMain.handle` throws "Attempted to register a second handler" the
 * moment any of them is registered twice, so the SECOND registerIdeIpcHandlers()
 * call (any reload) would crash main. Fixed by adding all 25 to the disposer.
 *
 * ide-ipc.ts does a REAL top-level `import { ipcMain } from "electron"` (plus a
 * transitive `import { BrowserWindow, session } from "electron"` via
 * browser-tool-host.ts). The "electron" npm package installed in this repo is only
 * `getElectronPath()` — a binary-path resolver stub, not the real Electron API — so
 * this file is normally unimportable under plain `node --test`. `node:test`'s
 * `mock.module()` (`--experimental-test-module-mocks`, wired into
 * scripts/run-tests.mjs for this suite) substitutes a fake `electron` exposing just
 * the two named exports this module's import graph touches at LOAD time, which is
 * enough to import the real module and actually CALL registerIdeIpcHandlers()
 * end-to-end — not merely parse its source.
 *
 * Two independent checks, so this can't silently regress again either way:
 *   1. STATIC — every `ipcMain.handle(IPC.X, ...)` call in the source has a
 *      matching entry in the disposer's channel array. Parsed straight from the
 *      file, so there is no second hand-kept list to drift out of sync.
 *   2. BEHAVIORAL — register → dispose → register AGAIN against a fake `ipcMain`
 *      that throws on a double `.handle()` for the same channel exactly like real
 *      Electron does, for the FULL channel list (not a sample) — a channel missing
 *      from the disposer reproduces the live crash right here, in this test.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { IPC } from "../shared/ipc-contract.js";
import type { IdeIpcWiring } from "./ide-ipc.js";
import type { DapHost } from "./ide/dap-host.js";
import type { FsWatchHost } from "./ide/fs-watch.js";
import type { GitHost } from "./ide/git-host.js";
import type { LspHost } from "./ide/lsp-host.js";
import type { PtyHost } from "./ide/pty-host.js";

const SOURCE_PATH = fileURLToPath(new URL("./ide-ipc.ts", import.meta.url));
const SOURCE = readFileSync(SOURCE_PATH, "utf8");

/** Every `IPC.<Channel>` identifier passed to an `ipcMain.handle(...)` call in the
 *  source (single- AND multi-line call forms both match — the regex only requires
 *  whitespace, not a newline count, between `handle(` and `IPC.`). */
function handledChannelIds(): Set<string> {
  const re = /ipcMain\.handle\(\s*IPC\.(\w+)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null = re.exec(SOURCE);
  while (m) {
    out.add(m[1]);
    m = re.exec(SOURCE);
  }
  return out;
}

/** Every `IPC.<Channel>` identifier named inside the disposer's FIRST
 *  `for (const channel of [...]) { ipcMain.removeHandler(channel); }` block — the
 *  array a dispose() call walks to remove the request/response handlers. */
function disposedChannelIds(): Set<string> {
  const returnIdx = SOURCE.indexOf("return () => {");
  const forStart = SOURCE.indexOf("for (const channel of [", returnIdx);
  const forEnd = SOURCE.indexOf("]) {\n      ipcMain.removeHandler(channel);", forStart);
  assert.ok(
    returnIdx > 0 && forStart > 0 && forEnd > 0,
    "disposer shape changed (return / first for-loop not found as expected) — update this test's parser",
  );
  const block = SOURCE.slice(forStart, forEnd);
  const re = /IPC\.(\w+)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null = re.exec(block);
  while (m) {
    out.add(m[1]);
    m = re.exec(block);
  }
  return out;
}

/** Map a set of `IPC.<Channel>` identifiers (e.g. "ideFsRead") to the actual wire
 *  string values (e.g. "ide:fs.read") ipcMain sees. */
function toChannelValues(ids: Set<string>): Set<string> {
  const dict = IPC as unknown as Record<string, string>;
  return new Set([...ids].map((id) => dict[id]));
}

test("every ipcMain.handle(IPC.*) channel has a matching disposer entry (static)", () => {
  const handled = handledChannelIds();
  const disposed = disposedChannelIds();
  // sanity: fail loudly if the parser regressed to matching ~nothing instead of the
  // real ~108, rather than passing vacuously on an empty diff.
  assert.ok(handled.size > 100, `sanity: expected >100 handled channels, saw ${handled.size}`);
  const missing = [...handled].filter((c) => !disposed.has(c)).sort();
  const stale = [...disposed].filter((c) => !handled.has(c)).sort();
  assert.deepEqual(
    missing,
    [],
    "channel(s) handled via ipcMain.handle() but never added to the disposer array — a " +
      "second registerIdeIpcHandlers() (e.g. a window reload) throws on these",
  );
  assert.deepEqual(
    stale,
    [],
    "channel(s) in the disposer array that are no longer ipcMain.handle()'d — dead entries",
  );
});

/** A fake, Electron-shaped `ipcMain`: throws on a double `.handle()` for the same
 *  channel exactly like the real one, so a channel missing from the disposer
 *  reproduces the live "Attempted to register a second handler" crash HERE. */
function makeFakeIpcMain() {
  const handlers = new Map<string, unknown>();
  const listeners = new Map<string, Set<unknown>>();
  return {
    handle(channel: string, fn: unknown): void {
      if (handlers.has(channel)) {
        throw new Error(
          `Attempted to register a second handler for '${channel}': registerIdeIpcHandlers()`,
        );
      }
      handlers.set(channel, fn);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    on(channel: string, fn: unknown): void {
      const set = listeners.get(channel) ?? new Set();
      set.add(fn);
      listeners.set(channel, set);
    },
    removeAllListeners(channel: string): void {
      listeners.delete(channel);
    },
    /** the registered handler, so a test can actually INVOKE a channel. */
    handlerFor(channel: string): ((ev: unknown, arg: unknown) => Promise<unknown>) | undefined {
      return handlers.get(channel) as ((ev: unknown, arg: unknown) => Promise<unknown>) | undefined;
    },
    handledChannels(): Set<string> {
      return new Set(handlers.keys());
    },
  };
}

/** The minimal host wiring registerIdeIpcHandlers touches SYNCHRONOUSLY during
 *  registration/dispose (`.on`/`.off` for the event multiplex) — none of its
 *  per-handler bodies run in this test, so a bare EventEmitter satisfies every host
 *  registerIdeIpcHandlers actually calls at this stage. */
/** The mocked `ipcMain`, kept by the first test that mocks electron. The mock is module-wide and
 *  ide-ipc.js binds `ipcMain` once, at import, so a later test must reach the SAME fake. */
let electronIpcMain: ReturnType<typeof makeFakeIpcMain> | undefined;

function makeWiring(): IdeIpcWiring {
  return {
    lsp: new EventEmitter() as unknown as LspHost,
    dap: new EventEmitter() as unknown as DapHost,
    pty: new EventEmitter() as unknown as PtyHost,
    git: {} as unknown as GitHost,
    fsWatch: new EventEmitter() as unknown as FsWatchHost,
  };
}

test("registerIdeIpcHandlers: register -> dispose -> register again never throws (Task #10)", async () => {
  const fakeIpcMain = makeFakeIpcMain();
  electronIpcMain = fakeIpcMain;
  mock.module("electron", {
    exports: {
      ipcMain: fakeIpcMain,
      // browser-tool-host.ts (imported transitively) touches these two at load time
      // only as type/identity references — getWindow()/session.fromPartition() are
      // never called by registration, so trivial stand-ins are enough.
      BrowserWindow: class FakeBrowserWindow {},
      session: { fromPartition: () => ({}) },
    },
  });

  const { registerIdeIpcHandlers } = await import("./ide-ipc.js");
  const expected = toChannelValues(handledChannelIds());
  const wiring = makeWiring();

  const dispose1 = registerIdeIpcHandlers(wiring);
  assert.deepEqual(
    [...fakeIpcMain.handledChannels()].sort(),
    [...expected].sort(),
    "the first registerIdeIpcHandlers() should register exactly the channels found in source",
  );

  assert.doesNotThrow(() => dispose1(), "dispose() must not throw");
  assert.equal(
    fakeIpcMain.handledChannels().size,
    0,
    "dispose() must remove EVERY handled channel — a leftover here would hide a real gap",
  );

  let dispose2: (() => void) | undefined;
  assert.doesNotThrow(() => {
    dispose2 = registerIdeIpcHandlers(wiring);
  }, "a second registerIdeIpcHandlers() (window reload/recreation) must not throw double-registration");

  assert.deepEqual(
    [...fakeIpcMain.handledChannels()].sort(),
    [...expected].sort(),
    "the second registration should register the exact same full channel set as the first",
  );
  dispose2?.();
  assert.equal(fakeIpcMain.handledChannels().size, 0, "the second dispose must also be complete");
});

test("an ELEVATED desktop clamps the operator's authorisation level, in MAIN", async () => {
  /**
   * The CLI stops for a red acknowledgement before opening a session as root, and its readline
   * and headless hosts clamp too. The desktop had no notion of elevation at all: launched under
   * `sudo`, it restored whatever level the operator had persisted and auto-approved against it as
   * the superuser — where one auto-approved `run_command` or `write_file` reaches the whole
   * machine, not just the workspace.
   *
   * The clamp belongs in MAIN, not the renderer. The renderer is the least-trusted surface in our
   * own app and it supplies `authLevel` on every request, so a warning painted in the UI would be
   * advisory only; enforcing it here means no renderer — ours or a compromised one — can hand the
   * system-tool path a full-autonomy level while running as root.
   */
  const { clampAuthLevelForElevation } = await import("./ide-ipc.js");
  const realUser = process.env.SUDO_USER;
  const realUid = process.env.SUDO_UID;
  try {
    process.env.SUDO_USER = "someone";
    assert.equal(clampAuthLevelForElevation(7), 5, "a root session kept the full-autonomy tier");
    assert.equal(clampAuthLevelForElevation(6), 5);
    // below the ceiling nothing changes — an elevated session stays usable
    assert.equal(clampAuthLevelForElevation(5), 5);
    assert.equal(clampAuthLevelForElevation(1), 1);
    assert.equal(clampAuthLevelForElevation(0), 0);

    Reflect.deleteProperty(process.env, "SUDO_USER");
    Reflect.deleteProperty(process.env, "SUDO_UID");
    if (process.getuid?.() !== 0) {
      assert.equal(clampAuthLevelForElevation(7), 7, "an ordinary session must not be clamped");
    }
  } finally {
    if (realUser === undefined) Reflect.deleteProperty(process.env, "SUDO_USER");
    else process.env.SUDO_USER = realUser;
    if (realUid === undefined) Reflect.deleteProperty(process.env, "SUDO_UID");
    else process.env.SUDO_UID = realUid;
  }
});

test("a no-auto-approve posture clamps the ladder to ask-before-everything", async () => {
  /**
   * The Security-strict profile's stated posture is "gate --strict, NO auto-approve", and it set
   * `autoApprove: false` — which nothing read. Selecting it tightened the gate and the force ban
   * and left auto-approval exactly as it was, so read-only tools kept being auto-approved by the
   * ladder. Level 0 ("paranoid — ask before EVERY action, even reading a file") is what that
   * setting means once it is honoured.
   *
   * The DEFAULT stays untouched: only an explicit `false` clamps, so a user who never chose the
   * profile keeps the ladder they have.
   */
  const { clampAuthLevelForPosture } = await import("./ide-ipc.js");
  assert.equal(
    clampAuthLevelForPosture(7, { autoApprove: false }),
    0,
    "an explicit no-auto-approve did not clamp",
  );
  assert.equal(clampAuthLevelForPosture(2, { autoApprove: false }), 0);
  // absent or true ⇒ the operator's level stands
  assert.equal(clampAuthLevelForPosture(7, { autoApprove: true }), 7);
  assert.equal(clampAuthLevelForPosture(7, {}), 7);
});

test("ide:fs.watch guards the root but keeps the renderer's OWN string as the watch key", async () => {
  // FileTree filters change events with `ev.root === root` (the raw root it asked for). Keying
  // the watcher by the canonical path broke that for any /tmp, /var, symlinked or trailing-slash
  // root, and the explorer silently stopped auto-refreshing. The guard must still refuse ~/.ssh.
  assert.ok(electronIpcMain, "runs after the test that mocks electron");
  const ipc = electronIpcMain as ReturnType<typeof makeFakeIpcMain>;
  const { registerIdeIpcHandlers } = await import("./ide-ipc.js");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const calls: Array<[string, string]> = [];
  const fsWatch = Object.assign(new EventEmitter(), {
    watch: (root: string) => calls.push(["watch", root]),
    unwatch: (root: string) => calls.push(["unwatch", root]),
  }) as unknown as FsWatchHost;
  const dispose = registerIdeIpcHandlers({ ...makeWiring(), fsWatch });
  try {
    const watch = ipc.handlerFor(IPC.ideFsWatch);
    const unwatch = ipc.handlerFor(IPC.ideFsUnwatch);
    assert.ok(watch && unwatch);
    const raw = "/tmp/prom-watch-root/"; // realpath is /private/tmp/…, and a trailing slash
    assert.deepEqual(await watch({}, { root: raw }), { ok: true });
    assert.deepEqual(await unwatch({}, { root: raw }), { ok: true });
    assert.deepEqual(calls, [
      ["watch", raw],
      ["unwatch", raw],
    ]);
    const secret = (await watch({}, { root: join(homedir(), ".ssh") })) as { ok: boolean };
    assert.equal(secret.ok, false, "a sensitive root is still refused");
    assert.equal(calls.length, 2, "…and never reaches the watcher");
  } finally {
    dispose();
  }
});
