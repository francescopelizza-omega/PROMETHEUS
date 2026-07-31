/**
 * ext-host.test.ts — the .promext install pipeline, the webview RPC gate, and the
 * utility-process lifecycle manager (APP-059). Everything is driven through INJECTED seams
 * (a fake gate, fake backends, a fake runner handle), so the whole host is covered without
 * Electron. Real tmpdir fs for the install pipeline.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ext as coreExt } from "@prometheus/core";

type ExtensionBackends = coreExt.ExtensionBackends;
type ExtensionManifest = coreExt.ExtensionManifest;
type WebviewMessage = coreExt.WebviewMessage;

import {
  type ExtGateVerdict,
  ExtHostManager,
  ExtInstallError,
  dispatchWebviewRpc,
  installExtension,
  rpcMethodAllowed,
} from "./ext-host.js";

/* ── shared fixtures ──────────────────────────────────────────────────────── */

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Build a STORED-only ZIP buffer from {name → bytes}. */
function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt32LE(f.data.length, 18);
    lfh.writeUInt32LE(f.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    const local = Buffer.concat([lfh, nameBuf, f.data]);
    locals.push(local);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cen, nameBuf]));
    offset += local.length;
  }
  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

const VALID_MANIFEST = {
  schema: "extension@1",
  id: "pub.sample",
  label: "Sample",
  version: "1.0.0",
  main: "dist/main.js",
  permissions: { engine: ["list"] },
};

async function writePromext(
  dir: string,
  manifest: unknown,
  { includeManifest = true } = {},
): Promise<string> {
  const files: { name: string; data: Buffer }[] = [
    { name: "dist/main.js", data: Buffer.from("x") },
  ];
  if (includeManifest) {
    files.unshift({
      name: "prometheus.extension.json",
      data: Buffer.from(JSON.stringify(manifest)),
    });
  }
  const path = join(dir, "sample.promext");
  await writeFile(path, buildZip(files));
  return path;
}

const allowGate = async (): Promise<ExtGateVerdict> => ({ verdict: "allow" });

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prom-exthost-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ── install pipeline ─────────────────────────────────────────────────────── */

test("installExtension: valid .promext installs (gated) into the extensions dir, staging cleaned", async () => {
  await withTmp(async (dir) => {
    const archive = await writePromext(dir, VALID_MANIFEST);
    const extensionsDir = join(dir, "extensions");
    const res = await installExtension(archive, {
      extensionsDir,
      stagingRoot: dir,
      studioVersion: "1.0.0",
      gate: allowGate,
    });
    assert.equal(res.id, "pub.sample");
    assert.equal(res.installPath, join(extensionsDir, "pub.sample"));
    // the manifest landed in place…
    const installed = await readFile(join(res.installPath, "prometheus.extension.json"), "utf8");
    assert.match(installed, /pub\.sample/);
    // …and no staging residue remains.
    const leftovers = (await readdirSafe(dir)).filter((n) => n.startsWith(".promext-staging-"));
    assert.deepEqual(leftovers, []);
  });
});

test("installExtension: a malformed zip is rejected (bad-zip) with no staging residue", async () => {
  await withTmp(async (dir) => {
    const archive = join(dir, "broken.promext");
    await writeFile(archive, Buffer.from("this is not a zip"));
    await assert.rejects(
      () =>
        installExtension(archive, {
          extensionsDir: join(dir, "ext"),
          stagingRoot: dir,
          gate: allowGate,
        }),
      (e: unknown) => e instanceof ExtInstallError && e.code === "bad-zip",
    );
    const leftovers = (await readdirSafe(dir)).filter((n) => n.startsWith(".promext-staging-"));
    assert.deepEqual(leftovers, []);
  });
});

test("installExtension: a missing/invalid manifest is rejected (bad-manifest)", async () => {
  await withTmp(async (dir) => {
    const archive = await writePromext(dir, {}, { includeManifest: false });
    await assert.rejects(
      () =>
        installExtension(archive, {
          extensionsDir: join(dir, "ext"),
          stagingRoot: dir,
          gate: allowGate,
        }),
      (e: unknown) => e instanceof ExtInstallError && e.code === "bad-manifest",
    );
  });
});

