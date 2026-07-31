/**
 * dap-adapter-install.test.ts — detect/install for debug adapters (APP-029).
 *
 * Injected probe/runCmd/gateTarget throughout — never a real pip/nemesis spawn.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { detectDapAdapter, installDapAdapter } from "./dap-adapter-install.js";

test("detectDapAdapter: python — available when the probe succeeds", async () => {
  const r = await detectDapAdapter("python", "/venv/bin/python", async (cmd, args) => {
    assert.equal(cmd, "/venv/bin/python");
    assert.deepEqual(args, ["-c", "import debugpy"]);
    return ""; // successful import prints nothing
  });
  assert.equal(r.available, true);
  assert.match(r.detail, /debugpy import ok/);
});

test("detectDapAdapter: python — unavailable when the probe fails (ImportError)", async () => {
  const r = await detectDapAdapter("python", undefined, async () => null);
  assert.equal(r.available, false);
  assert.match(r.detail, /not importable/);
});

test("detectDapAdapter: defaults to python3 when no interpreter is given", async () => {
  let seenCmd: string | undefined;
  await detectDapAdapter("python", undefined, async (cmd) => {
    seenCmd = cmd;
    return "";
  });
  assert.equal(seenCmd, "python3");
});

test("detectDapAdapter: node/rust are a presence-only PATH probe, honestly labelled", async () => {
  const found = await detectDapAdapter("node", undefined, async () => "");
  assert.equal(found.available, true);
  assert.match(found.detail, /presence only/);
  const missing = await detectDapAdapter("rust", undefined, async () => null);
  assert.equal(missing.available, false);
  assert.match(missing.detail, /not found on PATH/);
});

test("installDapAdapter: refuses non-python types without ever staging/gating", async () => {
  let calledRunCmd = false;
  let calledGate = false;
  const r = await installDapAdapter(
    "node",
    {},
    async () => {
      calledRunCmd = true;
      return { code: 0, stdout: "", stderr: "" };
    },
    async () => {
      calledGate = true;
      return { verdict: "allow" } as never;
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /not supported for debug type "node"/);
  assert.equal(calledRunCmd, false);
  assert.equal(calledGate, false);
});

test("installDapAdapter: download failure never reaches the gate or install step", async () => {
  let gateCalled = false;
  const r = await installDapAdapter(
    "python",
    {},
    async (_cmd, args) => {
      if (args.includes("download"))
        return { code: 1, stdout: "", stderr: "no matching distribution" };
      return { code: 0, stdout: "", stderr: "" };
    },
    async () => {
      gateCalled = true;
      return { verdict: "allow" } as never;
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /download failed/);
  assert.equal(gateCalled, false);
});

test("installDapAdapter: a BLOCK/ERROR verdict on the staged files refuses — never installs", async () => {
  let installCalled = false;
  const r = await installDapAdapter(
    "python",
    {},
    async (_cmd, args) => {
      if (args.includes("install")) installCalled = true;
      return { code: 0, stdout: "ok", stderr: "" };
    },
    async () => ({ verdict: "block" }) as never,
  );
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.match(r.error ?? "", /blocked by nemesis/);
  assert.equal(installCalled, false);
});

test("installDapAdapter: an ERROR verdict (fail-closed) refuses exactly like block", async () => {
  const r = await installDapAdapter(
    "python",
    {},
    async () => ({ code: 0, stdout: "ok", stderr: "" }),
    async () => ({ verdict: "error" }) as never,
  );
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
});

test("installDapAdapter: a WARN verdict without confirm needs confirm — never installs", async () => {
  let installCalled = false;
  const r = await installDapAdapter(
    "python",
    { confirm: false },
    async (_cmd, args) => {
      if (args.includes("install")) installCalled = true;
      return { code: 0, stdout: "ok", stderr: "" };
    },
    async () => ({ verdict: "warn" }) as never,
  );
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirm, true);
  assert.equal(installCalled, false);
});

test("installDapAdapter: a WARN verdict WITH confirm proceeds to install", async () => {
  const r = await installDapAdapter(
    "python",
    { confirm: true },
    async () => ({ code: 0, stdout: "ok", stderr: "" }),
    async () => ({ verdict: "warn" }) as never,
  );
  assert.equal(r.ok, true);
});

test("installDapAdapter: allow verdict installs FROM the staged dir (--no-index --find-links)", async () => {
  const calls: string[][] = [];
  const r = await installDapAdapter(
    "python",
    {},
    async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "ok", stderr: "" };
    },
    async () => ({ verdict: "allow" }) as never,
  );
  assert.equal(r.ok, true);
  const installCall = calls.find((c) => c.includes("install"));
  assert.ok(installCall);
  assert.ok(installCall!.includes("--no-index"));
  assert.ok(installCall!.includes("--find-links"));
  // the install target is "debugpy" — never a raw filesystem path the caller controls.
  assert.equal(installCall!.at(-1), "debugpy");
});

test("installDapAdapter: install-step failure after a clean gate is surfaced, not swallowed", async () => {
  const r = await installDapAdapter(
    "python",
    {},
    async (_cmd, args) => {
      if (args.includes("install")) return { code: 1, stdout: "", stderr: "permission denied" };
      return { code: 0, stdout: "ok", stderr: "" };
    },
    async () => ({ verdict: "allow" }) as never,
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /install failed/);
});
