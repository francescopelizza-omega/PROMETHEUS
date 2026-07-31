/**
 * main/telemetry.ts — live whole-machine resource telemetry + the launch guard.
 *
 * Reads CPU / RAM / DISK natively (node:os + fs.statfs) and GPU / NPU best-effort
 * (nvidia-smi when present; Apple Silicon reports its unified GPU + Neural Engine;
 * Linux probes /sys for an accel device). Every figure is PLAIN DATA (bytes / a
 * 0-100 percent) — the renderer only draws bars, it never re-derives a reading.
 *
 * THE GUARD (§ "don't eat the whole machine"): `evaluateResourceGuard` returns
 * allow:false when CPU% OR RAM% is at/above the ceiling (default 90%). The Model Hub
 * pull / serve / runner-install handlers consult it BEFORE spawning a heavy process,
 * so Prometheus refuses to launch work that would saturate the host (C4 fail-closed
 * in spirit: on a doubtful/failed reading we DON'T fabricate headroom).
 *
 * MAIN-process only (needs node:os / node:fs / child_process); the renderer reaches
 * it exclusively over the `system:telemetry` IPC seam (C5).
 */

import { promises as fsp } from "node:fs";
import os from "node:os";

import { probeSystemCommand } from "@prometheus/engine-bridge";

import type { GpuMeter, NpuInfo, ResourceMeter, SystemTelemetry } from "../shared/ipc-contract.js";
import { evaluateResourceGuard, pct } from "./telemetry-guard.js";

export { GUARD_THRESHOLD_PCT, evaluateResourceGuard } from "./telemetry-guard.js";

/** A read-only host-tool probe (via engine-bridge, the single spawner) — null on failure. */
function tryExec(cmd: string, args: string[], timeout = 4000): Promise<string | null> {
  return probeSystemCommand(cmd, args, { timeoutMs: timeout });
}

/* ── CPU (delta-sampled) ─────────────────────────────────────────────────────
 * os.cpus() reports CUMULATIVE tick counters; usage is the change in the non-idle
 * fraction between two snapshots. We keep the previous snapshot module-side so a
 * poll every ~2s reports the average load over that window; the very first read
 * (no prior snapshot) samples a short interval inline. */
interface CpuSnapshot {
  idle: number;
  total: number;
}
let prevCpu: CpuSnapshot | null = null;

function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readCpuPct(): Promise<number> {
  const a = prevCpu ?? cpuSnapshot();
  if (!prevCpu) await delay(150);
  const b = cpuSnapshot();
  prevCpu = b;
  const idleD = b.idle - a.idle;
  const totalD = b.total - a.total;
  if (totalD <= 0) return 0;
  return pct((1 - idleD / totalD) * 100);
}

/* ── RAM (OS-reported AVAILABLE, not raw free) ────────────────────────────────
 * os.freemem() excludes reclaimable cache/buffers, so on macOS/Linux it wildly
 * overstates "used". We read the OS's real "available" figure (Linux MemAvailable,
 * macOS vm_stat free+inactive+speculative+purgeable) and fall back to freemem. */
async function macAvailableBytes(total: number, fallback: number): Promise<number> {
  const out = await tryExec("vm_stat", []);
  if (!out) return fallback;
  const ps = /page size of (\d+) bytes/.exec(out);
  const pageSize = ps ? Number(ps[1]) : 4096;
  const grab = (label: string): number => {
    const m = new RegExp(`${label}:\\s+(\\d+)\\.`).exec(out);
    return m ? Number(m[1]) : 0;
  };
  const pages =
    grab("Pages free") +
    grab("Pages inactive") +
    grab("Pages speculative") +
    grab("Pages purgeable");
  if (pages <= 0) return fallback;
  return Math.min(total, pages * pageSize);
}

async function readMemory(): Promise<ResourceMeter> {
  const total = os.totalmem();
  let available = os.freemem();
  try {
    if (process.platform === "linux") {
      const info = await fsp.readFile("/proc/meminfo", "utf8");
      const m = /MemAvailable:\s+(\d+)\s*kB/.exec(info);
      if (m) available = Number(m[1]) * 1024;
    } else if (process.platform === "darwin") {
      available = await macAvailableBytes(total, available);
    }
  } catch {
    /* keep freemem() */
  }
  const used = Math.max(0, total - available);
  return {
    totalBytes: total,
    usedBytes: used,
    freeBytes: available,
    usedPct: total > 0 ? pct((used / total) * 100) : 0,
    measured: true,
  };
}

