// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * secrets/index.ts — the OS-keychain secrets barrel (file 09 §7.2).
 */
export type { SecretsStore, SafeStorageBackend } from "./keychain.js";
export {
  SECRETS_SERVICE,
  InMemorySecretsStore,
  SECRET_ENV_KEYS,
  redactSecretEnv,
} from "./keychain.js";
