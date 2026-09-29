/**
 * updates-ipc.test.ts — `updates:check` projects core's report into renderer-safe shapes.
 *
 * Mirrors effort-ipc.test.ts: `updates-ipc.ts` does a real top-level `import { ipcMain } from
 * "electron"`, so this suite substitutes a fake via node:test's `mock.module()` and calls the
 * handler directly. The CHECK itself is injected, so nothing here touches the network or spawns
 * a package manager.
 *
 * What is being pinned is the boundary, and it has two halves:
 *   • the renderer supplies exactly ONE boolean, and cannot name a tool, a URL or a command;
 *   • "could not check" survives the projection as `null`, and never becomes `false`.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { updates as u } from "@prometheus/core";

import { IPC, type UpdatesReportResult } from "../shared/ipc-contract.js";

type Handler = (event: unknown, arg: unknown) => unknown;

function makeFakeIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handle(channel: string, fn: Handler): void {
      if (handlers.has(channel)) throw new Error(`second handler for '${channel}'`);
      handlers.set(channel, fn);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    invoke(channel: string, arg?: unknown): unknown {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler registered for '${channel}'`);
      return fn(undefined, arg);
    },
  };
}

const fakeIpcMain = makeFakeIpcMain();
mock.module("electron", { exports: { ipcMain: fakeIpcMain } });
const { registerUpdatesIpcHandlers } = await import("./updates-ipc.js");

/** A report shaped like the real thing: one conflict, one tool, one unknown, one package. */
function sampleReport(over: Partial<u.UpdateReport> = {}): u.UpdateReport {
  return {
    clis: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    self: {
      prometheus: "0.1.0",
      updateAvailable: null,
      plan: u.buildSelfUpdatePlan({ method: "unknown" }),
    },
    checkedAt: "2026-09-29T00:00:00.000Z",
    tools: [
      {
        id: "claude",
        label: "Claude Code",
        role: "agent",
        installed: true,
        state: "duplicate",
        copies: [
          {
            pathEntry: "/u/.local/bin/claude",
            realPath: "/u/.local/share/claude/versions/2.1.284/claude",
            owner: "native-installer",
            version: "2.1.284",
          },
          {
            pathEntry: "/opt/homebrew/bin/claude",
            realPath: "/opt/homebrew/Caskroom/claude-code/2.1.274/claude",
            owner: "brew-cask",
            version: "2.1.274",
          },
        ],
        current: "2.1.284",
        latest: "2.1.284",
        updateAvailable: false,
        offer: [{ via: "self", command: "claude update" }],
        withheld: [{ command: "brew upgrade --cask claude-code", reason: "not the copy on PATH" }],
      },
      {
        id: "cursor",
        label: "Cursor Agent",
        role: "agent",
        installed: true,
        state: "single",
        copies: [],
        current: "2026.02.13",
        latest: null,
        updateAvailable: null, // could NOT check
        source: "none: no public version endpoint",
        offer: [],
        withheld: [],
      },
    ],
    managers: [
      {
        manager: "brew",
        label: "Homebrew",
        checkable: true,
        ok: true,
        packages: [
          {
            manager: "brew",
            name: "claude-code",
            kind: "cask",
            installed: "2.1.274",
            available: "2.1.277",
          },
        ],
      },
      {
        manager: "pipx",
        label: "pipx",
        checkable: false,
        ok: false,
        packages: [],
        note: "no outdated command",
      },
    ],
    conflicts: [
      {
        kind: "downgrade-offer",
        subject: "claude",
        summary: "brew offers an older version than the one you run",
        consequence: "the command succeeds and changes nothing",
        avoid: "brew upgrade --cask claude-code",
        severity: "high",
      },
    ],
    ...over,
  };
}

function register(report: u.UpdateReport, spy?: (deps: { force?: boolean }) => void) {
  return registerUpdatesIpcHandlers({
    home: "/tmp/nowhere",
    promVersion: "0.1.0",
    check: (async (deps: { force?: boolean }) => {
      spy?.(deps);
      return { report, fromCache: false };
    }) as never,
  });
}

test("the projection carries the conflict, its consequence AND the command to avoid", async () => {
  /**
   * The command must survive the boundary. Dropping it would leave Studio saying "something is
   * wrong with claude" while the user finds `brew upgrade --cask claude-code` in `brew outdated`
   * and runs it, unwarned — which is the whole failure this feature exists to prevent.
   */
  const dispose = register(sampleReport());
  try {
    const r = (await fakeIpcMain.invoke(IPC.updatesCheck, {})) as UpdatesReportResult;
    assert.equal(r.ok, true);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0]?.avoid, "brew upgrade --cask claude-code");
    assert.equal(r.conflicts[0]?.severity, "high");
  } finally {
    dispose();
  }
});

