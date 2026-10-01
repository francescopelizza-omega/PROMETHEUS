// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/home-servers-view.ts — PURE row derivation for the Home server controls
 * (APP-008). JSX-free so node:test pins the state→pill/action mapping and the
 * envelope guards. Status truth is ALWAYS the refetched `servers()` read — this
 * module only projects it; it never invents a state.
 */

import type { ServersResult } from "../../shared/ipc-contract.js";

/** supervisor states (core/supervisor registry.ts ServerState). */
export type ServerRowState = "starting" | "running" | "stopping" | "stopped" | "errored";

export interface ServerRowView {
  id: string;
  label: string;
  state: ServerRowState | "unknown";
  /** StatusPill's HealthViewStatus — role tokens only, no raw hex. */
  pill: "ok" | "degraded" | "down" | "unknown";
  /** the ONE action this state supports (start | stop) — null while transitioning. */
  op: "start" | "stop" | null;
  /** the supervisor's own lastError (e.g. the engine's 90% launch-guard refusal). */
  lastError: string | null;
}

/** Which action a supervisor state supports; transitions get none. */
export function nextServerOp(state: string): "start" | "stop" | null {
  if (state === "stopped" || state === "errored") return "start";
  if (state === "running" || state === "starting") return "stop";
  return null; // stopping (or unknown) — wait for the supervisor
}

/** ServerState → StatusPill status. */
export function serverPill(state: string): ServerRowView["pill"] {
  switch (state) {
    case "running":
      return "ok";
    case "starting":
    case "stopping":
      return "degraded";
    case "errored":
      return "down";
    default:
      return "unknown"; // stopped / junk — neutral, never invented health
  }
}

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "stopping",
  "stopped",
  "errored",
]);

/** Project a ServersResult envelope into rows — partial payloads never throw. */
export function serverRowViews(res: ServersResult | null | undefined): ServerRowView[] {
  if (!res || res.ok !== true || !Array.isArray(res.servers)) return [];
  const rows: ServerRowView[] = [];
  for (const s of res.servers) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.id) continue;
    const state = typeof s.state === "string" && KNOWN_STATES.has(s.state) ? s.state : "unknown";
    rows.push({
      id: s.id,
      label: typeof s.label === "string" && s.label ? s.label : s.id,
      state: state as ServerRowView["state"],
      pill: serverPill(state),
      op: nextServerOp(state),
      lastError: typeof s.lastError === "string" && s.lastError ? s.lastError : null,
    });
  }
  return rows;
}
