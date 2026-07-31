/**
 * sidecar.ts — the CLI's view of the Studio Python helper sidecars (C7).
 *
 * The actual spawning lives in @prometheus/engine-bridge (the SOLE importer of
 * node:child_process, per C5 / file 02 §1.1). This module just re-exports that
 * runner so the existing `./sidecar.js` importers in this package keep working
 * unchanged while the CLI no longer touches child_process itself.
 */
export {
  runSidecar,
  parseSidecarObject,
  resolveSidecarDir,
  type SidecarEnvelope,
  type SidecarOptions,
} from "@prometheus/engine-bridge";
