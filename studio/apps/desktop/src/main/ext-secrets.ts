/**
 * main/ext-secrets.ts — encrypted per-extension secret storage (APP-059, file 09 §5.2).
 *
 * Extension secrets persist through Electron `safeStorage` (macOS Keychain / Windows DPAPI /
 * Linux libsecret). The `safeStorage` object is INJECTED as a seam so this is node:test-able
 * without Electron. Each extension gets its own JSON file of base64 ciphertext; a key is
 * writable ONLY if the manifest declared it in `permissions.secrets` (default-deny).
 *
 * FAIL-CLOSED: if encryption is unavailable — OR the selected backend is Linux's
 * `basic_text` (a hardcoded "peanuts" password with no real keyring; trivially readable) —
 * we REFUSE to store rather than persist plaintext masquerading as a secret.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The subset of Electron `safeStorage` this module needs (injected for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  /** Electron 15+ — the backend id; "basic_text" on Linux means NO real keyring. */
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type ExtSecretsErrorCode = "encryption-unavailable" | "undeclared-key" | "bad-id";
export class ExtSecretsError extends Error {
  readonly code: ExtSecretsErrorCode;
  constructor(code: ExtSecretsErrorCode, message: string) {
    super(message);
    this.name = "ExtSecretsError";
    this.code = code;
  }
}

/** Is genuine OS-backed encryption available (not the Linux basic_text fallback)? */
export function encryptionSecure(ss: SafeStorageLike): boolean {
  if (!ss.isEncryptionAvailable()) return false;
  const backend = ss.getSelectedStorageBackend?.();
  return backend !== "basic_text";
}

export interface ExtSecretsOptions {
  safeStorage: SafeStorageLike;
  /** dir the per-extension secret files live in, e.g. `<userData>/ext-secrets`. */
  secretsDir: string;
}

/** An extension id used as a filename must not traverse — mirrors the manifest id pattern. */
function assertSafeExtId(extId: string): void {
  if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(extId)) {
    throw new ExtSecretsError("bad-id", `unsafe extension id: ${extId}`);
  }
}

/**
 * Per-extension encrypted secret store. `declaredKeys` (the manifest's permissions.secrets)
 * is passed on every call so the gate can never drift from the installed manifest.
 */
export class ExtSecrets {
  private readonly ss: SafeStorageLike;
  private readonly dir: string;

  constructor(opts: ExtSecretsOptions) {
    this.ss = opts.safeStorage;
    this.dir = opts.secretsDir;
  }

  private fileFor(extId: string): string {
    assertSafeExtId(extId);
    return join(this.dir, `${extId}.json`);
  }

  private async readStore(extId: string): Promise<Record<string, string>> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.fileFor(extId), "utf8"));
      return raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, string>)
        : {};
    } catch {
      return {}; // missing/corrupt → empty (fail-soft)
    }
  }

  private async writeStore(extId: string, store: Record<string, string>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileFor(extId), JSON.stringify(store, null, 2), "utf8");
  }

  private gateKey(key: string, declaredKeys: readonly string[]): void {
    if (!declaredKeys.includes(key)) {
      throw new ExtSecretsError(
        "undeclared-key",
        `secret not declared in permissions.secrets: ${key}`,
      );
    }
  }

  /** Read + decrypt a secret (undefined when unset). Refuses if the key is undeclared. */
  async get(
    extId: string,
    key: string,
    declaredKeys: readonly string[],
  ): Promise<string | undefined> {
    this.gateKey(key, declaredKeys);
    const store = await this.readStore(extId);
    const b64 = store[key];
    if (b64 === undefined) return undefined;
    if (!encryptionSecure(this.ss)) {
      throw new ExtSecretsError(
        "encryption-unavailable",
        "cannot decrypt: OS encryption unavailable",
      );
    }
    return this.ss.decryptString(Buffer.from(b64, "base64"));
  }

  /** Encrypt + persist a secret. Fail-closed when encryption is unavailable/insecure. */
  async set(
    extId: string,
    key: string,
    value: string,
    declaredKeys: readonly string[],
  ): Promise<void> {
    this.gateKey(key, declaredKeys);
    if (!encryptionSecure(this.ss)) {
      throw new ExtSecretsError(
        "encryption-unavailable",
        "refusing to store secret: OS encryption unavailable (would be plaintext)",
      );
    }
    const store = await this.readStore(extId);
    store[key] = Buffer.from(this.ss.encryptString(value)).toString("base64");
    await this.writeStore(extId, store);
  }

  /** Delete a secret. Allowed even when encryption is unavailable (no crypto needed). */
  async delete(extId: string, key: string, declaredKeys: readonly string[]): Promise<void> {
    this.gateKey(key, declaredKeys);
    const store = await this.readStore(extId);
    if (!(key in store)) return;
    delete store[key];
    await this.writeStore(extId, store);
  }
}
