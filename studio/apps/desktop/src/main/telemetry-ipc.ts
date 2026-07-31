/**
 * main/telemetry-ipc.ts — the typed `system:telemetry` ipcMain handler.
 *
 * The trusted side of the contextBridge for whole-machine resource telemetry
 * (CPU/GPU/NPU/RAM/DISK) + the launch guard verdict. RELAY-ONLY: it delegates to
 * `readTelemetry()` (main/telemetry.ts) and returns a plain-data contract shape —
 * the renderer polls this channel to draw the bottom-bar strip + the System panel,
 * and it never reads node:os/child_process itself (C5).
 *
 * Node/Electron only (privileged main).
 */
import { ipcMain } from "electron";

import { IPC, type SystemTelemetry } from "../shared/ipc-contract.js";
import { readTelemetry } from "./telemetry.js";

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A fail-soft telemetry envelope so a probe error never white-screens the strip. */
function errorTelemetry(message: string): SystemTelemetry {
  return {
    ok: false,
    platform: process.platform,
    arch: process.arch,
    osLabel: process.platform,
    cpu: { usedPct: 0, measured: false },
    ram: { usedPct: 0, measured: false },
    disk: { usedPct: 0, measured: false },
    gpus: [],
    npu: { present: false },
    // On a failed read we DON'T fabricate headroom: block the guard fail-closed.
    guard: {
      allow: false,
      thresholdPct: 90,
      cpuPct: 0,
      ramPct: 0,
      tripped: [],
      reason: `Telemetry unavailable (${message}) — launches held until a reading succeeds.`,
    },
    sampledAt: Date.now(),
    error: message,
  };
}

export function registerTelemetryIpcHandlers(): () => void {
  ipcMain.handle(IPC.systemTelemetry, async (): Promise<SystemTelemetry> => {
    try {
      return await readTelemetry();
    } catch (e) {
      return errorTelemetry(errString(e));
    }
  });

  return () => {
    ipcMain.removeHandler(IPC.systemTelemetry);
  };
}
