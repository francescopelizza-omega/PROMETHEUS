// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * memory-probe.ts — how much memory is really free, asked of the KERNEL.
 *
 * This exists because the app and the watchdogs disagreed about what "memory is tight" means,
 * and the app was using the metric this project already learned is wrong.
 *
 * `vm_stat`'s free + speculative pages are NOT a danger signal on this hardware: the file cache
 * keeps them at 0.9–1.5 GB while the kernel reports ~90% free, and loading a 23 GB model drained
 * them to 44 MB while the kernel still reported 57% free (2026-09-22). Guards built on that
 * number fired on nearly every poll and killed every model within seconds of loading it —
 * 1,925 historical false positives before the rule was replaced. `handoffs/mem-guard-lib.sh`
 * and `scripts/run-tests.mjs` were fixed to ask the kernel instead; this module is the same fix
 * for the TypeScript side, so all three finally agree.
 *
 * THE KERNEL'S OWN NUMBERS (macOS):
 *   `kern.memorystatus_level`            — percent of memory the kernel considers free
 *   `kern.memorystatus_vm_pressure_level` — 1 normal · 2 warning · 4 critical
 *
 * On Linux neither sysctl exists, so `MemAvailable` from /proc/meminfo is the equivalent
 * question — it is the kernel's own estimate of what a new allocation can have, which is
 * exactly what an admission check needs.
 */
import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";

import { type RemoteHardware, usableMemoryBytes } from "./remote-probe.js";
import type { SshTarget } from "./ssh-target.js";
import { probeRemoteHardware } from "./ssh.js";
import { probeSystemCommand } from "./system-probe.js";

/** Reserved for the OS, the compositor, the editor and Prometheus itself. */
export const DEFAULT_HEADROOM_BYTES = 6 * 1024 * 1024 * 1024;

export interface MemorySnapshot {
  totalBytes: number;
  availableBytes: number;
  headroomBytes: number;
  /** 1 normal · 2 warning · 4 critical; undefined where the kernel does not report it. */
  pressureLevel?: number;
  /** which machine this describes. */
  host?: string;
  /** how `availableBytes` was obtained — callers SHOW this. */
  source: "kernel" | "meminfo" | "os-freemem" | "remote-ssh" | "declared";
}

/** Parse `sysctl -n a b` output into numbers, in order. */
export function parseSysctlNumbers(stdout: string): number[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => Number(l))
    .filter((n) => Number.isFinite(n));
}

/** `MemAvailable` from /proc/meminfo, in bytes. Null when absent or unparseable. */
export function parseMemAvailable(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(meminfo);
  return m?.[1] ? Number(m[1]) * 1024 : null;
}

/**
 * The local machine's memory, from the kernel where possible.
 *
 * Never throws. Degrades kernel → /proc/meminfo → `os.freemem()`, and `source` says which one
 * answered, because `os.freemem()` on macOS is the very number that caused the false positives
 * above and a caller may reasonably want to be more cautious when that is all there is.
 */
export async function localMemorySnapshot(
  opts: { headroomBytes?: number; platform?: NodeJS.Platform } = {},
): Promise<MemorySnapshot> {
  const total = totalmem();
  const headroomBytes = opts.headroomBytes ?? DEFAULT_HEADROOM_BYTES;
  const platform = opts.platform ?? process.platform;

  if (platform === "darwin") {
    const out = await probeSystemCommand("/usr/sbin/sysctl", [
      "-n",
      "kern.memorystatus_vm_pressure_level",
      "kern.memorystatus_level",
    ]);
    const nums = out ? parseSysctlNumbers(out) : [];
    const pressureLevel = nums[0];
    const freePct = nums[1];
    if (typeof freePct === "number" && freePct >= 0 && freePct <= 100) {
      return {
        totalBytes: total,
        availableBytes: Math.round((total * freePct) / 100),
        headroomBytes,
        ...(pressureLevel !== undefined ? { pressureLevel } : {}),
        source: "kernel",
      };
    }
  }

  if (platform === "linux") {
    try {
      const avail = parseMemAvailable(readFileSync("/proc/meminfo", "utf8"));
      if (avail !== null) {
        return { totalBytes: total, availableBytes: avail, headroomBytes, source: "meminfo" };
      }
    } catch {
      /* fall through to os.freemem() */
    }
  }

  return { totalBytes: total, availableBytes: freemem(), headroomBytes, source: "os-freemem" };
}

