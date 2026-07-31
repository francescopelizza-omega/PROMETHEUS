/**
 * ext-secrets.test.ts — encrypted per-extension secrets over an injected safeStorage (059).
 *
 * The safeStorage seam is a reversible in-test fake, so encrypt/decrypt round-trip, the
 * undeclared-key gate, and the FAIL-CLOSED paths (unavailable / Linux basic_text) are all
 * exercised without Electron. Real tmpdir fs.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ExtSecrets, type SafeStorageLike, encryptionSecure } from "./ext-secrets.js";

function fakeSafe(opts: { available?: boolean; backend?: string } = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => opts.available ?? true,
    getSelectedStorageBackend: () => opts.backend ?? "keychain",
    encryptString: (s) => Buffer.from(`ENC(${s})`, "utf8"),
    decryptString: (b) => {
      const m = /^ENC\(([\s\S]*)\)$/.exec(b.toString("utf8"));
      return m ? (m[1] as string) : b.toString("utf8");
    },
  };
}

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prom-extsecrets-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const DECLARED = ["openai.key", "db.password"];

test("encryptionSecure: false when unavailable OR the Linux basic_text backend", () => {
  assert.equal(encryptionSecure(fakeSafe()), true);
  assert.equal(encryptionSecure(fakeSafe({ available: false })), false);
  assert.equal(encryptionSecure(fakeSafe({ backend: "basic_text" })), false);
});

test("set/get round-trips a declared secret + survives a fresh instance (restart)", async () => {
  await withTmp(async (dir) => {
    const secrets = new ExtSecrets({ safeStorage: fakeSafe(), secretsDir: dir });
    await secrets.set("pub.ext", "openai.key", "sk-abc123", DECLARED);
    assert.equal(await secrets.get("pub.ext", "openai.key", DECLARED), "sk-abc123");
    // a brand-new instance over the same dir reads the persisted (encrypted) value.
    const reopened = new ExtSecrets({ safeStorage: fakeSafe(), secretsDir: dir });
    assert.equal(await reopened.get("pub.ext", "openai.key", DECLARED), "sk-abc123");
  });
});

test("delete removes exactly one secret; get is undefined after", async () => {
  await withTmp(async (dir) => {
    const secrets = new ExtSecrets({ safeStorage: fakeSafe(), secretsDir: dir });
    await secrets.set("pub.ext", "openai.key", "a", DECLARED);
    await secrets.set("pub.ext", "db.password", "b", DECLARED);
    await secrets.delete("pub.ext", "openai.key", DECLARED);
    assert.equal(await secrets.get("pub.ext", "openai.key", DECLARED), undefined);
    assert.equal(await secrets.get("pub.ext", "db.password", DECLARED), "b"); // sibling intact
  });
});

test("an undeclared key is refused on set/get/delete (default-deny)", async () => {
  await withTmp(async (dir) => {
    const secrets = new ExtSecrets({ safeStorage: fakeSafe(), secretsDir: dir });
    await assert.rejects(
      () => secrets.set("pub.ext", "not.declared", "x", DECLARED),
      /not declared/,
    );
    await assert.rejects(() => secrets.get("pub.ext", "not.declared", DECLARED), /not declared/);
    await assert.rejects(() => secrets.delete("pub.ext", "not.declared", DECLARED), /not declared/);
  });
});

test("fail-closed: refuses to STORE when encryption is unavailable or basic_text", async () => {
  await withTmp(async (dir) => {
    const insecure = new ExtSecrets({
      safeStorage: fakeSafe({ available: false }),
      secretsDir: dir,
    });
    await assert.rejects(
      () => insecure.set("pub.ext", "openai.key", "x", DECLARED),
      /encryption unavailable/,
    );
    const basic = new ExtSecrets({
      safeStorage: fakeSafe({ backend: "basic_text" }),
      secretsDir: dir,
    });
    await assert.rejects(() => basic.set("pub.ext", "openai.key", "x", DECLARED), /encryption/);
  });
});

test("fail-closed: refuses to DECRYPT a stored secret when encryption goes unavailable", async () => {
  await withTmp(async (dir) => {
    // store securely…
    await new ExtSecrets({ safeStorage: fakeSafe(), secretsDir: dir }).set(
      "pub.ext",
      "openai.key",
      "sk",
      DECLARED,
    );
    // …then a later read with no encryption backend must refuse, not return garbage.
    const insecure = new ExtSecrets({
      safeStorage: fakeSafe({ available: false }),
      secretsDir: dir,
    });
    await assert.rejects(() => insecure.get("pub.ext", "openai.key", DECLARED), /unavailable/);
  });
});

test("a path-traversal extension id is rejected", async () => {
  await withTmp(async (dir) => {
    const secrets = new ExtSecrets({ safeStorage: fakeSafe(), secretsDir: dir });
    await assert.rejects(() => secrets.set("../evil", "openai.key", "x", DECLARED), /unsafe/);
  });
});
