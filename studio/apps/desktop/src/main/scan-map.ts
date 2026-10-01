// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/scan-map.ts — PURE mappers for the engine `scan` envelope → renderer shape.
 *
 * The engine returns loose maps (the `--json` contract, C2), so the MAIN process
 * must normalise them to the renderer-safe shapes in shared/ipc-contract.ts BEFORE
 * they cross the contextBridge. This module holds the PURE, electron-free pieces
 * of that mapping so they are unit-testable with node:test right now (no electron,
 * no engine spawn) — mirroring how verdict-map.ts / health-derive.ts split their
 * pure logic out of the privileged handlers.
 *
 * Grounded against the REAL engine: `python3 prometheus.py --json scan` emits
 *   { command:"scan", ok:true,
 *     os:    { family:"macos", pkg_manager:"brew" },   // ← an OBJECT, not a string
 *     agents:[{ name, label, kind, present, where }, …] }
 * so `osLabel` flattens the OBJECT (a bare `typeof === "string"` check would
 * silently drop it and always render an empty OS in the title bar).
 *
 * Node-stdlib-only, zero deps, no electron — importable by the decoupled runner.
 */

import type { AgentRow } from "../shared/ipc-contract.js";

/**
 * Flatten the engine's `scan.os` into a single display label for the renderer.
 *
 * Renders `family` primarily, appends the package manager when it adds signal
 * (`"macos · brew"`), and falls back to a bare string (a forward-compat path for a
 * future engine that emits `os` as a string) or `undefined` when the field is
 * absent/unparseable. Pure + side-effect-free so the seam never throws on an
 * unexpected shape.
 */
export function osLabel(os: unknown): string | undefined {
  if (typeof os === "string") return os.trim() || undefined;
  if (os && typeof os === "object") {
    const o = os as Record<string, unknown>;
    const family = typeof o.family === "string" ? o.family.trim() : "";
    const pkg = typeof o.pkg_manager === "string" ? o.pkg_manager.trim() : "";
    if (family && pkg) return `${family} · ${pkg}`;
    if (family) return family;
    if (pkg) return pkg;
  }
  return undefined;
}

/**
 * Normalise the engine's loose `scan.agents` array into typed AgentRow[]. Skips
 * non-object entries, coerces every field to its renderer-safe type, and defaults
 * a missing `kind` to "cli" (the most common detected surface). Pure — the seam
 * never throws on a malformed agent entry; it is simply dropped or defaulted.
 */
export function toAgentRows(agents: unknown): AgentRow[] {
  const raw = Array.isArray(agents) ? (agents as unknown[]) : [];
  return raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => {
      const row: AgentRow = {
        name: String(a.name ?? ""),
        label: String(a.label ?? a.name ?? ""),
        kind: (a.kind as AgentRow["kind"]) ?? "cli",
        present: a.present === true,
      };
      if (typeof a.where === "string") row.where = a.where;
      return row;
    });
}
