// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * admin-view.ts — the pure half of "Open disk space as administrator": what the panel says
 * when the session ends, for each way it can end.
 */
import type { DiskAdminResultView } from "../../../shared/ipc-contract.js";

export interface AdminEndMessage {
  tone: "info" | "error";
  text: string;
}

export function adminEndMessage(r: DiskAdminResultView): AdminEndMessage {
  if (r.ok) return { tone: "info", text: "disk-space (as administrator) closed." };
  switch (r.decision) {
    case "denied":
      return { tone: "info", text: "Not opened — you denied it." };
    case "timeout":
      return { tone: "info", text: `${r.error ?? "No answer in time"} — nothing ran.` };
    case "approved":
      return { tone: "error", text: r.error ?? `disk-space ended (exit ${r.exitCode ?? "?"})` };
    default:
      return { tone: "error", text: r.error ?? `Not opened (${r.decision ?? "failed"}).` };
  }
}
