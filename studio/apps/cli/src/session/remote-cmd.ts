// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/remote-cmd.ts — `/remote`, the whole of it.
 *
 * Lifted out of `slash-registry.ts` because the command stopped being three lines of list/add/
 * remove: it now declares a machine, probes its hardware over SSH, shows a host-key fingerprint
 * and waits for a human to accept it, opens and closes tunnels, and reports what is up. That is
 * a module, not a case in a switch.
 *
 * ── WHAT THE AI MODEL CAN AND CANNOT DO HERE ────────────────────────────────────────────────
 *
 * Nothing in this file is reachable by a model. It is a slash command: the human types it, the
 * human reads the fingerprint, the human answers the prompt. The model's own `run_command` path
 * reaches `ssh` through the exec registry, at tier `install` (A5) with `-o` denied, which is a
 * SEPARATE and much narrower door. That separation is the point — a feature that lets Prometheus
 * use a remote machine must not become a feature that lets a prompt-injected model use one.
 */
import { ai } from "@prometheus/core";
import {
  type RemoteHardware,
  type SshTarget,
  closeControlMaster,
  formatSshTarget,
  isKnownHost,
  listTunnels,
  openTunnel,
  probeRemoteHardware,
  remoteMemorySnapshot,
  runnerCensus,
  sshFingerprint,
  usableMemoryBytes,
} from "@prometheus/engine-bridge";

import { c } from "../render.js";

/** What a `/remote` subcommand needs from the session. */
export interface RemoteCtx {
  write: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
}

const gb = (n: number): string => ai.humanBytes(n);

/* ── list ───────────────────────────────────────────────────────────────────────────────────*/

/** One host, as a couple of lines: what it is, and what is known about the machine. */
export function describeHost(h: ai.RemoteHost): string[] {
  const out: string[] = [];
  const via = h.tunnel ? "ssh tunnel" : "direct http";
  out.push(`  ${c.cyan(h.host)}  ${c.dim(`${h.baseUrl} · ${via}`)}`);
  if (h.ssh) out.push(c.dim(`      ssh ${formatSshTarget(h.ssh)}`));
  if (h.hardware) {
    out.push(c.dim(`      ${hardwareLine(h.hardware)}`));
    if (h.hardwareAt) out.push(c.dim(`      measured ${ago(h.hardwareAt)}`));
  } else if (h.totalMemoryBytes) {
    // Said, not measured — and the difference matters enough to spell out, because a declared
    // number is believed forever and never notices the machine changing underneath it.
    out.push(c.dim(`      ${gb(h.totalMemoryBytes)} declared (not measured)`));
  } else {
    out.push(c.yellow("      size unknown — /remote probe, or --ram, to enable fit checks"));
  }
  return out;
}

/** A machine in one line. */
export function hardwareLine(hw: RemoteHardware): string {
  const bits: string[] = [];
  if (hw.os) bits.push(`${hw.os}${hw.arch ? `/${hw.arch}` : ""}`);
  if (hw.cpuModel) bits.push(`${hw.cpuModel}${hw.cpuCores ? ` ×${hw.cpuCores}` : ""}`);
  if (hw.memTotalBytes) {
    const free = hw.memAvailableBytes ? `${gb(hw.memAvailableBytes)} free of ` : "";
    bits.push(`${free}${gb(hw.memTotalBytes)} RAM`);
  }
  for (const g of hw.gpus) {
    const vram = g.totalBytes
      ? ` ${g.freeBytes !== undefined ? `${gb(g.freeBytes)} free of ` : ""}${gb(g.totalBytes)}`
      : "";
    bits.push(`${g.name}${vram}`);
  }
  if (hw.unifiedMemory) bits.push("unified memory");
  if (hw.ollamaInstalled === false) bits.push(c.yellow("no ollama installed"));
  else if (hw.ollamaVersion) bits.push(hw.ollamaVersion);
  return bits.join(" · ") || "no details";
}

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "at an unknown time";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

/* ── probe ──────────────────────────────────────────────────────────────────────────────────*/

/**
 * Ask a machine what it is.
 *
 * Returns the hardware so the caller can cache it on the host record — the probe is a couple of
 * seconds of SSH and a picker should not pay it to draw a list.
 */
