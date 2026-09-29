/**
 * ssh.ts — running things on another machine, and tunnelling to its model server.
 *
 * engine-bridge is the only package allowed to spawn (C5 / SPINE), so this is where SSH lives —
 * and so do its two pure neighbours, `ssh-target.ts` and `remote-probe.ts`. They were drafted in
 * `core` and moved here, because core DEPENDS ON engine-bridge and not the reverse; a module
 * whose whole purpose is to build a child-process argv safely belongs beside the spawn anyway.
 * Everything about WHAT to run and WHETHER it is safe is decided there. This module only
 * executes, supervises and cleans up.
 *
 * ── THREE JOBS ──────────────────────────────────────────────────────────────────────────────
 *
 *  1. `sshExec` — run the fixed probe script and capture its output.
 *  2. `sshFingerprint` — show the user a host key BEFORE they are asked to trust it.
 *  3. `openTunnel` — a long-lived `ssh -N -L` so a model server bound to loopback on the remote
 *     box is reachable here, over an encrypted channel, without that box exposing a port to the
 *     network at all.
 *
 * ── WHY THE TUNNEL IS THE DEFAULT AND NOT A LUXURY ──────────────────────────────────────────
 *
 * The plain alternative is `http://gpu-box.lan:11434`, which means: every prompt and every reply
 * crosses the network in clear text, and the runner must be bound to 0.0.0.0 where anyone on the
 * LAN can use it, unauthenticated — model runners have no auth at all. Through a tunnel the
 * runner stays on 127.0.0.1 on its own machine, the traffic is inside SSH, and access is exactly
 * the set of people who can already log in. That is a better security posture AND less
 * configuration, which is rare enough to be worth making the default.
 *
 * ── CONNECTION REUSE ────────────────────────────────────────────────────────────────────────
 *
 * A fresh SSH handshake costs 50–300 ms. An admission check that ran one per probe would add a
 * visible stall to every model switch, so the probes share one multiplexed connection via
 * `ControlMaster`, keyed on a socket under the user's own runtime directory.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REMOTE_PROBE_SCRIPT, type RemoteHardware, parseRemoteProbe } from "./remote-probe.js";
import { safeChildEnv } from "./safe-env.js";
import {
  type SshTarget,
  formatSshTarget,
  sshArgs,
  sshKeyscanArgs,
  validateSshTarget,
} from "./ssh-target.js";
import { execCapture } from "./system-probe.js";

/** Where the multiplexing sockets live. Short path: a unix socket has a ~104-byte limit. */
export function controlPathFor(target: SshTarget): string {
  const key = `${target.user ?? ""}@${target.host}:${target.port ?? 22}`;
  // A hash, not the name: a host name plus a long tmpdir overruns the socket path limit, and
  // the failure mode is an opaque "unix_listener: path too long".
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return join(tmpdir(), `prom-ssh-${h.toString(36)}`);
}

export interface SshResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  /** a sentence for the user when `ok` is false, in their vocabulary rather than ssh's. */
  error?: string;
}

/**
 * Turn ssh's exit code and stderr into something a human can act on.
 *
 * ssh exits 255 for everything from "no route to host" to "permission denied" to "host key
 * changed", which as a diagnostic is nearly useless — so the stderr is read for the cases a
 * user can actually fix, and the raw text is still carried for the ones we do not recognise.
 */
