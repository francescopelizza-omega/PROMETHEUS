/**
 * persona-ipc.test.ts — node:test coverage for registerPersonaIpcHandlers(): `personaList`
 * returns the shared on-disk persona catalog with `path` stripped off the wire, `personaExport`
 * reads one persona's raw markdown back out (found/not-found), `personaImportText`/
 * `personaImportPath` write ONLY into `<home>/agents/imported/` via persona-store.ts's hardened
 * `importPersonaMarkdown` (rejecting a malicious name / an oversized payload / a relative or
 * oversized file path before anything reaches disk), and `personaRemove` deletes an imported
 * persona (a no-op, not an error, for an unknown name).
 *
 * persona-ipc.ts does a REAL top-level `import { ipcMain } from "electron"`, so this suite uses
 * node:test's `mock.module()` (wired into scripts/run-tests.mjs) to substitute a fake exposing
 * just `ipcMain`, then calls the registered handlers DIRECTLY (bypassing real IPC transport) to
 * exercise the actual handler bodies against a real tmpdir filesystem.
 *
 * persona-store.ts's functions all default `home` to the REAL `prometheusHome()` — this suite
 * NEVER exercises that default (a store whose `home` defaults to the real `~/.prometheus` and is
 * called unconditionally from a test suite would silently write fixture data into the user's
 * actual home directory). persona-ipc.ts never threads a `home` override through the IPC boundary
 * (production always wants the one real shared catalog), so the only seam available here is
 * `$PROMETHEUS_HOME` — set to a real mkdtemp'd dir for this whole file's process BEFORE
 * persona-ipc.ts (and therefore persona-store.ts) is ever imported. This mirrors the tmp
 * `globalPath` seam model-health-ipc.test.ts / schedule-ipc.test.ts use, adapted to an env-var
 * because persona discovery is a SHARED (not Electron-`userData`-private) catalog.
 *
 * `mock.module("electron", ...)` may only be called ONCE per process, so — mirroring
 * model-health-ipc.test.ts, NOT ide-ipc.test.ts's per-test call — the mock + the ONE resulting
 * module import + registration happen ONCE at file scope, closing over a mutable `openRoot` that
 * the `workspaceRoot` getter reads fresh on every call (so one test can prove the getter is never
 * captured once at registration time — a real folder switch). Tests run in declaration order and
 * build on shared, accumulating filesystem state; the register→dispose→register test is last.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import {
  IPC,
  type PersonaExportResult,
  type PersonaImportResult,
  type PersonaListResult,
  type PersonaRemoveResult,
} from "../shared/ipc-contract.js";

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

// Real mkdtemp'd dirs throughout — NEVER the real `~/.prometheus` / real cwd.
const home = mkdtempSync(join(tmpdir(), "prom-persona-ipc-home-"));
const root = mkdtempSync(join(tmpdir(), "prom-persona-ipc-root-"));
const picked = mkdtempSync(join(tmpdir(), "prom-persona-ipc-picked-"));
process.env.PROMETHEUS_HOME = home;

/** What `workspaceRoot()` returns — mutated by the "read fresh" test to prove it is never
 *  captured once at registration time. */
let openRoot: string | undefined = root;

const fakeIpcMain = makeFakeIpcMain();
mock.module("electron", { exports: { ipcMain: fakeIpcMain } });
const { registerPersonaIpcHandlers, isRemoteLookingPath } = await import("./persona-ipc.js");
registerPersonaIpcHandlers(() => openRoot);

const CHANNELS = [
  IPC.personaList,
  IPC.personaExport,
  IPC.personaImportText,
  IPC.personaImportPath,
  IPC.personaRemove,
];

/* ── personaList ─────────────────────────────────────────────────────────── */

test("personaList: an empty catalog yields an empty list, not an error", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaList, {})) as PersonaListResult;
  assert.equal(res.ok, true);
  assert.deepEqual(res.personas, []);
});

test("personaList: lists a populated catalog with `path` stripped off the wire", async () => {
  mkdirSync(join(home, "agents", "imported"), { recursive: true });
  writeFileSync(
    join(home, "agents", "reviewer.md"),
    "---\ndescription: user reviewer\n---\nUser body.",
  );
  mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".prometheus", "agents", "docs.md"),
    "---\ndescription: writes docs\n---\nProject body.",
  );
  writeFileSync(
    join(home, "agents", "imported", "helper.md"),
    "---\ndescription: a shared helper\n---\nImported body.",
  );

  const res = (await fakeIpcMain.invoke(IPC.personaList, {})) as PersonaListResult;
  assert.equal(res.ok, true);
  assert.equal(res.personas?.length, 3);

  const byName = Object.fromEntries((res.personas ?? []).map((p) => [p.name, p]));
  assert.equal(byName.reviewer?.scope, "user");
  assert.equal(byName.reviewer?.description, "user reviewer");
  assert.equal(byName.docs?.scope, "project");
  assert.equal(byName.helper?.scope, "imported");

  for (const p of res.personas ?? []) {
    assert.deepEqual(Object.keys(p).sort(), ["description", "name", "scope"]);
    assert.equal(
      (p as unknown as { path?: unknown }).path,
      undefined,
      "a real filesystem path must never cross to the renderer",
    );
  }
});

