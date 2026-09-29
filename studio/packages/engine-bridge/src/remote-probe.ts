/**
 * ai/remote-probe.ts — the fixed script Prometheus runs on a remote machine, and how it is read.
 *
 * ── WHY A SCRIPT AT ALL ─────────────────────────────────────────────────────────────────────
 *
 * Driving a model server on another machine and knowing nothing about that machine is the gap
 * the user named. A runner's HTTP API reports what it is HOLDING; it never reports how much RAM
 * the box has, how much is free, whether there is a GPU, how much VRAM is left on it, or whether
 * the disk can take another model. Without those, "will this model fit over there?" has no
 * answer and the fit check degrades to a number the user typed once and may since have been
 * wrong about.
 *
 * So: one round trip, one script, every fact at once. One round trip matters — an SSH handshake
 * is 50–300 ms and asking eight questions separately turns a probe into a visible pause.
 *
 * ── WHY IT IS A CONSTANT ────────────────────────────────────────────────────────────────────
 *
 * This string is passed to the remote login SHELL, which will interpret it. So NOTHING may ever
 * be interpolated into it — not a host, not a path, not a model name, and above all nothing that
 * came from a model's output. It takes no arguments and reads no input for exactly that reason.
 * If a future need seems to require a parameter, the answer is a second constant script, not a
 * template.
 *
 * ── WHY IT CANNOT FAIL ──────────────────────────────────────────────────────────────────────
 *
 * Every command is guarded with `2>/dev/null` and `||:` so a missing tool prints nothing instead
 * of failing the probe. A remote box without `nvidia-smi` is the common case, not an error, and
 * a probe that exits non-zero over a missing GPU tool would report a healthy machine as
 * unreachable.
 *
 * PURE: the script text and its parser. `engine-bridge` runs it.
 */

/**
 * The probe. POSIX sh, no bashisms, no arguments, read-only.
 *
 * Emits `PROM_<KEY>=<value>` lines. The prefix exists so that a login shell's own chatter — a
 * `.profile` that echoes a banner, an MOTD, a "You have new mail" — cannot be mistaken for
 * output. That chatter is extremely common on exactly the kind of shared GPU box this targets.
 */
export const REMOTE_PROBE_SCRIPT = [
  "set -u",
  'echo "PROM_OK=1"',
  'echo "PROM_UNAME=$(uname -s 2>/dev/null || echo unknown)"',
  'echo "PROM_ARCH=$(uname -m 2>/dev/null || echo unknown)"',
  'echo "PROM_KERNEL=$(uname -r 2>/dev/null || echo unknown)"',
  'echo "PROM_HOSTNAME=$(hostname 2>/dev/null || echo unknown)"',
  // ── memory, per platform ────────────────────────────────────────────────
  'if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then',
  '  echo "PROM_MEM_TOTAL=$(sysctl -n hw.memsize 2>/dev/null || echo 0)"',
  '  echo "PROM_MEM_FREE_PCT=$(sysctl -n kern.memorystatus_level 2>/dev/null || echo 0)"',
  '  echo "PROM_MEM_PRESSURE=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 0)"',
  '  echo "PROM_CPU_MODEL=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"',
  '  echo "PROM_CPU_CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 0)"',
  // Apple Silicon has no separate VRAM: the GPU shares the machine's memory, so the honest
  // answer to "how much VRAM?" is "all of it, and it is the same pool as PROM_MEM_TOTAL".
  '  echo "PROM_GPU_UNIFIED=1"',
  "else",
  "  if [ -r /proc/meminfo ]; then",
  '    awk \'/^MemTotal:/{printf "PROM_MEM_TOTAL=%d\\n", $2*1024} /^MemAvailable:/{printf "PROM_MEM_AVAILABLE=%d\\n", $2*1024}\' /proc/meminfo 2>/dev/null || :',
  "  fi",
  "  if [ -r /proc/cpuinfo ]; then",
  "    echo \"PROM_CPU_MODEL=$(awk -F': ' '/^model name/{print $2; exit}' /proc/cpuinfo 2>/dev/null || echo unknown)\"",
  "    echo \"PROM_CPU_CORES=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 0)\"",
  "  fi",
  "fi",
  // ── GPUs ────────────────────────────────────────────────────────────────
  "if command -v nvidia-smi >/dev/null 2>&1; then",
  '  nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader,nounits 2>/dev/null | while IFS= read -r l; do echo "PROM_NVIDIA=$l"; done || :',
  "fi",
  "if command -v rocm-smi >/dev/null 2>&1; then",
  '  echo "PROM_ROCM=1"',
  "fi",
  // ── load, disk ──────────────────────────────────────────────────────────
  // NOT `tr -d ' '`: a machine in a comma-decimal locale reports "8,72 7,55 6,07", and deleting
  // the separators glues it into "8,727,556,07" — three numbers that read as one wrong one.
  // Runs of whitespace are collapsed instead, so the value stays the three numbers it is.
  "echo \"PROM_LOADAVG=$(uptime 2>/dev/null | sed -n 's/.*load averages*: *//p' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//' || echo 0)\"",
  'echo "PROM_DISK_FREE=$(df -k "$HOME" 2>/dev/null | awk \'NR==2{print $4*1024}\' || echo 0)"',
  // ── the runner itself ───────────────────────────────────────────────────
  "if command -v ollama >/dev/null 2>&1; then",
  '  echo "PROM_OLLAMA=1"',
  '  echo "PROM_OLLAMA_VERSION=$(ollama --version 2>/dev/null | head -1 || echo unknown)"',
  "else",
  '  echo "PROM_OLLAMA=0"',
  "fi",
  'echo "PROM_END=1"',
].join("\n");

