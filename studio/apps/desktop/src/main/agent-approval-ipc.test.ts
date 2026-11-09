// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent-approval-ipc.test.ts — `agent:systemTool` asks MAIN's ladder, not the renderer's.
 *
 * Its own file because node:test refuses a second mock of `electron` in one file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

function makeFakeIpcMain() {
  const handlers = new Map<string, unknown>();
  return {
    handle(channel: string, fn: unknown): void {
      handlers.set(channel, fn);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    on(): void {},
    off(): void {},
    once(): void {},
    removeAllListeners(): void {},
    handlerFor(channel: string): ((ev: unknown, arg: unknown) => Promise<unknown>) | undefined {
      return handlers.get(channel) as ((ev: unknown, arg: unknown) => Promise<unknown>) | undefined;
    },
  };
}

test("a call main's ladder must ask about runs only with a token or a native yes", async () => {
  const fakeIpcMain = makeFakeIpcMain();
  const MOCK_EXPORTS =
    Number(process.versions.node.split(".")[0]) >= 26 ? "exports" : "namedExports";
  mock.module("electron", {
    [MOCK_EXPORTS]: {
      dialog: { showMessageBox: async () => ({ response: 0 }), showMessageBoxSync: () => 0 },
      ipcMain: fakeIpcMain,
      BrowserWindow: class FakeBrowserWindow {},
      session: { fromPartition: () => ({}) },
    },
  });
  const { registerIdeIpcHandlers } = await import("./ide-ipc.js");
  const pg = await import("./ide/path-guard.js");
  const stub = () => new EventEmitter() as never;
  const asked: string[] = [];
  let answer = false;
  const dispose = registerIdeIpcHandlers({
    lsp: stub(),
    dap: stub(),
    pty: stub(),
    fsWatch: stub(),
    nativeApprover: async (p: { message: string; detail: string }) => {
      asked.push(p.detail);
      return answer;
    },
  } as never);
  try {
    const ws = mkdtempSync(join(tmpdir(), "prom-agent-approval-"));
    const file = join(ws, "inside.txt");
    writeFileSync(file, "inside\n");
    pg.clearGrantedRoots();
    pg.grantWorkingSetRoot(ws);
    await fakeIpcMain.handlerFor("ide:workingSet.set")?.({}, { roots: [ws] });

    const sys = fakeIpcMain.handlerFor("agent:systemTool");
    const mint = fakeIpcMain.handlerFor("agent:approveToolCall");
    assert.ok(sys && mint);
    const ev = { sender: { send() {}, isDestroyed: () => false } };
    // A0 ("paranoid") asks before every action — even a read. The renderer claiming it already
    // asked is not enough: main needs a token, or asks itself.
    const call = { name: "read_file", args: { path: file }, cwd: ws, authLevel: 0 };

    answer = false;
    const denied = (await sys(ev, call)) as { ok: boolean; summary: string };
    assert.equal(denied.ok, false);
    assert.match(denied.summary, /did not approve/);
    assert.equal(asked.length, 1, "main asked natively");

    answer = true;
    const yes = (await sys(ev, call)) as { ok: boolean; summary: string };
    assert.equal(yes.ok, true, yes.summary);
    assert.equal(asked.length, 2);

    // a token minted for THIS call runs it without a second question …
    answer = false;
    const m = (await mint(ev, { name: "read_file", args: { path: file } })) as { token: string };
    const withToken = (await sys(ev, { ...call, approval: m.token })) as { ok: boolean };
    assert.equal(withToken.ok, true);
    assert.equal(asked.length, 2, "no native prompt when the human already approved");
    // … once
    const replay = (await sys(ev, { ...call, approval: m.token })) as { ok: boolean };
    assert.equal(replay.ok, false);
    assert.equal(asked.length, 3);

    // a token for a different call does not cover this one
    const other = (await mint(ev, { name: "read_file", args: { path: `${file}.x` } })) as {
      token: string;
    };
    const swapped = (await sys(ev, { ...call, approval: other.token })) as { ok: boolean };
    assert.equal(swapped.ok, false);

    // the mint channel refuses names main cannot run
    const bad = (await mint(ev, { name: "rm_everything", args: {} })) as { ok: boolean };
    assert.equal(bad.ok, false);
  } finally {
    pg.clearGrantedRoots();
    pg.setWorkingSetRoots([]);
    dispose();
  }
});
