// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/disk-space-ipc.ts — the Disk Space panel's channels.
 *
 * Every channel is a thin, validated call into engine-bridge's disk-space facade, which runs
 * the `disk_map.py` sidecar (never as root). The renderer cannot invent a path the sidecar
 * would misread: paths must be absolute or `~`-relative, NUL-free and bounded, and the facade
 * always puts them after `--`.
 *
 * Two doors need more than a path:
 *  - `disk:delete` runs only with `confirm: true` (the dialog's explicit click), and passes
 *    `ackHighRisk` only when the renderer says the human typed "yes". `disk:deletePlan` can
 *    never delete. The sidecar re-checks every protection at confirm time.
 *  - `disk:rescanAsRoot` asks the sidecar for the exact root command and hands it to the
 *    privileged gate — the human approves that command in the approval dialog, and the
 *    password goes to sudo through the askpass helper. Nothing else here can elevate.
 */
import { ipcMain } from "electron";

import type { PrivilegedGate } from "@prometheus/core/agent-system-host";
import { type DiskSpaceClient, createDiskSpaceClient } from "@prometheus/engine-bridge";

import {
  type DiskDeleteModeView,
  type DiskDeletePlanView,
  type DiskDeleteRunView,
  type DiskFilesView,
  type DiskLevelsView,
  type DiskMapView,
  type DiskMountsView,
  type DiskNodeView,
  IPC,
} from "../shared/ipc-contract.js";

const MAX_PATH = 4096;
const MAX_PATHS = 200;
const DEFAULT_MAX_NODES = 5000;
/** How much of a root rescan's stdout (its JSON map) to keep. */
const ROOT_MAP_CAPTURE_BYTES = 64 * 1024 * 1024;

type Clean<T> = { ok: true; value: T } | { ok: false; error: string };

function cleanPath(v: unknown): Clean<string> {
  if (typeof v !== "string" || !v) return { ok: false, error: "a path is required" };
  if (v.length > MAX_PATH) return { ok: false, error: "path too long" };
  if (v.includes("\u0000")) return { ok: false, error: "path contains NUL" };
  const exact = v.startsWith("hex:") && /^hex:[0-9a-f]+$/i.test(v);
  if (!(exact || v.startsWith("/") || v === "~" || v.startsWith("~/"))) {
    return { ok: false, error: "the path must be absolute or start with ~" };
  }
  return { ok: true, value: v };
}

function cleanPaths(v: unknown): Clean<string[]> {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PATHS) {
    return { ok: false, error: `between 1 and ${MAX_PATHS} paths are required` };
  }
  const out: string[] = [];
  for (const p of v) {
    const c = cleanPath(p);
    if (!c.ok) return c;
    out.push(c.value);
  }
  return { ok: true, value: out };
}

function cleanMode(v: unknown): Clean<DiskDeleteModeView> {
  return v === "trash" || v === "permanent"
    ? { ok: true, value: v }
    : { ok: false, error: "mode must be trash or permanent" };
}

function intIn(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.max(lo, Math.min(hi, Math.trunc(v)))
    : dflt;
}

const errOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function registerDiskSpaceIpcHandlers(
  deps: { client?: DiskSpaceClient; gate?: () => PrivilegedGate | undefined } = {},
): () => void {
  const client = deps.client ?? createDiskSpaceClient();

  ipcMain.handle(IPC.diskMounts, async (): Promise<DiskMountsView> => {
    try {
      const r = await client.mounts();
      return r.ok
        ? { ok: true, mounts: r.mounts ?? [] }
        : { ok: false, error: r.error ?? "failed" };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskMap, async (_e, arg: unknown): Promise<DiskMapView> => {
    const a = (arg ?? {}) as { path?: unknown; maxNodes?: unknown };
    const p = cleanPath(a.path);
    if (!p.ok) return { ok: false, error: p.error };
    try {
      const r = await client.map(p.value, {
        maxNodes: intIn(a.maxNodes, 1, 50_000, DEFAULT_MAX_NODES),
      });
      if (!r.ok || !r.tree) return { ok: false, error: r.error ?? "the scan failed" };
      return {
        ok: true,
        tree: r.tree as DiskNodeView,
        ...(r.summary ? { summary: r.summary } : {}),
        ...(r.truncated ? { truncated: true } : {}),
      };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskLevels, async (_e, arg: unknown): Promise<DiskLevelsView> => {
    const a = (arg ?? {}) as { path?: unknown; depth?: unknown; top?: unknown };
    const p = cleanPath(a.path);
    if (!p.ok) return { ok: false, error: p.error };
    try {
      const r = await client.levels(p.value, {
        depth: intIn(a.depth, 1, 12, 4),
        top: intIn(a.top, 1, 200, 12),
      });
      return r.ok
        ? { ok: true, levels: r.levels ?? [] }
        : { ok: false, error: r.error ?? "failed" };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskFiles, async (_e, arg: unknown): Promise<DiskFilesView> => {
    const a = (arg ?? {}) as { path?: unknown; top?: unknown };
    const p = cleanPath(a.path);
    if (!p.ok) return { ok: false, error: p.error };
    try {
      const r = await client.largestFiles(p.value, { top: intIn(a.top, 1, 1000, 50) });
      return r.ok ? { ok: true, files: r.files ?? [] } : { ok: false, error: r.error ?? "failed" };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskDeletePlan, async (_e, arg: unknown): Promise<DiskDeletePlanView> => {
    const a = (arg ?? {}) as { paths?: unknown; mode?: unknown };
    const ps = cleanPaths(a.paths);
    if (!ps.ok) return { ok: false, error: ps.error };
    const mode = cleanMode(a.mode);
    if (!mode.ok) return { ok: false, error: mode.error };
    try {
      const r = await client.deletePlan(ps.value, { mode: mode.value });
      if (!r.ok) return { ok: false, error: r.error ?? "failed" };
      return {
        ok: true,
        mode: mode.value,
        items: r.items ?? [],
        worstRisk: r.worstRisk ?? null,
        total: r.total ?? 0,
        requiresPhrase: r.requiresPhrase === true,
      };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskDelete, async (_e, arg: unknown): Promise<DiskDeleteRunView> => {
    const a = (arg ?? {}) as {
      paths?: unknown;
      mode?: unknown;
      confirm?: unknown;
      ackHighRisk?: unknown;
    };
    if (a.confirm !== true) return { ok: false, error: "a delete needs confirm: true" };
    const ps = cleanPaths(a.paths);
    if (!ps.ok) return { ok: false, error: ps.error };
    const mode = cleanMode(a.mode);
    if (!mode.ok) return { ok: false, error: mode.error };
    try {
      const r = await client.deleteConfirm(ps.value, {
        mode: mode.value,
        ackHighRisk: a.ackHighRisk === true,
      });
      return r.ok
        ? { ok: (r.results ?? []).every((x) => x.ok), results: r.results ?? [] }
        : { ok: false, error: r.error ?? "failed" };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskRescanAsRoot, async (_e, arg: unknown): Promise<DiskMapView> => {
    const a = (arg ?? {}) as { path?: unknown };
    const p = cleanPath(a.path);
    if (!p.ok) return { ok: false, error: p.error };
    const gate = deps.gate?.();
    if (!gate) return { ok: false, error: "the privileged gate is not available" };
    try {
      const r = await client.privilegedRescan(p.value);
      if (!r.ok || !r.argv)
        return { ok: false, error: r.error ?? "could not build the root command" };
      const res = await gate.requestAndRun(
        {
          argv: r.argv,
          cwd: r.cwd ?? "/",
          why: r.why ?? `measure ${p.value} as root`,
          surface: "studio",
          requester: "Studio: Rescan as root",
        },
        // the whole map comes back on stdout — keep all of it, not the gate's 1 MiB default
        { captureBytes: ROOT_MAP_CAPTURE_BYTES },
      );
      if (res.decision !== "approved") {
        return {
          ok: false,
          decision: res.decision,
          error: res.reason ?? `not run (${res.decision})`,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          decision: res.decision,
          error: res.reason ?? `the root scan failed (exit ${res.exitCode})`,
        };
      }
      if (res.outputTruncated) {
        return {
          ok: false,
          decision: res.decision,
          error: "the root map was too large to keep — rescan a deeper folder",
        };
      }
      const parsed = JSON.parse(res.stdout ?? "") as {
        tree?: DiskNodeView;
        summary?: DiskMapView["summary"];
      };
      if (!parsed.tree) return { ok: false, error: "the root scan returned no tree" };
      return {
        ok: true,
        asRoot: true,
        decision: res.decision,
        tree: parsed.tree,
        ...(parsed.summary ? { summary: parsed.summary } : {}),
      };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  return () => {
    for (const ch of [
      IPC.diskMounts,
      IPC.diskMap,
      IPC.diskLevels,
      IPC.diskFiles,
      IPC.diskDeletePlan,
      IPC.diskDelete,
      IPC.diskRescanAsRoot,
    ]) {
      ipcMain.removeHandler(ch);
    }
  };
}