export function explainSshFailure(code: number, stderr: string): string {
  const s = stderr.toLowerCase();
  /**
   * An UNKNOWN host and a CHANGED key both end in "host key verification failed", and they mean
   * very different things.
   *
   * Real stderr from a first connection to 127.0.0.1 on this machine:
   *
   *   No ED25519 host key is known for 127.0.0.1 and you have requested strict checking.
   *   Host key verification failed.
   *
   * Matching the second line first told the user their machine might have been replaced by an
   * impostor, when in truth they had simply never connected to it. That is a false alarm about
   * an attack, which is worse than no message at all: it teaches people to ignore the real one.
   */
  if (s.includes("identification has changed") || /host key for .* has changed/.test(s)) {
    return "the host key CHANGED from the one in your known_hosts — either the machine was reinstalled, or this is not the machine you think it is. Nothing was sent.";
  }
  if (s.includes("is known for") || s.includes("no matching host key in known_hosts")) {
    return "this host is not in your known_hosts yet, so ssh refused it. Prometheus can show you the key's fingerprint to check before you trust it.";
  }
  if (s.includes("host key verification failed")) {
    return "ssh could not verify the host key. Nothing was sent.";
  }
  if (s.includes("no matching host key") || s.includes("unable to negotiate")) {
    return "your ssh client and that host could not agree on a key exchange — the host may be running a very old sshd.";
  }
  if (s.includes("permission denied")) {
    return "the host refused the login. BatchMode is on, so no password prompt is possible: the key must be in your agent or named with --identity.";
  }
  if (s.includes("connection timed out") || s.includes("operation timed out")) {
    return "the host did not answer in time — it may be off, asleep, or behind a firewall.";
  }
  if (s.includes("connection refused")) {
    return "nothing is listening on that ssh port.";
  }
  if (s.includes("could not resolve hostname") || s.includes("name or service not known")) {
    return "that host name does not resolve.";
  }
  if (s.includes("bind") && s.includes("address already in use")) {
    return "the local port for the tunnel is already taken.";
  }
  if (code === 127) return "the ssh client could not be started — is openssh installed?";
  const first = stderr.split("\n").find((l) => l.trim());
  return first ? first.trim() : `ssh exited ${code}`;
}

/**
 * Run ONE command on a remote host.
 *
 * `remoteCommand` must be a constant supplied by this repo. Nothing derived from a model's
 * output, a file's contents or a network response may reach it — it is handed to the remote
 * login shell, which will interpret it. The one caller today passes `REMOTE_PROBE_SCRIPT`.
 */
export async function sshExec(
  target: SshTarget,
  remoteCommand: string,
  opts: { timeoutMs?: number; connectTimeoutSec?: number; reuse?: boolean } = {},
): Promise<SshResult> {
  const v = validateSshTarget(target);
  if (!v.ok) return { ok: false, stdout: "", stderr: "", code: 1, error: v.error };
  let args: string[];
  try {
    args = sshArgs(v.target, {
      remoteCommand,
      ...(opts.connectTimeoutSec !== undefined
        ? { connectTimeoutSec: opts.connectTimeoutSec }
        : {}),
      ...(opts.reuse === false
        ? {}
        : { controlPath: controlPathFor(v.target), controlMaster: true, controlPersistSec: 120 }),
    });
  } catch (e) {
    return { ok: false, stdout: "", stderr: "", code: 1, error: (e as Error).message };
  }
  const r = await execCapture("ssh", args, { timeoutMs: opts.timeoutMs ?? 20_000 });
  if (r.code === 0) return { ok: true, stdout: r.stdout, stderr: r.stderr, code: 0 };
  return {
    ok: false,
    stdout: r.stdout,
    stderr: r.stderr,
    code: r.code,
    error: explainSshFailure(r.code, r.stderr),
  };
}

/** Run the hardware probe on a remote machine. */
export async function probeRemoteHardware(
  target: SshTarget,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; hardware: RemoteHardware } | { ok: false; error: string }> {
  const r = await sshExec(target, REMOTE_PROBE_SCRIPT, { timeoutMs: opts.timeoutMs ?? 20_000 });
  if (!r.ok) return { ok: false, error: r.error ?? "probe failed" };
  const hardware = parseRemoteProbe(r.stdout);
  if (hardware.memTotalBytes === undefined && hardware.gpus.length === 0) {
    // The connection worked but the script produced nothing usable. Usually a login shell that
    // is not POSIX-compatible (fish, csh) or a restricted shell.
    return {
      ok: false,
      error: `connected to ${formatSshTarget(target)} but the probe returned nothing usable — is the login shell POSIX-compatible?`,
    };
  }
  return { ok: true, hardware };
}

