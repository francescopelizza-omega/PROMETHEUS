/**
 * secrets-backend.test.ts — the CLI keychain SecretsStore (CLI-028). A FAKE spawn stands
 * in for `security`/`secret-tool` so no real keychain is touched; asserts the exact argv,
 * the exit-44/1 "not configured" handling, the stdin-piped Linux secret, and fail-closed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { type SecretSpawn, createCliSecretsStore } from "./secrets-backend.js";

function recorder(results: Record<string, { code: number; stdout?: string }>): {
  spawn: SecretSpawn;
  calls: { cmd: string; args: string[]; stdin?: string }[];
} {
  const calls: { cmd: string; args: string[]; stdin?: string }[] = [];
  const spawn: SecretSpawn = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    const r = results[args[0] ?? ""] ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: "" };
  };
  return { spawn, calls };
}

test("macOS store: set upserts with -U, get returns the password, delete tolerates 44", async () => {
  const { spawn, calls } = recorder({
    "add-generic-password": { code: 0 },
    "find-generic-password": { code: 0, stdout: "sk-secret\n" },
    "delete-generic-password": { code: 44 }, // not found → tolerated
  });
  const store = createCliSecretsStore({ platform: "darwin", spawn });
  await store.set("com.prometheus.studio", "provider:groq", "sk-secret");
  assert.ok(calls[0]?.args.includes("-U"), "set upserts (avoids errSecDuplicate)");
  assert.equal(calls[0]?.cmd, "security");
  const got = await store.get("com.prometheus.studio", "provider:groq");
  assert.equal(got, "sk-secret"); // trailing newline stripped
  await store.delete("com.prometheus.studio", "provider:groq"); // must not throw on 44
});

test("macOS store: find exit 44 → undefined (not configured, not an error)", async () => {
  const { spawn } = recorder({ "find-generic-password": { code: 44 } });
  const store = createCliSecretsStore({ platform: "darwin", spawn });
  assert.equal(await store.get("s", "provider:x"), undefined);
});

test("Linux store: secret is piped via STDIN (no argv leak); lookup exit 1 → undefined", async () => {
  const { spawn, calls } = recorder({
    store: { code: 0 },
    lookup: { code: 1 }, // not found
  });
  const store = createCliSecretsStore({ platform: "linux", spawn });
  await store.set("com.prometheus.studio", "provider:groq", "sk-linux");
  assert.equal(calls[0]?.cmd, "secret-tool");
  assert.equal(calls[0]?.stdin, "sk-linux", "the secret goes via stdin, never argv");
  assert.ok(!calls[0]?.args.includes("sk-linux"), "the secret is not on the command line");
  assert.equal(await store.get("com.prometheus.studio", "provider:groq"), undefined);
});

test("option-shaped account is refused (argv-injection guard)", async () => {
  const { spawn } = recorder({});
  const store = createCliSecretsStore({ platform: "darwin", spawn });
  await assert.rejects(() => store.set("svc", "-a-evil", "k"), /option-shaped/);
});

test("unsupported platform fails closed with a remedy that actually works", async () => {
  const store = createCliSecretsStore({ platform: "win32" });
  await assert.rejects(() => store.get("s", "a"), /no keychain tool for platform 'win32'/);
  // The old message ended "…or use the desktop app". The desktop resolves provider keys
  // through this same function, so that remedy sent a Windows user to the same wall.
  await assert.rejects(() => store.get("s", "a"), /environment variable/);
  await assert.rejects(
    () => store.get("s", "a"),
    (e) => !/use the desktop app/.test(String(e)),
  );
});
