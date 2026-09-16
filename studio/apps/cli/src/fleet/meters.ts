/**
 * fleet/meters.ts — the three-way resource split the fleet bar draws.
 *
 * Each meter answers two questions at once: how loaded is the machine, and how much of that is
 * US. The second half is the whole point — "cpu 41%" tells you nothing you can act on, while
 * "41%, and 28 of it is Prometheus" tells you which window to close.
 *
 * ## `oursPct: undefined` is a real answer
 *
 * Every meter can report that it does not know its own split, and the renderer draws NO BAR when
 * it does. That is not a fallback, it is the point: on Apple Silicon there is no per-process GPU
 * accounting to be had from any tool we are allowed to spawn, so a bar there could only be a
 * guess wearing the costume of a measurement. The missing bar IS the honest reading.
 *
 * The same rule already governs `rightCollapsed` in the desktop shell and the authorisation
 * clamp: store what you actually established, never the value a fallback produced.
 *
 * ## GPU never gets an ownership bar
 *
 * NVIDIA can tell us per-process VRAM (`--query-compute-apps`) but not per-process
 * UTILIZATION. Splitting a utilization bar by a memory ratio would put two different quantities
 * in one row of cells and call the result one measurement. So the gpu chip shows the machine
 * total and nothing else, on every platform, and `/fleet` explains why.
 *
 * ## Cost
 *
 * One `ps -A` per refresh, plus one `vm_stat` on macOS. CPU totals come from `os.cpus()` tick
 * counters — no spawn at all. The refresh only runs while a second instance exists, so a lone
 * session spawns nothing, ever. child_process is not reachable from apps/cli by design (SPINE
 * C5), so every probe goes through engine-bridge's `probeSystemCommand`.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";

import { LOCAL_RUNNERS } from "@prometheus/core";
import { probeSystemCommand } from "@prometheus/engine-bridge";

/** How often the meters re-probe. Slower than the heartbeat: load moves, but not that fast. */
export const METER_TICK_MS = 3_000;

/** One resource. `pct: null` ⇒ the unit is present but its usage is not exposed by this OS. */
export interface Meter {
  pct: number | null;
  /** the fleet's share of the machine, 0–100. undefined ⇒ not attributable ⇒ render no bar. */
  oursPct?: number;
}

export interface RamMeter extends Meter {
  totalGb: number;
  usedGb: number;
  oursGb?: number;
}

/** Everything the bar and `/fleet` read. */
export interface FleetMeters {
  cpu: Meter;
  ram: RamMeter;
  /** omitted entirely when the machine has no GPU we could even name. */
  gpu?: Meter;
  /** accelerators we can only detect, never measure — presence badges. */
  accelerators: string[];
}

const clampPct = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0);
const GB = 1024 ** 3;
const toGb = (bytes: number): number => Math.round((bytes / GB) * 10) / 10;

/* ── CPU: delta-sampled tick counters (no spawn) ─────────────────────────────*/

