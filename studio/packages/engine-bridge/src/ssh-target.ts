// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/ssh-target.ts — how Prometheus addresses a machine over SSH, and why the argv is built here.
 *
 * ── THE THREAT THIS MODULE EXISTS FOR ───────────────────────────────────────────────────────
 *
 * `ssh` takes its options on argv, and several of them run a command on the LOCAL machine
 * before anything is sent anywhere: `-o ProxyCommand=…`, `-o LocalCommand=…` with
 * `PermitLocalCommand`, and `-F <file>` pointing at a config that sets either. The repo's own
 * exec registry already names `ssh -o ProxyCommand` as an arbitrary-code escape.
 *
 * So the hostname is not a string that gets concatenated. A host of `-oProxyCommand=sh` is a
 * local shell, not a machine — and because `spawn` with `shell:false` passes argv verbatim, no
 * amount of quoting elsewhere helps. The defence is to REJECT it here, at the only place an SSH
 * argv is constructed, rather than to escape it somewhere downstream.
 *
 * Every rule below follows from that:
 *
 *   - a host, user, port or identity path is validated against a strict pattern, and a leading
 *     `-` is fatal regardless of what follows it;
 *   - the `-o` options are a FIXED set chosen by this module — a caller cannot add one;
 *   - `--` terminates option parsing before the destination, so even a validator bug cannot turn
 *     a host into a flag;
 *   - the remote command is a constant in `remote-probe.ts`, never assembled from input.
 *
 * ── WHY NOT AN SSH LIBRARY ──────────────────────────────────────────────────────────────────
 *
 * The system `ssh` already knows this user's `~/.ssh/config`, their agent, their keys, their
 * `known_hosts`, their hardware tokens and their jump hosts. A library in-process would know
 * none of it, would need the private key material handed to it, and would add a dependency to a
 * project whose engine is deliberately zero-dependency. Driving the real client keeps the user's
 * existing SSH setup working unchanged, which is also the only way the feature is trustworthy:
 * the credentials never leave the agent.
 *
 * PURE: no IO. `engine-bridge/src/ssh.ts` is what actually spawns.
 */

/** A machine reachable over SSH. */
export interface SshTarget {
  /** hostname or IP. Also accepts an alias defined in the user's own `~/.ssh/config`. */
  host: string;
  /** login user. Omitted means SSH's own default (the config, then the local username). */
  user?: string;
  /** port. Omitted means 22, or whatever the user's config says. */
  port?: number;
  /** path to a private key, when the agent is not being used. */
  identityFile?: string;
  /**
   * Trust the host key on first sight.
   *
   * Off by default. `StrictHostKeyChecking=accept-new` accepts an UNKNOWN host's key silently,
   * which is a trust decision the user has to make with the fingerprint in front of them —
   * `/remote ssh … --trust-new` shows it and asks. It never downgrades an existing entry: a
   * CHANGED key still fails, because that is the case the check exists for.
   */
  acceptNewHostKey?: boolean;
}

/** A hostname, an IPv4/IPv6 literal, or an `~/.ssh/config` alias. Deliberately narrow. */
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const IPV6_RE = /^[0-9A-Fa-f:]+$/;
/** POSIX-ish user names. No spaces, no `-` lead, nothing that could read as a flag. */
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export type SshValidation = { ok: true; target: SshTarget } | { ok: false; error: string };

/**
 * Validate a target. The ONLY way to obtain a target that `sshArgs` will accept.
 *
 * Rejects rather than sanitises. Silently stripping a dangerous character turns a host the user
 * typed into a different host they did not — which for a security boundary is worse than an
 * error message.
 */
