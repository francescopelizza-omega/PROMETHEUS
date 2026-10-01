// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ext/host.ts — the extension host SEAM (file 09 §5.2, interface-only).
 *
 * Extensions run in a dedicated utility process (never the renderer); the real host
 * lives in the desktop main process (Electron). Core defines the contract + the lazy
 * activation-event model so the rest of the system stays decoupled from Electron.
 */
import type { ExtensionBackends, ExtensionContext } from "./context.js";
import type { ExtensionManifest } from "./types.js";

/** A lazy activation trigger (§5.2 — keeps cold-start fast). */
export type ActivationEvent =
  | { kind: "onCommand"; command: string }
  | { kind: "onLanguage"; language: string }
  | { kind: "onView"; viewId: string }
  | { kind: "onStartupFinished" }
  | { kind: "onAgentRun"; agentId?: string };

/** The activation entrypoint an extension's main module exports. */
export type ActivateFn = (ctx: ExtensionContext) => void | Promise<void>;

/** The utility-process host the desktop main implements. */
export interface ExtensionHost {
  /** activate an installed extension (build its permission-bound context). */
  activate(manifest: ExtensionManifest, backends: ExtensionBackends): Promise<void>;
  /** deactivate + dispose an extension's subscriptions. */
  deactivate(id: string): Promise<void>;
  /** which extensions are currently active. */
  active(): string[];
}

/** Compute the activation events a manifest declares (from its contributions). */
export function activationEvents(manifest: ExtensionManifest): ActivationEvent[] {
  const events: ActivationEvent[] = [];
  for (const c of manifest.contributes?.commands ?? []) {
    events.push({ kind: "onCommand", command: c.id });
  }
  for (const p of manifest.ui?.panels ?? []) {
    events.push({ kind: "onView", viewId: p.id });
  }
  if (manifest.contributes?.agents?.length) events.push({ kind: "onAgentRun" });
  return events;
}
