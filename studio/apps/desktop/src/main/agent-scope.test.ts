/**
 * agent-scope.test.ts — the desktop agent's file tools must respect the working set.
 *
 * Its own file because `ide-ipc.test.ts` already mocks `electron`, and node:test refuses a second
 * mock of the same module in one file.
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

test("agent:systemTool refuses a read outside the working set", async () => {
  /**
   * `runSystemTool` accepts `roots` but its READ tools never consult them — the only path guard
   * inside it is `guardSecretPath`, which matches credential FILENAMES (`.env`, `*.pem`,
   * `.ssh/*`). The CLI enforces scope one layer above, in `agent-runtime`'s dispatcher; this
   * handler called `runSystemTool` directly, so the desktop agent had no file scope at all.
   *
   * Proven through this very handler with the working set correctly established
   * (`roots in force: ["/private/tmp/r10ws"]`):
   *     read_file /etc/passwd     → ok:true, full contents
   *     read_file ~/.zsh_history  → ok:true, the user's real shell history
   * Tool output is folded into the model's thread, and the thread may go to a cloud endpoint.
   */
  const fakeIpcMain = makeFakeIpcMain();
  // mock.module's option is `namedExports` up to Node 25 and `exports` from Node 26 (which deprecates
  // namedExports and rejects the two together). CI and .nvmrc run Node 22, where `exports` is
  // silently ignored: the mock then exports nothing and the import below fails to link.
  const MOCK_EXPORTS =
    Number(process.versions.node.split(".")[0]) >= 26 ? "exports" : "namedExports";

  mock.module("electron", {
    [MOCK_EXPORTS]: {
      ipcMain: fakeIpcMain,
      BrowserWindow: class FakeBrowserWindow {},
      session: { fromPartition: () => ({}) },
    },
  });
  const { registerIdeIpcHandlers } = await import("./ide-ipc.js");
  const pg = await import("./ide/path-guard.js");
  const stub = () => new EventEmitter() as never;
  const dispose = registerIdeIpcHandlers({
    lsp: stub(),
    dap: stub(),
    pty: stub(),
    fsWatch: stub(),
  } as never);

  try {
    const ws = mkdtempSync(join(tmpdir(), "prom-agent-scope-"));
    writeFileSync(join(ws, "inside.txt"), "inside\n");

    // the real open-folder sequence: the picker grants, then the renderer declares
    pg.clearGrantedRoots();
    pg.grantWorkingSetRoot(ws);
    const setWs = fakeIpcMain.handlerFor("ide:workingSet.set");
    assert.ok(setWs);
    await setWs({}, { roots: [ws] });
    assert.ok(pg.getWorkingSetRoots().length > 0, "precondition: a working set is in force");

    const sys = fakeIpcMain.handlerFor("agent:systemTool");
    assert.ok(sys, "agent:systemTool is not registered");
    const ev = { sender: { send() {}, isDestroyed: () => false } };

    for (const outside of ["/etc/passwd", "~/.zsh_history"]) {
      const r = (await sys(ev, {
        name: "read_file",
        args: { path: outside },
        cwd: ws,
      })) as { ok: boolean; summary: string };
      assert.equal(r.ok, false, `${outside} was readable from the desktop agent`);
      assert.match(r.summary, /outside the working set/);
    }

    // self-validating: a file INSIDE the workspace still reads, or the guard is a regression.
    const ok = (await sys(ev, {
      name: "read_file",
      args: { path: join(ws, "inside.txt") },
      cwd: ws,
    })) as { ok: boolean; summary: string };
    assert.equal(ok.ok, true, ok.summary);
    assert.match(ok.summary, /inside/);
  } finally {
    /**
     * Restore the module-level guard state.
     *
     * `path-guard` holds `grantedRoots`/`workingSetRoots` as process-wide singletons, and the
     * runner shares one process across suites — leaving a working set in force made
     * `ide-profile.test.ts` fail in the FULL suite while passing in isolation. Clearing the
     * grants first means the declaration falls back to "no roots", the original default.
     */
    pg.clearGrantedRoots();
    pg.setWorkingSetRoots([]);
    dispose();
  }
});