test("personaList: the workspaceRoot getter is read fresh, not captured at registration", async () => {
  const otherRoot = mkdtempSync(join(tmpdir(), "prom-persona-ipc-otherroot-"));
  try {
    mkdirSync(join(otherRoot, ".prometheus", "agents"), { recursive: true });
    writeFileSync(
      join(otherRoot, ".prometheus", "agents", "other-project.md"),
      "---\ndescription: a different project's persona\n---\nOther body.",
    );

    const before = (await fakeIpcMain.invoke(IPC.personaList, {})) as PersonaListResult;
    assert.ok(!before.personas?.some((p) => p.name === "other-project"));

    openRoot = otherRoot;
    const afterSwitch = (await fakeIpcMain.invoke(IPC.personaList, {})) as PersonaListResult;
    assert.ok(afterSwitch.personas?.some((p) => p.name === "other-project"));
  } finally {
    openRoot = root;
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

/* ── personaExport ───────────────────────────────────────────────────────── */

test("personaExport: exports a found persona's raw markdown verbatim", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaExport, {
    name: "reviewer",
  })) as PersonaExportResult;
  assert.equal(res.ok, true);
  assert.equal(res.scope, "user");
  assert.equal(res.markdown, "---\ndescription: user reviewer\n---\nUser body.");
});

test("personaExport: an unknown name yields ok:false, not a thrown error", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaExport, {
    name: "does-not-exist",
  })) as PersonaExportResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /no persona named/);
});

test("personaExport: rejects a missing name and never touches the store", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaExport, {})) as PersonaExportResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /name/);
});

/* ── personaImportText ───────────────────────────────────────────────────── */

test("personaImportText: imports pasted markdown into agents/imported/", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaImportText, {
    suggestedName: "shared-helper",
    markdown: "---\ndescription: a shared persona\n---\nBe helpful.",
  })) as PersonaImportResult;
  assert.equal(res.ok, true);
  assert.equal(res.name, "shared-helper");
  assert.equal(res.replaced, false);
  assert.equal(
    readFileSync(join(home, "agents", "imported", "shared-helper.md"), "utf8"),
    "---\ndescription: a shared persona\n---\nBe helpful.",
  );
});

test("personaImportText: a malicious suggestedName is rejected, nothing written", async () => {
  const importedDir = join(home, "agents", "imported");
  const before = new Set(existsSync(importedDir) ? readdirSync(importedDir) : []);

  const res = (await fakeIpcMain.invoke(IPC.personaImportText, {
    suggestedName: "../../evil",
    markdown: "Some body.",
  })) as PersonaImportResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not a valid persona name/);

  const after = new Set(existsSync(importedDir) ? readdirSync(importedDir) : []);
  assert.deepEqual(after, before, "the imported directory must be untouched");
});

test("personaImportText: an oversized payload is rejected before any write", async () => {
  const huge = "x".repeat(65537);
  const res = (await fakeIpcMain.invoke(IPC.personaImportText, {
    suggestedName: "too-big",
    markdown: huge,
  })) as PersonaImportResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /too large/);
  assert.ok(!existsSync(join(home, "agents", "imported", "too-big.md")));
});

test("personaImportText: rejects a missing suggestedName or markdown", async () => {
  const missingName = (await fakeIpcMain.invoke(IPC.personaImportText, {
    markdown: "Body.",
  })) as PersonaImportResult;
  assert.equal(missingName.ok, false);

  const missingMarkdown = (await fakeIpcMain.invoke(IPC.personaImportText, {
    suggestedName: "x",
  })) as PersonaImportResult;
  assert.equal(missingMarkdown.ok, false);
});

/* ── personaImportPath ───────────────────────────────────────────────────── */

test("personaImportPath: reads a real temp file (from the native picker) and imports it", async () => {
  const filePath = join(picked, "friend-persona.md");
  writeFileSync(filePath, "---\ndescription: from a friend\n---\nBe concise.");

  const res = (await fakeIpcMain.invoke(IPC.personaImportPath, {
    path: filePath,
  })) as PersonaImportResult;
  assert.equal(res.ok, true);
  assert.equal(res.name, "friend-persona");
  assert.equal(
    readFileSync(join(home, "agents", "imported", "friend-persona.md"), "utf8"),
    "---\ndescription: from a friend\n---\nBe concise.",
  );
});

