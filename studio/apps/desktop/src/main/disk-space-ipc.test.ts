// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * disk-space-ipc.test.ts — Studio's disk-space channels over a fake client and a fake gate.
 *
 * disk-space-ipc.ts does a real top-level `import { ipcMain } from "electron"`, so electron is
 * replaced ONCE for this file (`mock.module` may only be called once per process) and the
 * registered handlers are called directly.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { mock, test } from "node:test";

import type { PrivilegedGate, PrivilegedRequest } from "@prometheus/core/agent-system-host";
import type { DiskSpaceClient } from "@prometheus/engine-bridge";

import { IPC } from "../shared/ipc-contract.js";
import type { KeyInput } from "./terminal-keys.js";

const MOCK_EXPORTS = Number(process.versions.node.split(".")[0]) >= 26 ? "exports" : "namedExports";

type Handler = (event: unknown, arg: unknown) => unknown;
const handlers = new Map<string, Handler>();
const listeners = new Map<string, Handler>();
mock.module("electron", {
  [MOCK_EXPORTS]: {
    ipcMain: {
      handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
      removeHandler: (ch: string) => handlers.delete(ch),
      on: (ch: string, fn: Handler) => listeners.set(ch, fn),
      removeAllListeners: (ch: string) => listeners.delete(ch),
    },
  },
});
const { registerDiskSpaceIpcHandlers } = await import("./disk-space-ipc.js");

const calls: string[] = [];
const ok = { ok: true, command: "x" };
const TREE = { name: "/", path: "/", size: 10, dir: true, children: [] };
const client = {
  mounts: async () => {
    calls.push("mounts");
    return { ...ok, mounts: [] };
  },
  map: async (p: string, a?: { maxNodes?: number }) => {
    calls.push(`map ${p} ${a?.maxNodes}`);
    return { ...ok, tree: TREE };
  },
  levels: async (p: string) => {
    calls.push(`levels ${p}`);
    return { ...ok, levels: [] };
  },
  largestFiles: async (p: string) => {
    calls.push(`files ${p}`);
    return { ...ok, files: [] };
  },
  deletePlan: async (ps: string[], a?: { mode?: string }) => {
    calls.push(`plan ${ps} ${a?.mode}`);
    return { ...ok, planned: true, items: [] };
  },
  deleteConfirm: async (ps: string[], a: { mode?: string; ackHighRisk?: boolean }) => {
    calls.push(`confirm ${ps} ${a.mode} ${a.ackHighRisk === true}`);
    return { ...ok, executed: true, results: [] };
  },
  cleanupPlan: async () => ({ ...ok, findings: [] }),
  privilegedExplorer: async (p?: string) => {
    calls.push(`explorer ${p ?? ""}`);
    return {
      ...ok,
      argv: ["/usr/bin/python3", "-I", "/t/disk_space.py", "--no-sudo", "--log", "/dev/null"],
      cwd: "/",
      why: "explore the whole disk as root",
    };
  },
  privilegedRescan: async (p: string) => {
    calls.push(`rescan ${p}`);
    return {
      ...ok,
      argv: ["/usr/bin/python3", "/t/disk_space.py", "--no-sudo", "--map-json", p],
      cwd: "/",
      why: `measure ${p}`,
    };
  },
} as unknown as DiskSpaceClient;

