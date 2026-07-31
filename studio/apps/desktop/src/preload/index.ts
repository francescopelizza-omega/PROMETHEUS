/**
 * preload/index.ts — the contextBridge wire (runs in the isolated preload world).
 *
 * This is the ONLY code that bridges the sandboxed renderer to the privileged
 * main process. It exposes a SMALL, TYPED, FROZEN API under `window.prometheus`
 * (BRIDGE_KEY). Every method is a thin `ipcRenderer.invoke(<channel>, …)` — the
 * renderer therefore gets PLAIN PROMISES of PLAIN DATA and NEVER a Node handle,
 * an EngineClient, a ChildProcess, or `require`.
 *
 * C5: contextIsolation is on, so the renderer's `window` is a different realm —
 * `contextBridge.exposeInMainWorld` is the only sanctioned channel across it.
 * We expose functions only (no objects with live refs), and only the exact
 * channels declared in the shared contract. Nothing here can be used to spawn a
 * process or read the disk directly.
 */

import { contextBridge } from "electron";

import { BRIDGE_KEY } from "../shared/ipc-contract.js";
import { createPrometheusApi } from "./api.js";

// Build the exact narrow §5 surface in ONE place (preload/api.ts) from the single
// shared contract, then expose the frozen API into the renderer's main world.
// With sandbox:true + contextIsolation:true this is the ONLY bridge; the renderer
// cannot reach ipcRenderer or any node:* primitive directly.
contextBridge.exposeInMainWorld(BRIDGE_KEY, createPrometheusApi());