test("installExtension: an incompatible engines.studio is rejected (incompatible)", async () => {
  await withTmp(async (dir) => {
    const archive = await writePromext(dir, {
      ...VALID_MANIFEST,
      engines: { studio: ">=99.0.0" },
    });
    await assert.rejects(
      () =>
        installExtension(archive, {
          extensionsDir: join(dir, "ext"),
          stagingRoot: dir,
          studioVersion: "1.0.0",
          gate: allowGate,
        }),
      (e: unknown) => e instanceof ExtInstallError && e.code === "incompatible",
    );
  });
});

test("installExtension: a RED nemesis verdict blocks install unconditionally (no force)", async () => {
  await withTmp(async (dir) => {
    const archive = await writePromext(dir, VALID_MANIFEST);
    const extensionsDir = join(dir, "ext");
    const blockGate = async (): Promise<ExtGateVerdict> => ({
      verdict: "block",
      reason: "malware",
    });
    await assert.rejects(
      () => installExtension(archive, { extensionsDir, stagingRoot: dir, gate: blockGate }),
      (e: unknown) => e instanceof ExtInstallError && e.code === "blocked",
    );
    // nothing was installed, no staging residue.
    await assert.rejects(() => stat(join(extensionsDir, "pub.sample")));
    const leftovers = (await readdirSafe(dir)).filter((n) => n.startsWith(".promext-staging-"));
    assert.deepEqual(leftovers, []);
  });
});

/* ── webview RPC gate ─────────────────────────────────────────────────────── */

test("rpcMethodAllowed: safe methods always; resource methods need the declared permission", () => {
  const withEngine = { ...VALID_MANIFEST } as ExtensionManifest;
  const bare = {
    schema: "extension@1",
    id: "a.b",
    label: "L",
    version: "1.0.0",
  } as ExtensionManifest;
  assert.equal(rpcMethodAllowed(withEngine, "ui.notify"), true); // always safe
  assert.equal(rpcMethodAllowed(withEngine, "engine.run"), true); // engine declared
  assert.equal(rpcMethodAllowed(bare, "engine.run"), false); // not declared → deny
  assert.equal(rpcMethodAllowed(bare, "secrets.get"), false);
  assert.equal(rpcMethodAllowed(withEngine, "totally.unknown"), false); // unknown → deny
});

test("dispatchWebviewRpc: a declared method round-trips; an undeclared one rejects", async () => {
  const calls: string[] = [];
  const backends = {
    engine: {
      run: async (argv: string[]) => {
        calls.push(`engine:${argv.join(" ")}`);
        return { code: 0 };
      },
    },
    ui: { notify: () => calls.push("notify"), showPanel: () => {} },
    commands: { register: () => ({ dispose: () => {} }), execute: async () => undefined },
    workspace: { rootUri: "file:///w", readFile: async () => new Uint8Array() },
    mcp: { listServers: () => [], callTool: async () => undefined },
    secrets: { get: async () => undefined, store: async () => {} },
  } as unknown as ExtensionBackends;

  const okMsg: WebviewMessage = { type: "engine.run", id: "1", payload: { argv: ["list"] } };
  const okReply = await dispatchWebviewRpc(VALID_MANIFEST as ExtensionManifest, okMsg, backends);
  assert.equal(okReply.id, "1");
  assert.deepEqual(okReply.payload, { code: 0 });
  assert.equal(okReply.error, undefined);
  assert.deepEqual(calls, ["engine:list"]);

  // secrets.get is NOT declared in VALID_MANIFEST (only engine) → default-deny.
  const denyMsg: WebviewMessage = { type: "secrets.get", id: "2", payload: { key: "k" } };
  const denyReply = await dispatchWebviewRpc(
    VALID_MANIFEST as ExtensionManifest,
    denyMsg,
    backends,
  );
  assert.match(denyReply.error ?? "", /not permitted/);
  assert.equal(denyReply.payload, undefined);
});

/* ── utility-process lifecycle manager ────────────────────────────────────── */