test("personaImportPath: rejects a relative path", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaImportPath, {
    path: "relative/friend.md",
  })) as PersonaImportResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /absolute/);
});

test("personaImportPath: rejects a URL-scheme-looking path (never fetches over the network)", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaImportPath, {
    path: "https://evil.example.com/persona.md",
  })) as PersonaImportResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /absolute/);
});

test("personaImportPath: rejects a Windows UNC network path (isAbsolute()===true but names a network location, not a local file)", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaImportPath, {
    path: "\\\\evil-server\\share\\persona.md",
  })) as PersonaImportResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /absolute/);
});

test("personaImportPath: rejects a POSIX-style '//host/share' network path", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaImportPath, {
    path: "//evil-server/share/persona.md",
  })) as PersonaImportResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /absolute/);
});

test("isRemoteLookingPath: a Windows drive-letter path is NOT mistaken for a URL scheme", () => {
  // The bug: `/^[a-z][a-z0-9+.-]*:/i` (no "://" required) matches a bare drive letter just as
  // well as a real URL scheme, so on Windows EVERY absolute local path from the native picker
  // used to be rejected outright. Checked as a pure string predicate (not via `isAbsolute`,
  // which is only ever `true` for a drive-letter path on an actual win32 host) so this is
  // reproducible on any CI platform.
  assert.equal(isRemoteLookingPath("C:\\Users\\alice\\Downloads\\friend-persona.md"), false);
  assert.equal(isRemoteLookingPath("D:\\personas\\reviewer.md"), false);
});

test("isRemoteLookingPath: real URL schemes and network paths are still rejected", () => {
  assert.equal(isRemoteLookingPath("https://evil.example.com/persona.md"), true);
  assert.equal(isRemoteLookingPath("ftp://evil.example.com/persona.md"), true);
  assert.equal(isRemoteLookingPath("file:///etc/passwd"), true);
  assert.equal(isRemoteLookingPath("\\\\evil-server\\share\\persona.md"), true);
  assert.equal(isRemoteLookingPath("//evil-server/share/persona.md"), true);
  assert.equal(isRemoteLookingPath("/home/alice/personas/reviewer.md"), false);
});

test("personaImportPath: rejects an oversized file without importing it", async () => {
  const bigPath = join(picked, "too-big-file.md");
  writeFileSync(bigPath, "x".repeat(65537));

  const res = (await fakeIpcMain.invoke(IPC.personaImportPath, {
    path: bigPath,
  })) as PersonaImportResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /too large/);
  assert.ok(!existsSync(join(home, "agents", "imported", "too-big-file.md")));
});

test("personaImportPath: a missing file becomes a clean ok:false, never a thrown exception", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaImportPath, {
    path: join(picked, "does-not-exist.md"),
  })) as PersonaImportResult;
  assert.equal(res.ok, false);
  assert.ok((res.error ?? "").length > 0);
});

test("personaImportPath: rejects a missing path", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaImportPath, {})) as PersonaImportResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /path/);
});

/* ── personaRemove ───────────────────────────────────────────────────────── */

test("personaRemove: removes a real imported persona", async () => {
  const importedPath = join(home, "agents", "imported", "shared-helper.md");
  assert.ok(existsSync(importedPath));

  const res = (await fakeIpcMain.invoke(IPC.personaRemove, {
    name: "shared-helper",
  })) as PersonaRemoveResult;
  assert.equal(res.ok, true);
  assert.ok(!existsSync(importedPath));
});

test("personaRemove: removing an unknown name is a no-op success, not an error", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaRemove, {
    name: "never-existed",
  })) as PersonaRemoveResult;
  assert.equal(res.ok, true);
  assert.equal(res.error, undefined);
});

test("personaRemove: rejects a missing name", async () => {
  const res = (await fakeIpcMain.invoke(IPC.personaRemove, {})) as PersonaRemoveResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /name/);
});

/* ── lifecycle ────────────────────────────────────────────────────────────── */

test("registerPersonaIpcHandlers: a full dispose lets re-registration succeed (window-reload safety)", () => {
  assert.deepEqual([...fakeIpcMain.handledChannels()].sort(), [...CHANNELS].sort());
  for (const channel of CHANNELS) {
    fakeIpcMain.removeHandler(channel);
  }
  assert.equal(fakeIpcMain.handledChannels().size, 0);

  assert.doesNotThrow(() => {
    registerPersonaIpcHandlers(() => openRoot);
  }, "re-registering after a full dispose must not throw double-registration");
  assert.deepEqual([...fakeIpcMain.handledChannels()].sort(), [...CHANNELS].sort());
});

after(async () => {
  process.env.PROMETHEUS_HOME = undefined;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(picked, { recursive: true, force: true });
});