/** What the probe learned about a machine. */
export interface RemoteHardware {
  hostname?: string;
  os?: string;
  arch?: string;
  kernel?: string;
  cpuModel?: string;
  cpuCores?: number;
  /** physical RAM in bytes. */
  memTotalBytes?: number;
  /** what a new allocation can realistically have, in bytes. */
  memAvailableBytes?: number;
  /** macOS kernel pressure: 1 normal · 2 warning · 4 critical. */
  memPressureLevel?: number;
  /** discrete GPUs, if any. */
  gpus: RemoteGpu[];
  /** true when the GPU shares system memory (Apple Silicon), so VRAM is not a separate budget. */
  unifiedMemory?: boolean;
  loadAverage?: string;
  diskFreeBytes?: number;
  ollamaInstalled?: boolean;
  ollamaVersion?: string;
  /** lines the probe emitted that were not understood — kept so a surface can show the raw truth. */
  unparsed: string[];
}

export interface RemoteGpu {
  name: string;
  totalBytes?: number;
  usedBytes?: number;
  freeBytes?: number;
}

/**
 * Parse the probe's stdout.
 *
 * Ignores everything that is not a `PROM_` line, which is what makes this survive a login shell
 * that prints a banner, an MOTD, or a shell-startup warning before the script's own output.
 */
