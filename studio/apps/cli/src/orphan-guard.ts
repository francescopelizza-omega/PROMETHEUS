/**
 * orphan-guard.ts — re-export of the shared reaper (Phase 6).
 *
 * Moved to core with the rest of the host stack: Studio spawns children too, and an orphan
 * from the GUI is the same orphan. This shim keeps `bin.ts` / `pty` / `orchestration`
 * import sites stable.
 */
export * from "@prometheus/core/agent-system-host";
