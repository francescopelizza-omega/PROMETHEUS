/**
 * secrets-backend.ts — a pointer, not a store.
 *
 * The implementation moved into core's host half so the DESKTOP reads the same keychain
 * entries. A provider key is configured once, with `prometheus provider connect`, and both
 * surfaces find it — previously the GUI had no provider-key store at all and listed cloud
 * endpoints it could not authenticate to.
 */
export type { CliSecretsDeps, SecretSpawn, SpawnResult } from "@prometheus/core/agent-system-host";
export { createCliSecretsStore } from "@prometheus/core/agent-system-host";
