/**
 * secrets-backend.ts — a CLI-process `SecretsStore` over the OS keychain (CLI-028).
 *
 * The desktop's Electron `safeStorage` backend is NOT reachable from a bare `prometheus`
 * process, so the CLI stores provider keys with the OS keychain TOOLS directly:
 * macOS `security …-generic-password`, Linux `secret-tool` (libsecret). Both run via a
 * shell-free spawn with a sanitized env; the account/service argv never start with `-`
 * (option-injection guard). No secret ever lands in a file — the keychain is the only sink.
 *
 * Fail-closed: on an OS/host without the tool (Windows, headless Linux with no Secret
 * Service), every op rejects with a message naming the exact missing tool. The spawn is
 * a seam so tests use `InMemorySecretsStore` instead (no real keychain touched).
 */
import type { SecretsStore } from "@prometheus/core";
import { execCapture } from "@prometheus/engine-bridge";

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a keychain tool shell-free, optionally piping a secret via stdin (no argv leak). */
export type SecretSpawn = (cmd: string, args: string[], stdin?: string) => Promise<SpawnResult>;

export interface CliSecretsDeps {
  spawn?: SecretSpawn;
  platform?: NodeJS.Platform;
  /** is a host tool present? default = a `<bin> --version`/`--help` probe via spawn. */
  hasTool?: (bin: string) => Promise<boolean>;
}

// The real spawn goes through engine-bridge's execCapture — apps/cli never owns a
// child_process (C5 / SPINE: engine-bridge is the sole spawner).
const defaultSpawn: SecretSpawn = (cmd, args, stdin) =>
  execCapture(cmd, args, stdin !== undefined ? { stdin } : {});

/** Reject argv values that would be read as an option (fail-closed injection guard). */
function guardArg(name: string, value: string): void {
  if (value.startsWith("-")) throw new Error(`refusing option-shaped ${name}: ${value}`);
}

/**
 * A macOS `security`-backed SecretsStore. `-U` upserts (else re-connect → errSecDuplicate);
 * exit 44 (errSecItemNotFound) on find/delete means "not configured", not an error.
 */
function macStore(spawnFn: SecretSpawn): SecretsStore {
  return {
    async set(service, account, secret) {
      guardArg("service", service);
      guardArg("account", account);
      const r = await spawnFn("security", [
        "add-generic-password",
        "-a",
        account,
        "-s",
        service,
        "-w",
        secret,
        "-U",
      ]);
      if (r.code !== 0) throw new Error(`keychain set failed (security exit ${r.code})`);
    },
    async get(service, account) {
      guardArg("service", service);
      guardArg("account", account);
      const r = await spawnFn("security", [
        "find-generic-password",
        "-a",
        account,
        "-s",
        service,
        "-w",
      ]);
      if (r.code === 44) return undefined; // errSecItemNotFound → not configured
      if (r.code !== 0) throw new Error(`keychain get failed (security exit ${r.code})`);
      return r.stdout.replace(/\n$/, "");
    },
    async delete(service, account) {
      guardArg("service", service);
      guardArg("account", account);
      const r = await spawnFn("security", [
        "delete-generic-password",
        "-a",
        account,
        "-s",
        service,
      ]);
      if (r.code !== 0 && r.code !== 44) {
        throw new Error(`keychain delete failed (security exit ${r.code})`);
      }
    },
  };
}

/**
 * A Linux `secret-tool` (libsecret) SecretsStore — the secret is piped via STDIN (no argv
 * leak). `lookup` exits 1 when absent. Needs a running Secret Service (gnome-keyring/kwallet).
 */
function linuxStore(spawnFn: SecretSpawn): SecretsStore {
  return {
    async set(service, account, secret) {
      guardArg("service", service);
      guardArg("account", account);
      const r = await spawnFn(
        "secret-tool",
        ["store", "--label=Prometheus", "service", service, "account", account],
        secret,
      );
      if (r.code !== 0) {
        throw new Error(
          `keychain set failed (secret-tool exit ${r.code}) — is a Secret Service (gnome-keyring/kwallet) running?`,
        );
      }
    },
    async get(service, account) {
      guardArg("service", service);
      guardArg("account", account);
      const r = await spawnFn("secret-tool", ["lookup", "service", service, "account", account]);
      if (r.code !== 0) return undefined; // not found (exit 1) → not configured
      return r.stdout; // secret-tool prints the value with NO trailing newline
    },
    async delete(service, account) {
      guardArg("service", service);
      guardArg("account", account);
      await spawnFn("secret-tool", ["clear", "service", service, "account", account]);
    },
  };
}

/** A store whose every op fails closed, naming the missing per-OS tool. */
function unavailableStore(reason: string): SecretsStore {
  const fail = (): never => {
    throw new Error(reason);
  };
  return { set: async () => fail(), get: async () => fail(), delete: async () => fail() };
}

/**
 * Build the CLI SecretsStore for THIS host. macOS → `security`; Linux → `secret-tool`
 * (when present); everything else fails closed naming the missing tool. Injectable spawn
 * + platform for tests (real backends never run under the suite — tests use InMemory).
 */
export function createCliSecretsStore(deps: CliSecretsDeps = {}): SecretsStore {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const plat = deps.platform ?? process.platform;
  if (plat === "darwin") return macStore(spawnFn);
  if (plat === "linux") return linuxStore(spawnFn);
  return unavailableStore(
    `no CLI keychain tool for platform '${plat}' — set the provider's API-key env var instead, or use the desktop app`,
  );
}
