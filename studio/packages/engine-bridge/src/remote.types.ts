/**
 * remote.types.ts — remote interpreters (file 14 §3.7), PURE types + launcher argv.
 *
 * A `RemoteTarget` lives alongside local `Env`s (04): an SSH host, Docker container,
 * Compose service, or WSL distro whose Python runs run/debug/test/REPL while editing
 * stays local, with `pathMap` translating paths local↔remote. THIS module is the
 * dependency-free model + the pure argv builders the transport shims (07's pty/lsp/dap
 * hosts) feed to a child process — it NEVER spawns. Adding a target is GATED: the spec
 * crosses `nemesis gate <target>` before first use and the verdict is persisted as
 * `RemoteTarget.gate` (C3/C4); these helpers only carry that verdict, never decide it.
 */
import type { NemesisVerdictRef } from "./security/verdict.js";

/** Which transport a remote target uses (§3.7). */
export type RemoteKind = "ssh" | "docker" | "compose" | "wsl";

/** A local↔remote path mapping pair (§3.7 — required for remote run/debug). */
export interface PathMapping {
  local: string;
  remote: string;
}

/** A remote execution surface 04 lists beside local Envs (§3.7). */
export interface RemoteTarget {
  id: string;
  kind: RemoteKind;
  label: string;
  /** transport spec — kind-specific keys (ssh: host/user/port; docker: container; …). */
  spec: Record<string, string>;
  /** the interpreter inside the target. */
  pythonPath: string;
  pathMap: PathMapping[];
  /** the nemesis verdict from gating the target spec on first use (C3/C4). */
  gate: NemesisVerdictRef;
}

/* ── path translation (§3.7) ───────────────────────────────────────────────── */

function withTrailingSlash(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
}

/** Map a LOCAL path to its REMOTE equivalent via the longest matching prefix. */
export function toRemotePath(target: RemoteTarget, localPath: string): string | undefined {
  const sorted = [...target.pathMap].sort((a, b) => b.local.length - a.local.length);
  for (const m of sorted) {
    if (localPath === m.local) return m.remote;
    if (localPath.startsWith(withTrailingSlash(m.local))) {
      return m.remote.replace(/\/$/, "") + localPath.slice(m.local.length);
    }
  }
  return undefined;
}

/** Map a REMOTE path back to its LOCAL equivalent via the longest matching prefix. */
export function toLocalPath(target: RemoteTarget, remotePath: string): string | undefined {
  const sorted = [...target.pathMap].sort((a, b) => b.remote.length - a.remote.length);
  for (const m of sorted) {
    if (remotePath === m.remote) return m.local;
    if (remotePath.startsWith(withTrailingSlash(m.remote))) {
      return m.local.replace(/\/$/, "") + remotePath.slice(m.remote.length);
    }
  }
  return undefined;
}

/* ── launcher argv builders (§3.7) — pure; no spawning ─────────────────────── */

/** Build the `ssh [user@]host [-p port]` exec argv (the command is appended). */
export function buildSshArgv(target: RemoteTarget, command: readonly string[]): string[] {
  const { host, user, port } = target.spec;
  const dest = user ? `${user}@${host}` : (host ?? "");
  const argv = ["ssh"];
  if (port) argv.push("-p", port);
  argv.push(dest, "--", ...command);
  return argv;
}

/** Build the `docker exec [-w workdir] <container> <command>` argv. */
export function buildDockerArgv(target: RemoteTarget, command: readonly string[]): string[] {
  const { container, workdir } = target.spec;
  const argv = ["docker", "exec"];
  if (workdir) argv.push("-w", workdir);
  argv.push(container ?? "", ...command);
  return argv;
}

/** Build the `docker compose [-f file] exec -T <service> <command>` argv. */
export function buildComposeArgv(target: RemoteTarget, command: readonly string[]): string[] {
  const { service, file, workdir } = target.spec;
  const argv = ["docker", "compose"];
  if (file) argv.push("-f", file);
  argv.push("exec", "-T");
  if (workdir) argv.push("-w", workdir);
  argv.push(service ?? "", ...command);
  return argv;
}

/** Build the `wsl -d <distro> [--cd dir] -- <command>` argv. */
export function buildWslArgv(target: RemoteTarget, command: readonly string[]): string[] {
  const { distro, cwd } = target.spec;
  const argv = ["wsl"];
  if (distro) argv.push("-d", distro);
  if (cwd) argv.push("--cd", cwd);
  argv.push("--", ...command);
  return argv;
}

/** Dispatch the argv builder for a target's kind. */
export function launcherArgv(target: RemoteTarget, command: readonly string[]): string[] {
  switch (target.kind) {
    case "ssh":
      return buildSshArgv(target, command);
    case "docker":
      return buildDockerArgv(target, command);
    case "compose":
      return buildComposeArgv(target, command);
    case "wsl":
      return buildWslArgv(target, command);
  }
}

/**
 * Whether a remote target may be used under the current CLI profile. The airgapped
 * profile (11 §6) disables ALL remote targets (§3.7 contract); otherwise allowed only
 * when the persisted gate verdict is not a blocking tier (C3/C5 fail-closed).
 */
export function remoteTargetAllowed(target: RemoteTarget, airgapped: boolean): boolean {
  if (airgapped) return false;
  return target.gate.verdict !== "block" && target.gate.verdict !== "error";
}
