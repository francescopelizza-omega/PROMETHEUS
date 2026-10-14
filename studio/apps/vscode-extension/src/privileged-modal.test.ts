// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * privileged-modal.test.ts — the VS Code half of the privileged gate, and its wiring.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { type ApprovalView, createPrivilegedGate } from "@prometheus/core/agent-system-host";
import { makeVsCodeApprover } from "./privileged-modal.js";
import { VSCODE_TOOL_ALLOW, createVsCodeToolRunner } from "./tool-runner.js";
import type { WorkspaceIo } from "./workspace-io.js";

const VIEW: ApprovalView = {
  id: "v",
  commandLine: "sudo systemctl restart nginx",
  execArgv: ["/usr/bin/sudo", "-A", "--", "systemctl", "restart", "nginx"],
  elevator: "sudo",
  argv: ["systemctl", "restart", "nginx"],
  cwd: "/ws",
  surface: "vscode",
  requester: "agent",
  why: "the unit is root-owned",
  timeoutMs: 120_000,
  passwordVia: "askpass",
};

function win(choice: string | undefined, typed?: string) {
  const shown: { message: string; detail?: string; items: string[] }[] = [];
  const infos: string[] = [];
  return {
    shown,
    infos,
    showWarningMessage: async (
      message: string,
      opts: { modal: boolean; detail?: string },
      ...items: string[]
    ) => {
      assert.equal(opts.modal, true);
      shown.push({ message, ...(opts.detail ? { detail: opts.detail } : {}), items });
      return choice;
    },
    showInputBox: async () => typed,
    showInformationMessage: async (m: string) => {
      infos.push(m);
      return undefined;
    },
  };
}

test("a native modal with the exact command and ONE button — dismissing it denies", async () => {
  const w = win(undefined);
  assert.deepEqual(await makeVsCodeApprover(w)(VIEW, new AbortController().signal), {
    decision: "deny",
  });
  assert.match(w.shown[0]?.message ?? "", /sudo systemctl restart nginx/);
  assert.match(w.shown[0]?.detail ?? "", /why: +the unit is root-owned/);
  assert.deepEqual(w.shown[0]?.items, ["Approve once"]);
});

test("Approve once approves; a catastrophic command also needs its target typed", async () => {
  assert.deepEqual(
    await makeVsCodeApprover(win("Approve once"))(VIEW, new AbortController().signal),
    {
      decision: "approve",
    },
  );
  const v = { ...VIEW, phrase: "/dev/disk4" };
  assert.deepEqual(
    await makeVsCodeApprover(win("Approve once", "/dev/disk4"))(v, new AbortController().signal),
    {
      decision: "approve",
      phrase: "/dev/disk4",
    },
  );
  assert.deepEqual(
    await makeVsCodeApprover(win("Approve once", ""))(v, new AbortController().signal),
    {
      decision: "deny",
    },
  );
});

test("a click after the gate timed out is reported, never run", async () => {
  const w = win("Approve once");
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await makeVsCodeApprover(w)(VIEW, ac.signal), { decision: "deny" });
  assert.match(w.infos[0] ?? "", /timed out — nothing ran/);
});

test("propose_elevated is offered in VS Code, and runs only through the gate's approver", async () => {
  assert.ok(VSCODE_TOOL_ALLOW.includes("propose_elevated"));
  const spawned: string[][] = [];
  const gate = createPrivilegedGate({
    passwordVia: "askpass",
    askpass: async () => "/tmp/x/askpass.sh",
    resolveElevator: () => "/usr/bin/sudo",
    approver: makeVsCodeApprover(win(undefined)), // the human dismisses the modal
    spawnImpl: ((cmd: string, args: string[]) => {
      spawned.push([cmd, ...args]);
      const c = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill() {},
      });
      setImmediate(() => c.emit("close", 0));
      return c;
    }) as never,
  });
  const io = { rootPath: () => "/ws" } as unknown as WorkspaceIo;
  const run = createVsCodeToolRunner({ io, onToolNote: () => {}, privilegedGate: gate });
  const tool = { name: "propose_elevated" } as never;
  const out = await run(tool, {
    argv: ["systemctl", "restart", "nginx"],
    why: "the unit is root-owned",
  });
  assert.equal(out.ok, false);
  assert.match(out.summary, /denied/);
  assert.equal(spawned.length, 0);
});

test("with no folder open there is no cwd to run in — refused, nothing asked", async () => {
  const io = { rootPath: () => undefined } as unknown as WorkspaceIo;
  const run = createVsCodeToolRunner({ io, onToolNote: () => {} });
  const out = await run({ name: "propose_elevated" } as never, {
    argv: ["id"],
    why: "check identity",
  });
  assert.equal(out.ok, false);
});
