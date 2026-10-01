// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/kernel-host.ts — the MAIN-process live-kernel bridge over kernel.py serve
 * (APP-045). One supervised `spawnKernelSidecar` session per notebook, keyed by a
 * host-minted sessionId.
 *
 * The renderer never spawns a child: this host owns the engine-bridge KernelSidecar
 * (the sole child_process owner), forwards every NDJSON event out as a `"event"`
 * emission tagged with its sessionId (ide-ipc multiplexes it onto the shared `ide:event`
 * push), and guarantees NO ORPHAN — `shutdown(id)` disposes one session's process tree,
 * `disposeAll()` reaps every session on window close.
 *
 * The `spawnKernelSidecar` factory is INJECTED so ide-ipc handlers are testable with a
 * fake kernel (node stands in for python3), never a real ipykernel.
 */
import { EventEmitter } from "node:events";

import {
  type KernelEvent,
  type KernelSidecar,
  spawnKernelSidecar,
} from "@prometheus/engine-bridge";

import type { IdeKernelStreamEvent } from "../../shared/ipc-contract.js";

/** The injectable spawn factory (defaults to the real engine-bridge one). */
export type KernelSpawner = (opts: { cwd: string; env?: Record<string, string> }) => KernelSidecar;

const defaultSpawner: KernelSpawner = ({ cwd, env }) =>
  spawnKernelSidecar({ cwd, ...(env ? { env } : {}) });

interface Session {
  sidecar: KernelSidecar;
  off: () => void;
}

export class KernelHost extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private readonly spawn: KernelSpawner;
  private seq = 0;

  constructor(spawn: KernelSpawner = defaultSpawner) {
    super();
    this.spawn = spawn;
  }

  /** Start a session for `cwd`; returns its sessionId (or throws to a fail-closed handler). */
  start(cwd: string, env?: Record<string, string>): string {
    this.seq += 1;
    const sessionId = `nb-${this.seq}`;
    // APP-088: force a headless matplotlib backend so figure capture works without a
    // display (set at spawn — pyplot binds its backend on first import, can't swap after).
    const kernelEnv = { MPLBACKEND: "Agg", ...(env ?? {}) };
    const sidecar = this.spawn({ cwd, env: kernelEnv });
    const listener = (event: KernelEvent): void => {
      this.emit("event", { sessionId, event: event as IdeKernelStreamEvent });
      // when the process exits, drop the session so a later shutdown is a no-op.
      if (event.event === "exit") this.sessions.delete(sessionId);
    };
    const off = sidecar.on(listener);
    this.sessions.set(sessionId, { sidecar, off });
    return sessionId;
  }

  execute(sessionId: string, cellId: string, code: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.sidecar.execute(cellId, code);
    return true;
  }

  interrupt(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.sidecar.interrupt();
    return true;
  }

  restart(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.sidecar.restart();
    return true;
  }

  /** APP-088: request a paged DataFrame view; the kernel replies with a `dataframe` event. */
  dataframe(sessionId: string, name: string, offset: number, limit: number): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.sidecar.dataframe(name, offset, limit);
    return true;
  }

  /** Shut down ONE session's kernel + process tree. Idempotent. */
  shutdown(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    this.sessions.delete(sessionId);
    s.off();
    s.sidecar.dispose();
    return true;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Reap EVERY live session (window close / re-register) — no orphan ipykernel. */
  disposeAll(): void {
    for (const [, s] of this.sessions) {
      s.off();
      s.sidecar.dispose();
    }
    this.sessions.clear();
  }
}
