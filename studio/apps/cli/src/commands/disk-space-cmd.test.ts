// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * disk-space-cmd.test.ts — `/disk-space` over fakes: no Python, no disk, no sudo.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PrivilegedGate, PrivilegedRequest } from "@prometheus/core/agent-system-host";
import type { DiskSpaceClient, DiskToolPaths } from "@prometheus/engine-bridge";
import type { CliContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import type { OverlayLaunch } from "../tui/overlay-session.js";
import { type DiskSpaceIo, runDiskSpace, runDiskSpaceCommand } from "./disk-space-cmd.js";

setColorEnabled(false);

const PATHS: DiskToolPaths = {
  python: "/usr/bin/python3",
  tool: "/t/disk_space.py",
  ptyHost: "/t/pty_host.py",
};
const TREE = {
  name: "/data",
  path: "/data",
  size: 1000,
  dir: true,
  children: [{ name: "a", path: "/data/a", size: 600, dir: true }],
};

function fakes(answers: { confirm?: boolean[]; ask?: string[] } = {}) {
  const out: string[] = [];
  const calls: string[] = [];
  const overlays: OverlayLaunch[] = [];
  const gateCalls: PrivilegedRequest[] = [];
  const confirms = [...(answers.confirm ?? [])];
  const asks = [...(answers.ask ?? [])];
  const ok = { ok: true, command: "x" };
  const client: DiskSpaceClient = {
    mounts: async () => {
      calls.push("mounts");
      return { ...ok, mounts: [] };
    },
    map: async (p, a) => {
      calls.push(`map ${p} ${JSON.stringify(a ?? {})}`);
      return {
        ...ok,
        tree: TREE,
        summary: { survey_dirs: 3, seconds: 1, engine: "du", unreadable: 2 } as never,
      };
    },
    levels: async (p) => {
      calls.push(`levels ${p}`);
      return { ...ok, levels: [] };
    },
    largestFiles: async (p) => {
      calls.push(`files ${p}`);
      return { ...ok, files: [] };
    },
    deletePlan: async (ps, a) => {
      calls.push(`plan ${ps.join(",")} ${a?.mode}`);
      return {
        ...ok,
        planned: true,
        mode: a?.mode ?? "trash",
        items: ps.map((path) => ({
          path,
          mode: a?.mode ?? "trash",
          size: 10,
          risk: "MEDIUM" as const,
          reason: "",
          protected: null,
        })),
        total: 10,
        requiresPhrase: ps.includes("/data/huge"),
      };
    },
    deleteConfirm: async (ps, a) => {
      calls.push(`confirm ${ps.join(",")} ${a.mode} ${a.ackHighRisk === true}`);
      return {
        ...ok,
        executed: true,
        results: ps.map((path) => ({ path, ok: true, msg: "moved" })),
        deleted: ps.length,
      };
    },
    cleanupPlan: async () => {
      calls.push("cleanup");
      return {
        ...ok,
        findings: [
          {
            id: "docker",
            title: "Docker",
            category: "c",
            size: 10,
            reclaimable: 5,
            mountpoint: "/",
            risk: "LOW" as const,
            summary: "s",
            actions: [
              {
                id: "prune-safe",
                title: "Prune",
                risk: "LOW" as const,
                needsRoot: true,
                needsInput: [],
                preview: [],
                requiresReboot: false,
                recommended: true,
                command: [
                  "/usr/bin/python3",
                  "/t/disk_space.py",
                  "--apply",
                  "docker:prune-safe",
                  "--yes",
                ],
              },
            ],
          },
        ],
      };
    },
    privilegedRescan: async (p) => {
      calls.push(`rescan ${p}`);
      return {
        ...ok,
        argv: ["/usr/bin/python3", "/t/disk_space.py", "--no-sudo", "--map-json", p],
        cwd: "/",
        why: `measure ${p}`,
      };
    },
  };
  const gateIo: unknown[] = [];
  const gate: PrivilegedGate = {
    requestAndRun: async (req, io) => {
      gateCalls.push(req);
      gateIo.push(io);
      return {
        ok: true,
        decision: "approved",
        commandLine: `sudo ${req.argv.join(" ")}`,
        exitCode: 0,
        stdout: JSON.stringify({ summary: { size: 1000 }, tree: TREE }),
      };
    },
  };
  const io: DiskSpaceIo = {
    cwd: "/home/u",
    write: (l) => out.push(l),
    confirm: async () => confirms.shift() ?? false,
    ask: async () => asks.shift() ?? "",
  };
  const deps = { client, paths: PATHS, surface: "tui" as const, toolExists: () => true };
  return { out, calls, overlays, gateCalls, gateIo, client, gate, io, deps };
}

test("bare /disk-space opens disk_space.py's own TUI over the session — never as root", async () => {
  const f = fakes();
  const rc = await runDiskSpace(
    [],
    {
      ...f.io,
      openOverlay: (o) => {
        f.overlays.push(o);
        return "started";
      },
    },
    f.deps,
  );
  assert.equal(rc, 0);
  assert.deepEqual(f.overlays[0]?.argv, [
    "/usr/bin/python3",
    "-I",
    "/t/disk_space.py",
    "--no-sudo",
  ]);
  assert.equal(f.overlays[0]?.ptyHost, "/t/pty_host.py");
  assert.equal(f.overlays[0]?.label, "disk-space");
  assert.deepEqual(f.calls, []);
});

test("/disk-space PATH opens the tool's map of that folder", async () => {
  const f = fakes();
  await runDiskSpace(
    ["../data"],
    {
      ...f.io,
      openOverlay: (o) => {
        f.overlays.push(o);
        return "started";
      },
    },
    f.deps,
  );
  assert.deepEqual(f.overlays[0]?.argv.slice(-3), ["--no-sudo", "--map", "/home/data"]);
});

test("a second /disk-space while one is minimised resumes it", async () => {
  const f = fakes();
  await runDiskSpace([], { ...f.io, openOverlay: () => "resumed" }, f.deps);
  assert.match(f.out.join("\n"), /resum/);
});

test("--plain hands the real terminal over instead", async () => {
  const f = fakes();
  const handed: string[][] = [];
  await runDiskSpace(
    [],
    {
      ...f.io,
      handOver: async (argv) => {
        handed.push(argv);
        return 0;
      },
    },
    f.deps,
  );
  assert.deepEqual(handed[0], ["/usr/bin/python3", "-I", "/t/disk_space.py", "--no-sudo"]);
});

test("straight from the shell the tool takes the terminal; Ctrl+D ending it is a clean exit", async () => {
  const f = fakes();
  const shown: OverlayLaunch[] = [];
  const rc = await runDiskSpace(
    [],
    {
      ...f.io,
      runFullScreen: async (o) => {
        shown.push(o);
        return { code: 143, terminated: true };
      },
    },
    f.deps,
  );
  assert.equal(rc, 0);
  assert.deepEqual(shown[0]?.argv, ["/usr/bin/python3", "-I", "/t/disk_space.py", "--no-sudo"]);
  assert.equal(shown[0]?.ptyHost, "/t/pty_host.py");
  assert.deepEqual(f.out, [], "nothing is printed over a deliberate quit");
});

test("the tool failing on its own is reported with its code", async () => {
  const f = fakes();
  const rc = await runDiskSpace(
    [],
    { ...f.io, runFullScreen: async () => ({ code: 1, terminated: false }) },
    f.deps,
  );
  assert.equal(rc, 1);
  assert.match(f.out.join("\n"), /exit 1/);
});

const oneShot = (argv: string[]): CliContext =>
  ({ json: false, quiet: false, args: parseArgs(argv) }) as unknown as CliContext;

test("`prometheus disk-space` on a terminal runs the explorer full-screen, then returns", async () => {
  const f = fakes();
  const shown: OverlayLaunch[] = [];
  const out = await runDiskSpaceCommand(oneShot(["disk-space", "/data"]), {
    tty: true,
    deps: f.deps,
    fullScreen: async (o) => {
      shown.push(o);
      return { code: 0, terminated: false };
    },
  });
  assert.equal(out.exitCode, 0);
  assert.deepEqual(shown[0]?.argv.slice(-2), ["--map", "/data"]);
  assert.equal(out.text, "");
});

test("`prometheus disk-space` with no terminal prints the filesystems instead", async () => {
  const f = fakes();
  let shown = 0;
  const out = await runDiskSpaceCommand(oneShot(["disk-space"]), {
    tty: false,
    deps: f.deps,
    fullScreen: async () => {
      shown++;
      return { code: 0, terminated: false };
    },
  });
  assert.equal(shown, 0);
  assert.ok(f.calls.includes("mounts"));
  assert.equal(out.exitCode, 0);
});

test("a missing tool is reported, never half-launched", async () => {
  const f = fakes();
  const rc = await runDiskSpace(
    [],
    {
      ...f.io,
      openOverlay: (o) => {
        f.overlays.push(o);
        return "started";
      },
    },
    { ...f.deps, toolExists: () => false },
  );
  assert.equal(rc, 1);
  assert.equal(f.overlays.length, 0);
});

test("map / levels / files / mounts are native views over the sidecar", async () => {
  const f = fakes();
  await runDiskSpace(["map", "/data", "--max-nodes", "50"], f.io, f.deps);
  await runDiskSpace(["levels"], f.io, f.deps);
  await runDiskSpace(["files", "/x"], f.io, f.deps);
  await runDiskSpace(["mounts"], f.io, f.deps);
  assert.deepEqual(f.calls, ['map /data {"maxNodes":50}', "levels /home/u", "files /x", "mounts"]);
  assert.match(f.out.join("\n"), /600 B\s+60\.0%/);
  assert.match(f.out.join("\n"), /2 unreadable/);
});

test("delete: the plan first; a no stops there", async () => {
  const f = fakes({ confirm: [false] });
  await runDiskSpace(["delete", "/data/old"], f.io, f.deps);
  assert.deepEqual(f.calls, ["plan /data/old trash"]);
});

test("delete: a yes runs exactly the planned paths and mode", async () => {
  const f = fakes({ confirm: [true] });
  await runDiskSpace(["delete", "--permanent", "/data/old"], f.io, f.deps);
  assert.deepEqual(f.calls, ["plan /data/old permanent", "confirm /data/old permanent false"]);
});

test("delete: a high-risk plan also needs the typed word, and only then acknowledges it", async () => {
  const wrong = fakes({ confirm: [true], ask: ["y"] });
  await runDiskSpace(["delete", "/data/huge"], wrong.io, wrong.deps);
  assert.deepEqual(wrong.calls, ["plan /data/huge trash"]);
  const right = fakes({ confirm: [true], ask: ["yes"] });
  await runDiskSpace(["delete", "/data/huge"], right.io, right.deps);
  assert.deepEqual(right.calls, ["plan /data/huge trash", "confirm /data/huge trash true"]);
});

test("--sudo: the root rescan goes through the privileged gate and renders its map", async () => {
  const f = fakes();
  const rc = await runDiskSpace(["--sudo"], f.io, { ...f.deps, gate: f.gate });
  assert.equal(rc, 0);
  assert.deepEqual(f.calls, ["rescan /"]);
  assert.deepEqual(f.gateCalls[0]?.argv, [
    "/usr/bin/python3",
    "/t/disk_space.py",
    "--no-sudo",
    "--map-json",
    "/",
  ]);
  assert.equal(f.gateCalls[0]?.requester, "/disk-space --sudo");
  assert.match(f.out.join("\n"), /60\.0%/);
});

test("--sudo with no human-attached gate runs nothing and prints the command", async () => {
  const f = fakes();
  await runDiskSpace(["--sudo", "/var"], f.io, f.deps);
  assert.equal(f.gateCalls.length, 0);
  assert.match(
    f.out.join("\n"),
    /sudo \/usr\/bin\/python3 \/t\/disk_space\.py --no-sudo --map-json \/var/,
  );
});

test("cleanup: a picked action goes to the gate; no pick runs nothing", async () => {
  const none = fakes({ ask: [""] });
  await runDiskSpace(["cleanup"], none.io, { ...none.deps, gate: none.gate });
  assert.equal(none.gateCalls.length, 0);
  const one = fakes({ ask: ["1"] });
  await runDiskSpace(["cleanup"], one.io, { ...one.deps, gate: one.gate });
  assert.deepEqual(one.gateCalls[0]?.argv.slice(-3), ["--apply", "docker:prune-safe", "--yes"]);
});

test("--sudo asks the gate to keep the whole root map (64 MiB), and an overflow is named, not a JSON error", async () => {
  const f = fakes();
  await runDiskSpace(["--sudo"], f.io, { ...f.deps, gate: f.gate });
  assert.ok(((f.gateIo[0] as { captureBytes?: number })?.captureBytes ?? 0) >= 64 * 1024 * 1024);
  const cut = fakes();
  const gate = {
    requestAndRun: async () => ({
      ok: true,
      decision: "approved" as const,
      commandLine: "sudo …",
      exitCode: 0,
      stdout: '{"tree": {"na',
      outputTruncated: true,
    }),
  };
  const rc = await runDiskSpace(["--sudo"], cut.io, { ...cut.deps, gate });
  assert.equal(rc, 1);
  assert.match(cut.out.join("\n"), /too large/);
});