/** A controllable stand-in for the forked runner handle. */
class FakeRunner {
  readonly posted: unknown[] = [];
  terminated = false;
  autoReply = true;
  private msgL: ((m: unknown) => void)[] = [];
  private exitL: ((c: number | null) => void)[] = [];
  private errL: ((e: Error) => void)[] = [];

  postMessage(m: unknown): void {
    this.posted.push(m);
    const req = m as { reqId?: string };
    if (this.autoReply && typeof req.reqId === "string") {
      queueMicrotask(() => this.emitMessage({ reqId: req.reqId, ok: true }));
    }
  }
  on(ev: "message" | "exit" | "error", cb: (a: never) => void): void {
    if (ev === "message") this.msgL.push(cb as (m: unknown) => void);
    else if (ev === "exit") this.exitL.push(cb as (c: number | null) => void);
    else this.errL.push(cb as (e: Error) => void);
  }
  emitMessage(m: unknown): void {
    for (const cb of this.msgL) cb(m);
  }
  emitExit(code: number | null): void {
    for (const cb of this.exitL) cb(code);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const MANIFEST = VALID_MANIFEST as ExtensionManifest;

test("ExtHostManager: activate → active() → deactivate lifecycle over one runner", async () => {
  const runners: FakeRunner[] = [];
  const mgr = new ExtHostManager({
    spawn: () => {
      const r = new FakeRunner();
      runners.push(r);
      return r;
    },
  });
  await mgr.activate(MANIFEST, "/x/dist/main.js");
  assert.deepEqual(mgr.active(), ["pub.sample"]);
  assert.equal(runners.length, 1); // one runner spawned
  // the runner received an activate carrying the manifest + main path.
  assert.equal((runners[0]?.posted[0] as { op: string }).op, "activate");
  await mgr.deactivate("pub.sample");
  assert.deepEqual(mgr.active(), []);
  assert.equal(runners.length, 1); // still the same single runner
  mgr.dispose();
  assert.equal(runners[0]?.terminated, true);
});

test("ExtHostManager: a crash rejects the in-flight activate; the next activate respawns", async () => {
  const runners: FakeRunner[] = [];
  const mgr = new ExtHostManager({
    spawn: () => {
      const r = new FakeRunner();
      r.autoReply = runners.length > 0; // FIRST runner never replies (simulates a hang→crash)
      runners.push(r);
      return r;
    },
    now: () => 0,
  });
  const first = mgr.activate(MANIFEST, "/x/main.js");
  await tick();
  runners[0]?.emitExit(1); // the runner crashes with the request in flight
  await assert.rejects(first, /exited/);
  assert.deepEqual(mgr.active(), []); // active set dropped on crash
  // the next activate self-heals by spawning a fresh runner.
  await mgr.activate(MANIFEST, "/x/main.js");
  assert.equal(runners.length, 2);
  assert.deepEqual(mgr.active(), ["pub.sample"]);
  mgr.dispose();
});

test("ExtHostManager: services a runner's reverse host-rpc through the gated handler", async () => {
  const seen: { extId: string; method: string }[] = [];
  const mgr = new ExtHostManager({
    spawn: () => new FakeRunner(),
    onHostRpc: async (extId, msg) => {
      seen.push({ extId, method: msg.type });
      return { type: msg.type, ...(msg.id ? { id: msg.id } : {}), payload: "served" };
    },
  });
  await mgr.activate(MANIFEST, "/x/main.js");
  const runner = (mgr as unknown as { runner: FakeRunner }).runner;
  runner.emitMessage({
    hostRpc: true,
    rpcId: "r1",
    extId: "pub.sample",
    msg: { type: "engine.run", id: "r1", payload: { argv: ["list"] } },
  });
  await tick();
  assert.deepEqual(seen, [{ extId: "pub.sample", method: "engine.run" }]);
  // the manager posted the reply back to the runner.
  const reply = runner.posted.find((p) => (p as { hostRpcReply?: boolean }).hostRpcReply) as {
    rpcId: string;
    msg: WebviewMessage;
  };
  assert.equal(reply?.rpcId, "r1");
  assert.equal(reply?.msg.payload, "served");
  mgr.dispose();
});

/** readdir that tolerates a missing dir (returns []). */
async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
