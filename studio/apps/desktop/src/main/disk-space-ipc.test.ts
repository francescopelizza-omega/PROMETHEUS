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
import { mock, test } from "node:test";

import type { PrivilegedGate, PrivilegedRequest } from "@prometheus/core/agent-system-host";
import type { DiskSpaceClient } from "@prometheus/engine-bridge";

import { IPC } from "../shared/ipc-contract.js";

const MOCK_EXPORTS = Number(process.versions.node.split(".")[0]) >= 26 ? "exports" : "namedExports";

type Handler = (event: unknown, arg: unknown) => unknown;
const handlers = new Map<string, Handler>();
mock.module("electron", {
  [MOCK_EXPORTS]: {
    ipcMain: {
      handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
      removeHandler: (ch: string) => handlers.delete(ch),
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
const gate: PrivilegedGate = {
  requestAndRun: async (req, io) => {
    gateCalls.push(req);
    gateIo.push(io);
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
const dispose = registerDiskSpaceIpcHandlers({ client, gate: () => gate });
const invoke = (ch: string, arg?: unknown) => (handlers.get(ch) as Handler)(undefined, arg);

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
  ]) {
    assert.equal(handlers.has(ch), false, ch);
  }
});
