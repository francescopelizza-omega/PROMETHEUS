// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * secrets/keychain.ts — OS-keychain secret storage, never plaintext (file 09 §7.2).
 *
 * `SecretsStore` is the interface the app codes against. The REAL backend (Electron
 * `safeStorage` — Keychain/libsecret/DPAPI — with a keytar-style named layer) lives
 * in the desktop main and is INJECTED via `SafeStorageBackend` (keytar/electron are
 * not on core's resolution path). `InMemorySecretsStore` backs tests + a non-Electron
 * fallback. Service namespace: `com.prometheus.studio`.
 *
 * Nothing secret touches a settings file. `redactSecretEnv` strips secret-looking env
 * values from captured stderr before it can reach a log (defense-in-depth, §7.2).
 */

/** The keychain service namespace for all Studio secrets. */
export const SECRETS_SERVICE = "com.prometheus.studio";

/** Keychain CRUD, keyed by (service, account). All async (no sync keychain access). */
export interface SecretsStore {
  set(service: string, account: string, secret: string): Promise<void>;
  get(service: string, account: string): Promise<string | undefined>;
  delete(service: string, account: string): Promise<void>;
}

/** The Electron safeStorage adapter the desktop main injects (encrypt/decrypt at rest). */
export interface SafeStorageBackend {
  isAvailable(): boolean;
  encryptString(plain: string): string;
  decryptString(encoded: string): string;
}

/** A test/fallback SecretsStore that holds secrets in memory (never persisted). */
export class InMemorySecretsStore implements SecretsStore {
  private readonly map = new Map<string, string>();
  private key(service: string, account: string): string {
    return `${service}\x00${account}`;
  }
  async set(service: string, account: string, secret: string): Promise<void> {
    this.map.set(this.key(service, account), secret);
  }
  async get(service: string, account: string): Promise<string | undefined> {
    return this.map.get(this.key(service, account));
  }
  async delete(service: string, account: string): Promise<void> {
    this.map.delete(this.key(service, account));
  }
}

/* ── stderr redaction (§7.2) ─────────────────────────────────────────────────── */

/** Known secret env keys to redact verbatim (extend as new providers are added). */
export const SECRET_ENV_KEYS: readonly string[] = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

const REDACTED = "***REDACTED***";
// Any key that *looks* secret (…API_KEY / …TOKEN / …SECRET / …PASSWORD), generic.
const GENERIC_SECRET_KEY = /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/;
// A `KEY = value` / `KEY: value` env-or-log line (captures indent, key, separator).
const KV_LINE = /^(\s*)([A-Za-z][A-Za-z0-9_]*)(\s*[=:]\s*)(.+)$/;

function isSecretKey(key: string, extra: Set<string>): boolean {
  return extra.has(key) || GENERIC_SECRET_KEY.test(key);
}

/**
 * Redact secret VALUES from a captured stderr/log string. Per line, a `KEY=value` or
 * `KEY: value` whose KEY is known (SECRET_ENV_KEYS + extras) or looks secret
 * (…API_KEY/…TOKEN/…SECRET/…PASSWORD) has its value replaced — the key name stays so
 * the log still records WHAT was set, never the secret. Non-strings return "".
 */
export function redactSecretEnv(text: unknown, extraKeys: readonly string[] = []): string {
  if (typeof text !== "string") return "";
  const keys = new Set<string>([...SECRET_ENV_KEYS, ...extraKeys]);
  return text
    .split("\n")
    .map((line) => {
      const m = KV_LINE.exec(line);
      if (!m) return line;
      const key = m[2] as string;
      return isSecretKey(key, keys) ? `${m[1]}${m[2]}${m[3]}${REDACTED}` : line;
    })
    .join("\n");
}