/* ── DISK (the volume the user's home lives on) ──────────────────────────────*/
async function readDisk(): Promise<ResourceMeter & { mount?: string }> {
  const mount = os.homedir() || "/";
  try {
    // fs.statfs lands on Node 18.15+/Electron 33; typed on fsp.
    const st = await (fsp as unknown as { statfs(p: string): Promise<StatFs> }).statfs(mount);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize; // available to an unprivileged user
    const used = Math.max(0, total - st.bfree * st.bsize);
    return {
      mount,
      totalBytes: total,
      usedBytes: used,
      freeBytes: free,
      usedPct: total > 0 ? pct((used / total) * 100) : 0,
      measured: true,
    };
  } catch {
    return { mount, usedPct: 0, measured: false, note: "disk stats unavailable" };
  }
}
interface StatFs {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

/* ── GPU / NPU static probe (cached — the expensive detection runs ONCE) ─────*/
interface StaticProbe {
  gpus: GpuMeter[];
  npu: NpuInfo;
}
let staticProbe: StaticProbe | null = null;
let staticProbePromise: Promise<StaticProbe> | null = null;

async function probeAppleGpu(): Promise<GpuMeter[]> {
  const out = await tryExec("system_profiler", ["SPDisplaysDataType", "-json"], 8000);
  if (!out) {
    // arm64 macOS always has an integrated GPU even if the profiler timed out.
    if (os.arch() === "arm64")
      return [
        {
          name: "Apple Silicon GPU",
          vendor: "apple",
          unifiedMemory: true,
          note: "shares system RAM (unified memory)",
        },
      ];
    return [];
  }
  try {
    const data = JSON.parse(out) as { SPDisplaysDataType?: Array<Record<string, unknown>> };
    const gpus: GpuMeter[] = [];
    for (const d of data.SPDisplaysDataType ?? []) {
      const name = String(d.sppci_model ?? d._name ?? "GPU");
      const apple = name.toLowerCase().includes("apple");
      gpus.push({
        name,
        vendor: apple ? "apple" : "other",
        unifiedMemory: apple,
        note: apple ? "shares system RAM (unified memory)" : undefined,
      });
    }
    return gpus;
  } catch {
    return [];
  }
}

async function probeLinuxNpu(): Promise<NpuInfo> {
  // Intel/AMD NPUs surface a /dev/accel* char device + /sys/class/accel entry.
  try {
    const entries = await fsp.readdir("/sys/class/accel").catch(() => [] as string[]);
    if (entries.length > 0) {
      return { present: true, name: "NPU (accel device)", note: "utilization not exposed by OS" };
    }
  } catch {
    /* not present */
  }
  try {
    await fsp.access("/dev/accel0");
    return { present: true, name: "NPU (/dev/accel0)", note: "utilization not exposed by OS" };
  } catch {
    return { present: false, note: "no NPU detected" };
  }
}

async function runStaticProbe(): Promise<StaticProbe> {
  const plat = process.platform;
  const arch = os.arch();
  let gpus: GpuMeter[] = [];
  let npu: NpuInfo = { present: false, note: "no NPU detected" };

  // NVIDIA GPUs (Linux/Windows) — name only here; VRAM/util filled dynamically.
  const smi = await tryExec("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  if (smi) {
    for (const line of smi.trim().split("\n")) {
      const name = line.trim();
      if (name) gpus.push({ name, vendor: "nvidia", unifiedMemory: false });
    }
  }

  if (plat === "darwin") {
    if (gpus.length === 0) gpus = await probeAppleGpu();
    // Every Apple Silicon Mac ships a Neural Engine; utilization is not public.
    if (arch === "arm64")
      npu = {
        present: true,
        name: "Apple Neural Engine",
        note: "utilization not exposed by OS",
      };
  } else if (plat === "linux") {
    npu = await probeLinuxNpu();
  }

  return { gpus, npu };
}

function getStaticProbe(): Promise<StaticProbe> {
  if (staticProbe) return Promise.resolve(staticProbe);
  if (!staticProbePromise) {
    staticProbePromise = runStaticProbe().then((p) => {
      staticProbe = p;
      return p;
    });
  }
  return staticProbePromise;
}

/** Fill the dynamic NVIDIA figures (VRAM used/total + util) onto the static list. */
async function withNvidiaDynamic(gpus: GpuMeter[]): Promise<GpuMeter[]> {
  if (!gpus.some((g) => g.vendor === "nvidia")) return gpus;
  const out = await tryExec("nvidia-smi", [
    "--query-gpu=memory.total,memory.used,utilization.gpu",
    "--format=csv,noheader,nounits",
  ]);
  if (!out) return gpus;
  const rows = out
    .trim()
    .split("\n")
    .map((l) => l.split(",").map((c) => c.trim()));
  let i = 0;
  return gpus.map((g) => {
    if (g.vendor !== "nvidia") return g;
    const row = rows[i++];
    if (!row) return g;
    const totalMb = Number(row[0]);
    const usedMb = Number(row[1]);
    const util = Number(row[2]);
    const next: GpuMeter = { ...g };
    if (Number.isFinite(totalMb) && totalMb > 0) {
      const total = totalMb * 1024 * 1024;
      const used = Number.isFinite(usedMb) ? usedMb * 1024 * 1024 : 0;
      next.vram = {
        totalBytes: total,
        usedBytes: used,
        freeBytes: Math.max(0, total - used),
        usedPct: pct((used / total) * 100),
        measured: true,
      };
    }
    if (Number.isFinite(util)) next.utilPct = pct(util);
    return next;
  });
}

/** Human OS family the local-model install flow discriminates on. */
function osLabel(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return process.platform;
  }
}

/** Read the whole-machine telemetry snapshot (+ the launch guard verdict). */
export async function readTelemetry(): Promise<SystemTelemetry> {
  const [cpuPct, ram, disk, probe] = await Promise.all([
    readCpuPct(),
    readMemory(),
    readDisk(),
    getStaticProbe(),
  ]);
  const gpus = await withNvidiaDynamic(probe.gpus);
  const cpuCores = os.cpus();
  const cpu: ResourceMeter & { model?: string; cores?: number } = {
    usedPct: cpuPct,
    measured: true,
    cores: cpuCores.length,
    model: cpuCores[0]?.model?.trim() || os.arch(),
  };
  const guard = evaluateResourceGuard(cpu.usedPct, ram.usedPct);
  return {
    ok: true,
    platform: process.platform,
    arch: os.arch(),
    osLabel: osLabel(),
    cpu,
    ram,
    disk,
    gpus,
    npu: probe.npu,
    guard,
    sampledAt: Date.now(),
  };
}
