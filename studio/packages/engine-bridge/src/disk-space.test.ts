// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type DiskSidecarRunner, createDiskSpaceClient } from "./disk-space.js";
import type { SidecarOptions } from "./sidecar-runner.js";

/** A recording runner: no Python, no disk — just the exact argv and options. */
function recorder() {
  const calls: { script: string; argv: string[]; opts?: SidecarOptions }[] = [];
  const run = (async (script: string, argv: string[], opts?: SidecarOptions) => {
    calls.push({ script, argv, ...(opts ? { opts } : {}) });
    return { ok: true, command: "x" };
  }) as DiskSidecarRunner;
  return { calls, run };
}

test("every verb goes to disk_map.py with its exact argv; paths always after --", async () => {
  const r = recorder();
  const c = createDiskSpaceClient(r.run);
  await c.mounts();
  await c.map("/data", { depthCap: 8, minSize: "10M", maxNodes: 500 });
  await c.levels("/data", { depth: 3, top: 5 });
  await c.largestFiles("/data", { top: 7 });
  await c.privilegedRescan("/");
  await c.cleanupPlan();
  assert.ok(r.calls.every((x) => x.script === "disk_map.py"));
  assert.deepEqual(
    r.calls.map((x) => x.argv),
    [
      ["mounts"],
      ["map", "--depth-cap", "8", "--min-size", "10M", "--max-nodes", "500", "--", "/data"],
      ["levels", "--depth", "3", "--top", "5", "--", "/data"],
      ["largest-files", "--top", "7", "--", "/data"],
      ["privileged-rescan", "--", "/"],
      ["cleanup-plan"],
    ],
  );
});

test("privilegedExplorer asks for the interactive root command; a path comes after --", async () => {
  const r = recorder();
  const c = createDiskSpaceClient(r.run);
  await c.privilegedExplorer();
  await c.privilegedExplorer("/data");
  assert.deepEqual(
    r.calls.map((x) => x.argv),
    [["privileged-explorer"], ["privileged-explorer", "--", "/data"]],
  );
});

test("a path that starts with '-' is a path, never an option", async () => {
  const r = recorder();
  await createDiskSpaceClient(r.run).deletePlan(["-rf"]);
  assert.deepEqual(r.calls[0]?.argv, ["delete", "--trash", "--", "-rf"]);
});

test("a delete PLAN never carries --confirm; a confirmed delete carries exactly what was asked", async () => {
  const r = recorder();
  const c = createDiskSpaceClient(r.run);
  await c.deletePlan(["/tmp/a", "/tmp/b"], { mode: "permanent" });
  await c.deleteConfirm(["/tmp/a"], { mode: "trash" });
  await c.deleteConfirm(["/tmp/a"], { mode: "permanent", ackHighRisk: true });
  assert.deepEqual(
    r.calls.map((x) => x.argv),
    [
      ["delete", "--permanent", "--", "/tmp/a", "/tmp/b"],
      ["delete", "--trash", "--confirm", "--", "/tmp/a"],
      ["delete", "--permanent", "--confirm", "--ack-high-risk", "--", "/tmp/a"],
    ],
  );
});

test("nothing this client sends can elevate", async () => {
  const r = recorder();
  const c = createDiskSpaceClient(r.run);
  await c.map("/");
  await c.privilegedRescan("/");
  await c.deleteConfirm(["/tmp/x"], { mode: "permanent", ackHighRisk: true });
  for (const call of r.calls) {
    assert.ok(!call.argv.some((a) => /^(sudo|doas|pkexec|run0)$/.test(a)), call.argv.join(" "));
  }
});

test("long scans get a long timeout and stream progress; callers can still override", async () => {
  const r = recorder();
  const lines: string[] = [];
  const c = createDiskSpaceClient(r.run, { onStderr: (l) => lines.push(l) });
  await c.map("/");
  await c.levels("/");
  await c.largestFiles("/");
  await c.mounts({ timeoutMs: 5_000 });
  for (const call of r.calls.slice(0, 3)) {
    assert.ok((call.opts?.timeoutMs ?? 0) >= 30 * 60_000, call.argv[0]);
    assert.equal(typeof call.opts?.onStderr, "function");
  }
  assert.equal(r.calls[3]?.opts?.timeoutMs, 5_000);
});

const REAL_SIDECAR_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "python",
  "sidecar",
);

test(
  "the real sidecar answers through runSidecar (allow-listed, discovered, one envelope)",
  { skip: !existsSync(join(REAL_SIDECAR_DIR, "disk_map.py")) },
  async () => {
    const r = await createDiskSpaceClient(undefined, { sidecarDir: REAL_SIDECAR_DIR }).mounts();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.command, "disk.mounts");
    assert.ok((r.mounts ?? []).length > 0);
  },
);

test("the full TUI is always launched with --no-sudo, from the tools dir beside the sidecars", async () => {
  const { diskSpaceToolPaths, diskSpaceTuiArgv } = await import("./disk-space.js");
  const p = diskSpaceToolPaths({
    sidecarDir: "/opt/prom/studio/python/sidecar",
    pythonBin: "/usr/bin/python3",
  });
  assert.deepEqual(p, {
    python: "/usr/bin/python3",
    tool: "/opt/prom/studio/python/tools/disk_space.py",
    ptyHost: "/opt/prom/studio/python/tools/pty_host.py",
  });
  // -I: under `sudo prometheus disk-space` this runs as ROOT with the user's HOME (macOS sudo
  // keeps it) — without isolated mode root would load the user's site-packages `.pth` files and
  // let the user-writable tools/ dir shadow the standard library
  assert.deepEqual(diskSpaceTuiArgv(p), ["/usr/bin/python3", "-I", p.tool, "--no-sudo"]);
  assert.deepEqual(diskSpaceTuiArgv(p, "/data"), [
    "/usr/bin/python3",
    "-I",
    p.tool,
    "--no-sudo",
    "--map",
    "/data",
  ]);
});