/**
 * The host key fingerprint, so the user can compare it before trusting a new machine.
 *
 * Two hops, both read-only: `ssh-keyscan` fetches the public keys the host offers, `ssh-keygen
 * -lf -` prints their fingerprints. Neither writes to `known_hosts` — the point is to SHOW the
 * fingerprint and let a human decide, not to accept it for them.
 */
export async function sshFingerprint(
  target: SshTarget,
): Promise<{ ok: true; lines: string[] } | { ok: false; error: string }> {
  let args: string[];
  try {
    args = sshKeyscanArgs(target);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const scan = await execCapture("ssh-keyscan", args, { timeoutMs: 8000 });
  const keys = scan.stdout
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .join("\n");
  if (!keys.trim()) {
    return { ok: false, error: `no ssh host key offered by ${target.host}` };
  }
  const fp = await execCapture("ssh-keygen", ["-lf", "-"], { stdin: `${keys}\n`, timeoutMs: 8000 });
  const lines = fp.stdout.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return { ok: false, error: "could not read the host key fingerprint" };
  return { ok: true, lines };
}

/**
 * Is this host already in the user's `known_hosts`?
 *
 * Drives the question `/remote ssh` actually needs answered: whether trusting this machine is a
 * NEW decision the user must make with a fingerprint in front of them, or one they made long ago
 * and need not be asked about again. `ssh-keygen -F` is the same lookup ssh itself performs, and
 * a non-default port is spelled `[host]:port` there, exactly as `known_hosts` stores it.
 */
export async function isKnownHost(target: SshTarget): Promise<boolean> {
  const v = validateSshTarget(target);
  if (!v.ok) return false;
  const { host, port } = v.target;
  const needle = port && port !== 22 ? `[${host}]:${port}` : host;
  const r = await execCapture("ssh-keygen", ["-F", needle], { timeoutMs: 5000 });
  return r.code === 0 && r.stdout.trim().length > 0;
}

/* ── tunnels ────────────────────────────────────────────────────────────────────────────────*/

export interface Tunnel {
  /** the loopback port on THIS machine that now reaches the remote service. */
  localPort: number;
  /** what it reaches: `http://127.0.0.1:<localPort>`. */
  localBaseUrl: string;
  target: SshTarget;
  remotePort: number;
  /** tear it down. Idempotent. */
  close(): void;
  /** is the ssh process still up? */
  alive(): boolean;
}

/** Live tunnels, so a second request for the same route reuses one rather than stacking them. */
const tunnels = new Map<string, Tunnel>();

function tunnelKey(t: SshTarget, remoteHost: string, remotePort: number): string {
  return `${t.user ?? ""}@${t.host}:${t.port ?? 22}->${remoteHost}:${remotePort}`;
}

/** An unused loopback port, asked of the kernel rather than guessed. */
export function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Open `ssh -N -L 127.0.0.1:<local>:<remoteHost>:<remotePort>`.
 *
 * Resolves once the forward is actually usable, not merely once ssh was spawned — the difference
 * matters because the caller's very next act is an HTTP request through it, and connecting to a
 * port ssh has not bound yet fails in a way that looks like the remote server being down.
 *
 * `ExitOnForwardFailure=yes` (from `fixedSshOptions`) means a bind failure kills ssh rather than
 * leaving a connection with no forward, so a process that is still alive after the probe below
 * has genuinely bound the port.
 */
export async function openTunnel(
  target: SshTarget,
  opts: {
    remotePort: number;
    remoteHost?: string;
    localPort?: number;
    /** how long to wait for the forward to come up. */
    readyTimeoutMs?: number;
  },
): Promise<{ ok: true; tunnel: Tunnel } | { ok: false; error: string }> {
  const v = validateSshTarget(target);
  if (!v.ok) return { ok: false, error: v.error };
  const remoteHost = opts.remoteHost ?? "127.0.0.1";
  const key = tunnelKey(v.target, remoteHost, opts.remotePort);
  const existing = tunnels.get(key);
  if (existing?.alive()) return { ok: true, tunnel: existing };
  if (existing) tunnels.delete(key);

  let localPort: number;
  try {
    localPort = opts.localPort ?? (await freeLocalPort());
  } catch {
    return { ok: false, error: "could not reserve a local port for the tunnel" };
  }

  let args: string[];
  try {
    args = sshArgs(v.target, {
      noRemoteCommand: true,
      forward: { localPort, remoteHost, remotePort: opts.remotePort },
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const child = spawn("ssh", args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: safeChildEnv(),
    windowsHide: true,
    // Detached would outlive a crash of this process and leave an orphan listening on loopback.
    detached: false,
  });
  let stderr = "";
  child.stderr?.on("data", (b: Buffer) => {
    stderr += b.toString().slice(0, 4096);
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
    tunnels.delete(key);
  });
  child.on("error", () => {
    exited = true;
    tunnels.delete(key);
  });

  const ready = await waitForPort(localPort, opts.readyTimeoutMs ?? 8000, () => exited);
  if (!ready) {
    child.kill("SIGTERM");
    return {
      ok: false,
      error: exited
        ? explainSshFailure(child.exitCode ?? 255, stderr)
        : `the tunnel to ${formatSshTarget(v.target)} did not come up in time`,
    };
  }

  const tunnel: Tunnel = {
    localPort,
    localBaseUrl: `http://127.0.0.1:${localPort}`,
    target: v.target,
    remotePort: opts.remotePort,
    close: () => {
      tunnels.delete(key);
      if (!exited) child.kill("SIGTERM");
    },
    alive: () => !exited,
  };
  tunnels.set(key, tunnel);
  return { ok: true, tunnel };
}

/**
 * Poll a loopback port until something accepts, the deadline passes, or ssh dies.
 *
 * A TCP connect, not a sleep. `ssh -L` binds its listener some milliseconds after the process
 * starts and the delay varies with the handshake, so any fixed wait is either a stall or a race;
 * asking the port directly is both faster and correct. `died()` is checked every round so a
 * connection that was refused outright fails in its own time rather than at the deadline.
 */
export function waitForPort(
  port: number,
  timeoutMs: number,
  died: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      if (died() || Date.now() > deadline) {
        resolve(false);
        return;
      }
      const sock = new Socket();
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (ok) {
          resolve(true);
          return;
        }
        setTimeout(attempt, 100);
      };
      sock.setTimeout(500, () => done(false));
      sock.once("error", () => done(false));
      sock.connect(port, "127.0.0.1", () => done(true));
    };
    attempt();
  });
}

