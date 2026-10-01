// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ext-ipc.ts — the `ext:*` ipcMain handlers (file 09 §5, APP-059).
 *
 * RELAY-ONLY (mirrors settings-ipc.ts): validates the renderer's arg, delegates to the
 * PURE, Electron-free host (ext-host.ts / ext-secrets.ts), maps the result to a plain shape.
 * The Electron-coupled seams (utilityProcess spawn, safeStorage, the engine-bridge gate) are
 * INJECTED from main/index.ts so the host logic stays node:test-coverable here.
 *
 * The reverse host-RPC an extension makes (engine/secrets/fs/ui) is gated by
 * dispatchWebviewRpc against the installed manifest — default-deny, undeclared method rejects.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { describeEngineFailure } from "@prometheus/engine-bridge";

import { ext as coreExt } from "@prometheus/core";
import { ipcMain } from "electron";

import {
  type ExtActivateResult,
  type ExtDeactivateResult,
  type ExtInstallResult,
  type ExtListResult,
  type ExtRescanResult,
  IPC,
} from "../shared/ipc-contract.js";
import {
  type ExtGateFn,
  ExtHostManager,
  ExtInstallError,
  type SpawnRunner,
  dispatchWebviewRpc,
  installExtension,
} from "./ext-host.js";
import {
  type ExtRegistry,
  enabledIds,
  isEnabled,
  readRegistry,
  setEnabled,
  setVerdict,
  writeRegistry,
} from "./ext-registry.js";
import { ExtSecrets, type SafeStorageLike } from "./ext-secrets.js";

type ExtensionManifest = coreExt.ExtensionManifest;
type ExtensionBackends = coreExt.ExtensionBackends;

export interface ExtIpcOptions {
  /** the extensions root, `<userData>/extensions`. */
  extensionsDir: string;
  /** a scratch root for unzip staging. */
  stagingRoot: string;
  /** the per-extension encrypted-secrets dir, `<userData>/ext-secrets`. */
  secretsDir: string;
  /** the running Studio version (engines.studio gate). */
  studioVersion: string;
  /** the nemesis gate (engine-bridge) — a block/error verdict refuses install. */
  gate: ExtGateFn;
  /** the RICH nemesis gate (engine-bridge gateFull) — for the rescan verdict + findings. */
  gateFull: ExtGateFullFn;
  /** fork a fresh ext-runner utility process (injected — index.ts owns utilityProcess). */
  spawnRunner: SpawnRunner;
  /** Electron safeStorage (injected — index.ts owns it). */
  safeStorage: SafeStorageLike;
  /** the enable/verdict registry file, `<userData>/ext-registry.json` (APP-060). */
  registryPath: string;
}

/** A rich verdict for the rescan card (a compact projection of engine-bridge's NemesisVerdict). */
export interface ExtFullVerdict {
  verdict: string; // tier: allow | warn | block | error
  riskScore: number;
  scannedAt: string;
  findings: { ruleId: string; severity: string; detail: string }[];
}
export type ExtGateFullFn = (target: string) => Promise<ExtFullVerdict>;

interface Installed {
  manifest: ExtensionManifest;
  installPath: string;
}

// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;
function stringField(a: Record<string, unknown>, key: string): string | undefined {
  return typeof a[key] === "string" ? (a[key] as string) : undefined;
}

/** Resolve `p` (relative or file://) under `root`, rejecting any escape (path guard). */
function resolveWithinRoot(root: string, p: string): string {
  const rel = p.startsWith("file://") ? p.slice("file://".length) : p;
  const abs = resolve(root, rel.replace(/^\/+/, ""));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path escapes extension dir: ${p}`);
  }
  return abs;
}

/**
 * The host backends for one extension. secrets + workspace.readFile are wired to real,
 * guarded resources; ui is cosmetic; engine/mcp/commands are honest "not wired" rejections
 * (a follow-on) — the permission GATE (dispatchWebviewRpc) still enforces declaration.
 */
function backendsFor(
  manifest: ExtensionManifest,
  installPath: string,
  secrets: ExtSecrets,
): ExtensionBackends {
  const declaredSecrets = manifest.permissions?.secrets ?? [];
  return {
    commands: {
      register: () => ({ dispose: () => {} }),
      execute: async () => {
        throw new Error("commands.execute is not wired in this build");
      },
    },
    ui: { showPanel: () => {}, notify: () => {} },
    workspace: {
      rootUri: `file://${installPath}`,
      readFile: async (p) => new Uint8Array(await readFile(resolveWithinRoot(installPath, p))),
    },
    engine: {
      run: async () => {
        throw new Error("engine backend is not wired in this build");
      },
    },
    mcp: {
      listServers: () => [],
      callTool: async () => {
        throw new Error("mcp backend is not wired in this build");
      },
    },
    secrets: {
      get: (key) => secrets.get(manifest.id, key, declaredSecrets),
      store: (key, val) => secrets.set(manifest.id, key, val, declaredSecrets),
    },
  };
}

/** Scan the extensions dir for already-installed extensions (persistence across restart). */
async function scanInstalled(extensionsDir: string): Promise<Map<string, Installed>> {
  const out = new Map<string, Installed>();
  let dirs: string[];
  try {
    dirs = await readdir(extensionsDir);
  } catch {
    return out; // no extensions dir yet
  }
  for (const name of dirs) {
    const installPath = join(extensionsDir, name);
    try {
      const text = await readFile(join(installPath, "prometheus.extension.json"), "utf8");
      const manifest = coreExt.parseManifest(text);
      if (manifest) out.set(manifest.id, { manifest, installPath });
    } catch {
      /* not an extension dir — skip */
    }
  }
  return out;
}