const gateCalls: PrivilegedRequest[] = [];
const gateIo: unknown[] = [];
let gateDecision: "approved" | "denied" = "approved";
/** what the fake gate does with a terminal-mode request */
const term = {
  typed: [] as string[],
  resized: [] as string[],
  decision: "approved" as "approved" | "denied",
  /** when set, the program draws only once this resolves (the password dialog is up until then) */
  drawn: null as Promise<void> | null,
  /** what the program draws first */
  screen: "SCREEN",
};
const gate: PrivilegedGate = {
  requestAndRun: async (req, io) => {
    gateCalls.push(req);
    gateIo.push(io);
    if (io?.terminal) {
      if (term.decision !== "approved") {
        return { ok: false, decision: "denied", commandLine: "sudo …" };
      }
      io.terminal.onStart({
        write: (d) => term.typed.push(d),
        resize: (c, r) => term.resized.push(`${c}x${r}`),
      });
      if (term.drawn) await term.drawn;
      io.onOutput?.(term.screen, "stdout");
      // the program runs until the window stops it
      await new Promise<void>((res) => io.signal?.addEventListener("abort", () => res()));
      return { ok: false, decision: "approved", commandLine: "sudo …", exitCode: 143 };
    }
    return gateDecision === "approved"
      ? {
          ok: true,
          decision: "approved",
          commandLine: "sudo …",
          exitCode: 0,
          stdout: JSON.stringify({ summary: { size: 10 }, tree: TREE }),
        }
      : { ok: false, decision: "denied", commandLine: "sudo …" };
  },
};
/** The root terminal window, as main sees it: keys arrive from its keyboard hook only. */
interface FakeRootWindow {
  webContentsId: number;
  readied: number;
  shown: string[];
  status: string[];
  focused: number;
  closed: boolean;
  key(input: Partial<KeyInput> & { key: string }): void;
  close(): void;
}
const rootWindows: FakeRootWindow[] = [];
const openRootWindow = (h: { onKey(input: KeyInput): void; onClosed(): void }) => {
  const w: FakeRootWindow = {
    webContentsId: 500 + rootWindows.length,
    readied: 0,
    shown: [],
    status: [],
    focused: 0,
    closed: false,
    key: (input) =>
      h.onKey({ type: "keyDown", control: false, alt: false, shift: false, meta: false, ...input }),
    close: () => {
      w.closed = true;
      h.onClosed();
    },
  };
  rootWindows.push(w);
  return {
    webContentsId: w.webContentsId,
    data: (chunk: string) => w.shown.push(chunk),
    status: (text: string) => w.status.push(text),
    focus: () => {
      w.focused++;
    },
    ready: () => {
      w.readied++;
    },
    close: () => {
      w.closed = true;
    },
  };
};
const dispose = registerDiskSpaceIpcHandlers({
  client,
  gate: () => gate,
  rootWindow: openRootWindow,
});
const invoke = (ch: string, arg?: unknown) => (handlers.get(ch) as Handler)(undefined, arg);