interface CpuSnapshot {
  idle: number;
  total: number;
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

let prevCpu: CpuSnapshot | null = null;

/**
 * Machine CPU since the previous call.
 *
 * The FIRST call has no baseline, and a 150ms inline sleep to manufacture one would block the
 * frame the bar is being painted into. So it falls back to the 1-minute load average, which is
 * laggy but real, and every call after this one is a true delta over the refresh window.
 */
export function readCpuPct(): number {
  const prev = prevCpu;
  const now = cpuSnapshot();
  prevCpu = now;
  if (!prev) {
    const cores = Math.max(1, os.cpus().length);
    return clampPct(((os.loadavg()[0] ?? 0) / cores) * 100);
  }
  const idleD = now.idle - prev.idle;
  const totalD = now.total - prev.total;
  if (totalD <= 0) return 0;
  return clampPct((1 - idleD / totalD) * 100);
}

/** Test seam — drop the CPU baseline so the next read takes the loadavg path again. */
export function resetCpuSampler(): void {
  prevCpu = null;
  procTree = null;
}

/* ── RAM: the OS's own "available", never raw freemem ────────────────────────*/

/**
 * Bytes the OS considers available.
 *
 * `os.freemem()` excludes reclaimable page cache, so on macOS it reports a machine with 40 GB of
 * cache as nearly full — a meter pinned at 95% that never moves, which is worse than no meter.
 * Linux publishes `MemAvailable` and macOS's `vm_stat` gives the pages that can be reclaimed.
 */
export async function readAvailableBytes(total: number): Promise<number> {
  const fallback = os.freemem();
  try {
    if (process.platform === "linux") {
      const info = await readFile("/proc/meminfo", "utf8");
      const m = /MemAvailable:\s+(\d+)\s*kB/.exec(info);
      if (m) return Math.min(total, Number(m[1]) * 1024);
      return fallback;
    }
    if (process.platform === "darwin") {
      const out = await probeSystemCommand("vm_stat", [], { timeoutMs: 3000 });
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
      return pages > 0 ? Math.min(total, pages * pageSize) : fallback;
    }
  } catch {
    /* fall through to freemem */
  }
  return fallback;
}

/* ── attribution: the fleet's own processes, and everything they spawned ─────*/

interface ProcRow {
  pid: number;
  ppid: number;
  pcpu: number;
  rssBytes: number;
  /** the executable, as `ps -o comm=` reports it — a full path on macOS, a truncated name on
   *  Linux, and `""` for a 4-column table (the older probe, and the unit-test fixtures). */
  comm: string;
}

/**
 * Shared model-server process names, matched against a `comm` BASENAME, case-insensitively.
 *
 * Sourced from `LOCAL_RUNNERS[].processMatch` rather than a fresh literal list so this cannot
 * drift from the runner definitions the rest of the product uses. That field is documented as
 * BEST-EFFORT — LM Studio's server process reports as "Bionic" on a current install, not
 * "LM Studio" — so this is a heuristic, and it errs toward counting a process as ours.
 *
 * The child runners that actually hold the model weights are added explicitly: they are separate
 * processes with their own names, and they are the multi-GB half of the reading.
 */
const SHARED_RUNNER_COMMS: readonly string[] = [
  ...LOCAL_RUNNERS.map((r) => r.processMatch),
  "llama-server",
  "ollama_llama_server",
  "mlx_lm",
]
  .filter((m): m is string => typeof m === "string" && m.length > 0)
  .map((m) => m.toLowerCase());

/** Is this row a shared model server rather than something a Prometheus window owns? */
function isSharedRunner(comm: string): boolean {
  const base = (comm.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  return base.length > 0 && SHARED_RUNNER_COMMS.some((m) => base.includes(m));
}

/** Parse `ps -A -o pid=,ppid=,pcpu=,rss=,comm=`. Tolerates the leading padding ps emits. */
export function parsePsTable(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const pid = Number(f[0]);
    const ppid = Number(f[1]);
    const pcpu = Number(f[2]);
    const rssKb = Number(f[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    rows.push({
      pid,
      ppid,
      pcpu: Number.isFinite(pcpu) ? pcpu : 0,
      // ps reports RSS in KiB on both macOS and Linux.
      rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
      // `comm` can contain spaces (an .app bundle path), so take everything after column 4.
      // The `f.length < 4` guard above deliberately still admits a 4-column table, which is
      // what the older probe and the unit fixtures produce — those simply have no comm.
      comm: f.slice(4).join(" "),
    });
  }
  return rows;
}

/**
 * Sum CPU and RSS over the fleet's pids AND their descendants.
 *
 * Descendants matter: the engine subprocess, a spawned `git`, a sidecar — those ARE what the
 * window costs. A model server like ollama is deliberately NOT included; it is a system service
 * shared by every window rather than owned by any, so it belongs in `other`, and `/fleet` says so.
 */
export function sumFleetUsage(
  rows: readonly ProcRow[],
  pids: readonly number[],
): { pcpu: number; rssBytes: number; counted: number } {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  const queue = [...pids];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    if (seen.has(pid) || !byPid.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) {
      const row = byPid.get(child);
      // A shared model server is NOT ours, which is what this function's docstring and the line
      // `/fleet` prints both claim — and the claim had no implementation: `startModelServer`
      // spawns `ollama serve` with `detached: true`, which makes it a group leader but leaves
      // its PPID pointing at the spawning Prometheus, so it and its multi-GB `ollama runner`
      // child were both walked as descendants and billed to this window.
      //
      // `continue` BEFORE the push is what makes it right for the weights: never entering
      // `ollama serve` means its runner child is never reached either.
      if (row && isSharedRunner(row.comm)) continue;
      queue.push(child);
    }
  }
  let pcpu = 0;
  let rssBytes = 0;
  for (const pid of seen) {
    const r = byPid.get(pid);
    if (!r) continue;
    pcpu += r.pcpu;
    rssBytes += r.rssBytes;
  }
  return { pcpu, rssBytes, counted: seen.size };
}

let procTree: ProcRow[] | null = null;

async function readProcTable(): Promise<ProcRow[] | null> {
  const out = await probeSystemCommand("ps", ["-A", "-o", "pid=,ppid=,pcpu=,rss=,comm="], {
    timeoutMs: 4000,
  });
  if (!out) return null;
  const rows = parsePsTable(out);
  procTree = rows.length > 0 ? rows : null;
  return procTree;
}

/* ── GPU + accelerators: named where possible, measured where allowed ────────*/

interface Accel {
  gpu?: { label: string; nvidia: boolean };
  accelerators: string[];
}
let accelProbe: Accel | null = null;
let accelPromise: Promise<Accel> | null = null;

async function runAccelProbe(): Promise<Accel> {
  const accelerators: string[] = [];
  let gpu: Accel["gpu"];
  const smi = await probeSystemCommand("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  if (smi?.trim()) gpu = { label: "gpu", nvidia: true };
  if (process.platform === "darwin") {
    if (!gpu && os.arch() === "arm64") gpu = { label: "gpu", nvidia: false };
    // Every Apple Silicon Mac has a Neural Engine; its utilization is not public.
    if (os.arch() === "arm64") accelerators.push("ane");
  } else if (process.platform === "linux") {
    // Intel/AMD NPUs surface a /dev/accel* char device; Coral TPUs a /dev/apex_*.
    const { access } = await import("node:fs/promises");
    const has = async (p: string): Promise<boolean> =>
      access(p).then(
        () => true,
        () => false,
      );
    if (await has("/dev/accel0")) accelerators.push("npu");
    if (await has("/dev/apex_0")) accelerators.push("tpu");
  }
  return { ...(gpu ? { gpu } : {}), accelerators };
}

function getAccelProbe(): Promise<Accel> {
  if (accelProbe) return Promise.resolve(accelProbe);
  if (!accelPromise) {
    accelPromise = runAccelProbe().then((p) => {
      accelProbe = p;
      return p;
    });
  }
  return accelPromise;
}

/** Test seam — forget the cached one-shot accelerator detection. */
export function resetAccelProbe(): void {
  accelProbe = null;
  accelPromise = null;
}

async function readGpu(a: Accel): Promise<Meter | undefined> {
  if (!a.gpu) return undefined;
  if (!a.gpu.nvidia) {
    // Apple Silicon: the GPU is right there and its utilization is not exposed to us.
    return { pct: null };
  }
  const out = await probeSystemCommand("nvidia-smi", [
    "--query-gpu=utilization.gpu",
    "--format=csv,noheader,nounits",
  ]);
  const first = out?.trim().split("\n")[0]?.trim();
  const util = first !== undefined ? Number(first) : Number.NaN;
  // No ownership split: see the module docstring — util is not attributable by any tool here.
  return { pct: Number.isFinite(util) ? clampPct(util) : null };
}

/* ── the one call the ticker makes ───────────────────────────────────────────*/

/**
 * Probe every meter for the given fleet pids.
 *
 * Never throws and never rejects: each half degrades on its own, so a `ps` that is missing costs
 * you the ownership bars and leaves the machine totals intact.
 */
export async function readFleetMeters(pids: readonly number[]): Promise<FleetMeters> {
  const cpuPct = readCpuPct();
  const totalBytes = os.totalmem();
  const cores = Math.max(1, os.cpus().length);
  const [availableBytes, rows, accel] = await Promise.all([
    readAvailableBytes(totalBytes),
    pids.length > 0 ? readProcTable() : Promise.resolve(null),
    getAccelProbe(),
  ]);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const gpu = await readGpu(accel);

  const ram: RamMeter = {
    pct: totalBytes > 0 ? clampPct((usedBytes / totalBytes) * 100) : 0,
    totalGb: toGb(totalBytes),
    usedGb: toGb(usedBytes),
  };
  const cpu: Meter = { pct: clampPct(cpuPct) };

  if (rows) {
    const ours = sumFleetUsage(rows, pids);
    // ps reports pcpu as a percentage of ONE core; the meter is a percentage of the MACHINE.
    cpu.oursPct = Math.min(clampPct(cpu.pct ?? 0), clampPct(ours.pcpu / cores));
    ram.oursPct = Math.min(ram.pct ?? 0, clampPct((ours.rssBytes / totalBytes) * 100));
    ram.oursGb = toGb(ours.rssBytes);
  }
  return { cpu, ram, ...(gpu ? { gpu } : {}), accelerators: accel.accelerators };
}