/** Close every tunnel this process opened. */
export function closeAllTunnels(): void {
  for (const t of [...tunnels.values()]) t.close();
  tunnels.clear();
}

/** The tunnels currently up, for a status view. */
export function listTunnels(): Tunnel[] {
  return [...tunnels.values()].filter((t) => t.alive());
}

/**
 * Drop the shared SSH connection to a host.
 *
 * `ControlPersist` keeps a master connection alive after the last command, which is what makes
 * repeated probes cheap — but it also means a host stays logged in for two minutes after the
 * user removed it. `/remote remove` calls this so "removed" means removed.
 */
export async function closeControlMaster(target: SshTarget): Promise<void> {
  const v = validateSshTarget(target);
  if (!v.ok) return;
  const path = controlPathFor(v.target);
  await execCapture("ssh", ["-o", `ControlPath=${path}`, "-O", "exit", "--", v.target.host], {
    timeoutMs: 5000,
  }).catch(() => undefined);
}

/** Tear everything down when the process goes away. */
let exitHooked = false;
export function hookTunnelCleanup(): void {
  if (exitHooked) return;
  exitHooked = true;
  const bye = (): void => closeAllTunnels();
  process.once("exit", bye);
  process.once("SIGINT", bye);
  process.once("SIGTERM", bye);
}

/** A ChildProcess handle, exported for tests that need to assert on the spawn. */
export type TunnelProcess = ChildProcess;