export async function probeHost(
  entry: ai.RemoteHost,
  ctx: RemoteCtx,
): Promise<RemoteHardware | null> {
  if (!entry.ssh) {
    ctx.write(c.red(`${entry.host} has no ssh access declared`));
    ctx.write(c.dim("  /remote add <url> --ssh [user@]host   to add it"));
    return null;
  }
  ctx.write(c.dim(`probing ${formatSshTarget(entry.ssh)} over ssh …`));
  const r = await probeRemoteHardware(entry.ssh, { timeoutMs: 25_000 });
  if (!r.ok) {
    ctx.write(c.red(`  ${r.error}`));
    return null;
  }
  const hw = r.hardware;
  ctx.write(c.green(`  ✓ ${hw.hostname ?? entry.host}`));
  ctx.write(`      ${hardwareLine(hw)}`);
  const { bytes, basis } = usableMemoryBytes(hw);
  if (basis !== "unknown") {
    ctx.write(
      c.dim(
        `      ${gb(bytes)} available for a model, from ${basis === "vram" ? "GPU memory" : "system memory"}`,
      ),
    );
  }
  if (hw.diskFreeBytes) ctx.write(c.dim(`      ${gb(hw.diskFreeBytes)} free on disk`));
  if (hw.loadAverage) ctx.write(c.dim(`      load ${hw.loadAverage}`));
  if (hw.ollamaInstalled === false) {
    ctx.write(c.yellow("      ollama is not installed there — nothing can serve a model yet"));
  }
  for (const u of hw.unparsed) ctx.write(c.dim(`      ? ${u}`));
  return hw;
}

/* ── trust ──────────────────────────────────────────────────────────────────────────────────*/

/**
 * Show a host key and ask the human to accept it.
 *
 * This is the one security decision in the feature that cannot be made by code: whether the
 * machine answering is the machine the user meant. SSH's own answer is to refuse an unknown host
 * outright, which is correct and unhelpful; the answer here is to show the fingerprint —
 * the same string `ssh-keygen -lf` prints, comparable against what the remote box says about
 * itself — and let the user say yes.
 *
 * Returns true when the connection may proceed. A `false` is a refusal, not an error: nothing
 * was sent, and nothing was written to `known_hosts`.
 */
export async function confirmHostKey(target: SshTarget, ctx: RemoteCtx): Promise<boolean> {
  if (await isKnownHost(target)) return true;
  ctx.write(c.yellow(`${target.host} is not in your known_hosts — this is a first connection.`));
  const fp = await sshFingerprint(target);
  if (!fp.ok) {
    ctx.write(c.red(`  ${fp.error}`));
    return false;
  }
  ctx.write(c.dim("  the host offers these keys:"));
  for (const line of fp.lines) ctx.write(`    ${line}`);
  ctx.write(
    c.dim(
      "  compare this against the machine itself (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` there)",
    ),
  );
  return ctx.confirm(`Is this the machine you meant, ${target.host}?`);
}

/* ── tunnels ────────────────────────────────────────────────────────────────────────────────*/

/**
 * Bring up the tunnel for a host and report where it landed.
 *
 * The local port is chosen at connect time rather than configured, because a fixed one collides
 * the moment a second host is connected or a second Prometheus is running — and the caller does
 * not need to know it in advance: it is returned, and the endpoint is rewritten to use it.
 */
export async function connectHost(
  entry: ai.RemoteHost,
  ctx: RemoteCtx,
): Promise<{ baseUrl: string } | null> {
  if (!entry.ssh || !entry.tunnel) {
    ctx.write(c.red(`${entry.host} is not configured for tunnelling`));
    ctx.write(c.dim("  /remote add <url> --ssh [user@]host --tunnel"));
    return null;
  }
  if (!(await confirmHostKey(entry.ssh, ctx))) {
    ctx.write(c.dim("cancelled — nothing was connected"));
    return null;
  }
  ctx.write(c.dim(`opening a tunnel to ${formatSshTarget(entry.ssh)} …`));
  const r = await openTunnel(entry.ssh, { remotePort: entry.tunnel.remotePort });
  if (!r.ok) {
    ctx.write(c.red(`  ${r.error}`));
    return null;
  }
  const base = `${r.tunnel.localBaseUrl}/v1`;
  ctx.write(
    c.green(
      `  ✓ ${entry.host}:${entry.tunnel.remotePort} is now at 127.0.0.1:${r.tunnel.localPort}`,
    ),
  );
  ctx.write(c.dim("      traffic travels inside ssh; that port is not exposed to the network"));
  return { baseUrl: base };
}