export function validateSshTarget(t: SshTarget): SshValidation {
  const host = t.host?.trim() ?? "";
  if (!host) return { ok: false, error: "a host is required" };
  if (host.startsWith("-")) {
    return { ok: false, error: `"${host}" starts with "-", which ssh would read as an option` };
  }
  if (host.length > 253) return { ok: false, error: "host name is too long" };
  const bare = host.replace(/^\[|\]$/g, "");
  if (!HOST_RE.test(bare) && !IPV6_RE.test(bare)) {
    return { ok: false, error: `"${host}" is not a valid host name or address` };
  }

  if (t.user !== undefined) {
    const u = t.user.trim();
    if (!u) return { ok: false, error: "user is empty" };
    if (u.startsWith("-") || !USER_RE.test(u) || u.length > 64) {
      return { ok: false, error: `"${t.user}" is not a valid user name` };
    }
  }

  if (t.port !== undefined) {
    if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) {
      return { ok: false, error: `${t.port} is not a valid port` };
    }
  }

  if (t.identityFile !== undefined) {
    const p = t.identityFile.trim();
    if (!p) return { ok: false, error: "identity file path is empty" };
    if (p.startsWith("-")) {
      return { ok: false, error: 'identity file path may not start with "-"' };
    }
    // A newline in a path would split the argument in any context that ever re-parses it, and no
    // real key path contains one.
    if (/[\n\r\0]/.test(p))
      return { ok: false, error: "identity file path contains a control character" };
  }

  return {
    ok: true,
    target: {
      host: bare,
      ...(t.user ? { user: t.user.trim() } : {}),
      ...(t.port ? { port: t.port } : {}),
      ...(t.identityFile ? { identityFile: t.identityFile.trim() } : {}),
      ...(t.acceptNewHostKey ? { acceptNewHostKey: true } : {}),
    },
  };
}

/**
 * Parse `user@host:port` — the form a user types.
 *
 * An IPv6 literal must be bracketed to be distinguishable from its own colons, which is the
 * same rule URLs use, so it is the one the user already knows.
 */
export function parseSshDestination(input: string): SshValidation {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "a host is required" };
  let rest = raw;
  let user: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let port: number | undefined;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracket) {
    rest = bracket[1] as string;
    if (bracket[2]) port = Number(bracket[2]);
  } else {
    // Only a SINGLE colon is a port separator; several colons is a bare IPv6 address.
    const colons = rest.match(/:/g)?.length ?? 0;
    if (colons === 1) {
      const [h, p] = rest.split(":");
      rest = h as string;
      port = Number(p);
      if (!Number.isFinite(port)) return { ok: false, error: `"${p}" is not a port` };
    }
  }
  return validateSshTarget({
    host: rest,
    ...(user !== undefined ? { user } : {}),
    ...(port !== undefined ? { port } : {}),
  });
}

/** How this module spells a target back to the user. */
export function formatSshTarget(t: SshTarget): string {
  const host = t.host.includes(":") ? `[${t.host}]` : t.host;
  return `${t.user ? `${t.user}@` : ""}${host}${t.port ? `:${t.port}` : ""}`;
}

/**
 * The fixed `-o` options every Prometheus SSH invocation carries.
 *
 * These are not defaults a caller may change. Each one closes something:
 *
 *   BatchMode=yes            — never prompt for a password or a passphrase. A prompt on a
 *                              non-interactive spawn is an indefinite hang, and a hang inside an
 *                              admission check is worse than a refusal.
 *   StrictHostKeyChecking    — see `SshTarget.acceptNewHostKey`. `yes` is the default here, so an
 *                              unknown OR changed key fails closed.
 *   ClearAllForwardings=yes  — neutralises any `LocalForward`/`RemoteForward` inherited from the
 *                              user's own config, so the only forward in effect is the one this
 *                              code asked for on the same command line.
 *   PermitLocalCommand=no    — disables `LocalCommand` outright, whatever a config file says.
 *   ExitOnForwardFailure=yes — a tunnel that silently failed to bind is worse than no tunnel: the
 *                              client would talk to whatever else holds that port.
 *   ConnectTimeout           — a dead host must fail in seconds, not in TCP's own time.
 *
 * `PermitLocalCommand=no` and `ClearAllForwardings=yes` are here specifically because the user's
 * `~/.ssh/config` is honoured — which is the point of driving the real client — and that file is
 * not something this code controls.
 */