test("`could not check` crosses the bridge as null, not as false", async () => {
  const dispose = register(sampleReport());
  try {
    const r = (await fakeIpcMain.invoke(IPC.updatesCheck, {})) as UpdatesReportResult;
    const cursor = r.tools.find((t) => t.id === "cursor");
    assert.equal(cursor?.updateAvailable, null);
    assert.notEqual(cursor?.updateAvailable, false);
    // …and so does the self-check, which queries GitLab and can simply fail.
    assert.equal(r.self.updateAvailable, null);
  } finally {
    dispose();
  }
});

test("a manager that could not be asked is listed separately, never as an empty success", async () => {
  // An empty package list from a manager nobody successfully asked is indistinguishable from
  // "everything is current" — which is the conflation this whole feature removes.
  const dispose = register(sampleReport());
  try {
    const r = (await fakeIpcMain.invoke(IPC.updatesCheck, {})) as UpdatesReportResult;
    assert.deepEqual(
      r.unavailableManagers.map((m) => m.manager),
      ["pipx"],
    );
    assert.equal(r.packages.length, 1, "brew's real row is still there");
  } finally {
    dispose();
  }
});

test("every package carries the exact command, with Homebrew's cask flag", async () => {
  /**
   * Built in core from the manager's own spec. `brew upgrade claude-code` and
   * `brew upgrade --cask claude-code` name different things, and the renderer must never be in
   * a position to assemble either one.
   */
  const dispose = register(sampleReport());
  try {
    const r = (await fakeIpcMain.invoke(IPC.updatesCheck, {})) as UpdatesReportResult;
    assert.equal(r.packages[0]?.command, "brew upgrade --cask claude-code");
  } finally {
    dispose();
  }
});

test("the copies of a duplicated install cross the bridge, so the version is not read as whole truth", async () => {
  const dispose = register(sampleReport());
  try {
    const r = (await fakeIpcMain.invoke(IPC.updatesCheck, {})) as UpdatesReportResult;
    const claude = r.tools.find((t) => t.id === "claude");
    assert.equal(claude?.state, "duplicate");
    assert.equal(claude?.copies.length, 2);
    assert.equal(claude?.copies[1]?.owner, "brew-cask");
    assert.equal(claude?.copies[1]?.version, "2.1.274");
    // The withheld command travels WITH its reason, or the warning becomes a silence.
    assert.equal(claude?.withheld[0]?.reason, "not the copy on PATH");
  } finally {
    dispose();
  }
});

test("ONLY `force` crosses the boundary — everything else the renderer sends is ignored", async () => {
  /**
   * The security property. A renderer that could name a manager, a URL or a command would be a
   * renderer that can steer a spawn in the main process.
   */
  const seen: { force?: boolean }[] = [];
  const dispose = register(sampleReport(), (d) => seen.push(d));
  try {
    await fakeIpcMain.invoke(IPC.updatesCheck, {
      force: true,
      command: "rm -rf /",
      manager: "evil",
      url: "http://attacker",
    });
    assert.equal(seen[0]?.force, true);
    assert.equal((seen[0] as Record<string, unknown>).command, undefined);
    assert.equal((seen[0] as Record<string, unknown>).manager, undefined);
    assert.equal((seen[0] as Record<string, unknown>).url, undefined);
  } finally {
    dispose();
  }
});

test("a non-boolean `force` is not truthy-coerced into a forced sweep", async () => {
  // `force` skips the throttle and spawns every package manager; "yes" must not do that.
  const seen: { force?: boolean }[] = [];
  const dispose = register(sampleReport(), (d) => seen.push(d));
  try {
    await fakeIpcMain.invoke(IPC.updatesCheck, { force: "yes" });
    assert.equal(seen[0]?.force, false);
  } finally {
    dispose();
  }
});

test("a thrown check returns ok:false — never an empty report that reads as up to date", async () => {
  const dispose = registerUpdatesIpcHandlers({
    home: "/tmp/nowhere",
    promVersion: "0.1.0",
    check: (async () => {
      throw new Error("registry unreachable");
    }) as never,
  });
  try {
    const r = (await fakeIpcMain.invoke(IPC.updatesCheck, {})) as UpdatesReportResult;
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /registry unreachable/);
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.self.updateAvailable, null, "unknown, not `nothing to do`");
  } finally {
    dispose();
  }
});

test("the handler is removed on dispose, so a re-register cannot double-bind", async () => {
  const dispose = register(sampleReport());
  dispose();
  const again = register(sampleReport());
  again();
});