/** Everything currently up. */
export function tunnelStatus(ctx: RemoteCtx): void {
  const live = listTunnels();
  if (live.length === 0) {
    ctx.write(c.dim("no tunnels open"));
    return;
  }
  ctx.write(`${c.bold("Tunnels")}  ${c.dim(`${live.length} open`)}`);
  for (const t of live) {
    ctx.write(
      `  ${c.green("●")} 127.0.0.1:${t.localPort} ${c.dim(`→ ${formatSshTarget(t.target)}:${t.remotePort}`)}`,
    );
  }
}

/** Drop the ssh connection to a host when it is removed, so "removed" means removed. */
export async function disconnectHost(entry: ai.RemoteHost, ctx: RemoteCtx): Promise<void> {
  for (const t of listTunnels()) {
    if (entry.ssh && t.target.host === entry.ssh.host) t.close();
  }
  if (entry.ssh) await closeControlMaster(entry.ssh);
  ctx.write(c.dim(`disconnected from ${entry.host}`));
}

/* ── fit, on the remote machine ─────────────────────────────────────────────────────────────*/

/**
 * `/remote fit <host>` — what will actually run over there.
 *
 * The same question `/ram` answers locally, asked of the machine that would do the work. Its
 * memory comes from the remote kernel via SSH when that is available, and from the declared
 * `--ram` when it is not — and it SAYS which, because a measured budget and a remembered one
 * deserve different confidence.
 */
export async function remoteFit(
  entry: ai.RemoteHost,
  contextTokens: number,
  ctx: RemoteCtx,
): Promise<void> {
  const root = ai.ollamaRoot(entry.baseUrl);
  const census = await runnerCensus([{ id: "ollama", baseUrl: root, api: "ollama" }], {
    timeoutMs: 4000,
    host: entry.host,
  }).catch(() => []);
  const resident = census.flatMap((r) => r.models);

  let available: number | undefined;
  let total: number | undefined;
  let headroom = 2 * 1024 ** 3;
  let basisNote = "";
  if (entry.ssh) {
    const snap = await remoteMemorySnapshot(entry.ssh, { timeoutMs: 20_000 });
    if (snap.ok) {
      available = snap.snapshot.availableBytes;
      total = snap.snapshot.totalBytes;
      headroom = snap.snapshot.headroomBytes;
      basisNote = snap.basis === "vram" ? "GPU memory, measured over ssh" : "measured over ssh";
    } else {
      ctx.write(c.yellow(`  ! ${snap.error}`));
    }
  }
  if (available === undefined && entry.totalMemoryBytes) {
    const held = resident.reduce((n, m) => n + m.sizeBytes, 0);
    total = entry.totalMemoryBytes;
    available = Math.max(0, entry.totalMemoryBytes - held);
    basisNote = "declared size, less what is loaded";
  }
  if (available === undefined || total === undefined) {
    ctx.write(c.red(`  cannot size ${entry.host}: no ssh access and no --ram declared`));
    return;
  }

  ctx.write(
    `${c.bold(`Memory on ${entry.host}`)}  ${c.dim(`${gb(available)} free of ${gb(total)}`)}`,
  );
  ctx.write(
    c.dim(
      `  ${gb(headroom)} kept for the system · ${gb(Math.max(0, available - headroom))} offered to a model · ${basisNote}`,
    ),
  );
  for (const m of resident) {
    ctx.write(`  ${c.green("●")} ${m.id} ${c.dim(`loaded, ${gb(m.sizeBytes)}`)}`);
  }

  const candidates = await ai
    .inventoryCandidates(root, contextTokens, { runner: "ollama", resident, timeoutMs: 6000 })
    .catch(() => [] as ai.ModelCandidate[]);
  if (candidates.length === 0) {
    ctx.write(c.dim("  (no models installed there, or the runner did not answer)"));
    return;
  }
  const rows = ai.affordableModels(candidates, {
    totalBytes: total,
    availableBytes: available + resident.reduce((n, m) => n + m.sizeBytes, 0),
    headroomBytes: headroom,
    host: entry.host,
  });
  ctx.write(
    `${c.bold("Models")}  ${c.dim(`at a ${contextTokens.toLocaleString("en-US")}-token context`)}`,
  );
  for (const row of rows) {
    const mark = row.fits ? c.green("✓") : c.red("✗");
    const size = row.uncertain
      ? `${gb(row.footprint.lowerBoundBytes ?? row.footprint.totalBytes)}–${gb(row.footprint.totalBytes)}`
      : gb(row.footprint.totalBytes);
    const note = ai.footprintNote(row.footprint.source);
    ctx.write(
      `  ${mark} ${row.candidate.id} ${c.dim(`${size}${note ? ` ${note}` : ""}`)}`.trimEnd(),
    );
  }
}