/** Is the kernel already unhappy? Mirrors `handoffs/mem-guard-lib.sh`'s ACT rule. */
export function underMemoryPressure(snap: MemorySnapshot): boolean {
  if (snap.pressureLevel !== undefined && snap.pressureLevel >= 2) return true;
  return snap.availableBytes / Math.max(1, snap.totalBytes) <= 0.15;
}

/**
 * The SAME question, asked of a machine across the network.
 *
 * This is the point of the SSH work. Before it, a remote host's budget was a number the user
 * typed into `/remote add … --ram 128` and Prometheus believed forever — so it could not notice
 * RAM being added, a GPU filling up, another user's job running, or the box being rebooted into
 * something else entirely. `probeRemoteHardware` reads the remote KERNEL, which is the same
 * metric `localMemorySnapshot` reads here, so the two machines are finally judged alike.
 *
 * On a discrete-GPU box the budget is free VRAM, not system RAM — a 24 GB card cannot hold a
 * 30 GB model however much DDR the host has, and calling that "it fits" would be a lie told in
 * the user's favour. `usableMemoryBytes` decides which pool applies; `basis` says which it chose
 * so a surface can show the reason rather than an unexplained number.
 */
export async function remoteMemorySnapshot(
  target: SshTarget,
  opts: { headroomBytes?: number; timeoutMs?: number } = {},
): Promise<
  | { ok: true; snapshot: MemorySnapshot; hardware: RemoteHardware; basis: "vram" | "system" }
  | { ok: false; error: string }
> {
  const probed = await probeRemoteHardware(target, {
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (!probed.ok) return { ok: false, error: probed.error };
  const hw = probed.hardware;
  const { bytes, basis } = usableMemoryBytes(hw);
  if (basis === "unknown" || bytes <= 0) {
    return { ok: false, error: `${target.host} answered, but reported no usable memory figure` };
  }
  /**
   * A GPU box needs less headroom than a laptop.
   *
   * The local reserve (6 GiB) exists because this machine is also running a compositor, an
   * editor and a browser, and on Apple Silicon the compositor starves before jetsam intervenes.
   * A headless box running a model server and sshd has no compositor to starve. And when the
   * budget is VRAM the reserve is smaller again: nothing else on that card is competing except
   * the display, if there even is one.
   */
  const headroomBytes =
    opts.headroomBytes ?? (basis === "vram" ? VRAM_HEADROOM_BYTES : REMOTE_HEADROOM_BYTES);
  return {
    ok: true,
    hardware: hw,
    basis,
    snapshot: {
      totalBytes:
        basis === "vram"
          ? hw.gpus.reduce((n, g) => n + (g.totalBytes ?? 0), 0) || bytes
          : (hw.memTotalBytes ?? bytes),
      availableBytes: bytes,
      headroomBytes,
      ...(hw.memPressureLevel !== undefined ? { pressureLevel: hw.memPressureLevel } : {}),
      host: target.host,
      source: "remote-ssh",
    },
  };
}

/**
 * Memory held back on a remote machine that is NOT this one.
 *
 * Smaller than the local reserve: a box serving models is not also drawing the user's screen.
 * Still non-zero, because an OS, sshd and the page cache need room whatever else is running.
 */
export const REMOTE_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Held back on a GPU.
 *
 * Smaller still — a card's memory has no OS living in it. It is not zero because the driver,
 * the display (if the card drives one) and the runner's own workspace all take a slice, and a
 * VRAM allocation that just misses does not degrade: it fails the load outright.
 */
export const VRAM_HEADROOM_BYTES = 1024 * 1024 * 1024;
