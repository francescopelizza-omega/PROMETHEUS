/**
 * codebase-overview-ipc.test.ts — node:test coverage for registerCodebaseOverviewIpcHandlers():
 * `codebase:overview` walks the CURRENTLY OPEN workspace root (a getter, read fresh on every
 * call — mirrors persona-ipc.test.ts's own "read fresh, not captured at registration" proof) and
 * returns a plain-data overview; no workspace open, or the root being unreadable, is a clean
 * `{ok:false}` rather than a thrown exception.
 *
 * codebase-overview-ipc.ts does a REAL top-level `import { ipcMain } from "electron"`, so this
 * suite uses node:test's `mock.module()` (wired into scripts/run-tests.mjs) to substitute a fake
 * exposing just `ipcMain`, then calls the registered handler DIRECTLY (bypassing real IPC
 * transport) against a real tmpdir tree — never the real filesystem beyond that tree.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import type { CodebaseOverviewResult } from "../shared/ipc-contract.js";
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

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "prom-codebase-overview-ipc-"));
  dirs.push(d);
  return d;
}

/** What `workspaceRoot()` returns — mutated across tests to simulate opening/closing folders. */
let openRoot: string | undefined;

const fakeIpcMain = makeFakeIpcMain();
mock.module("electron", { exports: { ipcMain: fakeIpcMain } });
const { registerCodebaseOverviewIpcHandlers } = await import("./codebase-overview-ipc.js");
const dispose = registerCodebaseOverviewIpcHandlers(() => openRoot);

test("codebase:overview: no workspace open is a clean ok:false, never a thrown exception", async () => {
  openRoot = undefined;
  const res = (await fakeIpcMain.invoke(IPC.codebaseOverview, {})) as CodebaseOverviewResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /no workspace/i);
});

test("codebase:overview: walks the open root and returns a real overview", async () => {
  const root = tmp();
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "README.md"), "# Hi");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export function main() {}");
  openRoot = root;

  const res = (await fakeIpcMain.invoke(IPC.codebaseOverview, {})) as CodebaseOverviewResult;
  assert.equal(res.ok, true);
  assert.ok(res.overview);
  assert.ok(res.overview?.detectedStacks.includes("Node.js / JavaScript"));
  assert.equal(res.overview?.readmePath, "README.md");
  assert.equal(res.overview?.fileCount, 3);
});

test("codebase:overview: the workspaceRoot getter is read fresh, not captured at registration", async () => {
  const first = tmp();
  writeFileSync(join(first, "Cargo.toml"), "[package]");
  const second = tmp();
  writeFileSync(join(second, "go.mod"), "module example.com/x");

  openRoot = first;
  const res1 = (await fakeIpcMain.invoke(IPC.codebaseOverview, {})) as CodebaseOverviewResult;
  assert.ok(res1.overview?.detectedStacks.includes("Rust"));

  openRoot = second;
  const res2 = (await fakeIpcMain.invoke(IPC.codebaseOverview, {})) as CodebaseOverviewResult;
  assert.ok(res2.overview?.detectedStacks.includes("Go"));
  assert.ok(!res2.overview?.detectedStacks.includes("Rust"));
});

test("codebase:overview: a root that is not a directory is a clean ok:false", async () => {
  const root = tmp();
  const filePath = join(root, "not-a-dir");
  writeFileSync(filePath, "hello");
  openRoot = filePath;

  const res = (await fakeIpcMain.invoke(IPC.codebaseOverview, {})) as CodebaseOverviewResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not a directory/);
});

test("registerCodebaseOverviewIpcHandlers: a full dispose lets re-registration succeed (window-reload safety)", () => {
  assert.deepEqual([...fakeIpcMain.handledChannels()], [IPC.codebaseOverview]);
  dispose();
  assert.equal(fakeIpcMain.handledChannels().size, 0);
  assert.doesNotThrow(() => {
    registerCodebaseOverviewIpcHandlers(() => openRoot);
  }, "re-registering after a full dispose must not throw double-registration");
  assert.deepEqual([...fakeIpcMain.handledChannels()], [IPC.codebaseOverview]);
});

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