function window(id: number) {
  const sent: [string, unknown][] = [];
  const events = new EventEmitter();
  const sender = {
    id,
    send: (ch: string, payload: unknown) => sent.push([ch, payload]),
    isDestroyed: () => false,
    once: (ev: string, cb: () => void) => events.once(ev, cb),
    on: (ev: string, cb: (...a: unknown[]) => void) => events.on(ev, cb),
    removeListener: (ev: string, cb: (...a: unknown[]) => void) => events.removeListener(ev, cb),
  };
  return {
    sent,
    events,
    invoke: (ch: string, arg?: unknown) => (handlers.get(ch) as Handler)({ sender }, arg),
    emit: (ch: string, arg?: unknown) => (listeners.get(ch) as Handler)({ sender }, arg),
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
};

test("Open as administrator: the root command runs through the gate, in its OWN window", async () => {
  calls.length = 0;
  gateCalls.length = 0;
  gateIo.length = 0;
  term.typed.length = 0;
  rootWindows.length = 0;
  const panel = window(7);
  const done = panel.invoke(IPC.diskOpenAdmin, {});
  await settle();
  assert.deepEqual(calls, ["explorer "]);
  const req = gateCalls.at(-1) as PrivilegedRequest;
  assert.deepEqual(req.argv.slice(0, 4), [
    "/usr/bin/python3",
    "-I",
    "/t/disk_space.py",
    "--no-sudo",
  ]);
  assert.equal(req.requester, "Studio: Disk space as administrator");
  const io = gateIo.at(-1) as { terminal: { python: string; ptyHost: string }; timeoutMs?: number };
  assert.match(io.terminal.ptyHost, /pty_host\.py$/);
  assert.ok(isAbsolute(io.terminal.python), "the relay interpreter is absolute");
  assert.ok((io.timeoutMs ?? 0) >= 60 * 60_000, "not cut at the gate's 30-minute default");

  const w = rootWindows[0] as FakeRootWindow;
  assert.ok(w, "the root program gets its own window once it starts");
  assert.match(w.status[0] ?? "", /password/i);
  assert.deepEqual(w.shown, ["SCREEN"], "screen bytes go to the root window");
  assert.equal(w.focused, 1, "focused once the program draws (not over the password dialog)");
  assert.deepEqual(panel.sent, [], "the panel never sees the root screen");

  // a second session while this one runs is refused
  const second = (await window(9).invoke(IPC.diskOpenAdmin, {})) as { ok: boolean };
  assert.equal(second.ok, false);

  w.key({ key: "j" });
  w.key({ key: "d", control: true });
  assert.deepEqual(term.typed, ["j"], "Ctrl+D is never typed into the program — it ends it");
  const r = (await done) as { ok: boolean; decision: string };
  assert.equal(r.ok, true, "ended by the human: a clean close");
  assert.equal(w.closed, true, "the root window closes with the session");
});

test("nothing a renderer sends can type into root: there is no input channel", () => {
  assert.equal((IPC as Record<string, string>).diskAdminInput, undefined);
  assert.ok(![...listeners.keys()].some((ch) => /admin.?input/i.test(ch)));
});

test("arrows follow the program's cursor-key mode; keys before it has drawn are dropped", async () => {
  term.typed.length = 0;
  rootWindows.length = 0;
  let draw: () => void = () => {};
  term.drawn = new Promise((r) => {
    draw = r;
  });
  term.screen = "\x1b[?1h";
  try {
    const done = window(7).invoke(IPC.diskOpenAdmin, {});
    await settle();
    const w = rootWindows[0] as FakeRootWindow;
    w.key({ key: "y" });
    w.key({ key: "Enter" });
    assert.deepEqual(term.typed, [], "the password dialog is up: nothing is buffered for root");
    draw();
    await settle();
    w.key({ key: "ArrowUp" });
    w.key({ key: "q" });
    assert.deepEqual(term.typed, ["\x1bOA", "q"]);
    w.key({ key: "d", control: true });
    await done;
  } finally {
    term.drawn = null;
    term.screen = "SCREEN";
  }
});

test("resize is accepted from the root window only; Stop from the panel or the root window", async () => {
  term.resized.length = 0;
  rootWindows.length = 0;
  const panel = window(7);
  const done = panel.invoke(IPC.diskOpenAdmin, {});
  await settle();
  const w = rootWindows[0] as FakeRootWindow;
  const rootView = window(w.webContentsId);
  panel.emit(IPC.diskAdminResize, { cols: 50, rows: 10 });
  rootView.emit(IPC.diskAdminResize, { cols: 140, rows: 40 });
  assert.deepEqual(term.resized, ["140x40"]);
  panel.emit(IPC.diskAdminReady);
  assert.equal(w.readied, 0, "only the root window's page can say it is listening");
  rootView.emit(IPC.diskAdminReady);
  assert.equal(w.readied, 1);
  window(99).emit(IPC.diskAdminStop);
  const io = gateIo.at(-1) as { signal: AbortSignal };
  assert.equal(io.signal.aborted, false, "a stranger cannot stop it");
  rootView.emit(IPC.diskAdminStop);
  assert.equal(io.signal.aborted, true);
  await done;
});

test("closing the root window ends the root program", async () => {
  rootWindows.length = 0;
  const done = window(7).invoke(IPC.diskOpenAdmin, {});
  await settle();
  const io = gateIo.at(-1) as { signal: AbortSignal };
  (rootWindows[0] as FakeRootWindow).close();
  assert.equal(io.signal.aborted, true);
  await done;
});

test("the panel's window navigating away or crashing ends it", async () => {
  for (const ev of ["did-start-navigation", "render-process-gone"]) {
    const w = window(7);
    const done = w.invoke(IPC.diskOpenAdmin, {});
    await settle();
    const io = gateIo.at(-1) as { signal: AbortSignal };
    assert.equal(io.signal.aborted, false);
    if (ev === "did-start-navigation")
      w.events.emit(ev, { isMainFrame: true, isSameDocument: false });
    else w.events.emit(ev, {}, { reason: "crashed" });
    assert.equal(io.signal.aborted, true, ev);
    await done;
    assert.equal(w.events.listenerCount(ev), 0, `${ev} listener removed`);
  }
});

test("a denied administrator session runs nothing, opens no window, and says so", async () => {
  term.decision = "denied";
  rootWindows.length = 0;
  try {
    const r = (await window(7).invoke(IPC.diskOpenAdmin, {})) as { ok: boolean; decision?: string };
    assert.equal(r.ok, false);
    assert.equal(r.decision, "denied");
    assert.equal(rootWindows.length, 0);
  } finally {
    term.decision = "approved";
  }
});

test("paths must be absolute or ~-relative; anything else never reaches the sidecar", async () => {
  calls.length = 0;
  for (const bad of ["relative/dir", "", "/a\u0000b", 42, null]) {
    const r = (await invoke(IPC.diskMap, { path: bad })) as { ok: boolean };
    assert.equal(r.ok, false, String(bad));
  }
  assert.deepEqual(calls, []);
  assert.equal(((await invoke(IPC.diskMap, { path: "~" })) as { ok: boolean }).ok, true);
  assert.deepEqual(calls, ["map ~ 5000"]);
});

test("a delete PLAN never confirms; a delete needs confirm:true, and acknowledges high risk only when told", async () => {
  calls.length = 0;
  await invoke(IPC.diskDeletePlan, { paths: ["/tmp/a"], mode: "permanent" });
  const refused = (await invoke(IPC.diskDelete, { paths: ["/tmp/a"], mode: "trash" })) as {
    ok: boolean;
  };
  assert.equal(refused.ok, false);
  await invoke(IPC.diskDelete, { paths: ["/tmp/a"], mode: "trash", confirm: true });
  await invoke(IPC.diskDelete, {
    paths: ["/tmp/a"],
    mode: "permanent",
    confirm: true,
    ackHighRisk: true,
  });
  assert.deepEqual(calls, [
    "plan /tmp/a permanent",
    "confirm /tmp/a trash false",
    "confirm /tmp/a permanent true",
  ]);
});

test("an unknown delete mode is refused", async () => {
  const r = (await invoke(IPC.diskDeletePlan, { paths: ["/tmp/a"], mode: "shred" })) as {
    ok: boolean;
  };
  assert.equal(r.ok, false);
});

test("Rescan as root goes through the privileged gate, and renders what root measured", async () => {
  gateCalls.length = 0;
  gateIo.length = 0;
  gateDecision = "approved";
  const r = (await invoke(IPC.diskRescanAsRoot, { path: "/" })) as {
    ok: boolean;
    asRoot?: boolean;
    tree?: unknown;
  };
  assert.equal(r.ok, true);
  assert.equal(r.asRoot, true);
  assert.deepEqual(r.tree, TREE);
  assert.equal(gateCalls[0]?.surface, "studio");
  assert.equal(gateCalls[0]?.requester, "Studio: Rescan as root");
  assert.deepEqual(gateCalls[0]?.argv, [
    "/usr/bin/python3",
    "/t/disk_space.py",
    "--no-sudo",
    "--map-json",
    "/",
  ]);
  assert.ok(((gateIo[0] as { captureBytes?: number })?.captureBytes ?? 0) >= 64 * 1024 * 1024);
});

test("a denied rescan comes back as the decision, not as a map", async () => {
  gateDecision = "denied";
  const r = (await invoke(IPC.diskRescanAsRoot, { path: "/" })) as {
    ok: boolean;
    decision?: string;
    tree?: unknown;
  };
  assert.equal(r.ok, false);
  assert.equal(r.decision, "denied");
  assert.equal(r.tree, undefined);
});

test("dispose removes every channel", () => {
  dispose();
  for (const ch of [
    IPC.diskMounts,
    IPC.diskMap,
    IPC.diskLevels,
    IPC.diskFiles,
    IPC.diskDeletePlan,
    IPC.diskDelete,
    IPC.diskRescanAsRoot,
    IPC.diskOpenAdmin,
  ]) {
    assert.equal(handlers.has(ch), false, ch);
  }
  for (const ch of [IPC.diskAdminResize, IPC.diskAdminStop, IPC.diskAdminReady]) {
    assert.equal(listeners.has(ch), false, ch);
  }
});
