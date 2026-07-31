/**
 * routes/catalog-lifecycle-view.ts — PURE helpers for the app/worldsim/model
 * lifecycle GUI (APP-007). JSX-free so node:test pins the verb→request mapping,
 * the progress-stream filtering, and the versions-envelope parsing.
 *
 * The wire shape is the REAL contract ({surface, action, tool, version?, runId?}
 * — CatalogAppLifecycleRequest), not the spec's assumed {op, name}; actions are
 * validated by main's zod APP_ACTION enum, so names here match it exactly.
 */

import type { CatalogAppLifecycleRequest } from "../shared/ipc-contract.js";

/** The lifecycle surface for a catalog item kind — null = no lifecycle menu. */
export function lifecycleSurfaceFor(kind: string): CatalogAppLifecycleRequest["surface"] | null {
  switch (kind) {
    case "app":
      return "apps";
    case "worldsim":
      return "worldsim";
    case "model-tool":
      return "models";
    default:
      return null; // plugins/documented use install/uninstall, not appLifecycle
  }
}

/** The verbs the per-entry menu offers (subset of main's APP_ACTION enum). */
export const LIFECYCLE_MENU_ACTIONS = [
  "update",
  "restart",
  "logs",
  "versions",
  "enable",
  "disable",
] as const;
export type LifecycleMenuAction = (typeof LIFECYCLE_MENU_ACTIONS)[number] | "rollback";

/** Actions whose engine run streams stderr worth showing live. */
export function lifecycleStreams(action: string): boolean {
  return (
    action === "update" ||
    action === "update-all" ||
    action === "restart" ||
    action === "rollback" ||
    action === "install" ||
    action === "uninstall"
  );
}

/** Build the exact wire request for a lifecycle verb. */
export function lifecycleRequest(
  surface: CatalogAppLifecycleRequest["surface"],
  action: string,
  tool: string,
  opts: { version?: string | undefined; runId?: string | undefined } = {},
): CatalogAppLifecycleRequest {
  const req: CatalogAppLifecycleRequest = { surface, action, tool };
  if (opts.version !== undefined) req.version = opts.version;
  if (opts.runId !== undefined) req.runId = opts.runId;
  return req;
}

/** A run correlation id that always satisfies main's RUN_ID zod regex
 *  (`[A-Za-z0-9._:-]+`, ≤128) — tool names may carry `/`/`,` which are legal in
 *  NAME but not RUN_ID, so everything else maps to `-`. */
export function lifecycleRunId(tool: string, seq: number): string {
  const safe = tool.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 100) || "tool";
  return `lifecycle:${safe}:${seq}`;
}

/** Cap so a chatty engine can't grow the pane unbounded. */
export const LOG_LINE_CAP = 500;

/**
 * Append a catalog progress event to the log pane's lines IFF it belongs to the
 * active run (the stream is GLOBAL — shared with install/uninstall/bundle; a
 * strict runId match keeps foreign ops out). Multi-line payloads split; the cap
 * keeps the newest lines.
 */
export function appendLifecycleLog(
  lines: readonly string[],
  event: { runId?: string; message?: string } | null | undefined,
  activeRunId: string | null,
): string[] {
  if (!event || activeRunId === null || event.runId !== activeRunId) return [...lines];
  const msg = typeof event.message === "string" ? event.message : "";
  const parts = msg.split("\n").filter((l) => l.trim().length > 0);
  if (parts.length === 0) return [...lines];
  const next = [...lines, ...parts];
  return next.length > LOG_LINE_CAP ? next.slice(next.length - LOG_LINE_CAP) : next;
}

/**
 * Pull a version list out of the `versions` envelope. The engine's shape is not
 * contract-pinned (raw envelope) — accept string arrays or {version} object rows
 * under the common keys, else []. Ordering is engine-defined; presented as-is.
 */
export function parseVersions(data: Record<string, unknown> | null | undefined): string[] {
  if (!data || typeof data !== "object") return [];
  for (const key of ["versions", "available", "list", "rows", "items"]) {
    const v = (data as Record<string, unknown>)[key];
    if (!Array.isArray(v)) continue;
    const out: string[] = [];
    for (const entry of v) {
      if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
      else if (entry && typeof entry === "object") {
        const ver = (entry as Record<string, unknown>).version;
        if (typeof ver === "string" && ver.trim()) out.push(ver.trim());
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}
