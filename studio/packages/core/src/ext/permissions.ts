/**
 * ext/permissions.ts — the enforced capability set built from the manifest (§5.2).
 *
 * The ExtensionContext capabilities are CONSTRUCTED from `permissions` — an
 * extension with `network:"none"` literally gets no host egress; `engine.run` rejects
 * any subcommand not in `permissions.engine`; `secrets.get` rejects any key not
 * declared. Default-DENY: an absent permission grants nothing. Enforced at the
 * boundary, not trusted. FS globs reuse the §4.4 path guard (symlink-resolution is
 * the host's job at the actual fs call).
 */
import { isPathAllowed } from "../agents/sandbox.js";
import type { ExtNetworkPolicy, ExtPermissions } from "./types.js";

export interface ExtCapabilities {
  /** may the extension invoke this prometheus subcommand? */
  engineAllowed(subcmd: string): boolean;
  /** may it request this keychain key? */
  secretAllowed(key: string): boolean;
  /** is this path within the declared fs.read allowlist? */
  fsReadAllowed(path: string, workspaceRoot: string): boolean;
  /** is this path within the declared fs.write allowlist? */
  fsWriteAllowed(path: string, workspaceRoot: string): boolean;
  readonly network: ExtNetworkPolicy;
  readonly shell: boolean;
}

/** Build the enforced capabilities from declared permissions (default-deny). */
export function buildCapabilities(perms: ExtPermissions | undefined): ExtCapabilities {
  const p = perms ?? {};
  const engine = new Set(p.engine ?? []);
  const secrets = new Set(p.secrets ?? []);
  const fsRead = p.fs?.read ?? [];
  const fsWrite = p.fs?.write ?? [];
  return {
    engineAllowed: (cmd) => engine.has(cmd),
    secretAllowed: (key) => secrets.has(key),
    fsReadAllowed: (path, root) => fsRead.length > 0 && isPathAllowed(path, fsRead, root),
    fsWriteAllowed: (path, root) => fsWrite.length > 0 && isPathAllowed(path, fsWrite, root),
    network: p.network ?? "none",
    shell: p.shell === true,
  };
}

/** Is a raw host egress allowed? Only when network is a host allowlist containing it. */
export function networkHostAllowed(network: ExtNetworkPolicy, host: string): boolean {
  if (network === "none" || network === "mcp-only") return false;
  return network.includes(host);
}