/** Register the `ext:*` handlers. Returns a disposer (mirrors sibling IPC modules). */
export function registerExtIpcHandlers(opts: ExtIpcOptions): () => void {
  const secrets = new ExtSecrets({ safeStorage: opts.safeStorage, secretsDir: opts.secretsDir });
  const installed = new Map<string, Installed>();
  let registry: ExtRegistry = {};
  let scanned = false;

  const manager = new ExtHostManager({
    spawn: opts.spawnRunner,
    onHostRpc: async (extId, msg) => {
      const entry = installed.get(extId);
      if (!entry) {
        return {
          type: msg.type,
          ...(msg.id ? { id: msg.id } : {}),
          error: `unknown extension: ${extId}`,
        };
      }
      return dispatchWebviewRpc(
        entry.manifest,
        msg,
        backendsFor(entry.manifest, entry.installPath, secrets),
      );
    },
  });

  async function persistRegistry(next: ExtRegistry): Promise<void> {
    registry = next;
    await writeRegistry(opts.registryPath, next).catch(() => undefined);
  }

  /** Scan the extensions dir + load the registry, then (once) ACTIVATE every ENABLED
   *  extension — a disabled one is never activated at startup (APP-060). Best-effort. */
  async function ensureScanned(): Promise<void> {
    if (scanned) return;
    scanned = true;
    registry = await readRegistry(opts.registryPath);
    for (const [id, e] of await scanInstalled(opts.extensionsDir)) {
      if (!installed.has(id)) installed.set(id, e);
    }
    for (const id of enabledIds(registry)) {
      const entry = installed.get(id);
      if (!entry || manager.active().includes(id)) continue;
      const mainPath = join(entry.installPath, entry.manifest.main ?? "main.js");
      await manager.activate(entry.manifest, mainPath).catch(() => undefined);
    }
  }

  ipcMain.handle(IPC.extList, async (): Promise<ExtListResult> => {
    try {
      await ensureScanned();
      const active = new Set(manager.active());
      const extensions = [...installed.values()].map((e) => ({
        id: e.manifest.id,
        label: e.manifest.label,
        version: e.manifest.version,
        installPath: e.installPath,
        active: active.has(e.manifest.id),
        enabled: isEnabled(registry, e.manifest.id),
        permissions: coreExt.permissionSummary(e.manifest.permissions),
        ...(registry[e.manifest.id]?.verdict ? { verdict: registry[e.manifest.id]?.verdict } : {}),
      }));
      return { ok: true, extensions };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.extInstall, async (_e, arg: unknown): Promise<ExtInstallResult> => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const archivePath = stringField(a, "archivePath");
    if (!archivePath) return { ok: false, error: "archivePath is required" };
    try {
      await ensureScanned();
      const res = await installExtension(archivePath, {
        extensionsDir: opts.extensionsDir,
        stagingRoot: opts.stagingRoot,
        studioVersion: opts.studioVersion,
        gate: opts.gate,
      });
      installed.set(res.id, { manifest: res.manifest, installPath: res.installPath });
      return { ok: true, id: res.id, installPath: res.installPath };
    } catch (e) {
      const code = e instanceof ExtInstallError ? e.code : undefined;
      return { ok: false, ...(code ? { code } : {}), error: errString(e) };
    }
  });

  ipcMain.handle(IPC.extActivate, async (_e, arg: unknown): Promise<ExtActivateResult> => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const id = stringField(a, "id");
    if (!id) return { ok: false, error: "id is required" };
    const entry = installed.get(id);
    if (!entry) return { ok: false, error: `not installed: ${id}` };
    try {
      await ensureScanned();
      const mainPath = join(entry.installPath, entry.manifest.main ?? "main.js");
      await manager.activate(entry.manifest, mainPath);
      // persist the DESIRED enabled state so it's restored at the next startup (APP-060).
      await persistRegistry(setEnabled(registry, id, true));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.extDeactivate, async (_e, arg: unknown): Promise<ExtDeactivateResult> => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const id = stringField(a, "id");
    if (!id) return { ok: false, error: "id is required" };
    try {
      await ensureScanned();
      await manager.deactivate(id);
      await persistRegistry(setEnabled(registry, id, false)); // disabled → won't auto-activate
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.extRescan, async (_e, arg: unknown): Promise<ExtRescanResult> => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const id = stringField(a, "id");
    if (!id) return { ok: false, error: "id is required" };
    try {
      await ensureScanned();
      const entry = installed.get(id);
      if (!entry) return { ok: false, error: `not installed: ${id}` };
      // gate target: repo wins over the installed dir (mirrors the install-time gate target).
      const target = coreExt.gateTargetFor(entry.manifest, entry.installPath);
      const v = await opts.gateFull(target);
      // store the compact verdict so the chip survives a relaunch (persistence).
      await persistRegistry(
        setVerdict(registry, id, {
          tier: v.verdict,
          riskScore: v.riskScore,
          findingsCount: v.findings.length,
          scannedAt: v.scannedAt,
        }),
      );
      return {
        ok: true,
        verdict: {
          tier: v.verdict,
          riskScore: v.riskScore,
          scannedAt: v.scannedAt,
          findings: v.findings,
        },
      };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  return () => {
    manager.dispose();
    for (const channel of [
      IPC.extList,
      IPC.extInstall,
      IPC.extActivate,
      IPC.extDeactivate,
      IPC.extRescan,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
