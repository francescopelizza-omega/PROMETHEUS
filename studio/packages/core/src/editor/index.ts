/**
 * editor/index.ts — the editor-core barrel (MDS parity file 01 / file 07 §3.1,§8).
 *
 * One import surface for the PURE editor logic: the ChangeSet apply/reject engine
 * (changeset.ts), the editor command registry (command-registry.ts), and the
 * smart-key + clipboard-ring math (smart-keys.ts). Everything here is framework-
 * free (NO monaco/react/electron), so this subpath is safe for BOTH the `prometheus`
 * CLI and the C5-sandboxed renderer (the ROOT `@prometheus/core` barrel is not:
 * it eagerly evaluates node:fs modules).
 *
 * The root index.ts remains the canonical public surface for node consumers —
 * it re-exports these same symbols; this barrel adds no new names of its own.
 */

export * from "./changeset.js";
export * from "./command-registry.js";
export * from "./smart-keys.js";
export * from "./templates.js";
