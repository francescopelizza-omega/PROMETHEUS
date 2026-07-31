/**
 * window.d.ts — the typed `window.prometheus` surface for the renderer.
 *
 * The preload script (preload/index.ts) exposes a frozen `PrometheusApi` under
 * `window.prometheus` via contextBridge. This ambient declaration tells the
 * renderer's TypeScript about it so calls like `window.prometheus.scan()` are
 * fully typed WITHOUT the renderer importing anything privileged.
 *
 * It imports ONLY the plain-data types from the shared contract (no Node, no
 * Electron, no engine-bridge runtime) — those types are erased at compile time,
 * so nothing privileged is bundled into the sandboxed renderer.
 */

import type { PrometheusApi } from "../shared/ipc-contract.js";

declare global {
  interface Window {
    /** The contextBridge-exposed engine API (C5). undefined-safe in tests. */
    readonly prometheus: PrometheusApi;
  }
}
