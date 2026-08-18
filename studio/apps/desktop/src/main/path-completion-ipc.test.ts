/**
 * path-completion-ipc.test.ts — node:test coverage for registerPathCompletionIpcHandlers():
 * the sensitive-path guard, fuzzy ranking + dotfile hiding, the opt-in frecency boost, the
 * record-use round-trip, and register→dispose→register safety (mirrors ide-ipc.test.ts's
 * Task #10 pattern, sized to this module's 2 channels).
 *
 * path-completion-ipc.ts does a REAL top-level `import { ipcMain } from "electron"`, so this
 * suite uses node:test's `mock.module()` (wired into scripts/run-tests.mjs) to substitute a
 * fake exposing just `ipcMain`, then calls the registered handlers DIRECTLY (bypassing real
 * IPC transport) to exercise the actual handler bodies against a real tmpdir filesystem.
 *
 * `mock.module("electron", ...)` may only be called ONCE per process (a second call throws
 * "already mocked"), so — unlike a fresh `loadHandlers()` per test — the mock + the ONE
 * resulting module import happen ONCE at file scope; every test shares that same fake
 * `ipcMain` and the one registration. Tests run in declaration order within a file (node:test's
 * default, no `concurrency` used here), so the register→dispose→register test is placed LAST —
 * it leaves the registry re-registered afterward, but nothing later depends on it.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import { IPC, type PathCompletionListResult } from "../shared/ipc-contract.js";
import { loadPathFrecency } from "./path-frecency-store.js";

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

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // realpath: on macOS, tmpdir() lives under /var, a symlink to /private/var — and
  // assertNotSensitivePath canonicalizes (realpath) every path it guards, so a test
  // comparing a full expected path must start from the SAME canonical form, or it fails
  // on a symlink technicality that has nothing to do with the behavior under test.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "prom-path-completion-ipc-")));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fakeIpcMain = makeFakeIpcMain();
mock.module("electron", { exports: { ipcMain: fakeIpcMain } });
const { registerPathCompletionIpcHandlers } = await import("./path-completion-ipc.js");
registerPathCompletionIpcHandlers();

test("pathCompletionList: dir is required", async () => {
  const res = (await fakeIpcMain.invoke(IPC.pathCompletionList, {})) as PathCompletionListResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /dir is required/);
});

test("pathCompletionList: refuses a sensitive directory (e.g. ~/.ssh)", async () => {
  const res = (await fakeIpcMain.invoke(IPC.pathCompletionList, {
    dir: join(homedir(), ".ssh"),
    query: "",
  })) as PathCompletionListResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /sensitive/);
});

test("pathCompletionList: refuses a sensitive workspaceRoot too, not just dir", async () => {
  await withTmpDir(async (dir) => {
    const res = (await fakeIpcMain.invoke(IPC.pathCompletionList, {
      dir,
      query: "",
      workspaceRoot: join(homedir(), ".ssh"),
      useFrecency: true,
    })) as PathCompletionListResult;
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /sensitive/);
  });
});

test("pathCompletionList: lists + fuzzy-ranks a real directory, dirs get a trailing slash", async () => {
  await withTmpDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "reducer.ts"), "");
    await writeFile(join(dir, "README.md"), "");
    const res = (await fakeIpcMain.invoke(IPC.pathCompletionList, {
      dir,
      query: "rdcr",
    })) as PathCompletionListResult;
    assert.equal(res.ok, true);
    const names = (res.entries ?? []).map((e) => e.name);
    assert.ok(names.includes("reducer.ts"), "a fragmented, non-prefix query should still match");
    assert.ok(!names.includes("README.md"));
  });
});

test("pathCompletionList: dotfiles are hidden unless explicitly typed", async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, ".env"), "");
    await writeFile(join(dir, "index.ts"), "");
    const hidden = (await fakeIpcMain.invoke(IPC.pathCompletionList, {
      dir,
      query: "",
    })) as PathCompletionListResult;
    assert.ok(!(hidden.entries ?? []).some((e) => e.name.startsWith(".")));
    const shown = (await fakeIpcMain.invoke(IPC.pathCompletionList, {
      dir,
      query: ".",
    })) as PathCompletionListResult;
    assert.ok((shown.entries ?? []).some((e) => e.name === ".env"));
  });
});

test("pathCompletionList: useFrecency boosts a remembered favorite to the top on a blank query", async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, "aaa.ts"), "");
    await writeFile(join(dir, "favorite.ts"), "");
    // seed the frecency store directly via a record-use call before listing.
    await fakeIpcMain.invoke(IPC.pathCompletionRecordUse, {
      workspaceRoot: dir,
      path: join(dir, "favorite.ts"),
    });
    const res = (await fakeIpcMain.invoke(IPC.pathCompletionList, {
      dir,
      query: "",
      workspaceRoot: dir,
      useFrecency: true,
    })) as PathCompletionListResult;
    assert.equal(res.entries?.[0]?.name, "favorite.ts");
  });
});

test("pathCompletionList: without useFrecency, past usage does NOT influence ranking", async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, "aaa.ts"), "");
    await writeFile(join(dir, "favorite.ts"), "");
    await fakeIpcMain.invoke(IPC.pathCompletionRecordUse, {
      workspaceRoot: dir,
      path: join(dir, "favorite.ts"),
    });
    const res = (await fakeIpcMain.invoke(IPC.pathCompletionList, {
      dir,
      query: "",
      workspaceRoot: dir,
      // useFrecency omitted — feature "off" for this call
    })) as PathCompletionListResult;
    assert.equal(res.entries?.[0]?.name, "aaa.ts", "plain alphabetical, no frecency boost");
  });
});

test("pathCompletionRecordUse: requires both workspaceRoot and path", async () => {
  const res = await fakeIpcMain.invoke(IPC.pathCompletionRecordUse, { workspaceRoot: "/x" });
  assert.equal((res as { ok: boolean }).ok, false);
});

test("pathCompletionRecordUse: refuses a sensitive workspaceRoot and never touches disk there", async () => {
  const sensitiveDir = join(homedir(), ".ssh");
  const res = (await fakeIpcMain.invoke(IPC.pathCompletionRecordUse, {
    workspaceRoot: sensitiveDir,
    path: "/tmp/whatever.ts",
  })) as { ok: boolean; error?: string };
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /sensitive/);
  // and it must genuinely never have written anything — not just returned an error while
  // still creating the file first.
  const store = await loadPathFrecency(sensitiveDir);
  assert.deepEqual(store.entries, []);
});

test("pathCompletionRecordUse: persists to the workspace's frecency store", async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, "a.ts");
    const res = await fakeIpcMain.invoke(IPC.pathCompletionRecordUse, {
      workspaceRoot: dir,
      path: file,
    });
    assert.equal((res as { ok: boolean }).ok, true);
    const store = await loadPathFrecency(dir);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0]?.path, file);
  });
});

test("registerPathCompletionIpcHandlers: a full dispose lets re-registration succeed (window-reload safety)", () => {
  assert.deepEqual(
    [...fakeIpcMain.handledChannels()].sort(),
    [IPC.pathCompletionList, IPC.pathCompletionRecordUse].sort(),
  );
  // Simulate what the real disposer does (this file never held the original registration's
  // dispose() reference — it's the module-scope call above — so drive removeHandler directly,
  // the exact mechanism the real disposer uses).
  for (const channel of [IPC.pathCompletionList, IPC.pathCompletionRecordUse]) {
    fakeIpcMain.removeHandler(channel);
  }
  assert.equal(fakeIpcMain.handledChannels().size, 0);

  assert.doesNotThrow(() => {
    registerPathCompletionIpcHandlers();
  }, "re-registering after a full dispose must not throw double-registration");
  assert.deepEqual(
    [...fakeIpcMain.handledChannels()].sort(),
    [IPC.pathCompletionList, IPC.pathCompletionRecordUse].sort(),
  );
});
