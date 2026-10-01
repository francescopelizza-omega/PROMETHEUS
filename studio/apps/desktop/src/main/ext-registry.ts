// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ext-registry.ts — the extension enable/verdict registry (APP-060).
 *
 * A tiny main-side JSON file (`<userData>/ext-registry.json`) that persists, per installed
 * extension id: its DESIRED enabled state (authoritative at startup — a disabled extension is
 * never activated) and its LAST stored nemesis verdict (so the marketplace chip survives a
 * relaunch instead of showing "unknown" until a rescan). Pure fs (node:fs, no Electron) +
 * pure reducers so it stays node:test-coverable, mirroring settings-store.ts.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The last nemesis scan result stored for an extension (compact — for the chip + card). */
export interface ExtStoredVerdict {
  tier: string; // "allow" | "warn" | "block" | "error"
  riskScore: number;
  findingsCount: number;
  scannedAt: string;
}

export interface ExtRegistryEntry {
  /** the user's desired activation state (persisted across relaunch). */
  enabled: boolean;
  /** the last nemesis verdict, when the extension has been scanned. */
  verdict?: ExtStoredVerdict;
}

export type ExtRegistry = Record<string, ExtRegistryEntry>;

/** Read the registry file; a missing/corrupt file is EMPTY (fail-soft, never throws). */
export async function readRegistry(path: string): Promise<ExtRegistry> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: ExtRegistry = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v && typeof v === "object" && typeof (v as ExtRegistryEntry).enabled === "boolean") {
        out[id] = v as ExtRegistryEntry;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the registry (pretty JSON; creates the parent dir). */
export async function writeRegistry(path: string, reg: ExtRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(reg, null, 2), "utf8");
}

/** Set an id's enabled state, preserving its stored verdict. Returns a NEW registry. */
export function setEnabled(reg: ExtRegistry, id: string, enabled: boolean): ExtRegistry {
  return { ...reg, [id]: { ...(reg[id] ?? { enabled }), enabled } };
}

/** Store an id's latest verdict, preserving its enabled state (default false). New registry. */
export function setVerdict(reg: ExtRegistry, id: string, verdict: ExtStoredVerdict): ExtRegistry {
  return { ...reg, [id]: { enabled: reg[id]?.enabled ?? false, verdict } };
}

/** Is an id enabled? (absent → false; a new install is NOT auto-enabled). */
export function isEnabled(reg: ExtRegistry, id: string): boolean {
  return reg[id]?.enabled === true;
}

/** The ids the user has enabled (the startup activation set). */
export function enabledIds(reg: ExtRegistry): string[] {
  return Object.entries(reg)
    .filter(([, e]) => e.enabled)
    .map(([id]) => id);
}