export function parseRemoteProbe(stdout: string): RemoteHardware {
  const hw: RemoteHardware = { gpus: [], unparsed: [] };
  let sawOk = false;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("PROM_")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case "PROM_OK":
        sawOk = true;
        break;
      case "PROM_HOSTNAME":
        if (value && value !== "unknown") hw.hostname = value;
        break;
      case "PROM_UNAME":
        if (value && value !== "unknown") hw.os = value;
        break;
      case "PROM_ARCH":
        if (value && value !== "unknown") hw.arch = value;
        break;
      case "PROM_KERNEL":
        if (value && value !== "unknown") hw.kernel = value;
        break;
      case "PROM_CPU_MODEL":
        if (value && value !== "unknown") hw.cpuModel = value;
        break;
      case "PROM_CPU_CORES": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) hw.cpuCores = n;
        break;
      }
      case "PROM_MEM_TOTAL": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) hw.memTotalBytes = n;
        break;
      }
      case "PROM_MEM_AVAILABLE": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) hw.memAvailableBytes = n;
        break;
      }
      case "PROM_MEM_FREE_PCT": {
        // macOS reports a percentage, not bytes — the same `kern.memorystatus_level` the local
        // probe and both watchdogs already use, so the two machines are judged by one metric.
        const pct = Number(value);
        if (Number.isFinite(pct) && pct > 0 && pct <= 100 && hw.memTotalBytes) {
          hw.memAvailableBytes = Math.round((hw.memTotalBytes * pct) / 100);
        }
        break;
      }
      case "PROM_MEM_PRESSURE": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) hw.memPressureLevel = n;
        break;
      }
      case "PROM_GPU_UNIFIED":
        hw.unifiedMemory = value === "1";
        break;
      case "PROM_NVIDIA": {
        const gpu = parseNvidiaRow(value);
        if (gpu) hw.gpus.push(gpu);
        break;
      }
      case "PROM_LOADAVG":
        if (value && value !== "0") hw.loadAverage = value;
        break;
      case "PROM_DISK_FREE": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) hw.diskFreeBytes = n;
        break;
      }
      case "PROM_OLLAMA":
        hw.ollamaInstalled = value === "1";
        break;
      case "PROM_OLLAMA_VERSION":
        if (value && value !== "unknown") hw.ollamaVersion = value;
        break;
      case "PROM_ROCM":
      case "PROM_END":
        break;
      default:
        hw.unparsed.push(line);
    }
  }
  // `PROM_MEM_FREE_PCT` can arrive before `PROM_MEM_TOTAL` is known on some shells' ordering;
  // one re-read fixes it without needing the script to change.
  if (hw.memAvailableBytes === undefined && hw.memTotalBytes) {
    const pct = /PROM_MEM_FREE_PCT=(\d+)/.exec(stdout)?.[1];
    const n = pct ? Number(pct) : Number.NaN;
    if (Number.isFinite(n) && n > 0 && n <= 100) {
      hw.memAvailableBytes = Math.round((hw.memTotalBytes * n) / 100);
    }
  }
  if (!sawOk) hw.unparsed.push("probe did not report PROM_OK — output may be truncated");
  return hw;
}

/** `NVIDIA GeForce RTX 4090, 24564, 1234, 23330` (MiB, from `--format=csv,nounits`). */
export function parseNvidiaRow(row: string): RemoteGpu | null {
  const parts = row.split(",").map((s) => s.trim());
  const name = parts[0];
  if (!name) return null;
  const mib = (s: string | undefined): number | undefined => {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1024 * 1024) : undefined;
  };
  const totalBytes = mib(parts[1]);
  const usedBytes = mib(parts[2]);
  const freeBytes = mib(parts[3]);
  return {
    name,
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    ...(usedBytes !== undefined ? { usedBytes } : {}),
    ...(freeBytes !== undefined ? { freeBytes } : {}),
  };
}

/**
 * The memory a model may actually use on this machine.
 *
 * On a discrete-GPU box the binding constraint is VRAM, not system RAM: a 24 GB card cannot hold
 * a 30 GB model however much DDR the host has, and offloading the remainder to the CPU is so
 * much slower that treating it as "it fits" would be a lie told in the user's favour. So the
 * budget is the GPU's free VRAM when there are GPUs, and system memory when there are not.
 *
 * Apple Silicon reports `unifiedMemory`, where the two are the same pool and system memory is
 * the right answer.
 */
export function usableMemoryBytes(hw: RemoteHardware): {
  bytes: number;
  basis: "vram" | "system" | "unknown";
} {
  if (!hw.unifiedMemory && hw.gpus.length > 0) {
    const free = hw.gpus.reduce((sum, g) => sum + (g.freeBytes ?? 0), 0);
    if (free > 0) return { bytes: free, basis: "vram" };
    const total = hw.gpus.reduce((sum, g) => sum + (g.totalBytes ?? 0), 0);
    if (total > 0) return { bytes: total, basis: "vram" };
  }
  if (hw.memAvailableBytes && hw.memAvailableBytes > 0) {
    return { bytes: hw.memAvailableBytes, basis: "system" };
  }
  if (hw.memTotalBytes && hw.memTotalBytes > 0) {
    return { bytes: hw.memTotalBytes, basis: "system" };
  }
  return { bytes: 0, basis: "unknown" };
}