export function fixedSshOptions(t: SshTarget, connectTimeoutSec = 10): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `StrictHostKeyChecking=${t.acceptNewHostKey ? "accept-new" : "yes"}`,
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.round(connectTimeoutSec))}`,
  ];
}

export interface SshArgsOptions {
  /** the command to run remotely. A constant from the caller — never assembled from input. */
  remoteCommand?: string;
  /** `-L <localPort>:<remoteHost>:<remotePort>`, bound to loopback only. */
  forward?: { localPort: number; remoteHost: string; remotePort: number };
  /** `-N`: no remote command at all. Used by the tunnel. */
  noRemoteCommand?: boolean;
  connectTimeoutSec?: number;
  /** ControlMaster socket path, when reusing one connection for many probes. */
  controlPath?: string;
  /** open the shared connection rather than joining one. */
  controlMaster?: boolean;
  /** keep the shared connection alive this long after the last use, in seconds. */
  controlPersistSec?: number;
}

/**
 * Build the argv for `ssh`.
 *
 * Throws on an unvalidated target. That is deliberate: this function is the last gate before a
 * spawn, and returning a "safe default" for a malformed host would mean connecting to a machine
 * nobody named. Callers validate first and handle the error in their own vocabulary.
 */
export function sshArgs(target: SshTarget, opts: SshArgsOptions = {}): string[] {
  const v = validateSshTarget(target);
  if (!v.ok) throw new Error(`refusing to build an ssh command: ${v.error}`);
  const t = v.target;

  const args: string[] = [...fixedSshOptions(t, opts.connectTimeoutSec)];

  if (opts.controlPath) {
    args.push("-o", `ControlPath=${opts.controlPath}`);
    args.push("-o", `ControlMaster=${opts.controlMaster ? "yes" : "no"}`);
    if (opts.controlMaster) {
      args.push("-o", `ControlPersist=${Math.max(1, Math.round(opts.controlPersistSec ?? 120))}`);
    }
  }

  if (t.port) args.push("-p", String(t.port));
  if (t.user) args.push("-l", t.user);
  if (t.identityFile) {
    args.push("-i", t.identityFile);
    // With an explicit key, do NOT let the agent offer every other key it holds: a server that
    // logs offered public keys would otherwise learn the user's whole key set.
    args.push("-o", "IdentitiesOnly=yes");
  }

  if (opts.forward) {
    const f = opts.forward;
    assertPort(f.localPort, "local");
    assertPort(f.remotePort, "remote");
    const rh = validateSshTarget({ host: f.remoteHost });
    if (!rh.ok) throw new Error(`refusing to forward to "${f.remoteHost}": ${rh.error}`);
    // Bound to 127.0.0.1 EXPLICITLY. Without the bind address ssh honours `GatewayPorts`, and a
    // tunnel that listens on 0.0.0.0 publishes the remote model server to the whole local
    // network — the opposite of what a tunnel is for.
    const rhost = rh.target.host.includes(":") ? `[${rh.target.host}]` : rh.target.host;
    args.push("-L", `127.0.0.1:${f.localPort}:${rhost}:${f.remotePort}`);
  }

  if (opts.noRemoteCommand) args.push("-N");

  // `--` ends option parsing: whatever follows is the destination, even if it begins with a dash.
  // Belt and braces over the validator, because the cost of being wrong here is a local shell.
  args.push("--", t.host);

  if (opts.remoteCommand) args.push(opts.remoteCommand);
  return args;
}

function assertPort(p: number, which: string): void {
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`${which} port ${p} is not valid`);
  }
}

/**
 * Argv for `ssh-keyscan`, used to SHOW a fingerprint before the user trusts a new host.
 *
 * Separate from `sshArgs` because keyscan takes no `-o` options and no destination terminator;
 * sharing the builder would mean weakening it for one caller.
 */
export function sshKeyscanArgs(target: SshTarget): string[] {
  const v = validateSshTarget(target);
  if (!v.ok) throw new Error(`refusing to scan "${target.host}": ${v.error}`);
  const t = v.target;
  return ["-T", "5", ...(t.port ? ["-p", String(t.port)] : []), t.host];
}
